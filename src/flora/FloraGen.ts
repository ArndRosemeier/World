import * as THREE from 'three';
import { GeoBuilder, v3 } from '../render/GeoBuilder';
import { FloraDef } from '../world/WorldParams';
import { RNG } from '../core/rng';
import { Noise } from '../core/noise';
import { RGB, mixRGB, scaleRGB, hsl } from '../core/math';

// ---------------------------------------------------------------------------------------------
// Procedural plant, fungus, crystal and rock geometry. Every species gets several variants,
// all built along +Y with the base at the origin; instancing orients and scales them.
// ---------------------------------------------------------------------------------------------

type V3 = THREE.Vector3;

export function buildFloraVariant(def: FloraDef, variant: number): THREE.BufferGeometry {
  const rng = new RNG(def.seed + variant * 7919);
  const b = new GeoBuilder();
  const gen = GENERATORS[def.kind];
  gen(b, def, rng);
  return b.build(def.wind);
}

const GENERATORS: Record<FloraDef['kind'], (b: GeoBuilder, d: FloraDef, r: RNG) => void> = {
  tree: genTree,
  shrub: genShrub,
  fungus: (b, d, r) => genFungus(b, d, r, false),
  giantfungus: (b, d, r) => genFungus(b, d, r, true),
  glowcap: genGlowcap,
  crystal: genCrystal,
  grass: genGrass,
  bulb: genBulb,
  spiral: genSpiral,
  fan: genFan,
  rock: (b, d, r) => genRock(b, d, r, 1),
  pebble: genPebbles,
  stalactite: genStalactite,
  vine: genVine,
  kelp: genKelp,
  bonetree: genBoneTree,
  lantern: genLantern,
};

function jitter(c: RGB, r: RNG, k = 0.08): RGB {
  return [c[0] * (1 + r.range(-k, k)), c[1] * (1 + r.range(-k, k)), c[2] * (1 + r.range(-k, k))];
}

