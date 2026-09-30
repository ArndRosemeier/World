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
    };
    this.classify(ch);
    this.chunks.set(key, ch);
    // Existing water in neighbours may now flow in
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const n = this.chunks.get(FluidSim.key(cx + dx, cy + dy, cz + dz));
      if (n) this.wake(n);
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
  }

  wake(ch: FChunk): void {
    if (!ch.awake) {
      ch.awake = true;
      ch.next.set(ch.mass);
    }
    ch.calm = 0;
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
            if (remaining <= MIN_MASS) continue;
            // Up (pressure)
            fl = this.flowTo(ch, x, y + 1, z, x0, y0, z0, remaining, 'up', touched);
            if (fl > 0) next[i] -= fl;
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
        change += Math.abs(v - mass[i]);
        mass[i] = v;
      }
      ch.steps++;
      if (change > 0.03) {
        ch.dirty = true;
        ch.calm = 0;
        ch.awake = true;
      } else if (++ch.calm > 25) {
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
      if (!n.awake) {
        this.wake(n);
      }
      touched.add(n);
    } else i = idx(x, y, z);
    if (target.kind[i] === SOLID) return 0;
    const other = target.mass[i];
    let flow: number;
    if (mode === 'down') {
      flow = stable(remaining + other) - other;
      if (flow > MIN_FLOW) flow *= 0.5;
      flow = Math.max(0, Math.min(flow, MAX_SPEED, remaining));
      // Falling water hitting a pool throws up a splash
      if (flow > 0.3 && y >= 0 && y < FC && ch.vy[idx(Math.min(FC - 1, Math.max(0, x)), Math.min(FC - 1, y + 1), Math.min(FC - 1, Math.max(0, z)))] < -0.3 && Math.random() < 0.02) {
        this.splashes.push({ x: x0 + x + 0.5, y: y0 + y + 1, z: z0 + z + 0.5, s: flow });
      }
    } else if (mode === 'up') {
      flow = remaining - stable(remaining + other);
      if (flow > MIN_FLOW) flow *= 0.5;
      flow = Math.max(0, Math.min(flow, MAX_SPEED, remaining));
    } else {
      flow = (mode - other) / 4;
      if (flow > MIN_FLOW) flow *= 0.5;
      flow = Math.max(0, Math.min(flow, remaining));
    }
    // Ignore micro-flows: they only keep settled water awake
    if (flow < MIN_FLOW * 0.25) return 0;
    target.next[i] += flow;
    if (target !== ch) target.dirty = true;
    return flow;
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
