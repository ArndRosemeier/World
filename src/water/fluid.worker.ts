/// <reference lib="webworker" />
import { createWorldParams } from '../world/WorldParams';
import { Terrain } from '../world/Terrain';
import { EditStore } from '../world/Edits';
import { FluidSim, FC, FChunk } from './FluidSim';

declare const self: DedicatedWorkerGlobalScope;

// ---------------------------------------------------------------------------------------------
// Runs the water simulation off the main thread and streams smooth surface meshes of every
// changed chunk (surface nets over the water mass field), with per-vertex flow and foam.
// ---------------------------------------------------------------------------------------------

let sim: FluidSim | null = null;
let seaLevel = 0;
let lakeLevel = -372;

export interface FluidMesh {
  key: string;
  positions: Float32Array;
  normals: Float32Array;
  flow: Float32Array;
  foam: Float32Array;
  indices: Uint32Array;
  /** One bit per cell: water mass > 0.5 (for swimming queries). */
  occ: Uint8Array;
  ox: number;
  oy: number;
  oz: number;
}

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m.type === 'init') {
    const params = createWorldParams(m.seed);
    const edits = new EditStore();
    edits.load(m.edits ?? []);
    sim = new FluidSim(new Terrain(params), edits, params);
    seaLevel = params.seaLevel;
    lakeLevel = params.under.liquidLevel;
    // Rebuild water around saved excavations that reach below liquid level
    for (const e of edits.edits) if (e.op === 1) sim.onEdit(e.x, e.y, e.z, e.r);
    setInterval(tick, 33);
  } else if (m.type === 'edit' && sim) {
    sim.edits.add(m.x, m.y, m.z, m.r, m.op);
    sim.onEdit(m.x, m.y, m.z, m.r);
  } else if (m.type === 'focus' && sim) {
    sim.focus = { x: m.x, y: m.y, z: m.z };
    sim.focusKnown = true;
  }
};

let tickCount = 0;

function tick(): void {
  if (!sim) return;
  const t0 = performance.now();
  tickCount++;
  sim.processCreates(4);
  // Run as many steps as fit in the budget (fast flow when little water is moving)
  let steps = 0;
  while (sim.awakeCount > 0 && performance.now() - t0 < 14 && steps < 6) {
    sim.step();
    steps++;
  }
  if (tickCount % 30 === 0) {
    for (const key of sim.manage()) self.postMessage({ type: 'remove', key });
  }
  // Mesh dirty chunks (throttled)
  if (tickCount % 3 === 0) {
    let meshed = 0;
    for (const ch of sim.chunks.values()) {
      if (!ch.dirty || ch.frozen) continue;
      ch.dirty = false;
      const mesh = buildMesh(sim, ch);
      if (mesh) self.postMessage({ type: 'mesh', mesh }, [mesh.positions.buffer, mesh.normals.buffer, mesh.flow.buffer, mesh.foam.buffer, mesh.indices.buffer, mesh.occ.buffer]);
      else self.postMessage({ type: 'remove', key: ch.key });
      if (++meshed >= 12 || performance.now() - t0 > 25) break;
    }
  }
  if (sim.splashes.length) {
    const s = sim.splashes.splice(0, 40);
    self.postMessage({ type: 'splash', s });
  }
  if (tickCount % 15 === 0) self.postMessage({ type: 'stats', chunks: sim.chunks.size, awake: sim.awakeCount });
}

// --- Meshing --------------------------------------------------------------------------------

const S = FC + 3; // samples at local cell -1 .. FC+1
const vals = new Float32Array(S * S * S);
const vtx = new Int32Array(S * S * S);
const vel = new Float32Array(3);