/** Random unit vector within `spread` radians of `axis`. */
function coneDir(axis: V3, spread: number, r: RNG): V3 {
  const a = r.next() * Math.PI * 2;
  const t = r.next() * spread;
  const perp = Math.abs(axis.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(axis, perp).normalize();
  const w = new THREE.Vector3().crossVectors(axis, u);
  return axis.clone().multiplyScalar(Math.cos(t)).addScaledVector(u, Math.sin(t) * Math.cos(a)).addScaledVector(w, Math.sin(t) * Math.sin(a)).normalize();
}

function bentPath(start: V3, dir: V3, length: number, segs: number, bend: V3, wobble: number, r: RNG): V3[] {
  const pts: V3[] = [start.clone()];
  const d = dir.clone();
  const p = start.clone();
  for (let i = 1; i <= segs; i++) {
    d.addScaledVector(bend, 1 / segs).add(v3(r.range(-wobble, wobble), r.range(-wobble, wobble) * 0.5, r.range(-wobble, wobble))).normalize();
    p.addScaledVector(d, length / segs);
    pts.push(p.clone());
  }
  return pts;
}

// --- Trees -----------------------------------------------------------------------------------

function genTree(b: GeoBuilder, d: FloraDef, r: RNG): void {
  const P = d.p;
  const H = P.height * r.range(0.8, 1.2);
  const trunkR = H * 0.035 * (0.6 + P.trunk);
  const bark = jitter(d.colors.a, r);
  const barkDark = scaleRGB(bark, 0.55);
  const leaf = d.colors.b;
  const accent = d.colors.c;
  const glow = d.glow;
  const canopy = P.canopy;

  // Roots flaring into the ground
  const nRoots = r.int(3, 6);
  for (let i = 0; i < nRoots; i++) {
    const a = (i / nRoots) * Math.PI * 2 + r.range(-0.3, 0.3);
    const dir = v3(Math.cos(a), -0.35, Math.sin(a)).normalize();
    b.tube(bentPath(v3(0, trunkR * 1.5, 0), dir, trunkR * r.range(3, 5), 4, v3(0, -0.5, 0), 0.05, r), (t) => trunkR * 0.7 * (1 - t * 0.85), 5, () => barkDark);
  }

  const branch = (start: V3, dir: V3, len: number, rad: number, depth: number) => {
    const segs = Math.max(3, Math.round(len / (H * 0.12)));
    const bend = v3(0, -P.droop * 0.4 * (P.depth - depth + 1) / P.depth, 0).addScaledVector(dir.clone().cross(v3(0, 1, 0)), P.twist * 0.4);
    const path = bentPath(start, dir, len, segs, bend, 0.08, r);
    b.tube(path, (t) => rad * (1 - t * 0.72), depth === P.depth ? 7 : 5, (t) => mixRGB(barkDark, bark, 0.4 + t * 0.6), (t) => (glow > 0 && depth <= 1 ? t * t * glow * 0.3 : 0), depth === 0);
    const end = path[path.length - 1];
    const endDir = end.clone().sub(path[path.length - 2]).normalize();
    if (depth <= 0) {
      foliage(end, endDir, len);
      return;
    }
    const n = P.branches + r.int(-1, 1);
    for (let i = 0; i < n; i++) {
      const t = r.range(0.45, 1);
      const idx = Math.min(path.length - 1, Math.round(t * (path.length - 1)));
      const at = path[idx];
      const nd = coneDir(endDir, r.range(0.5, 1.1), r);
      nd.y = Math.max(nd.y, -0.2);
      branch(at, nd.normalize(), len * r.range(0.55, 0.75), rad * (1 - t * 0.6) * 0.7, depth - 1);
    }
    if (r.chance(0.5)) foliage(end, endDir, len);
  };

  const foliage = (at: V3, dir: V3, len: number) => {
    const size = H * 0.09 * r.range(0.8, 1.4);
    switch (canopy) {
      case 0: {
        // Puffy leaf clusters
        const k = r.int(1, 3);
        for (let i = 0; i < k; i++) {
          const c = at.clone().add(v3(r.range(-1, 1), r.range(-0.3, 0.8), r.range(-1, 1)).multiplyScalar(size * 0.7));
          const s = size * r.range(0.8, 1.3);
          const seed = r.next() * 100;
          b.blob(c, v3(s, s * r.range(0.55, 0.9), s), 1,
            (p, n) => mixRGB(scaleRGB(leaf, 0.65), leaf, 0.5 + 0.5 * n.y) as RGB,
            glow * 0.15,
            (dd) => 0.18 * Math.sin(dd.x * 5 + seed) * Math.sin(dd.z * 4 + seed));
        }
        break;
      }
      case 1: {
        // Hanging glowing tendrils
        const k = r.int(4, 8);
        b.windOverride = 1;
        for (let i = 0; i < k; i++) {
          const s = at.clone().add(v3(r.range(-0.4, 0.4), 0, r.range(-0.4, 0.4)));
          const L = len * r.range(0.4, 1.0);
          b.tube(bentPath(s, v3(r.range(-0.2, 0.2), -1, r.range(-0.2, 0.2)).normalize(), L, 5, v3(0, 0, 0), 0.1, r), (t) => 0.05 * (1 - t * 0.7) * H * 0.08, 3, (t) => mixRGB(leaf, accent, t), (t) => (glow > 0 ? t * glow : 0), true);
        }
        b.windOverride = NaN;
        b.blob(at, v3(size * 0.4, size * 0.3, size * 0.4), 1, () => leaf, 0);
        break;
      }
      case 2: {
        // Umbrella disc
        const R = size * 1.6;
        const m = new THREE.Matrix4().makeTranslation(at.x, at.y, at.z);
        b.with(m, () => b.lathe([[0.05, -R * 0.12], [R * 0.6, -R * 0.08], [R, -R * 0.15], [R * 0.95, -R * 0.02], [R * 0.5, R * 0.12], [0.02, R * 0.18]], 12,
          (v) => mixRGB(scaleRGB(leaf, 0.6), leaf, v) as RGB, (v) => (v < 0.3 ? glow * 0.6 : 0), 0.08, r.next() * 10));
        break;
      }
      default: {
        // Bulbs and pods
        const k = r.int(2, 5);
        for (let i = 0; i < k; i++) {
          const c = at.clone().add(v3(r.range(-1, 1), r.range(-1.2, 0.2), r.range(-1, 1)).multiplyScalar(size * 0.6));
          const s = size * r.range(0.25, 0.5);
          b.blob(c, v3(s, s * 1.3, s), 1, () => accent, glow > 0 ? glow : 0.2);
        }
      }
    }
  };

  const trunkDir = v3(r.range(-0.12, 0.12), 1, r.range(-0.12, 0.12)).normalize();
  branch(v3(0, -0.3, 0), trunkDir, H * 0.55, trunkR, P.depth);
}

function genBoneTree(b: GeoBuilder, d: FloraDef, r: RNG): void {
  const P = d.p;
  const H = P.height * r.range(0.8, 1.2);
  const c0 = d.colors.a, c1 = d.colors.b;
  const spine = bentPath(v3(0, -0.5, 0), v3(r.range(-0.1, 0.1), 1, r.range(-0.1, 0.1)).normalize(), H, 10, v3(r.range(-0.3, 0.3), 0, r.range(-0.3, 0.3)), 0.02, r);
  b.tube(spine, (t) => H * 0.035 * (1 - t * 0.6) * (1 + 0.25 * Math.sin(t * 40)), 7, (t) => mixRGB(c0, c1, t));
  const ribs = P.ribs;
  for (let i = 0; i < ribs; i++) {
    const t = 0.25 + (i / ribs) * 0.7;
    const at = spine[Math.round(t * (spine.length - 1))];
    for (const side of [-1, 1]) {
      const a = (i * 0.9 + (side > 0 ? 0 : Math.PI)) + r.range(-0.2, 0.2);
      const out = v3(Math.cos(a), P.arc * 0.3, Math.sin(a)).normalize();
      const L = H * 0.35 * (1 - t * 0.5) * r.range(0.8, 1.1);
      b.tube(bentPath(at, out, L, 6, v3(0, P.arc, 0), 0.02, r), (tt) => H * 0.012 * (1 - tt * 0.8), 4, () => c1, (tt) => tt > 0.9 ? d.glow : 0);
    }
  }
  b.blob(spine[spine.length - 1], v3(H * 0.05, H * 0.07, H * 0.05), 1, () => d.colors.c, d.glow > 0 ? d.glow : 0.3);
}

function genLantern(b: GeoBuilder, d: FloraDef, r: RNG): void {
  const P = d.p;
  const H = P.height * r.range(0.8, 1.2);
  const trunk = bentPath(v3(0, -0.3, 0), v3(0, 1, 0), H, 8, v3(r.range(-0.6, 0.6), 0, r.range(-0.6, 0.6)), 0.05, r);
  b.tube(trunk, (t) => H * 0.03 * (1 - t * 0.6), 6, (t) => mixRGB(scaleRGB(d.colors.a, 0.5), d.colors.a, t));
  const top = trunk[trunk.length - 1];
  for (let i = 0; i < P.lanterns; i++) {
    const a = (i / P.lanterns) * Math.PI * 2 + r.range(-0.3, 0.3);
    const L = H * r.range(0.25, 0.45);
    const arm = bentPath(top, v3(Math.cos(a), 0.5, Math.sin(a)).normalize(), L, 6, v3(0, -P.droop * 1.5, 0), 0.03, r);
    b.tube(arm, (t) => H * 0.012 * (1 - t * 0.5), 4, () => d.colors.a);
    const end = arm[arm.length - 1];
    b.windOverride = 1;
    const hang = end.clone().add(v3(0, -H * 0.08, 0));
    b.tube([end, hang], () => 0.02, 3, () => d.colors.a, () => 0, false);
    const s = H * r.range(0.035, 0.06);
    b.blob(hang.clone().add(v3(0, -s, 0)), v3(s, s * 1.4, s), 1, () => d.colors.glow, 1.2);
    b.windOverride = NaN;
  }
}

// --- Shrubs, grass, fans ---------------------------------------------------------------------

function genShrub(b: GeoBuilder, d: FloraDef, r: RNG): void {
  const P = d.p;
  const H = P.height * r.range(0.8, 1.2);
  const style = P.style;
  for (let i = 0; i < P.stems; i++) {
    const a = r.next() * Math.PI * 2;
    const dir = v3(Math.cos(a) * r.range(0.2, 0.7), 1, Math.sin(a) * r.range(0.2, 0.7)).normalize();
    const path = bentPath(v3(0, -0.05, 0), dir, H * r.range(0.6, 1), 5, v3(Math.cos(a) * 0.4, -0.2, Math.sin(a) * 0.4), 0.1, r);
    b.tube(path, (t) => 0.03 * H * (1 - t * 0.8), 4, (t) => mixRGB(d.colors.a, d.colors.b, t));
    const end = path[path.length - 1];
    if (style === 0) {
      // Leaves along the stem
      for (let k = 1; k < path.length; k++) {
        const p = path[k];
        const la = r.next() * Math.PI * 2;
        const ld = v3(Math.cos(la), 0.4, Math.sin(la)).normalize();
        const side = new THREE.Vector3().crossVectors(ld, v3(0, 1, 0)).normalize();
        b.blade(p, ld, side, H * 0.25, H * 0.06, v3(0, -0.4, 0), 2, d.colors.b, d.colors.c, d.glow * 0.5);
      }
    } else if (style === 1) {
      b.blob(end, v3(H * 0.07, H * 0.07, H * 0.07), 0, () => d.colors.c, d.glow);
    } else {
      // Thorns
      for (let k = 1; k < path.length; k++) b.prism(path[k], coneDir(v3(0, 1, 0), 1.3, r), H * 0.012, H * 0.12, 3, 0.6, d.colors.b, d.colors.c, 0, d.glow);
    }
  }
}

function genGrass(b: GeoBuilder, d: FloraDef, r: RNG): void {
  const P = d.p;
  for (let i = 0; i < P.blades; i++) {
    const a = r.next() * Math.PI * 2;
    const rr = Math.sqrt(r.next()) * 0.45;
    const base = v3(Math.cos(a) * rr, -0.05, Math.sin(a) * rr);
    const lean = v3(Math.cos(a) * r.range(0.05, 0.35), 1, Math.sin(a) * r.range(0.05, 0.35)).normalize();
    const side = v3(-Math.sin(a + r.range(-0.5, 0.5)), 0, Math.cos(a)).normalize();
    const L = P.height * r.range(0.6, 1.3);
    const curl = v3(Math.cos(a) * P.curl, -P.curl * 0.3, Math.sin(a) * P.curl);
    b.blade(base, lean, side, L, P.width * r.range(0.7, 1.3), curl, 2, scaleRGB(d.colors.a, 0.7), jitter(d.colors.b, r, 0.12), d.glow);
  }
}

function genFan(b: GeoBuilder, d: FloraDef, r: RNG): void {
  const P = d.p;
  const H = P.height * r.range(0.8, 1.2);
  const planes = r.int(1, 2);
  for (let pl = 0; pl < planes; pl++) {
    const rot = new THREE.Matrix4().makeRotationY((pl / planes) * Math.PI + r.range(-0.3, 0.3));
    b.with(rot, () => {
      const rec = (start: V3, dir: V3, len: number, rad: number, depth: number) => {
        const path = bentPath(start, dir, len, 3, v3(0, 0.1, 0), 0.02, r);
        const tt = 1 - depth / P.depth;
        b.tube(path, (t) => rad * (1 - t * 0.5), 4, (t) => mixRGB(d.colors.a, d.colors.b, Math.min(1, tt + t / P.depth)), (t) => (depth === 0 ? t * d.glow : 0), depth === 0);
        const end = path[path.length - 1];
        if (depth === 0) {
          b.blob(end, v3(rad * 1.8, rad * 1.8, rad * 1.8), 0, () => d.colors.c, d.glow);
          return;
        }
        for (const s of [-1, 1]) {
          const a = Math.atan2(dir.y, dir.x) + s * P.spread * r.range(0.25, 0.5);
          rec(end, v3(Math.cos(a), Math.sin(a), 0), len * r.range(0.65, 0.85), rad * 0.72, depth - 1);
        }
      };
      rec(v3(0, -0.1, 0), v3(0, 1, 0), H * 0.3, H * 0.035, P.depth);
    });
  }
}

// --- Fungi -----------------------------------------------------------------------------------

function mushroom(b: GeoBuilder, at: V3, H: number, capR: number, flat: number, stemC: RGB, capC: RGB, gillC: RGB, spotC: RGB, glow: number, r: RNG, lean: V3): void {
  const m = new THREE.Matrix4().makeTranslation(at.x, at.y, at.z);
  const q = new THREE.Quaternion().setFromUnitVectors(v3(0, 1, 0), lean);
  m.multiply(new THREE.Matrix4().makeRotationFromQuaternion(q));
  b.with(m, () => {
    const sr = capR * 0.18;
    b.lathe([[sr * 1.6, -0.1], [sr * 1.1, H * 0.1], [sr, H * 0.5], [sr * 0.85, H * 0.9], [sr * 1.1, H]], 8, (v) => mixRGB(scaleRGB(stemC, 0.8), stemC, v), (v) => glow * 0.2 * v, 0.05, r.next() * 10);
    const top = H + capR * (1 - flat) * 0.9;
    const prof: [number, number][] = [
      [sr * 1.1, H - capR * 0.05],
      [capR * 0.7, H - capR * 0.08],
      [capR, H - capR * 0.02],
      [capR * 0.97, H + capR * 0.12],
      [capR * 0.75, H + (top - H) * 0.7],
      [capR * 0.35, top * 0.98 + H * 0.02],
      [0.01, top],
    ];
    b.lathe(prof, 14, (v) => (v < 0.3 ? gillC : mixRGB(capC, scaleRGB(capC, 1.2), v)), (v) => (v < 0.3 ? glow : glow * 0.12), 0.06, r.next() * 10);
    // Spots
    const spots = r.int(0, 7);
    for (let i = 0; i < spots; i++) {
      const a = r.next() * Math.PI * 2;
      const t = r.range(0.2, 0.8);
      const rr = capR * (1 - t) * 0.9 + capR * 0.1;
      const y = H + capR * 0.1 + (top - H) * t;
      const s = capR * r.range(0.06, 0.12);
      b.blob(v3(Math.cos(a) * rr, y, Math.sin(a) * rr), v3(s, s * 0.4, s), 0, () => spotC, glow > 0 ? 1 : 0);
    }
  });
}

function genFungus(b: GeoBuilder, d: FloraDef, r: RNG, giant: boolean): void {
  const P = d.p;
  const n = giant ? P.caps : P.caps + r.int(0, 2);
  for (let i = 0; i < n; i++) {
    const at = i === 0 ? v3(0, 0, 0) : v3(r.range(-1, 1), 0, r.range(-1, 1)).multiplyScalar(P.cap * (giant ? 0.9 : 1.2));
    const H = P.height * (i === 0 ? 1 : r.range(0.35, 0.7)) * r.range(0.85, 1.15);
    const lean = v3(at.x * 0.15 + r.range(-0.1, 0.1), 1, at.z * 0.15 + r.range(-0.1, 0.1)).normalize();
    mushroom(b, at, H, P.cap * (i === 0 ? 1 : r.range(0.4, 0.7)), P.flat, d.colors.a, d.colors.b, d.glow > 0 ? d.colors.glow : scaleRGB(d.colors.b, 0.5), d.colors.c, d.glow, r, lean);
    if (giant) {
      b.windOverride = 1;
      const strands = r.int(4, 10);
      for (let k = 0; k < strands; k++) {
        const a = r.next() * Math.PI * 2;
        const rr = P.cap * r.range(0.4, 0.95);
        const s = v3(at.x + Math.cos(a) * rr, H - P.cap * 0.05, at.z + Math.sin(a) * rr);
        b.tube([s, s.clone().add(v3(0, -H * r.range(0.1, 0.35), 0))], (t) => 0.05 * (1 - t), 3, () => d.colors.glow, (t) => t * 1.2, false);
      }
      b.windOverride = NaN;
    }
  }
}

function genGlowcap(b: GeoBuilder, d: FloraDef, r: RNG): void {
  const P = d.p;
  for (let i = 0; i < P.caps; i++) {
    const at = v3(r.range(-1, 1), 0, r.range(-1, 1)).multiplyScalar(0.5);
    const lean = v3(at.x * 0.8, 1, at.z * 0.8).normalize();
    mushroom(b, at, P.height * r.range(0.5, 1.3), P.cap * r.range(0.6, 1.2), P.flat, d.colors.a, d.colors.glow, d.colors.glow, d.colors.c, 1, r, lean);
  }
}

// --- Crystals --------------------------------------------------------------------------------

function genCrystal(b: GeoBuilder, d: FloraDef, r: RNG): void {
  const P = d.p;
  const base = mixRGB(d.colors.glow, [0.1, 0.1, 0.12], 0.55);
  for (let i = 0; i < P.count; i++) {
    const dir = i === 0 ? v3(0, 1, 0) : coneDir(v3(0, 1, 0), P.spread * 1.6, r);
    const L = P.length * (i === 0 ? 1 : r.range(0.35, 0.8));
    const rad = L * r.range(0.1, 0.17);
    const at = v3(r.range(-0.3, 0.3), -rad, r.range(-0.3, 0.3));
    b.prism(at, dir, rad, L, P.sides, r.range(0.15, 0.35), base, d.colors.glow, 0.15 * d.glow, 1.1 * d.glow);
  }
  b.blob(v3(0, 0, 0), v3(0.5, 0.25, 0.5), 1, () => scaleRGB(base, 0.6), 0);
}

// --- Other plants ----------------------------------------------------------------------------

function genBulb(b: GeoBuilder, d: FloraDef, r: RNG): void {
  const P = d.p;
  for (let i = 0; i < P.bulbs; i++) {
    const a = r.next() * Math.PI * 2;
    const H = P.height * r.range(0.6, 1.1);
    const path = bentPath(v3(0, -0.05, 0), v3(Math.cos(a) * 0.2, 1, Math.sin(a) * 0.2).normalize(), H, 6, v3(Math.cos(a) * 0.4, 0, Math.sin(a) * 0.4), 0.05, r);
    b.tube(path, (t) => 0.035 * (1 - t * 0.5), 4, (t) => mixRGB(d.colors.a, d.colors.b, t), () => 0, false);
    const s = P.bulbSize * r.range(0.7, 1.2);
    const end = path[path.length - 1];
    b.blob(end.clone().add(v3(0, s * 0.8, 0)), v3(s, s * 1.15, s), 1, (p, n) => mixRGB(d.colors.c, d.colors.glow, 0.5 + 0.5 * n.y), d.glow, (dd) => 0.08 * Math.sin(dd.y * 12));
  }
  // Leaf rosette
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + r.range(-0.2, 0.2);
    const dir = v3(Math.cos(a), 0.35, Math.sin(a)).normalize();
    b.blade(v3(0, 0, 0), dir, v3(-Math.sin(a), 0, Math.cos(a)), P.height * 0.3, 0.12, v3(0, -0.3, 0), 3, d.colors.a, d.colors.b);
  }
}

