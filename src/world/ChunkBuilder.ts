import { Terrain, Column } from './Terrain';
import { CHUNK, BEDROCK } from './constants';
import { EDIT_STRIDE, OP_ADD, applyEdit, editBlend } from './Edits';
import { clamp, smoothstep } from '../core/math';
import { scatterProps } from './Scatter';

// ---------------------------------------------------------------------------------------------
// Builds one chunk: samples the density field on a (CHUNK+5)^3 grid, extracts a smooth surface
// with Surface Nets, and bakes per-vertex albedo, emission, ambient occlusion and sky
// visibility. Chunks overlap their neighbours by one cell so LOD seams stay closed.
// ---------------------------------------------------------------------------------------------

export const G = CHUNK + 5; // samples per axis, k in [-2, CHUNK + 2]
const OFF = 2; // array index of sample k = 0

export interface ChunkJob {
  key: string;
  version: number;
  level: number;
  ox: number;
  oy: number;
  oz: number;
  edits: Float32Array;
  destroyed?: never;
}

export interface ChunkResult {
  key: string;
  version: number;
  empty: boolean;
  positions?: Float32Array;
  normals?: Float32Array;
  colors?: Uint8Array;
  emit?: Uint8Array;
  indices?: Uint32Array;
  water?: { positions: Float32Array; depth: Float32Array; indices: Uint32Array; glow: number } [];
  props?: Float32Array;
  /** Lowest surface height over the chunk (for buried-chunk culling). */
  minH?: number;
  ms: number;
}

export class ChunkBuilder {
  readonly terrain: Terrain;
  private cols: Column[] = [];
  private dens = new Float32Array(G * G * G);
  private cellVert = new Int32Array((G - 1) * (G - 1) * (G - 1));
  private pos = new Float32Array((G - 1) ** 3 * 3);
  private nrm = new Float32Array((G - 1) ** 3 * 3);
  private idx = new Uint32Array((G - 1) ** 3 * 18);
  private grad = new Float32Array(G * G * G * 3);
  private shadeOut = new Float32Array(6);

  constructor(terrain: Terrain) {
    this.terrain = terrain;
    for (let i = 0; i < G * G; i++) this.cols.push(new Column());
  }

