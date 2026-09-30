import { Noise } from '../core/noise';
import { hash01, hash4 } from '../core/rng';
import { clamp, lerp, smoothstep, RGB } from '../core/math';
import { BiomeDef, CivDef, WorldParams } from './WorldParams';
import { BEDROCK } from './constants';

// ---------------------------------------------------------------------------------------------
// Terrain: a signed density field over all of 3D space (negative = solid, positive = air).
// It is built from 2D "column" data (height, biome, underworld shape, nearby structures) plus
// 3D terms (overhangs, caves, floating islands, moonlets, spires, arches, shafts).
// The same code runs in the chunk workers and on the main thread for physics queries.
// ---------------------------------------------------------------------------------------------

export class Column {
  x = 0; z = 0;
  h = 0; baseH = 0; cont = 0; land = 0;
  b0 = 0; b1 = 0; w1 = 0;
  overhang = 0;
  top = 0;
  lev = 0;
  settle = 0; settleCiv = -1;
  uF = 0; uC = 0; uSettle = 0; uOpen = 0;
  entrance = 0;
  spX = 0; spZ = 0; spB = 0; spH = 0; spR = 0;
  isX = 0; isY = 0; isZ = 0; isR = 0; isT = 0;
  moX = 0; moY = 0; moZ = 0; moR = 0;
  riX = 0; riY = 0; riZ = 0; riR = 0; rir = 0; riC = 1; riS = 0;
  shX = 0; shZ = 0; shR = 0;
  piX = 0; piZ = 0; piR = 0;
}

export interface SiteInfo {
  cx: number;
  cz: number;
  x: number;
  y: number;
  z: number;
  r: number;
  civ: CivDef;
  seed: number;
  layer: 'surface' | 'under';
}

interface IslandCell { x: number; y: number; z: number; r: number; t: number }
interface MoonCell { x: number; y: number; z: number; r: number }
interface SpireCell { x: number; z: number; b: number; h: number; r: number }
interface RingCell { x: number; y: number; z: number; R: number; r: number; c: number; s: number }
interface ShaftCell { x: number; z: number; r: number }
interface PillarCell { x: number; z: number; r: number }
export interface WellCell { x: number; z: number; r: number; base: number; height: number }

const SPIRE_CELL = 64;
const ISLAND_CELL = 260;
const MOON_CELL = 720;
const RING_CELL = 1500;
const SHAFT_CELL = 950;
const PILLAR_CELL = 95;
const WELL_CELL = 340;

class CellCache<T> {
  private map = new Map<number, T | null>();
  get(cx: number, cz: number, make: () => T | null): T | null {
    const key = (cx & 0xffff) * 65536 + (cz & 0xffff);
    let v = this.map.get(key);
    if (v === undefined) {
      if (this.map.size > 4096) this.map.clear();
      v = make();
      this.map.set(key, v);
    }
    return v;
  }
}

export class Terrain {
  readonly p: WorldParams;
  private nA: Noise; // continents, hills
  private nB: Noise; // climate
  private nC: Noise; // caves
  private nD: Noise; // detail and structures
  private nU: Noise; // underworld
  private seedI: number;
  private tmp = new Column();

  private spires = new CellCache<SpireCell>();
  private islands = new CellCache<IslandCell>();
  private moons = new CellCache<MoonCell>();
  private rings = new CellCache<RingCell>();
  private shafts = new CellCache<ShaftCell>();
  private pillars = new CellCache<PillarCell>();
  private wells = new CellCache<WellCell>();
  private sites: CellCache<SiteInfo>[];

  constructor(p: WorldParams) {
    this.p = p;
    this.seedI = p.seed | 0;
    this.nA = new Noise(hash4(p.seed, 1));
    this.nB = new Noise(hash4(p.seed, 2));
    this.nC = new Noise(hash4(p.seed, 3));
    this.nD = new Noise(hash4(p.seed, 4));
    this.nU = new Noise(hash4(p.seed, 5));
    this.sites = p.civs.map(() => new CellCache<SiteInfo>());
  }

  // --- Climate & biomes ----------------------------------------------------------------------

  /** Picks the two nearest biomes in climate space and a blend weight for the second one. */
  private biomeAt(x: number, z: number, out: Column): void {
    const n = this.nB;
    const wx = x + 500 * n.n2(x / 1700, z / 1700);
    const wz = z + 500 * n.n2(x / 1700 + 50, z / 1700 - 50);
    const T = clamp(0.5 + 0.85 * n.fbm2(wx / 3000, wz / 3000, 3), 0, 1);
    const M = clamp(0.5 + 0.85 * n.fbm2(wx / 3000 + 91.7, wz / 3000 - 37.1, 3), 0, 1);
    const biomes = this.p.biomes;
    let d0 = 9, d1 = 9, i0 = 0, i1 = 0;
    for (let i = 0; i < biomes.length; i++) {
      const c = biomes[i].climate;
      const d = (c[0] - T) * (c[0] - T) + (c[1] - M) * (c[1] - M);
      if (d < d0) {
        d1 = d0; i1 = i0;
        d0 = d; i0 = i;
      } else if (d < d1) {
        d1 = d;
        i1 = i;
      }
    }
    out.b0 = i0;
    out.b1 = i1;
    out.w1 = 0.5 * (1 - smoothstep(0, 0.07, Math.sqrt(d1) - Math.sqrt(d0)));
  }

