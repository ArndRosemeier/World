import { hash01, hash4 } from '../core/rng';
import { clamp, lerp, smoothstep } from '../core/math';
import { CHUNK } from './constants';
import { EDIT_STRIDE, applyEdit } from './Edits';
import type { ChunkBuilder, ChunkJob } from './ChunkBuilder';
import { Column, Terrain } from './Terrain';
import { WorldParams, FloraDef, Habitat } from './WorldParams';

// ---------------------------------------------------------------------------------------------
// Deterministic prop placement. Candidates live on world-aligned jittered grids (one per
// species) so a plant always appears at the same spot regardless of which LOD chunk
// generated it. Surfaces are found in the chunk's density grid, then refined with the exact
// density function so props sit flush on the ground at every LOD.
// ---------------------------------------------------------------------------------------------

/** Floats per prop: flora id, variant, x, y, z, upX, upY, upZ, rotation, scale, uid, sky. */
export const PROP_STRIDE = 12;

interface Tables {
  biome: Float32Array[]; // [biome][floraId] density
  habitat: Map<Habitat, Float32Array>;
}

let tables: Tables | null = null;
let tablesFor = -1;

function getTables(P: WorldParams): Tables {
  if (tables && tablesFor === P.seed) return tables;
  const nF = P.flora.length;
  const biome = P.biomes.map((b) => {
    const t = new Float32Array(nF);
    for (const f of b.flora) t[f.id] += f.density;
    return t;
  });
  const habitat = new Map<Habitat, Float32Array>();
  const fill = (list: { id: number; density: number }[]) => {
    for (const f of list) {
      const h = P.flora[f.id].habitat;
      let t = habitat.get(h);
      if (!t) habitat.set(h, (t = new Float32Array(nF)));
      t[f.id] += f.density;
    }
  };
  fill(P.caveFlora);
  fill(P.underFlora);
  fill(P.seaFlora);
  tables = { biome, habitat };
  tablesFor = P.seed;
  return tables;
}

const OFF = 2;
const SKY_PROBES = [3, 7, 14, 26, 45];
const exactCol = new Column();
const g3 = new Float32Array(3);

