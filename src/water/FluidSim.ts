import { Terrain, Column } from '../world/Terrain';
import { EditStore } from '../world/Edits';
import { WorldParams } from '../world/WorldParams';

// ---------------------------------------------------------------------------------------------
// Dynamic water: a sparse cellular automaton on a 1 m grid ("compressible mass" water: each
// cell holds a mass; it flows down, levels out sideways and is pushed up by slight
// over-pressure, which makes communicating vessels work). The static seas and underworld lakes
// act as infinite sources, so anything dug below their level fills, and water pours through
// any opening into caves below. Chunks fall asleep when they settle.
// ---------------------------------------------------------------------------------------------

export const FC = 16;
const N = FC * FC * FC;
const MAX_MASS = 1;
const MAX_COMPRESS = 0.03;
const MIN_MASS = 0.0005;
const MIN_FLOW = 0.004;
const MAX_SPEED = 1;

const AIR = 0;
const SOLID = 1;
const SOURCE = 2;

export interface FChunk {
  key: string;
  cx: number;
  cy: number;
  cz: number;
  kind: Uint8Array;
  mass: Float32Array;
  next: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  awake: boolean;
  calm: number;
  dirty: boolean;
  steps: number;
  hasSource: boolean;
  frozen: boolean;
  /** BFS stamps for the hydrostatic pass. */
  visit: Uint32Array;
  /** Source cells touching open cells below their level (null = needs recomputing). */
  iface: Int32Array | null;
  /** Filled by the hydrostatic pass this step (keeps the chunk awake). */
  fed: boolean;
}

const idx = (x: number, y: number, z: number) => x + FC * (y + FC * z);

function stable(total: number): number {
  if (total <= MAX_MASS) return MAX_MASS;
  if (total < 2 * MAX_MASS + MAX_COMPRESS) return (MAX_MASS * MAX_MASS + total * MAX_COMPRESS) / (MAX_MASS + MAX_COMPRESS);
  return (total + MAX_COMPRESS) / 2;
}

export interface Splash {
  x: number;
  y: number;
  z: number;
  s: number;
}

export class FluidSim {
  readonly chunks = new Map<string, FChunk>();
  private col = new Column();
  private createQueue = new Set<string>();
  focus = { x: 0, y: 0, z: 0 };
  /** Chunks are only frozen or dropped once we know where the player is. */
  focusKnown = false;
  radius = 160;
  splashes: Splash[] = [];

  constructor(readonly terrain: Terrain, readonly edits: EditStore, readonly params: WorldParams) {}

  static key(cx: number, cy: number, cz: number): string {
    return `${cx},${cy},${cz}`;
  }

  /** Levels at which infinite liquid bodies exist. */
  private get maxLevel(): number {
    return Math.max(this.params.seaLevel, this.params.under.liquidLevel);
  }

  private inRange(cx: number, cy: number, cz: number): boolean {
    const x = (cx + 0.5) * FC - this.focus.x, y = (cy + 0.5) * FC - this.focus.y, z = (cz + 0.5) * FC - this.focus.z;
    if (!this.focusKnown) return true;
    return x * x + z * z < this.radius * this.radius && Math.abs(y) < this.radius;
  }