function genSpiral(b: GeoBuilder, d: FloraDef, r: RNG): void {
  const P = d.p;
  for (let s = 0; s < P.strands; s++) {
    const pts: V3[] = [];
    const off = (s / P.strands) * Math.PI * 2;
    const N = 40;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const a = off + t * P.turns * Math.PI * 2;
      const rad = P.radius * (1 - t * 0.7) * (0.6 + 0.4 * Math.sin(t * 3.1));
      pts.push(v3(Math.cos(a) * rad, t * P.height, Math.sin(a) * rad));
    }
    b.tube(pts, (t) => 0.09 * (1 - t * 0.8) * (P.height / 4), 5, (t) => mixRGB(d.colors.a, d.colors.b, t), (t) => (t > 0.85 ? d.glow : 0));
  }
  b.blob(v3(0, P.height, 0), v3(0.15, 0.25, 0.15).multiplyScalar(P.height / 4), 1, () => d.colors.c, 0.6);
}

function genVine(b: GeoBuilder, d: FloraDef, r: RNG): void {
  const P = d.p;
  b.windOverride = NaN;
  const glowC = d.colors.glow;
  for (let i = 0; i < P.strands; i++) {
    const at = v3(r.range(-0.6, 0.6), -0.1, r.range(-0.6, 0.6));
    const L = P.length * r.range(0.5, 1.2);
    const path = bentPath(at, v3(0, 1, 0), L, 7, v3(r.range(-0.3, 0.3), 0, r.range(-0.3, 0.3)), 0.12, r);
    b.tube(path, (t) => 0.035 * (1 - t * 0.6), 3, (t) => mixRGB(d.colors.a, glowC, t * 0.5), (t) => t * 0.3, false);
    // Glowing droplets along the strand
    for (let k = 2; k < path.length; k += 2) b.blob(path[k], v3(0.06, 0.09, 0.06), 0, () => glowC, 1.2);
    b.blob(path[path.length - 1], v3(0.1, 0.14, 0.1), 0, () => glowC, 1.5);
  }
}