export function scatterProps(B: ChunkBuilder, job: ChunkJob, s: number): Float32Array | undefined {
  const T = B.terrain;
  const P = T.p;
  const tb = getTables(P);
  const out: number[] = [];
  const size = CHUNK * s;
  const { ox, oy, oz, edits } = job;
  const nEdits = edits.length / EDIT_STRIDE;
  const seed = P.seed | 0;

  const exactDensity = (x: number, y: number, z: number) => {
    let d = T.density(x, y, z, exactCol, 1);
    for (let e = 0; e < nEdits; e++) {
      const b = e * EDIT_STRIDE;
      d = applyEdit(d, x, y, z, edits[b], edits[b + 1], edits[b + 2], edits[b + 3], edits[b + 4]);
    }
    return Terrain.finalize(d, y);
  };

  const nearEdit = (x: number, y: number, z: number) => {
    for (let e = 0; e < nEdits; e++) {
      const b = e * EDIT_STRIDE;
      if (Math.hypot(x - edits[b], y - edits[b + 1], z - edits[b + 2]) < edits[b + 3] + 1.2) return true;
    }
    return false;
  };

  for (const f of P.flora) {
    if (f.maxLevel < job.level) continue;
    const sp = f.spacing;
    const cx0 = Math.floor(ox / sp), cx1 = Math.floor((ox + size) / sp);
    const cz0 = Math.floor(oz / sp), cz1 = Math.floor((oz + size) / sp);
    const habTable = f.habitat === 'surface' ? null : tb.habitat.get(f.habitat);
    if (!habTable && f.habitat !== 'surface') continue;
    if (habTable && habTable[f.id] <= 0) continue;

    for (let cz = cz0; cz <= cz1; cz++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const x = (cx + hash01(cx, cz, f.id, seed)) * sp;
        const z = (cz + hash01(cx, cz, f.id, seed + 1)) * sp;
        if (x < ox || x >= ox + size || z < oz || z >= oz + size) continue;
        const fx = (x - ox) / s + OFF, fz = (z - oz) / s + OFF;
        const col = B.columnAtIndex(Math.round(fx), Math.round(fz));

        let dens: number;
        if (habTable) dens = habTable[f.id];
        else dens = lerp(tb.biome[col.b0][f.id], tb.biome[col.b1][f.id], col.w1);
        if (dens <= 0) continue;
        const cl = 0.5 + 0.5 * T.clusterNoise(x, z, f.id);
        const prob = f.prob * dens * lerp(1, cl * cl * 2.2, f.cluster);
        const r0 = hash01(cx, cz, f.id, seed + 2);
        if (r0 > prob) continue;

        const ceilingSpecies = f.habitat === 'ceiling' || f.habitat === 'underCeiling';
        let colReady = false;
        // Scan the column inside this chunk for floor / ceiling transitions.
        for (let j = OFF; j < OFF + CHUNK; j++) {
          const dLo = B.sampleGrid(fx, j, fz);
          const dHi = B.sampleGrid(fx, j + 1, fz);
          const isFloor = dLo < 0 && dHi >= 0;
          const isCeil = dLo >= 0 && dHi < 0;
          if (ceilingSpecies ? !isCeil : !isFloor) continue;
          if (!colReady) {
            T.column(x, z, exactCol, 1);
            colReady = true;
          }
          // Refine with the exact density.
          let yLo = oy + (j - OFF) * s, yHi = yLo + s;
          const iters = 4 + job.level;
          for (let it = 0; it < iters; it++) {
            const ym = (yLo + yHi) * 0.5;
            const dm = exactDensity(x, ym, z);
            if (ceilingSpecies ? dm >= 0 : dm < 0) yLo = ym;
            else yHi = ym;
          }
          const y = (yLo + yHi) * 0.5;
          const hab = classify(exactCol, y, isFloor, P.seaLevel);
          if (hab !== f.habitat) continue;

          B.gridGradient(fx, (y - oy) / s + OFF, fz, g3);
          const gl = Math.hypot(g3[0], g3[1], g3[2]) || 1;
          const nx = g3[0] / gl, ny = g3[1] / gl, nz = g3[2] / gl;
          const upY = ceilingSpecies ? -1 : 1;
          if (ny * upY < f.minUp) continue;
          if (nEdits && nearEdit(x, y, z)) continue;
          if (hab === 'surface' && exactCol.settle > 0.25 && f.collider > 0) continue;
          if (hab === 'surface' && exactCol.settle > 0.6) continue;
          if (hab === 'under' && exactCol.uSettle > 0.2 && (f.collider > 0 || exactCol.uSettle > 0.6)) continue;

          let ux = nx * f.alignNormal, uy = upY * (1 - f.alignNormal) + ny * f.alignNormal, uz = nz * f.alignNormal;
          const ul = Math.hypot(ux, uy, uz) || 1;
          ux /= ul; uy /= ul; uz /= ul;
          const scale = lerp(f.scaleMin, f.scaleMax, Math.pow(hash01(cx, cz, f.id, seed + 3), 1.5));
          const sink = f.sink * scale;
          const uid = hash4(f.id * 7919 + (isFloor ? 0 : 1), cx, cz, Math.floor(y / 6)) % 16777213;
          let sky = 1;
          if (ceilingSpecies || Terrain.sealedFromSky(exactCol, y)) sky = 0;
          else if (y < exactCol.top) {
            for (const st of SKY_PROBES) {
              const yy = y + st;
              if (yy > exactCol.top) break;
              sky *= smoothstep(-3, 1.5, exactDensity(x, yy, z));
              if (sky < 0.01) break;
            }
          }
          out.push(
            f.id, hash4(cx, cz, f.id, seed + 4) % f.variants,
            x - ux * sink, y - uy * sink, z - uz * sink,
            ux, uy, uz,
            hash01(cx, cz, f.id, seed + 5) * Math.PI * 2, scale, uid, sky,
          );
        }
      }
  }

  if (job.level <= 1) scatterMoonlets(B, job, s, out, tb);

  return out.length ? new Float32Array(out) : undefined;
}