  /** Builds solidity and liquid sources for a chunk. */
  create(cx: number, cy: number, cz: number): FChunk {
    const key = FluidSim.key(cx, cy, cz);
    const existing = this.chunks.get(key);
    if (existing) return existing;
    const ch: FChunk = {
      key, cx, cy, cz,
      kind: new Uint8Array(N), mass: new Float32Array(N), next: new Float32Array(N),
      vx: new Float32Array(N), vy: new Float32Array(N), vz: new Float32Array(N),
      awake: true, calm: 0, dirty: true, steps: 0, hasSource: false, frozen: false,
      visit: new Uint32Array(N), iface: null, fed: false,
    };
    this.classify(ch);
    this.chunks.set(key, ch);
    // Existing water in neighbours may now flow in
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const n = this.chunks.get(FluidSim.key(cx + dx, cy + dy, cz + dz));
      if (n) {
        n.iface = null;
        this.wake(n);
      }
    }
    return ch;
  }

  private classify(ch: FChunk): void {
    const T = this.terrain;
    const P = this.params;
    const sea = P.seaLevel;
    const ll = P.under.liquidLevel;
    const x0 = ch.cx * FC, y0 = ch.cy * FC, z0 = ch.cz * FC;
    const c = this.col;
    ch.hasSource = false;
    for (let z = 0; z < FC; z++)
      for (let x = 0; x < FC; x++) {
        const wx = x0 + x + 0.5, wz = z0 + z + 0.5;
        T.column(wx, wz, c, 1);
        const seaCol = c.h < sea;
        const lakeCol = c.uOpen > 4 && c.uC > ll + 1 && c.h > ll + 30;
        for (let y = 0; y < FC; y++) {
          const wy = y0 + y + 0.5;
          const orig = T.density(wx, wy, wz, c, 1);
          const d = Terrain.finalize(this.edits.applyAt(orig, wx, wy, wz), wy);
          const i = idx(x, y, z);
          if (d < 0) {
            ch.kind[i] = SOLID;
            ch.mass[i] = 0;
            continue;
          }
          // Air that was part of the original sea or lake volume is an infinite source
          const src = orig > 0 && ((seaCol && wy < sea && wy > c.h - 1.5) || (lakeCol && wy < ll && wy > c.uF - 1.5));
          if (src) {
            ch.kind[i] = SOURCE;
            ch.mass[i] = MAX_MASS;
            ch.hasSource = true;
          } else {
            if (ch.kind[i] === SOURCE) ch.mass[i] = 0;
            ch.kind[i] = AIR;
          }
        }
      }
    ch.next.set(ch.mass);
    ch.iface = null;
  }

  wake(ch: FChunk): void {
    if (!ch.awake) {
      ch.awake = true;
      ch.next.set(ch.mass);
      ch.calm = 0;
    }
  }

  /** An edit happened: rebuild affected chunks and wake the water around it. */
  onEdit(x: number, y: number, z: number, r: number): void {
    if (y - r > this.maxLevel + 2 && !this.anyWaterNear(x, y, z, r)) return;
    const m = r + 2;
    const cx0 = Math.floor((x - m) / FC), cx1 = Math.floor((x + m) / FC);
    const cy0 = Math.floor((y - m) / FC), cy1 = Math.floor((y + m) / FC);
    const cz0 = Math.floor((z - m) / FC), cz1 = Math.floor((z + m) / FC);
    for (let cx = cx0; cx <= cx1; cx++)
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cz = cz0; cz <= cz1; cz++) {
          const ch = this.chunks.get(FluidSim.key(cx, cy, cz));
          if (ch) {
            // Preserve existing water in cells that stay open
            const keep = ch.mass.slice();
            this.classify(ch);
            for (let i = 0; i < N; i++) if (ch.kind[i] === AIR) ch.mass[i] = keep[i];
            ch.next.set(ch.mass);
            ch.dirty = true;
            this.wake(ch);
          } else if (cy * FC < this.maxLevel + 2) {
            this.create(cx, cy, cz);
          }
        }
  }

  private anyWaterNear(x: number, y: number, z: number, r: number): boolean {
    const m = r + 2;
    for (const ch of this.chunks.values()) {
      const x0 = ch.cx * FC, y0 = ch.cy * FC, z0 = ch.cz * FC;
      if (x + m < x0 || x - m > x0 + FC || y + m < y0 || y - m > y0 + FC || z + m < z0 || z - m > z0 + FC) continue;
      return true;
    }
    return false;
  }

  /** Mass at a world cell, and the chunk that holds it (or null if no chunk). */
  private cellRef(wx: number, wy: number, wz: number): [FChunk | null, number] {
    const cx = Math.floor(wx / FC), cy = Math.floor(wy / FC), cz = Math.floor(wz / FC);
    const ch = this.chunks.get(FluidSim.key(cx, cy, cz)) ?? null;
    if (!ch) return [null, -1];
    return [ch, idx(wx - cx * FC, wy - cy * FC, wz - cz * FC)];
  }

  /** One simulation step over all awake chunks. */
  step(): void {
    this.hydro();
    const awake: FChunk[] = [];
    for (const ch of this.chunks.values()) if (ch.awake && !ch.frozen) awake.push(ch);
    for (const ch of awake) ch.next.set(ch.mass);
    const touched = new Set<FChunk>();

    for (const ch of awake) {
      const { kind, mass, next } = ch;
      const x0 = ch.cx * FC, y0 = ch.cy * FC, z0 = ch.cz * FC;
      for (let z = 0; z < FC; z++)
        for (let y = 0; y < FC; y++)
          for (let x = 0; x < FC; x++) {
            const i = idx(x, y, z);
            if (kind[i] === SOLID) continue;
            let remaining = mass[i];
            if (remaining <= MIN_MASS) continue;

            // Down
            let fl = this.flowTo(ch, x, y - 1, z, x0, y0, z0, remaining, 'down', touched);
            if (fl > 0) {
              next[i] -= fl;
              remaining -= fl;
              ch.vy[i] = ch.vy[i] * 0.8 - fl * 0.2;
            }
            if (remaining <= MIN_MASS) continue;
            // Sideways
            let hx = 0, hz = 0;
            for (let s = 0; s < 4; s++) {
              const dx = s === 0 ? 1 : s === 1 ? -1 : 0, dz = s === 2 ? 1 : s === 3 ? -1 : 0;
              fl = this.flowTo(ch, x + dx, y, z + dz, x0, y0, z0, remaining, mass[i], touched);
              if (fl > 0) {
                next[i] -= fl;
                remaining -= fl;
                hx += dx * fl;
                hz += dz * fl;
              }
              if (remaining <= MIN_MASS) break;
            }
            ch.vx[i] = ch.vx[i] * 0.85 + hx * 0.6;
            ch.vz[i] = ch.vz[i] * 0.85 + hz * 0.6;
            // (No upward "pressure" flow: the hydrostatic pass equalises levels, and upward
            // leakage from an infinite source would climb above sea level.)
          }
    }

    // Commit, keep sources full, detect settling
    const all = new Set<FChunk>([...awake, ...touched]);
    for (const ch of all) {
      const { kind, mass, next } = ch;
      let change = 0;
      for (let i = 0; i < N; i++) {
        let v = next[i];
        if (kind[i] === SOURCE) v = MAX_MASS;
        else if (kind[i] === SOLID) v = 0;
        else if (v < MIN_MASS) v = 0;
        const dv = Math.abs(v - mass[i]);
        if (dv > change) change = dv;
        mass[i] = v;
      }
      ch.steps++;
      if (change > 0.002 || ch.fed) {
        ch.fed = false;
        ch.dirty = true;
        ch.calm = 0;
        ch.awake = true;
      } else if (++ch.calm > 30) {
        ch.awake = false;
        ch.vx.fill(0);
        ch.vy.fill(0);
        ch.vz.fill(0);
        ch.dirty = true;
      }
    }
  }

  /**
   * Moves mass from the current cell into a neighbour (possibly in another chunk).
   * mode: 'down', 'up' or the current cell's mass (sideways levelling).
   */
  private flowTo(ch: FChunk, x: number, y: number, z: number, x0: number, y0: number, z0: number, remaining: number, mode: 'down' | 'up' | number, touched: Set<FChunk>): number {
    let target = ch;
    let i: number;
    if (x < 0 || y < 0 || z < 0 || x >= FC || y >= FC || z >= FC) {
      const wx = x0 + x, wy = y0 + y, wz = z0 + z;
      const [n, j] = this.cellRef(wx, wy, wz);
      if (!n) {
        // Water wants to leave into unknown space: create that chunk soon
        const cx = Math.floor(wx / FC), cy = Math.floor(wy / FC), cz = Math.floor(wz / FC);
        if (this.inRange(cx, cy, cz)) this.createQueue.add(FluidSim.key(cx, cy, cz));
        return 0;
      }
      if (n.frozen) return 0;
      target = n;
      i = j;
    } else i = idx(x, y, z);
    if (target.kind[i] === SOLID) return 0;
    const other = target.mass[i];
    let flow: number;
    if (mode === 'down') {
      // Incompressible: a cell never holds more than one cell of water
      flow = Math.max(0, Math.min(MAX_MASS - Math.max(other, target.next[i]), MAX_SPEED, remaining));
      // Falling water hitting a pool throws up a splash
      if (flow > 0.3 && y >= 0 && y < FC && ch.vy[idx(Math.min(FC - 1, Math.max(0, x)), Math.min(FC - 1, y + 1), Math.min(FC - 1, Math.max(0, z)))] < -0.3 && Math.random() < 0.02) {
        this.splashes.push({ x: x0 + x + 0.5, y: y0 + y + 1, z: z0 + z + 0.5, s: flow });
      }
    } else if (mode === 'up') {
      flow = remaining - stable(remaining + other);
      if (flow > MIN_FLOW) flow *= 0.5;
      flow = Math.max(0, Math.min(flow, MAX_SPEED, remaining));
    } else {
      flow = (mode - other) / 3;
      flow = Math.max(0, Math.min(flow, remaining, MAX_MASS - Math.max(other, target.next[i])));
    }
    if (flow < 1e-5) return 0;
    if (target !== ch) {
      // Trickles don't wake sleeping neighbours; real flows do
      if (!target.awake) {
        if (flow < 0.002) return 0;
        this.wake(target);
      }
      touched.add(target);
    }
    target.next[i] += flow;
    if (target !== ch) target.dirty = true;
    return flow;
  }

  // --- Hydrostatic pressure ----------------------------------------------------------------
  //
  // Local cell rules only move water by diffusion, which is hopelessly slow over distance.
  // Real water is pushed by pressure: anything connected to a sea or lake through a flooded
  // path gets fed at the far end of that path immediately. We flood-fill the pressurised body
  // (full cells connected to a source) each step and pour water into its open boundary cells,
  // up to the source's level, lowest and supported cells fastest.

  private stamp = 1;
  private nbCh: FChunk | null = null;
  private nbI = 0;

  /** Neighbour of cell i in chunk ch along axis dir (0..5: +x -x +y -y +z -z) into nbCh/nbI. */
  private neighbour(ch: FChunk, i: number, dir: number): boolean {
    let x = i & 15, y = (i >> 4) & 15, z = i >> 8;
    if (dir === 0) x++;
    else if (dir === 1) x--;
    else if (dir === 2) y++;
    else if (dir === 3) y--;
    else if (dir === 4) z++;
    else z--;
    if (x >= 0 && y >= 0 && z >= 0 && x < FC && y < FC && z < FC) {
      this.nbCh = ch;
      this.nbI = x + FC * (y + FC * z);
      return true;
    }
    const cx = ch.cx + (x < 0 ? -1 : x >= FC ? 1 : 0), cy = ch.cy + (y < 0 ? -1 : y >= FC ? 1 : 0), cz = ch.cz + (z < 0 ? -1 : z >= FC ? 1 : 0);
    const n = this.chunks.get(FluidSim.key(cx, cy, cz));
    if (!n) {
      if (this.inRange(cx, cy, cz)) this.createQueue.add(FluidSim.key(cx, cy, cz));
      return false;
    }
    this.nbCh = n;
    this.nbI = (x & 15) + FC * ((y & 15) + FC * (z & 15));
    return true;
  }

  private levelOf(wy: number): number {
    return wy < -150 ? this.params.under.liquidLevel : this.params.seaLevel;
  }

  private computeIface(ch: FChunk): Int32Array {
    const out: number[] = [];
    if (ch.hasSource) {
      const y0 = ch.cy * FC;
      for (let i = 0; i < N; i++) {
        if (ch.kind[i] !== SOURCE) continue;
        const level = this.levelOf(y0 + ((i >> 4) & 15));
        for (let d = 0; d < 6; d++) {
          if (!this.neighbour(ch, i, d)) continue;
          const n = this.nbCh!, j = this.nbI;
          if (n.kind[j] === AIR && n.cy * FC + ((j >> 4) & 15) < level) {
            out.push(i);
            break;
          }
        }
      }
    }
    return new Int32Array(out);
  }

  private hydro(): void {
    const full = ++this.stamp;
    const edge = ++this.stamp;
    const qc: FChunk[] = [];
    const qi: number[] = [];
    const ql: number[] = [];
    for (const ch of this.chunks.values()) {
      if (!ch.hasSource || ch.frozen) continue;
      if (!ch.iface) ch.iface = this.computeIface(ch);
      const y0 = ch.cy * FC;
      for (const i of ch.iface) {
        qc.push(ch);
        qi.push(i);
        ql.push(this.levelOf(y0 + ((i >> 4) & 15)));
      }
    }
    if (!qc.length) return;
    const bc: FChunk[] = [];
    const bi: number[] = [];
    const bcap: number[] = [];
    for (let h = 0; h < qc.length && h < 150000; h++) {
      const ch = qc[h], i = qi[h], level = ql[h];
      for (let d = 0; d < 6; d++) {
        if (!this.neighbour(ch, i, d)) continue;
        const n = this.nbCh!, j = this.nbI;
        if (n.kind[j] !== AIR || n.frozen) continue;
        const v = n.visit[j];
        if (v === full || v === edge) continue;
        if (n.mass[j] >= 0.97) {
          n.visit[j] = full;
          qc.push(n);
          qi.push(j);
          ql.push(level);
          continue;
        }
        const wy = n.cy * FC + ((j >> 4) & 15);
        const cap = Math.min(1, Math.max(0, level - wy));
        if (cap > n.mass[j] + 0.02) {
          n.visit[j] = edge;
          bc.push(n);
          bi.push(j);
          bcap.push(cap);
        }
      }
    }
    // Pour into the boundary: supported cells fill fast, overhanging ones spout and fall
    for (let k = 0; k < bc.length; k++) {
      const n = bc[k], j = bi[k];
      let supported = true;
      if (this.neighbour(n, j, 3)) {
        const b = this.nbCh!, bj = this.nbI;
        supported = b.kind[bj] !== AIR || b.mass[bj] >= 0.97;
      }
      const add = Math.min(bcap[k] - n.mass[j], supported ? 0.6 : 0.25, MAX_MASS - n.mass[j]);
      if (add <= 0) continue;
      if (!n.awake) this.wake(n);
      n.mass[j] += add;
      n.vy[j] = Math.min(n.vy[j], supported ? 0 : -0.3);
      if (add > 0.02) {
        n.fed = true;
        n.dirty = true;
        n.calm = 0;
      }
    }
  }

  /** Create chunks water wanted to flow into (a few per tick, they need terrain sampling). */
  processCreates(max = 3): number {
    let n = 0;
    for (const key of this.createQueue) {
      this.createQueue.delete(key);
      if (this.chunks.has(key)) continue;
      const [cx, cy, cz] = key.split(',').map(Number);
      this.create(cx, cy, cz);
      if (++n >= max) break;
    }
    return n;
  }

  /** Freeze far chunks, forget very far ones. */
  manage(): string[] {
    const removed: string[] = [];
    if (!this.focusKnown) return removed;
    for (const [key, ch] of this.chunks) {
      const x = (ch.cx + 0.5) * FC - this.focus.x, y = (ch.cy + 0.5) * FC - this.focus.y, z = (ch.cz + 0.5) * FC - this.focus.z;
      const d = Math.sqrt(x * x + z * z + y * y * 0.5);
      ch.frozen = d > this.radius * 1.3;
      if (d > this.radius * 4) {
        this.chunks.delete(key);
        removed.push(key);
      }
    }
    return removed;
  }

  get awakeCount(): number {
    let n = 0;
    for (const ch of this.chunks.values()) if (ch.awake && !ch.frozen) n++;
    return n;
  }

  /** Water value at a world cell for meshing (0..1); solids return -1. */
  sample(wx: number, wy: number, wz: number): number {
    const [ch, i] = this.cellRef(wx, wy, wz);
    if (!ch) return 0;
    if (ch.kind[i] === SOLID) return -1;
    const m = ch.mass[i];
    // Thin falling streams are still visible
    const fall = Math.min(1, -ch.vy[i] * 2.5);
    return Math.min(1, Math.max(m, m > 0.02 ? fall * 0.75 : 0));
  }

  velocity(wx: number, wy: number, wz: number, out: Float32Array): void {
    const [ch, i] = this.cellRef(wx, wy, wz);
    if (!ch || i < 0) {
      out[0] = out[1] = out[2] = 0;
      return;
    }
    out[0] = ch.vx[i];
    out[1] = ch.vy[i];
    out[2] = ch.vz[i];
  }

  isSource(wx: number, wy: number, wz: number): boolean {
    const [ch, i] = this.cellRef(wx, wy, wz);
    return !!ch && ch.kind[i] === SOURCE;
  }
}

const NEIGHBOURS: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