function genKelp(b: GeoBuilder, d: FloraDef, r: RNG): void {
  const P = d.p;
  for (let i = 0; i < P.strands; i++) {
    const a = r.next() * Math.PI * 2;
    const base = v3(Math.cos(a) * 0.3, 0, Math.sin(a) * 0.3);
    const L = P.length * r.range(0.6, 1.1);
    const side = v3(-Math.sin(a), 0, Math.cos(a));
    b.blade(base, v3(0, 1, 0), side, L, 0.25, v3(Math.cos(a) * 0.3, 0, Math.sin(a) * 0.3), 6, d.colors.a, d.colors.b, d.glow * 0.5);
    for (let k = 1; k < 4; k++) b.blob(base.clone().add(v3(0, (L * k) / 4, 0)), v3(0.18, 0.25, 0.18), 0, () => d.colors.glow, d.glow);
  }
}

function genStalactite(b: GeoBuilder, d: FloraDef, r: RNG): void {
  const P = d.p;
  const n = r.int(1, 3);
  for (let i = 0; i < n; i++) {
    const L = P.length * (i === 0 ? 1 : r.range(0.3, 0.7));
    const R = P.radius * (i === 0 ? 1 : r.range(0.4, 0.7));
    const at = i === 0 ? v3(0, -0.2, 0) : v3(r.range(-1, 1), -0.2, r.range(-1, 1)).multiplyScalar(R * 1.8);
    const prof: [number, number][] = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      prof.push([R * Math.pow(1 - t, 1.3) * (1 + 0.12 * Math.sin(t * 20)) + 0.01, t * L]);
    }
    b.with(new THREE.Matrix4().makeTranslation(at.x, at.y, at.z), () =>
      b.lathe(prof, 7, (v) => mixRGB(d.colors.a, d.colors.b, v), (v) => (v > 0.9 ? 0.5 : 0), 0.15, r.next() * 10));
  }
}