  levitation(x: number, z: number): number {
    const v = 0.5 + 0.75 * this.nB.fbm2(x / 2600 + 311, z / 2600 - 707, 2);
    const thr = 0.92 - 0.38 * this.p.levitation;
    return smoothstep(thr, thr + 0.1, v);
  }

  /** Regional multiplier on gravity strength (0.55x .. 1.8x), independent of levitation zones. */
  gravityFactor(x: number, z: number): number {
    return Math.pow(2, 0.85 * this.nB.fbm2(x / 3300 - 500, z / 3300 + 900, 2) * 1.4);
  }

  /** Surface height without settlements or structures. Fills biome info into `c`. */
  baseHeight(x: number, z: number, c: Column, s = 1): number {
    this.biomeAt(x, z, c);
    const B0 = this.p.biomes[c.b0];
    const B1 = this.p.biomes[c.b1];
    const w = c.w1;
    const A = this.nA;

    const cn = A.fbm2(x / 5200, z / 5200, 4) + 0.2;
    const land = smoothstep(-0.04, 0.2, cn);
    c.cont = cn;
    c.land = land;
    let h = cn < 0 ? cn * 170 : cn * 45;
    h += land * lerp(B0.baseOffset, B1.baseOffset, w);

    const hs = lerp(B0.hillScale, B1.hillScale, w);
    const hillAmp = lerp(B0.hillAmp, B1.hillAmp, w);
    h += A.fbm2(x / hs, z / hs, s < 8 ? 4 : 3) * hillAmp * (0.3 + 0.7 * land);

    const mw = lerp(B0.mountain, B1.mountain, w);
    const mm = smoothstep(0.0, 0.45, A.fbm2(x / 2900 + 71.3, z / 2900 - 33.1, 3)) * mw * land;
    if (mm > 0.001) h += Math.pow(A.ridged2(x / 1050, z / 1050, s < 4 ? 6 : 4), 1.6) * 540 * mm;

    const dunes = lerp(B0.dunes, B1.dunes, w);
    if (dunes > 0.01) {
      const u = x * 0.8 + z * 0.6 + 60 * A.n2(x / 400, z / 400);
      const v = -x * 0.6 + z * 0.8;
      const ridge = 1 - Math.abs(A.n2(u / 85, v / 260));
      h += (ridge * ridge * 20 + A.billow2(x / 45, z / 45, 2) * 3) * dunes * land;
    }

    if (s < 8) h += A.fbm2(x / 36, z / 36, 3) * 2.2 * land;

    const tA = B0.terrace, tB = B1.terrace;
    const tw = lerp(tA > 0 ? 1 : 0, tB > 0 ? 1 : 0, w);
    if (tw > 0.01) {
      const step = tA > 0 ? tA : tB;
      const t = h / step;
      const f = t - Math.floor(t);
      const th = step * (Math.floor(t) + smoothstep(0.55, 0.92, f) + 0.15 * f);
      h = lerp(h, th, tw * land);
    }

    const oh = lerp(B0.overhang, B1.overhang, w);
    c.overhang = oh > 0.5 ? oh * (0.45 + 0.55 * (0.5 + 0.5 * this.nD.n2(x / 480, z / 480))) * land : 0;
    return h;
  }

  // --- Structure cells -------------------------------------------------------------------------

  private spireCell(cx: number, cz: number): SpireCell | null {
    return this.spires.get(cx, cz, () => {
      const r = hash01(cx, cz, this.seedI, 101);
      const x = (cx + 0.2 + 0.6 * hash01(cx, cz, this.seedI, 102)) * SPIRE_CELL;
      const z = (cz + 0.2 + 0.6 * hash01(cx, cz, this.seedI, 103)) * SPIRE_CELL;
      const col = this.tmp;
      const b = this.baseHeight(x, z, col);
      const bi = this.p.biomes;
      const sp = lerp(bi[col.b0].spires, bi[col.b1].spires, col.w1);
      if (r > sp * 0.55 || col.land < 0.5 || b < this.p.seaLevel + 2) return null;
      const k = hash01(cx, cz, this.seedI, 104);
      return { x, z, b: b - 6, h: 28 + 95 * k * k, r: 5 + 6 * hash01(cx, cz, this.seedI, 105) };
    });
  }

  private islandCell(cx: number, cz: number): IslandCell | null {
    return this.islands.get(cx, cz, () => {
      const x = (cx + 0.32 + 0.36 * hash01(cx, cz, this.seedI, 201)) * ISLAND_CELL;
      const z = (cz + 0.32 + 0.36 * hash01(cx, cz, this.seedI, 202)) * ISLAND_CELL;
      const lev = this.levitation(x, z);
      if (hash01(cx, cz, this.seedI, 203) > lev * 0.13) return null;
      const b = Math.max(this.baseHeight(x, z, this.tmp), this.p.seaLevel);
      const k = hash01(cx, cz, this.seedI, 204);
      const r = 18 + 42 * k;
      return { x, z, y: b + 55 + 190 * hash01(cx, cz, this.seedI, 205), r, t: r * (0.7 + 0.8 * hash01(cx, cz, this.seedI, 206)) };
    });
  }