  build(job: ChunkJob): ChunkResult {
    const t0 = performance.now();
    const s = 1 << job.level;
    const { ox, oy, oz } = job;
    const T = this.terrain;
    const cols = this.cols;
    const dens = this.dens;

    // 1. Columns
    let maxTop = -Infinity;
    let minFloor = Infinity;
    for (let k = 0; k < G; k++)
      for (let i = 0; i < G; i++) {
        const c = cols[i + k * G];
        T.column(ox + (i - OFF) * s, oz + (k - OFF) * s, c, s);
        if (c.top > maxTop) maxTop = c.top;
        if (c.uF < minFloor) minFloor = c.uF;
      }

    const yMin = oy - OFF * s;
    const yMax = oy + (G - 1 - OFF) * s;
    const edits = job.edits;
    const nEdits = edits.length / EDIT_STRIDE;
    let maxEditTop = -Infinity;
    for (let e = 0; e < nEdits; e++) {
      if (edits[e * EDIT_STRIDE + 4] === OP_ADD) maxEditTop = Math.max(maxEditTop, edits[e * EDIT_STRIDE + 1] + edits[e * EDIT_STRIDE + 3] + 2);
    }
    // Entirely above anything solid, or entirely below bedrock: nothing to mesh.
    if (yMin > maxTop + s && yMin > maxEditTop) return { key: job.key, version: job.version, empty: true, ms: performance.now() - t0 };
    if (yMax < BEDROCK - 2 * s) return { key: job.key, version: job.version, empty: true, ms: performance.now() - t0 };

    // 2. Density grid
    let hasPos = false, hasNeg = false;
    for (let k = 0; k < G; k++)
      for (let i = 0; i < G; i++) {
        const c = cols[i + k * G];
        const x = ox + (i - OFF) * s;
        const z = oz + (k - OFF) * s;
        for (let j = 0; j < G; j++) {
          const y = oy + (j - OFF) * s;
          dens[i + G * (j + G * k)] = T.density(x, y, z, c, s);
        }
      }

    // 3. Edits (in order), then bedrock
    for (let e = 0; e < nEdits; e++) {
      const b = e * EDIT_STRIDE;
      const ex = edits[b], ey = edits[b + 1], ez = edits[b + 2], er = edits[b + 3], op = edits[b + 4];
      const m = er + editBlend(er) + s;
      const i0 = clamp(Math.floor((ex - m - ox) / s) + OFF, 0, G - 1), i1 = clamp(Math.ceil((ex + m - ox) / s) + OFF, 0, G - 1);
      const j0 = clamp(Math.floor((ey - m - oy) / s) + OFF, 0, G - 1), j1 = clamp(Math.ceil((ey + m - oy) / s) + OFF, 0, G - 1);
      const k0 = clamp(Math.floor((ez - m - oz) / s) + OFF, 0, G - 1), k1 = clamp(Math.ceil((ez + m - oz) / s) + OFF, 0, G - 1);
      for (let k = k0; k <= k1; k++)
        for (let j = j0; j <= j1; j++)
          for (let i = i0; i <= i1; i++) {
            const id = i + G * (j + G * k);
            dens[id] = applyEdit(dens[id], ox + (i - OFF) * s, oy + (j - OFF) * s, oz + (k - OFF) * s, ex, ey, ez, er, op);
          }
    }
    for (let n = 0; n < dens.length; n++) {
      const j = Math.floor(n / G) % G;
      const y = oy + (j - OFF) * s;
      const v = Math.min(dens[n], y - BEDROCK);
      dens[n] = v;
      if (v > 0) hasPos = true;
      else hasNeg = true;
    }
    if (!(hasPos && hasNeg)) return { key: job.key, version: job.version, empty: true, ms: performance.now() - t0 };

    // 4. Gradients at every sample (central differences, one-sided at the border)
    const grad = this.grad;
    for (let k = 0; k < G; k++)
      for (let j = 0; j < G; j++)
        for (let i = 0; i < G; i++) {
          const id = i + G * (j + G * k);
          const xm = i > 0 ? id - 1 : id, xp = i < G - 1 ? id + 1 : id;
          const ym = j > 0 ? id - G : id, yp = j < G - 1 ? id + G : id;
          const zm = k > 0 ? id - G * G : id, zp = k < G - 1 ? id + G * G : id;
          grad[id * 3] = (dens[xp] - dens[xm]) / ((xp - xm) || 1);
          grad[id * 3 + 1] = (dens[yp] - dens[ym]) / (((yp - ym) / G) || 1);
          grad[id * 3 + 2] = (dens[zp] - dens[zm]) / (((zp - zm) / (G * G)) || 1);
        }

    // 5. Surface nets: one vertex per sign-changing cell
    const C = G - 1;
    const cellVert = this.cellVert;
    cellVert.fill(-1);
    const pos = this.pos, nrm = this.nrm;
    let nv = 0;
    for (let k = 0; k < C; k++)
      for (let j = 0; j < C; j++)
        for (let i = 0; i < C; i++) {
          const b = i + G * (j + G * k);
          const d000 = dens[b], d100 = dens[b + 1], d010 = dens[b + G], d110 = dens[b + 1 + G];
          const d001 = dens[b + G * G], d101 = dens[b + 1 + G * G], d011 = dens[b + G + G * G], d111 = dens[b + 1 + G + G * G];
          let mask = 0;
          if (d000 < 0) mask |= 1; if (d100 < 0) mask |= 2; if (d010 < 0) mask |= 4; if (d110 < 0) mask |= 8;
          if (d001 < 0) mask |= 16; if (d101 < 0) mask |= 32; if (d011 < 0) mask |= 64; if (d111 < 0) mask |= 128;
          if (mask === 0 || mask === 255) continue;
          let sx = 0, sy = 0, sz = 0, cnt = 0;
          // 12 edges
          const e = (da: number, db: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
            if ((da < 0) === (db < 0)) return;
            const t = da / (da - db);
            sx += ax + (bx - ax) * t;
            sy += ay + (by - ay) * t;
            sz += az + (bz - az) * t;
            cnt++;
          };
          e(d000, d100, 0, 0, 0, 1, 0, 0); e(d010, d110, 0, 1, 0, 1, 1, 0); e(d001, d101, 0, 0, 1, 1, 0, 1); e(d011, d111, 0, 1, 1, 1, 1, 1);
          e(d000, d010, 0, 0, 0, 0, 1, 0); e(d100, d110, 1, 0, 0, 1, 1, 0); e(d001, d011, 0, 0, 1, 0, 1, 1); e(d101, d111, 1, 0, 1, 1, 1, 1);
          e(d000, d001, 0, 0, 0, 0, 0, 1); e(d100, d101, 1, 0, 0, 1, 0, 1); e(d010, d011, 0, 1, 0, 0, 1, 1); e(d110, d111, 1, 1, 0, 1, 1, 1);
          const fx = sx / cnt, fy = sy / cnt, fz = sz / cnt;
          // Trilinear gradient
          let gx = 0, gy = 0, gz = 0;
          for (let c8 = 0; c8 < 8; c8++) {
            const cx = c8 & 1, cy = (c8 >> 1) & 1, cz = (c8 >> 2) & 1;
            const w = (cx ? fx : 1 - fx) * (cy ? fy : 1 - fy) * (cz ? fz : 1 - fz);
            const gi = (b + cx + G * cy + G * G * cz) * 3;
            gx += grad[gi] * w;
            gy += grad[gi + 1] * w;
            gz += grad[gi + 2] * w;
          }
          const gl = Math.hypot(gx, gy, gz) || 1;
          pos[nv * 3] = ox + (i + fx - OFF) * s;
          pos[nv * 3 + 1] = oy + (j + fy - OFF) * s;
          pos[nv * 3 + 2] = oz + (k + fz - OFF) * s;
          nrm[nv * 3] = gx / gl;
          nrm[nv * 3 + 1] = gy / gl;
          nrm[nv * 3 + 2] = gz / gl;
          cellVert[i + C * (j + C * k)] = nv++;
        }

    // 6. Quads for sign-changing edges owned by this chunk (+1 cell overlap)
    const idx = this.idx;
    let ni = 0;
    const lo = 1, hi = CHUNK + 2;
    const cv = (i: number, j: number, k: number) => cellVert[i + C * (j + C * k)];
    const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      // Split along the shorter diagonal for smoother results.
      const dac = dist2(pos, a, c), dbd = dist2(pos, b, d);
      if (flip) { const t = b; b = d; d = t; }
      if (dac <= dbd) {
        idx[ni++] = a; idx[ni++] = b; idx[ni++] = c;
        idx[ni++] = a; idx[ni++] = c; idx[ni++] = d;
      } else {
        idx[ni++] = a; idx[ni++] = b; idx[ni++] = d;
        idx[ni++] = b; idx[ni++] = c; idx[ni++] = d;
      }
    };
    for (let k = lo; k <= hi; k++)
      for (let j = lo; j <= hi; j++)
        for (let i = lo; i <= hi; i++) {
          const b = i + G * (j + G * k);
          const d0 = dens[b];
          const s0 = d0 < 0;
          // X edge: cells differ in (y, z)
          if (i < hi + 1 && (dens[b + 1] < 0) !== s0) {
            quad(cv(i, j - 1, k - 1), cv(i, j, k - 1), cv(i, j, k), cv(i, j - 1, k), !s0);
          }
          // Y edge: cells differ in (z, x)
          if ((dens[b + G] < 0) !== s0) {
            quad(cv(i - 1, j, k - 1), cv(i - 1, j, k), cv(i, j, k), cv(i, j, k - 1), !s0);
          }
          // Z edge: cells differ in (x, y)
          if ((dens[b + G * G] < 0) !== s0) {
            quad(cv(i - 1, j - 1, k), cv(i, j - 1, k), cv(i, j, k), cv(i - 1, j, k), !s0);
          }
        }