// --- Rocks -----------------------------------------------------------------------------------

function genRock(b: GeoBuilder, d: FloraDef, r: RNG, sizeMul: number): void {
  const P = d.p;
  const noise = new Noise(Math.floor(r.next() * 1e9));
  const size = (P.size ?? 1.5) * sizeMul * r.range(0.8, 1.2);
  const flat = P.flat;
  const rough = P.rough;
  const sx = r.range(0.8, 1.3), sz = r.range(0.8, 1.3);
  const tiltM = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(r.range(-0.2, 0.2), r.next() * 6, r.range(-0.2, 0.2)));
  b.with(tiltM, () =>
    b.blob(
      v3(0, size * flat * 0.45, 0),
      v3(size * sx, size * flat, size * sz),
      3,
      (p, n) => {
        const k = 0.5 + 0.5 * noise.n3(p.x * 1.3, p.y * 1.3, p.z * 1.3);
        const base = mixRGB(d.colors.a, d.colors.b, k);
        const top = Math.max(0, n.y);
        const band = 0.5 + 0.5 * Math.sin(p.y * 6 + noise.n2(p.x, p.z) * 2);
        return mixRGB(mixRGB(base, d.colors.c, band * 0.25), scaleRGB(base, 1.15), top * 0.4);
      },
      0,
      (dir) => {
        // Faceted, fractured look: quantised noise plus a few flat cuts
        let v = noise.fbm3(dir.x * 1.8, dir.y * 1.8, dir.z * 1.8, 3) * rough * 1.6;
        v = Math.round(v * 5) / 5 * 0.6 + v * 0.4;
        if (dir.y < -0.3) v -= (-0.3 - dir.y) * 0.5;
        return v;
      },
    ),
  );
}

function genPebbles(b: GeoBuilder, d: FloraDef, r: RNG): void {
  const n = r.int(2, 5);
  for (let i = 0; i < n; i++) {
    const m = new THREE.Matrix4().makeTranslation(r.range(-0.8, 0.8), 0, r.range(-0.8, 0.8)).multiply(new THREE.Matrix4().makeScale(0.35, 0.35, 0.35));
    b.with(m, () => genRock(b, d, r, r.range(0.4, 1)));
  }
}

export function floraTint(uid: number): RGB {
  const h = (uid % 1000) / 1000;
  return hsl(0.1 + h * 0.8, 0.05, 0.5).map((c) => 0.88 + c * 0.24) as RGB;
}
