import { smax, smin } from '../core/math';

// ---------------------------------------------------------------------------------------------
// Terrain edits are stored as an ordered list of smooth CSG operations (spheres). Because they
// are resolution independent, every LOD level simply re-applies the edits that overlap it.
// ---------------------------------------------------------------------------------------------

export const OP_DIG = 1;
export const OP_ADD = 2;

/** Floats per packed edit: x, y, z, radius, op. */
export const EDIT_STRIDE = 5;

export interface Edit {
  id: number;
  x: number;
  y: number;
  z: number;
  r: number;
  op: number;
}

const CELL = 16;

export function editBlend(r: number): number {
  return Math.min(1.4, r * 0.3);
}

/** Apply one edit to a density value. */
export function applyEdit(d: number, px: number, py: number, pz: number, x: number, y: number, z: number, r: number, op: number): number {
  const s = Math.hypot(px - x, py - y, pz - z) - r;
  const k = editBlend(r);
  return op === OP_DIG ? smax(d, -s, k) : smin(d, s, k);
}

export class EditStore {
  readonly edits: Edit[] = [];
  private grid = new Map<string, number[]>();
  private nextId = 1;
  /** Bumped on every change so that savers can tell when to persist. */
  revision = 0;

  add(x: number, y: number, z: number, r: number, op: number): Edit {
    const e: Edit = { id: this.nextId++, x, y, z, r, op };
    this.insert(e);
    this.revision++;
    return e;
  }

  private insert(e: Edit): void {
    const idx = this.edits.length;
    this.edits.push(e);
    const m = e.r + editBlend(e.r) + 1;
    const x0 = Math.floor((e.x - m) / CELL), x1 = Math.floor((e.x + m) / CELL);
    const y0 = Math.floor((e.y - m) / CELL), y1 = Math.floor((e.y + m) / CELL);
    const z0 = Math.floor((e.z - m) / CELL), z1 = Math.floor((e.z + m) / CELL);
    for (let i = x0; i <= x1; i++)
      for (let j = y0; j <= y1; j++)
        for (let k = z0; k <= z1; k++) {
          const key = `${i},${j},${k}`;
          let arr = this.grid.get(key);
          if (!arr) this.grid.set(key, (arr = []));
          arr.push(idx);
        }
  }

  /** All edits overlapping an AABB, in creation order. */
  query(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Edit[] {
    if (this.edits.length === 0) return EMPTY;
    const set = new Set<number>();
    const x0 = Math.floor(minX / CELL), x1 = Math.floor(maxX / CELL);
    const y0 = Math.floor(minY / CELL), y1 = Math.floor(maxY / CELL);
    const z0 = Math.floor(minZ / CELL), z1 = Math.floor(maxZ / CELL);
    // Huge regions (coarse chunks) are cheaper to scan linearly.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > this.edits.length * 4) {
      const out: Edit[] = [];
      for (const e of this.edits) {
        const m = e.r + editBlend(e.r) + 1;
        if (e.x + m < minX || e.x - m > maxX || e.y + m < minY || e.y - m > maxY || e.z + m < minZ || e.z - m > maxZ) continue;
        out.push(e);
      }
      return out;
    }
    for (let i = x0; i <= x1; i++)
      for (let j = y0; j <= y1; j++)
        for (let k = z0; k <= z1; k++) {
          const arr = this.grid.get(`${i},${j},${k}`);
          if (arr) for (const idx of arr) set.add(idx);
        }
    const out: Edit[] = [];
    for (const idx of [...set].sort((a, b) => a - b)) {
      const e = this.edits[idx];
      const m = e.r + editBlend(e.r) + 1;
      if (e.x + m < minX || e.x - m > maxX || e.y + m < minY || e.y - m > maxY || e.z + m < minZ || e.z - m > maxZ) continue;
      out.push(e);
    }
    return out;
  }

  /** Point query cache: edits near the last queried cell. */
  private pcKey = '';
  private pcList: Edit[] = EMPTY;
  private pcRev = -1;

  applyAt(d: number, x: number, y: number, z: number): number {
    if (this.edits.length === 0) return d;
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
    const key = `${cx},${cy},${cz}`;
    if (key !== this.pcKey || this.pcRev !== this.revision) {
      const arr = this.grid.get(key);
      this.pcList = arr ? arr.map((i) => this.edits[i]) : EMPTY;
      this.pcKey = key;
      this.pcRev = this.revision;
    }
    for (const e of this.pcList) d = applyEdit(d, x, y, z, e.x, e.y, e.z, e.r, e.op);
    return d;
  }

  static pack(list: Edit[]): Float32Array {
    const out = new Float32Array(list.length * EDIT_STRIDE);
    list.forEach((e, i) => {
      out.set([e.x, e.y, e.z, e.r, e.op], i * EDIT_STRIDE);
    });
    return out;
  }

  serialize(): number[] {
    const out: number[] = [];
    for (const e of this.edits) out.push(round2(e.x), round2(e.y), round2(e.z), round2(e.r), e.op);
    return out;
  }

  load(data: number[]): void {
    for (let i = 0; i + 4 < data.length; i += 5) {
      this.insert({ id: this.nextId++, x: data[i], y: data[i + 1], z: data[i + 2], r: data[i + 3], op: data[i + 4] });
    }
    this.revision++;
  }
}

const EMPTY: Edit[] = [];

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