function classify(c: Column, y: number, floor: boolean, sea: number): Habitat | null {
  const depth = c.h - y;
  const under = y < c.uC + 8 && y > c.uF - 25 && c.uOpen > 0 && depth > 30;
  if (!floor) {
    if (under) return 'underCeiling';
    return depth > 4 ? 'ceiling' : null;
  }
  if (under) return 'under';
  if (c.moR > 0 && Math.hypot(0, y - c.moY) < c.moR * 1.6 && y > c.h + 30) return null; // moonlets scattered separately
  if (c.isR > 0 && y > c.h + 15) return 'surface';
  if (c.spR > 0 && y > c.h + 3) return 'surface';
  if (depth > 6) return 'cave';
  if (y < sea - 1.5) return 'seafloor';
  return 'surface';
}

/** Props on moonlets grow radially outward from the moonlet's centre. */
function scatterMoonlets(B: ChunkBuilder, job: ChunkJob, s: number, out: number[], tb: Tables): void {
  const T = B.terrain;
  const P = T.p;
  const size = CHUNK * s;
  const { ox, oy, oz } = job;
  const moons: { x: number; y: number; z: number; r: number }[] = [];
  T.moonsNear(ox + size / 2, oz + size / 2, moons);
  for (const m of moons) {
    const R = m.r * 1.3;
    if (m.x + R < ox || m.x - R > ox + size || m.y + R < oy || m.y - R > oy + size || m.z + R < oz || m.z - R > oz + size) continue;
    const bc = T.columnAt(m.x, m.z);
    const b0 = bc.b0;
    for (const f of P.flora) {
      if (f.habitat !== 'surface' || f.maxLevel < job.level) continue;
      const dens = tb.biome[b0][f.id];
      if (dens <= 0) continue;
      const n = Math.min(400, Math.floor(((4 * Math.PI * m.r * m.r) / (f.spacing * f.spacing)) * f.prob * dens));
      for (let i = 0; i < n; i++) {
        // Fibonacci sphere direction, jittered per species
        const t = (i + 0.5) / n;
        const phi = Math.acos(1 - 2 * t);
        const th = Math.PI * (1 + Math.sqrt(5)) * i + f.id * 1.7;
        const dx = Math.sin(phi) * Math.cos(th), dy = Math.cos(phi), dz = Math.sin(phi) * Math.sin(th);
        // March inward along the radius in the chunk grid.
        let prev = Infinity;
        let found = -1;
        for (let rr = m.r * 1.35; rr > m.r * 0.55; rr -= s * 0.5) {
          const px = m.x + dx * rr, py = m.y + dy * rr, pz = m.z + dz * rr;
          const fx = (px - ox) / s + OFF, fy = (py - oy) / s + OFF, fz = (pz - oz) / s + OFF;
          if (fx < 0 || fy < 0 || fz < 0 || fx > CHUNK + 3 || fy > CHUNK + 3 || fz > CHUNK + 3) {
            prev = Infinity;
            continue;
          }
          const d = B.sampleGrid(fx, fy, fz);
          if (d < 0 && prev >= 0 && prev !== Infinity) {
            found = rr + (s * 0.5 * d) / (d - prev);
            break;
          }
          prev = d;
        }
        if (found < 0) continue;
        const px = m.x + dx * found, py = m.y + dy * found, pz = m.z + dz * found;
        if (px < ox || px >= ox + size || py < oy || py >= oy + size || pz < oz || pz >= oz + size) continue;
        const scale = lerp(f.scaleMin, f.scaleMax, hash01(i, f.id, m.x | 0, 3)) * 0.8;
        const sink = f.sink * scale;
        out.push(
          f.id, hash4(i, f.id, m.x | 0, 4) % f.variants,
          px - dx * sink, py - dy * sink, pz - dz * sink,
          dx, dy, dz,
          hash01(i, f.id, m.z | 0, 5) * Math.PI * 2, scale,
          hash4(f.id, i, m.x | 0, m.z | 0) % 16777213, 1,
        );
      }
    }
  }
  void clamp;
}

export type { FloraDef };