    if (ni === 0) return { key: job.key, version: job.version, empty: true, ms: performance.now() - t0 };

    // 7. Compact vertices that are referenced, bake attributes
    const remap = new Int32Array(nv).fill(-1);
    let nOut = 0;
    for (let n = 0; n < ni; n++) {
      const v = idx[n];
      if (remap[v] < 0) remap[v] = nOut++;
    }
    const positions = new Float32Array(nOut * 3);
    const normals = new Float32Array(nOut * 3);
    const colors = new Uint8Array(nOut * 4);
    const emit = new Uint8Array(nOut * 4);
    const indices = new Uint32Array(ni);
    for (let n = 0; n < ni; n++) indices[n] = remap[idx[n]];

    const so = this.shadeOut;
    for (let v = 0; v < nv; v++) {
      const o = remap[v];
      if (o < 0) continue;
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      const nx = nrm[v * 3], ny = nrm[v * 3 + 1], nz = nrm[v * 3 + 2];
      positions[o * 3] = x; positions[o * 3 + 1] = y; positions[o * 3 + 2] = z;
      normals[o * 3] = nx; normals[o * 3 + 1] = ny; normals[o * 3 + 2] = nz;

      const ci = clamp(Math.round((x - ox) / s) + OFF, 0, G - 1);
      const ck = clamp(Math.round((z - oz) / s) + OFF, 0, G - 1);
      const col = cols[ci + ck * G];
      T.shade(x, y, z, nx, ny, nz, col, so);

      // Built-up material from "add" edits
      for (let e = nEdits - 1; e >= 0; e--) {
        const b = e * EDIT_STRIDE;
        const dd = Math.hypot(x - edits[b], y - edits[b + 1], z - edits[b + 2]) - edits[b + 3];
        if (dd < 0.6) {
          if (edits[b + 4] === OP_ADD) {
            const bc = T.p.builtColor;
            const nn = 0.85 + 0.15 * Math.sin(x * 1.7 + y * 2.3 + z * 1.1);
            so[0] = bc[0] * nn; so[1] = bc[1] * nn; so[2] = bc[2] * nn;
            so[3] = so[4] = so[5] = 0;
          }
          break;
        }
      }

      // Ambient occlusion from the density grid along the normal
      const a1 = this.sampleGrid((x - ox) / s + OFF + nx * 1.5, (y - oy) / s + OFF + ny * 1.5, (z - oz) / s + OFF + nz * 1.5) / (1.5 * s);
      const a2 = this.sampleGrid((x - ox) / s + OFF + nx * 3.5, (y - oy) / s + OFF + ny * 3.5, (z - oz) / s + OFF + nz * 3.5) / (3.5 * s);
      const ao = 0.3 + 0.7 * clamp((a1 + a2) * 0.5, 0, 1);

      // Sky visibility: exact probes straight up the column
      let sky = 1;
      if (y < col.top) {
        const steps = SKY_STEPS;
        for (let q = 0; q < steps.length && sky > 0.01; q++) {
          const yy = y + steps[q] * Math.max(1, s * 0.5);
          if (yy > col.top) break;
          let dd = T.density(x, yy, z, col, s);
          for (let e = 0; e < nEdits; e++) {
            const b = e * EDIT_STRIDE;
            dd = applyEdit(dd, x, yy, z, edits[b], edits[b + 1], edits[b + 2], edits[b + 3], edits[b + 4]);
          }
          sky *= smoothstep(-3, 1.5, dd);
        }
        // Undersides of floating rock still receive light bounced from the ground below.
        if (y > col.h + 12) sky = Math.max(sky, 0.45);
      }

      colors[o * 4] = toByte(so[0]);
      colors[o * 4 + 1] = toByte(so[1]);
      colors[o * 4 + 2] = toByte(so[2]);
      colors[o * 4 + 3] = toByte(ao);
      emit[o * 4] = toByte(so[3] * 0.5);
      emit[o * 4 + 1] = toByte(so[4] * 0.5);
      emit[o * 4 + 2] = toByte(so[5] * 0.5);
      emit[o * 4 + 3] = toByte(sky);
    }