function buildMesh(sim: FluidSim, ch: FChunk): FluidMesh | null {
  const x0 = ch.cx * FC, y0 = ch.cy * FC, z0 = ch.cz * FC;
  const at = (i: number, j: number, k: number) => i + S * (j + S * k);
  let any = false;
  let occAny = false;
  const occ = new Uint8Array((FC * FC * FC) / 8);
  for (let k = 0; k < S; k++)
    for (let j = 0; j < S; j++)
      for (let i = 0; i < S; i++) {
        const lx = i - 1, ly = j - 1, lz = k - 1;
        let v: number;
        if (lx >= 0 && ly >= 0 && lz >= 0 && lx < FC && ly < FC && lz < FC) {
          const c = lx + FC * (ly + FC * lz);
          if (ch.kind[c] === 1) v = -1;
          else {
            const m = ch.mass[c];
            const fall = Math.min(1, -ch.vy[c] * 2.5);
            v = Math.min(1, Math.max(m, m > 0.02 ? fall * 0.75 : 0));
            if (m > 0.5) {
              occ[c >> 3] |= 1 << (c & 7);
              occAny = true;
            }
          }
        } else v = sim.sample(x0 + lx, y0 + ly, z0 + lz);
        vals[at(i, j, k)] = v;
        if (v > 0.5) any = true;
      }
  if (!any) return occAny ? emptyMesh(ch, occ) : null;
  // Solids take the strongest neighbouring water value, so no surfaces form against rock
  for (let k = 0; k < S; k++)
    for (let j = 0; j < S; j++)
      for (let i = 0; i < S; i++) {
        const a = at(i, j, k);
        if (vals[a] !== -1) continue;
        let m = 0;
        if (i > 0) m = Math.max(m, vals[a - 1]);
        if (i < S - 1) m = Math.max(m, vals[a + 1]);
        if (j > 0) m = Math.max(m, vals[a - S]);
        if (j < S - 1) m = Math.max(m, vals[a + S]);
        if (k > 0) m = Math.max(m, vals[a - S * S]);
        if (k < S - 1) m = Math.max(m, vals[a + S * S]);
        vals[a] = -2 - m; // encoded; decoded below
      }
  for (let a = 0; a < vals.length; a++) if (vals[a] <= -2) vals[a] = -2 - vals[a];

  // Surface nets: vertex per cell (between samples) with a sign change of (v - 0.5)
  const pos: number[] = [], nrm: number[] = [], flw: number[] = [], fm: number[] = [];
  vtx.fill(-1);
  const C = S - 1;
  for (let k = 0; k < C; k++)
    for (let j = 0; j < C; j++)
      for (let i = 0; i < C; i++) {
        let inside = 0;
        const d: number[] = [];
        for (let c = 0; c < 8; c++) {
          const v = vals[at(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))] - 0.5;
          d.push(v);
          if (v > 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of EDGES) {
          const da = d[a], db = d[b];
          if (da > 0 === db > 0) continue;
          const t = da / (da - db);
          sx += (a & 1) + ((b & 1) - (a & 1)) * t;
          sy += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t;
          sz += ((a >> 2) & 1) + (((b >> 2) & 1) - ((a >> 2) & 1)) * t;
          n++;
        }
        sx /= n;
        sy /= n;
        sz /= n;
        // Gradient (points into the water); normal points out
        const gx = (d[1] + d[3] + d[5] + d[7]) - (d[0] + d[2] + d[4] + d[6]);
        const gy = (d[2] + d[3] + d[6] + d[7]) - (d[0] + d[1] + d[4] + d[5]);
        const gz = (d[4] + d[5] + d[6] + d[7]) - (d[0] + d[1] + d[2] + d[3]);
        const gl = Math.hypot(gx, gy, gz) || 1;
        // Sample grid index s corresponds to world cell (s - 1) whose centre is at +0.5
        const wx = x0 + i - 1 + 0.5 + sx, wy = y0 + j - 1 + 0.5 + sy, wz = z0 + k - 1 + 0.5 + sz;
        vtx[at(i, j, k)] = pos.length / 3;
        pos.push(wx, wy, wz);
        nrm.push(-gx / gl, -gy / gl, -gz / gl);
        sim.velocity(Math.floor(wx), Math.floor(wy), Math.floor(wz), vel);
        flw.push(vel[0], vel[1], vel[2]);
        const speed = Math.hypot(vel[0], vel[1], vel[2]);
        fm.push(Math.min(1, speed * 3 + Math.max(0, -vel[1]) * 2));
      }

  const idxs: number[] = [];
  const quad = (a: number, b: number, c: number, e: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || e < 0) return;
    // Hide the surface where it coincides with the static sea/lake surface
    const cy = (pos[a * 3 + 1] + pos[c * 3 + 1]) / 2;
    const cx = Math.floor((pos[a * 3] + pos[c * 3]) / 2), cz = Math.floor((pos[a * 3 + 2] + pos[c * 3 + 2]) / 2);
    for (const L of [seaLevel, lakeLevel]) {
      if (Math.abs(cy - L) < 1.3 && sim.isSource(cx, Math.floor(L - 0.5), cz)) return;
    }
    if (flip) idxs.push(a, c, b, a, e, c);
    else idxs.push(a, b, c, a, c, e);
  };
  // Own edges whose start sample is local cell 0..FC-1 (sample index 1..FC)
  for (let k = 1; k <= FC; k++)
    for (let j = 1; j <= FC; j++)
      for (let i = 1; i <= FC; i++) {
        const v0 = vals[at(i, j, k)] > 0.5;
        if ((vals[at(i + 1, j, k)] > 0.5) !== v0) quad(vtx[at(i, j - 1, k - 1)], vtx[at(i, j, k - 1)], vtx[at(i, j, k)], vtx[at(i, j - 1, k)], !v0);
        if ((vals[at(i, j + 1, k)] > 0.5) !== v0) quad(vtx[at(i - 1, j, k - 1)], vtx[at(i - 1, j, k)], vtx[at(i, j, k)], vtx[at(i, j, k - 1)], !v0);
        if ((vals[at(i, j, k + 1)] > 0.5) !== v0) quad(vtx[at(i - 1, j - 1, k)], vtx[at(i, j - 1, k)], vtx[at(i, j, k)], vtx[at(i - 1, j, k)], !v0);
      }
  if (!idxs.length) return emptyMesh(ch, occ);
  return {
    key: ch.key,
    positions: new Float32Array(pos), normals: new Float32Array(nrm), flow: new Float32Array(flw), foam: new Float32Array(fm),
    indices: new Uint32Array(idxs), occ, ox: x0, oy: y0, oz: z0,
  };
}

function emptyMesh(ch: FChunk, occ: Uint8Array): FluidMesh {
  return {
    key: ch.key, positions: new Float32Array(0), normals: new Float32Array(0), flow: new Float32Array(0), foam: new Float32Array(0),
    indices: new Uint32Array(0), occ, ox: ch.cx * FC, oy: ch.cy * FC, oz: ch.cz * FC,
  };
}

const EDGES: [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];