  private moonCell(cx: number, cz: number): MoonCell | null {
    return this.moons.get(cx, cz, () => {
      if (hash01(cx, cz, this.seedI, 301) > 0.5 * this.p.moonlets) return null;
      const x = (cx + 0.15 + 0.7 * hash01(cx, cz, this.seedI, 302)) * MOON_CELL;
      const z = (cz + 0.15 + 0.7 * hash01(cx, cz, this.seedI, 303)) * MOON_CELL;
      const b = Math.max(this.baseHeight(x, z, this.tmp), this.p.seaLevel);
      const r = 16 + 32 * hash01(cx, cz, this.seedI, 304);
      return { x, z, y: b + 170 + 260 * hash01(cx, cz, this.seedI, 305), r };
    });
  }

  private ringCell(cx: number, cz: number): RingCell | null {
    return this.rings.get(cx, cz, () => {
      if (hash01(cx, cz, this.seedI, 401) > 0.4) return null;
      const x = (cx + 0.15 + 0.7 * hash01(cx, cz, this.seedI, 402)) * RING_CELL;
      const z = (cz + 0.15 + 0.7 * hash01(cx, cz, this.seedI, 403)) * RING_CELL;
      const b = this.baseHeight(x, z, this.tmp);
      if (b < this.p.seaLevel - 20) return null;
      const R = 28 + 50 * hash01(cx, cz, this.seedI, 404);
      const a = hash01(cx, cz, this.seedI, 405) * Math.PI;
      return { x, z, y: b + R * 0.55, R, r: 4 + R * 0.1, c: Math.cos(a), s: Math.sin(a) };
    });
  }

  private shaftCell(cx: number, cz: number): ShaftCell | null {
    return this.shafts.get(cx, cz, () => {
      if (hash01(cx, cz, this.seedI, 501) > 0.4) return null;
      const x = (cx + 0.2 + 0.6 * hash01(cx, cz, this.seedI, 502)) * SHAFT_CELL;
      const z = (cz + 0.2 + 0.6 * hash01(cx, cz, this.seedI, 503)) * SHAFT_CELL;
      const b = this.baseHeight(x, z, this.tmp);
      if (b < this.p.seaLevel + 4) return null;
      return { x, z, r: 11 + 16 * hash01(cx, cz, this.seedI, 504) };
    });
  }

  private pillarCell(cx: number, cz: number): PillarCell | null {
    return this.pillars.get(cx, cz, () => {
      if (hash01(cx, cz, this.seedI, 601) > 0.45) return null;
      return {
        x: (cx + 0.25 + 0.5 * hash01(cx, cz, this.seedI, 602)) * PILLAR_CELL,
        z: (cz + 0.25 + 0.5 * hash01(cx, cz, this.seedI, 603)) * PILLAR_CELL,
        r: 6 + 14 * hash01(cx, cz, this.seedI, 604),
      };
    });
  }

  /** Lift wells: columns of reversed gravity inside levitation zones. */
  wellCell(cx: number, cz: number): WellCell | null {
    return this.wells.get(cx, cz, () => {
      const x = (cx + 0.25 + 0.5 * hash01(cx, cz, this.seedI, 701)) * WELL_CELL;
      const z = (cz + 0.25 + 0.5 * hash01(cx, cz, this.seedI, 702)) * WELL_CELL;
      const lev = this.levitation(x, z);
      if (hash01(cx, cz, this.seedI, 703) > lev * 0.8) return null;
      const b = Math.max(this.baseHeight(x, z, this.tmp), this.p.seaLevel);
      return { x, z, r: 7 + 5 * hash01(cx, cz, this.seedI, 704), base: b - 5, height: 170 + 120 * hash01(cx, cz, this.seedI, 705) };
    });
  }

  wellAt(x: number, z: number): WellCell | null {
    const w = this.wellCell(Math.floor(x / WELL_CELL), Math.floor(z / WELL_CELL));
    if (!w) return null;
    const dx = x - w.x, dz = z - w.z;
    return dx * dx + dz * dz < (w.r + 30) * (w.r + 30) ? w : null;
  }

  moonAt(x: number, z: number): MoonCell | null {
    return this.moonCell(Math.floor(x / MOON_CELL), Math.floor(z / MOON_CELL));
  }