    const water = this.buildLiquids(job, s);
    const props = job.level <= 3 ? scatterProps(this, job, s) : undefined;

    let minH = Infinity;
    for (let k = OFF - 1; k <= OFF + CHUNK + 1; k++)
      for (let i = OFF - 1; i <= OFF + CHUNK + 1; i++) {
        const c = cols[i + k * G];
        minH = Math.min(minH, c.shR > 0 ? -Infinity : c.h - c.overhang * 1.3 - 12 * c.entrance);
      }
    for (let e = 0; e < nEdits; e++) minH = Math.min(minH, edits[e * EDIT_STRIDE + 1] - edits[e * EDIT_STRIDE + 3] - 2);
    return {
      key: job.key, version: job.version, empty: false,
      positions, normals, colors, emit, indices, water, props, minH,
      ms: performance.now() - t0,
    };
  }

  /** Trilinear sample of the density grid in array coordinates. */
  sampleGrid(fx: number, fy: number, fz: number): number {
    fx = clamp(fx, 0, G - 1.001);
    fy = clamp(fy, 0, G - 1.001);
    fz = clamp(fz, 0, G - 1.001);
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const d = this.dens;
    const b = i + G * (j + G * k);
    const c00 = d[b] + (d[b + 1] - d[b]) * tx;
    const c10 = d[b + G] + (d[b + 1 + G] - d[b + G]) * tx;
    const c01 = d[b + G * G] + (d[b + 1 + G * G] - d[b + G * G]) * tx;
    const c11 = d[b + G + G * G] + (d[b + 1 + G + G * G] - d[b + G + G * G]) * tx;
    const c0 = c00 + (c10 - c00) * ty;
    const c1 = c01 + (c11 - c01) * ty;
    return c0 + (c1 - c0) * tz;
  }

  /** Grid gradient (unnormalised) at array coordinates. */
  gridGradient(fx: number, fy: number, fz: number, out: Float32Array): void {
    const e = 0.5;
    out[0] = this.sampleGrid(fx + e, fy, fz) - this.sampleGrid(fx - e, fy, fz);
    out[1] = this.sampleGrid(fx, fy + e, fz) - this.sampleGrid(fx, fy - e, fz);
    out[2] = this.sampleGrid(fx, fy, fz + e) - this.sampleGrid(fx, fy, fz - e);
  }

  columnAtIndex(i: number, k: number): Column {
    return this.cols[clamp(i, 0, G - 1) + clamp(k, 0, G - 1) * G];
  }

  private buildLiquids(job: ChunkJob, s: number): ChunkResult['water'] {
    const out: NonNullable<ChunkResult['water']> = [];
    const P = this.terrain.p;
    const top = job.oy + CHUNK * s;
    const layers: { level: number; glow: number; test: (c: Column) => number }[] = [];
    if (P.seaLevel >= job.oy && P.seaLevel < top) layers.push({ level: P.seaLevel, glow: 0, test: (c) => P.seaLevel - c.h });
    const ul = P.under.liquidLevel;
    if (ul >= job.oy && ul < top) layers.push({ level: ul, glow: 1, test: (c) => (c.uOpen > 4 && c.uC > ul + 1 && c.h > ul + 30 ? ul - c.uF : -1) });
    for (const L of layers) {
      const vid = new Int32Array(G * G).fill(-1);
      const p: number[] = [];
      const dep: number[] = [];
      const ind: number[] = [];
      const getV = (i: number, k: number) => {
        const id = i + k * G;
        if (vid[id] >= 0) return vid[id];
        const c = this.cols[id];
        vid[id] = p.length / 3;
        p.push(job.ox + (i - OFF) * s, L.level, job.oz + (k - OFF) * s);
        dep.push(L.test(c));
        return vid[id];
      };
      // Only owned cells: overlapping transparent quads would double up along chunk borders.
      for (let k = OFF; k < OFF + CHUNK; k++)
        for (let i = OFF; i < OFF + CHUNK; i++) {
          const c0 = this.cols[i + k * G], c1 = this.cols[i + 1 + k * G], c2 = this.cols[i + (k + 1) * G], c3 = this.cols[i + 1 + (k + 1) * G];
          if (L.test(c0) <= 0 && L.test(c1) <= 0 && L.test(c2) <= 0 && L.test(c3) <= 0) continue;
          const a = getV(i, k), b = getV(i + 1, k), c = getV(i + 1, k + 1), d = getV(i, k + 1);
          ind.push(a, c, b, a, d, c);
        }
      if (ind.length) out.push({ positions: new Float32Array(p), depth: new Float32Array(dep), indices: new Uint32Array(ind), glow: L.glow });
    }
    return out.length ? out : undefined;
  }
}

const SKY_STEPS = [3, 7, 14, 26, 45, 80];

function toByte(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
}

function dist2(p: Float32Array, a: number, b: number): number {
  const dx = p[a * 3] - p[b * 3], dy = p[a * 3 + 1] - p[b * 3 + 1], dz = p[a * 3 + 2] - p[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}