  /** Every moonlet whose cell touches the 3x3 neighbourhood of (x, z). */
  moonsNear(x: number, z: number, out: MoonCell[]): MoonCell[] {
    out.length = 0;
    const cx = Math.floor(x / MOON_CELL), cz = Math.floor(z / MOON_CELL);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const m = this.moonCell(cx + i, cz + j);
        if (m) out.push(m);
      }
    return out;
  }

  // --- Settlements -----------------------------------------------------------------------------

  siteCell(civIndex: number, cx: number, cz: number): SiteInfo | null {
    const civ = this.p.civs[civIndex];
    return this.sites[civIndex].get(cx, cz, () => {
      const cs = civ.cellSize;
      if (hash01(cx, cz, this.seedI, 900 + civIndex) > civ.chance) return null;
      const seed = hash4(cx, cz, this.seedI, 950 + civIndex);
      const r = 55 + 55 * hash01(seed, 1);
      const m = (r * 1.5) / cs;
      const x = (cx + m + (1 - 2 * m) * hash01(seed, 2)) * cs;
      const z = (cz + m + (1 - 2 * m) * hash01(seed, 3)) * cs;
      const col = this.tmp;
      if (civ.layer === 'surface') {
        const y = this.baseHeight(x, z, col);
        if (y < this.p.seaLevel + 5 || col.land < 0.9) return null;
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2;
          const hk = this.baseHeight(x + Math.cos(a) * r, z + Math.sin(a) * r, col);
          if (Math.abs(hk - y) > r * 0.55 || hk < this.p.seaLevel + 1) return null;
        }
        return { cx, cz, x, y, z, r, civ, seed, layer: 'surface' };
      }
      const f = this.underFloorRaw(x, z);
      if (f < this.p.under.liquidLevel + 3) return null;
      return { cx, cz, x, y: f, z, r, civ, seed, layer: 'under' };
    });
  }

  /** The settlement (if any) of civ `civIndex` whose area contains (x, z). */
  siteAt(civIndex: number, x: number, z: number): SiteInfo | null {
    const cs = this.p.civs[civIndex].cellSize;
    return this.siteCell(civIndex, Math.floor(x / cs), Math.floor(z / cs));
  }

  // --- Underworld ------------------------------------------------------------------------------

  underFloorRaw(x: number, z: number): number {
    const u = this.p.under;
    return u.floorBase + 24 * this.nU.fbm2(x / 380, z / 380, 3) + 7 * this.nU.ridged2(x / 70, z / 70, 2);
  }

  private underCeilRaw(x: number, z: number, s: number): number {
    const u = this.p.under;
    const U = this.nU;
    let c = u.ceilBase + 38 * U.fbm2(x / 520 + 17, z / 520 - 9, 3);
    const st = U.n2(x / 38, z / 38);
    if (st > 0) c -= st * st * st * 70;
    if (s < 4) {
      const st2 = U.n2(x / 11 + 5, z / 11);
      if (st2 > 0.3) c -= (st2 - 0.3) * (st2 - 0.3) * 30;
    }
    const pinch = smoothstep(0.3, 0.62, U.fbm2(x / 1150 - 40, z / 1150 + 80, 2));
    return c - pinch * 220;
  }

  // --- Column --------------------------------------------------------------------------------

  column(x: number, z: number, c: Column, s = 1): Column {
    c.x = x;
    c.z = z;
    let h = this.baseHeight(x, z, c, s);
    c.baseH = h;
    c.lev = this.levitation(x, z);

    // Settlements flatten the ground around them.
    c.settle = 0;
    c.settleCiv = -1;
    c.uSettle = 0;
    const civs = this.p.civs;
    for (let i = 0; i < civs.length; i++) {
      const site = this.siteAt(i, x, z);
      if (!site) continue;
      const d = Math.hypot(x - site.x, z - site.z);
      if (d > site.r * 1.35) continue;
      const w = smoothstep(site.r * 1.35, site.r * 0.8, d);
      if (site.layer === 'surface') {
        h = lerp(h, site.y, w);
        c.overhang *= 1 - w;
        c.settle = w;
      } else {
        c.uSettle = w;
      }
      c.settleCiv = i;
    }
    c.h = h;

    let top = h + c.overhang * 1.25 + 2;

    // Spires
    c.spR = 0;
    if (c.settle < 0.01) {
      const sp = this.spireCell(Math.floor(x / SPIRE_CELL), Math.floor(z / SPIRE_CELL));
      if (sp) {
        const d = Math.hypot(x - sp.x, z - sp.z);
        if (d < sp.r + 6) {
          c.spX = sp.x; c.spZ = sp.z; c.spB = sp.b; c.spH = sp.h; c.spR = sp.r;
          top = Math.max(top, sp.b + sp.h + 3);
        }
      }
    }

    // Floating islands
    c.isR = 0;
    if (c.lev > 0.01) {
      const is = this.islandCell(Math.floor(x / ISLAND_CELL), Math.floor(z / ISLAND_CELL));
      if (is) {
        const d = Math.hypot(x - is.x, z - is.z);
        if (d < is.r * 1.3 + 6) {
          c.isX = is.x; c.isY = is.y; c.isZ = is.z; c.isR = is.r; c.isT = is.t;
          top = Math.max(top, is.y + is.r * 0.25 + 8);
        }
      }
    }

    // Moonlets
    c.moR = 0;
    const mo = this.moonAt(x, z);
    if (mo) {
      const d = Math.hypot(x - mo.x, z - mo.z);
      if (d < mo.r * 1.35 + 4) {
        c.moX = mo.x; c.moY = mo.y; c.moZ = mo.z; c.moR = mo.r;
        top = Math.max(top, mo.y + mo.r * 1.35 + 4);
      }
    }

    // Standing rings
    c.riR = 0;
    if (c.settle < 0.01) {
      const ri = this.ringCell(Math.floor(x / RING_CELL), Math.floor(z / RING_CELL));
      if (ri) {
        const d = Math.hypot(x - ri.x, z - ri.z);
        if (d < ri.R + ri.r + 4) {
          c.riX = ri.x; c.riY = ri.y; c.riZ = ri.z; c.riR = ri.R; c.rir = ri.r; c.riC = ri.c; c.riS = ri.s;
          top = Math.max(top, ri.y + ri.R + ri.r + 4);
        }
      }
    }
    c.top = top;

    // Underworld
    let uF = this.underFloorRaw(x, z);
    let uC = this.underCeilRaw(x, z, s);
    if (c.uSettle > 0) {
      const site = this.siteAt(c.settleCiv, x, z)!;
      uF = lerp(uF, site.y, c.uSettle);
      uC = lerp(uC, Math.max(uC, site.y + 90), c.uSettle);
    }
    uC = Math.min(uC, h - 45);
    c.uF = uF;
    c.uC = uC;
    c.uOpen = uC - uF;

    const pi = this.pillarCell(Math.floor(x / PILLAR_CELL), Math.floor(z / PILLAR_CELL));
    c.piR = 0;
    if (pi && c.uSettle < 0.05) {
      const d = Math.hypot(x - pi.x, z - pi.z);
      if (d < pi.r * 1.9 + 6) {
        c.piX = pi.x; c.piZ = pi.z; c.piR = pi.r;
      }
    }

    c.shR = 0;
    const sh = this.shaftCell(Math.floor(x / SHAFT_CELL), Math.floor(z / SHAFT_CELL));
    if (sh && c.settle < 0.01) {
      const d = Math.hypot(x - sh.x, z - sh.z);
      if (d < sh.r * 1.6 + 26) {
        c.shX = sh.x; c.shZ = sh.z; c.shR = sh.r;
      }
    }

    c.entrance = smoothstep(0.15, 0.55, this.nC.n2(x / 420, z / 420));
    return c;
  }

  // --- Density ---------------------------------------------------------------------------------

  /** Density at (x, y, z) given the column at (x, z). `s` is the voxel size (for LOD detail). */
  density(x: number, y: number, z: number, c: Column, s = 1): number {
    let d = y - c.h;
    if (y > c.top) return d;

    const a = c.overhang;
    if (a > 0.5) {
      const ad = Math.abs(d);
      if (ad < a * 1.25) {
        const oct = s <= 2 ? 3 : s <= 8 ? 2 : 1;
        const n = this.nD.fbm3(x / 55, y / 36, z / 55, oct);
        d += n * a * (1 - smoothstep(a * 0.6, a * 1.25, ad));
      }
    }

    if (c.spR > 0) d = Math.min(d, this.spireSDF(x, y, z, c, s));
    if (c.isR > 0) d = Math.min(d, this.islandSDF(x, y, z, c, s));
    if (c.moR > 0) d = Math.min(d, this.moonSDF(x, y, z, c, s));
    if (c.riR > 0) d = Math.min(d, this.ringSDF(x, y, z, c, s));

    // Caves: winding tunnels (intersection of two noise isosurfaces) and large chambers.
    const depth0 = c.h - y;
    // Coarse distant chunks skip deep caves: they are invisible from afar and cost triangles.
    if (d < 4 + 2 * s && (s < 8 || depth0 < 3 * s)) {
      const C = this.nC;
      const depth = depth0;
      const n1 = C.n3(x / 95, y / 62, z / 95);
      const n2 = C.n3(x / 95 + 71.3, y / 62 - 13.7, z / 95 + 29.1);
      const w = 0.085 + 0.045 * C.n2(x / 310, z / 310);
      let cave = (Math.sqrt(n1 * n1 + n2 * n2) - w) * 48;
      if (depth > 25 && y > c.uC + 25) {
        const oct = s <= 4 ? 2 : 1;
        const ch = (0.36 - C.fbm3(x / 150, y / 85, z / 150, oct)) * 70;
        cave = Math.min(cave, ch + Math.max(0, 55 - depth) * 1.2);
      }
      // Seal most of the surface so openings stay special; never break the sea floor.
      const seal = depth < 10 ? (10 - depth) * 2.2 * (1 - c.entrance) : 0;
      const sea = c.h < this.p.seaLevel + 2 ? Math.max(0, 16 - depth) * 3 : 0;
      cave += seal + sea + c.settle * 40;
      if (depth < -2) cave += -depth * 3;
      d = Math.max(d, -cave);
    }

    // The underworld: a vast cavern layer with pillars and glowing lakes.
    const band = 6 + 2 * s;
    if (y < c.uC + band && y > c.uF - band && c.uOpen > -40) {
      let cav = Math.max(c.uF - y, y - c.uC);
      if (c.piR > 0) {
        const mid = (c.uF + c.uC) * 0.5;
        const half = Math.max(20, (c.uC - c.uF) * 0.5);
        const t = (y - mid) / half;
        const r = c.piR * (0.55 + 0.6 * t * t) + 2 * this.nU.n3(x / 9, y / 14, z / 9);
        const pil = Math.hypot(x - c.piX, z - c.piZ) - r;
        cav = Math.max(cav, -pil);
      }
      d = Math.max(d, -cav);
    }

    // Sinkhole shafts connecting the surface with the underworld.
    if (c.shR > 0 && y > c.uF - band && y < c.h + 20) {
      const U = this.nU;
      const ox = 22 * U.n2(y / 110, c.shX / 97);
      const oz = 22 * U.n2(y / 110 + 40, c.shZ / 97);
      const r = c.shR * (1 + 0.35 * U.n2(y / 40, c.shX)) + (y > c.h - 25 ? (y - (c.h - 25)) * 0.6 : 0);
      const sh = Math.hypot(x - c.shX - ox, z - c.shZ - oz) - r + 1.5 * U.n3(x / 7, y / 7, z / 7);
      d = Math.max(d, -sh);
    }

    return d;
  }

  private spireSDF(x: number, y: number, z: number, c: Column, s: number): number {
    const qy = y - c.spB;
    const t = clamp(qy / c.spH, 0, 1);
    const band = 0.88 + 0.12 * Math.sin(qy * 0.33 + c.spX);
    let r = c.spR * (1 - 0.68 * t) * band;
    if (s <= 4) r += 1.8 * this.nD.n3(x / 11, y / 8, z / 11);
    const side = Math.hypot(x - c.spX, z - c.spZ) - r;
    // Hoodoo cap: a wider boulder on top of some spires.
    const capR = c.spR * 0.75;
    const cap = Math.hypot(x - c.spX, (y - c.spB - c.spH) * 1.4, z - c.spZ) - capR;
    return Math.min(Math.max(side, qy - c.spH), Math.abs(Math.floor(c.spX * 7 + c.spZ * 3)) % 3 === 0 ? cap : 1e9);
  }

  private islandSDF(x: number, y: number, z: number, c: Column, s: number): number {
    const qx = x - c.isX, qy = y - c.isY, qz = z - c.isZ;
    const r = Math.hypot(qx, qz);
    const R = c.isR;
    const dome = (1 - Math.min(1, (r / R) * (r / R))) * R * 0.12;
    const dTop = qy - dome - 1.5 * this.nD.n2(x / 17, z / 17);
    const f = clamp(-qy / c.isT, 0, 1);
    const radiusAt = R * Math.pow(1 - f, 0.65) + 5 * this.nD.n3(x / 21, y / 13, z / 21);
    const dSide = r - radiusAt;
    let d = Math.max(dTop, dSide, -qy - c.isT);
    if (s <= 4) d += 1.6 * this.nD.n3(x / 7, y / 7, z / 7);
    return d;
  }

  private moonSDF(x: number, y: number, z: number, c: Column, s: number): number {
    const qx = x - c.moX, qy = y - c.moY, qz = z - c.moZ;
    const R = c.moR;
    const l = Math.hypot(qx, qy, qz);
    let d = l - R;
    if (d < R * 0.5) {
      const inv = 1 / (R * 0.45);
      d += R * 0.16 * this.nD.fbm3(qx * inv, qy * inv, qz * inv, s <= 2 ? 3 : 2);
      // Craters: spherical bites along the surface.
      const k = 1 / (R * 0.35);
      const cr = this.nD.n3(qx * k + 50, qy * k, qz * k);
      if (cr > 0.45) d += (cr - 0.45) * R * 0.25;
    }
    return d;
  }

  private ringSDF(x: number, y: number, z: number, c: Column, s: number): number {
    const qx = x - c.riX, qy = y - c.riY, qz = z - c.riZ;
    const lx = qx * c.riC + qz * c.riS;
    const lz = -qx * c.riS + qz * c.riC;
    let d = Math.hypot(Math.hypot(lx, qy) - c.riR, lz) - c.rir;
    if (s <= 4) d += 1.2 * this.nD.n3(x / 6, y / 6, z / 6);
    return d;
  }

  /** Low-frequency noise used to clump vegetation into groves and meadows. */
  clusterNoise(x: number, z: number, id: number): number {
    return this.nD.n2(x / 37 + id * 13.1, z / 37 - id * 7.3);
  }

  // --- Convenience for single-point queries (main thread physics) ----------------------------

  private qCol = new Column();
  private qColKeyX = NaN;
  private qColKeyZ = NaN;

  /** Density at a point, reusing the column when x and z repeat (common in gradient probes). */
  densityAt(x: number, y: number, z: number): number {
    if (x !== this.qColKeyX || z !== this.qColKeyZ) {
      this.column(x, z, this.qCol);
      this.qColKeyX = x;
      this.qColKeyZ = z;
    }
    return this.density(x, y, z, this.qCol);
  }

  columnAt(x: number, z: number): Column {
    if (x !== this.qColKeyX || z !== this.qColKeyZ) {
      this.column(x, z, this.qCol);
      this.qColKeyX = x;
      this.qColKeyZ = z;
    }
    return this.qCol;
  }

  // --- Shading ---------------------------------------------------------------------------------

  /**
   * Albedo and emission for a surface point. Writes rgb albedo into out[0..2] and rgb emission
   * into out[3..5].
   */
  shade(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: Column, out: Float32Array): void {
    const P = this.p;
    const D = this.nD;
    out[3] = out[4] = out[5] = 0;
    const depth = c.h - y;

    // Moonlets
    if (c.moR > 0) {
      const qx = x - c.moX, qy = y - c.moY, qz = z - c.moZ;
      const l = Math.hypot(qx, qy, qz);
      if (l < c.moR * 1.5) {
        const up = (qx * nx + qy * ny + qz * nz) / (l || 1);
        const t = smoothstep(0.55, 0.85, up + 0.2 * D.n3(x / 6, y / 6, z / 6));
        mix3(out, P.moonRock, P.moonTop, t);
        const g = D.n3(x / 3, y / 3, z / 3);
        if (g > 0.6) {
          out[3] = P.crystal[0] * (g - 0.6) * 2;
          out[4] = P.crystal[1] * (g - 0.6) * 2;
          out[5] = P.crystal[2] * (g - 0.6) * 2;
        }
        return;
      }
    }

    // Underworld
    const inUnder = y < c.uC + 30 && y > c.uF - 40 && c.uOpen > 0 && depth > 30;
    if (inUnder) {
      const U = P.under;
      if (ny > 0.45) {
        const n = D.n2(x / 9, z / 9) * 0.5 + 0.5;
        const m = D.n2(x / 3.1, z / 3.1);
        out[0] = lerp(U.rock[0], U.moss[0] * 0.35, n);
        out[1] = lerp(U.rock[1], U.moss[1] * 0.35, n);
        out[2] = lerp(U.rock[2], U.moss[2] * 0.35, n);
        const e = smoothstep(0.1, 0.7, n) * (0.35 + 0.65 * smoothstep(0.2, 0.6, m)) * smoothstep(0.45, 0.8, ny);
        const t2 = smoothstep(0.3, 0.8, D.n2(x / 40, z / 40));
        out[3] = lerp(U.moss[0], U.moss2[0], t2) * e;
        out[4] = lerp(U.moss[1], U.moss2[1], t2) * e;
        out[5] = lerp(U.moss[2], U.moss2[2], t2) * e;
        if (c.uSettle > 0.3) mix3(out, [out[0], out[1], out[2]], P.civs[1].trim, c.uSettle * 0.7);
      } else {
        const st = this.stratum(x, y, z, P.biomes[c.b0]);
        out[0] = lerp(U.rock[0], st[0] * 0.4, 0.4);
        out[1] = lerp(U.rock[1], st[1] * 0.4, 0.4);
        out[2] = lerp(U.rock[2], st[2] * 0.4, 0.4);
        const v = Math.abs(D.n3(x / 16, y / 30, z / 16));
        if (v < 0.035) {
          const k = (1 - v / 0.035) * 1.2;
          out[3] = U.crystal[0] * k; out[4] = U.crystal[1] * k; out[5] = U.crystal[2] * k;
        }
        if (ny < -0.4) {
          const g = D.n3(x / 1.7, y / 1.7, z / 1.7);
          if (g > 0.55) {
            const k = (g - 0.55) * 4;
            out[3] += U.moss2[0] * k; out[4] += U.moss2[1] * k; out[5] += U.moss2[2] * k;
          }
        }
      }
      return;
    }

    // Floating islands use surface shading relative to their own top.
    let localDepth = depth;
    if (c.isR > 0 && y > c.h + 20) localDepth = c.isY + 2 - y;
    if (c.spR > 0 && y > c.h + 4) localDepth = 20;
    if (c.riR > 0 && y > c.h + 3) localDepth = 20;

    const B0 = P.biomes[c.b0];
    const B1 = P.biomes[c.b1];

    // Caves
    if (localDepth > 7) {
      const st = this.stratum(x, y, z, B0);
      const cr = P.caveRock;
      const k = smoothstep(7, 40, localDepth);
      out[0] = lerp(st[0], cr[0], k * 0.6);
      out[1] = lerp(st[1], cr[1], k * 0.6);
      out[2] = lerp(st[2], cr[2], k * 0.6);
      if (localDepth > 12) {
        const v = Math.abs(D.n3(x / 13, y / 13, z / 13));
        if (v < 0.04) {
          const e = (1 - v / 0.04) * smoothstep(12, 30, localDepth);
          out[0] = lerp(out[0], P.crystal[0], e * 0.6);
          out[1] = lerp(out[1], P.crystal[1], e * 0.6);
          out[2] = lerp(out[2], P.crystal[2], e * 0.6);
          out[3] = P.crystal[0] * e * 0.9; out[4] = P.crystal[1] * e * 0.9; out[5] = P.crystal[2] * e * 0.9;
        }
        if (ny > 0.6) {
          const m = smoothstep(0.2, 0.7, D.n2(x / 7, z / 7));
          out[0] = lerp(out[0], out[0] * 0.6 + 0.04, m);
          out[1] = lerp(out[1], out[1] * 0.6 + 0.04, m);
          out[2] = lerp(out[2], out[2] * 0.6 + 0.04, m);
        }
      }
      return;
    }

    const w = c.w1;
    this.surfaceColor(x, y, z, nx, ny, nz, localDepth, B0, c, out);
    if (w > 0.001) {
      const o2 = SC_TMP;
      this.surfaceColor(x, y, z, nx, ny, nz, localDepth, B1, c, o2);
      for (let i = 0; i < 6; i++) out[i] = lerp(out[i], o2[i], w);
    }

    if (c.settle > 0.2 && ny > 0.6) {
      const civ = P.civs[0];
      const path = smoothstep(0.2, 0.9, c.settle) * (0.55 + 0.45 * D.n2(x / 4, z / 4));
      out[0] = lerp(out[0], civ.trim[0] * 0.8 + 0.1, path * 0.6);
      out[1] = lerp(out[1], civ.trim[1] * 0.8 + 0.1, path * 0.6);
      out[2] = lerp(out[2], civ.trim[2] * 0.8 + 0.1, path * 0.6);
    }
  }

  private surfaceColor(x: number, y: number, z: number, nx: number, ny: number, nz: number, localDepth: number, B: BiomeDef, c: Column, out: Float32Array): void {
    const D = this.nD;
    const P = this.p;
    const st = this.stratum(x, y, z, B);
    const rn = D.n2(x / 5.3, z / 5.3);
    let r = lerp(B.rock[0], st[0], 0.65), g = lerp(B.rock[1], st[1], 0.65), b = lerp(B.rock[2], st[2], 0.65);

    const flat = smoothstep(0.62, 0.86, ny + 0.08 * rn) * (localDepth < 2.5 ? 1 : 0);
    const tn = 0.5 + 0.5 * D.n2(x / 14, z / 14);
    let tr = lerp(B.top[0], B.top2[0], tn), tg = lerp(B.top[1], B.top2[1], tn), tb = lerp(B.top[2], B.top2[2], tn);

    // Soil band between grass and rock
    const soilT = smoothstep(0.45, 0.65, ny) * (1 - flat);
    r = lerp(r, B.soil[0], soilT * 0.7); g = lerp(g, B.soil[1], soilT * 0.7); b = lerp(b, B.soil[2], soilT * 0.7);

    // Beach and sea floor
    const sea = P.seaLevel;
    if (y < sea + 2.5 + rn * 1.2 && c.cont < 0.3) {
      tr = B.sand[0]; tg = B.sand[1]; tb = B.sand[2];
      if (y < sea) {
        const k = smoothstep(0, 30, sea - y);
        tr = lerp(tr, P.liquid[0] * 0.5, k); tg = lerp(tg, P.liquid[1] * 0.5, k); tb = lerp(tb, P.liquid[2] * 0.5, k);
      }
    }
    // Frost at altitude
    const fl = B.frostLine + 25 * D.n2(x / 90, z / 90);
    if (y > fl) {
      const k = smoothstep(fl, fl + 30, y) * smoothstep(0.35, 0.7, ny);
      tr = lerp(tr, B.frost[0], k); tg = lerp(tg, B.frost[1], k); tb = lerp(tb, B.frost[2], k);
      const fr = k * 0.6 * smoothstep(0.2, 0.5, ny);
      r = lerp(r, B.frost[0], fr); g = lerp(g, B.frost[1], fr); b = lerp(b, B.frost[2], fr);
    }
    out[0] = lerp(r, tr, flat);
    out[1] = lerp(g, tg, flat);
    out[2] = lerp(b, tb, flat);
    out[3] = out[4] = out[5] = 0;

    if (B.cracks) {
      const cr = 1 - Math.abs(D.n2(x / 21, z / 21) + 0.3 * D.n2(x / 5, z / 5));
      const mask = smoothstep(0.1, 0.5, D.n2(x / 160, z / 160));
      if (cr > 0.955 && mask > 0) {
        const e = (cr - 0.955) * 22 * (0.6 + 0.4 * ny) * mask;
        out[3] = B.cracks[0] * e * 1.6; out[4] = B.cracks[1] * e * 1.6; out[5] = B.cracks[2] * e * 1.6;
        out[0] *= 0.6; out[1] *= 0.6; out[2] *= 0.6;
      }
    }
    void nx; void nz;
  }

  /** Warped horizontal rock bands, the planet's geological record. */
  stratum(x: number, y: number, z: number, B: BiomeDef): RGB {
    const warp = 7 * this.nD.n2(x / 140, z / 140) + 2 * this.nD.n3(x / 30, y / 30, z / 30);
    const band = Math.floor((y + warp) / 3.1);
    const k = hash4(band, this.seedI, 77) % B.strata.length;
    const s = B.strata[k];
    const v = 0.88 + 0.24 * hash01(band, this.seedI, 78);
    STRATUM[0] = s[0] * v;
    STRATUM[1] = s[1] * v;
    STRATUM[2] = s[2] * v;
    return STRATUM;
  }

  /** Finalises a density value after edits (bedrock can't be removed). */
  static finalize(d: number, y: number): number {
    return Math.min(d, y - BEDROCK);
  }
}

const STRATUM: RGB = [0, 0, 0];
const SC_TMP = new Float32Array(6);

function mix3(out: Float32Array, a: RGB, b: RGB, t: number): void {
  out[0] = lerp(a[0], b[0], t);
  out[1] = lerp(a[1], b[1], t);
  out[2] = lerp(a[2], b[2], t);
}
