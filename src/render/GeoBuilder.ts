import * as THREE from 'three';
import { RGB } from '../core/math';

type V3 = THREE.Vector3;
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();

/**
 * Accumulates procedural geometry with per-vertex colour, glow and wind weight.
 * Shapes are emitted in the current transform (a small matrix stack), so generators can
 * build parts locally and place them anywhere.
 */
export class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  glow: number[] = [];
  wind: number[] = [];
  idx: number[] = [];
  private stack: THREE.Matrix4[] = [new THREE.Matrix4()];
  /** Explicit wind weight for subsequent vertices (NaN = derive from height). */
  windOverride = NaN;
  /** Low-detail mode for distant instances: fewer sides, coarser spheres, shorter paths. */
  lod = 0;

  get matrix(): THREE.Matrix4 {
    return this.stack[this.stack.length - 1];
  }

  push(m: THREE.Matrix4): void {
    this.stack.push(this.matrix.clone().multiply(m));
  }

  pop(): void {
    this.stack.pop();
  }

  with(m: THREE.Matrix4, fn: () => void): void {
    this.push(m);
    fn();
    this.pop();
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  vertex(p: V3, n: V3, c: RGB, glow = 0): number {
    const m = this.matrix;
    _p.copy(p).applyMatrix4(m);
    _nm.getNormalMatrix(m);
    _n.copy(n).applyMatrix3(_nm).normalize();
    this.pos.push(_p.x, _p.y, _p.z);
    this.nrm.push(_n.x, _n.y, _n.z);
    this.col.push(c[0], c[1], c[2]);
    this.glow.push(glow);
    this.wind.push(this.windOverride);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /**
   * A tube along a polyline with parallel-transport frames.
   * radius(t), color(t) and glow(t) take t in [0, 1] along the path.
   */
  tube(path: V3[], radius: (t: number) => number, sides: number, color: (t: number) => RGB, glow: (t: number) => number = () => 0, cap = true): void {
    if (this.lod) {
      sides = Math.max(3, Math.ceil(sides / 2));
      if (path.length > 3) path = path.filter((_, i) => i % 2 === 0 || i === path.length - 1);
    }
    const n = path.length;
    if (n < 2) return;
    const tangents: V3[] = [];
    for (let i = 0; i < n; i++) {
      const a = path[Math.max(0, i - 1)], b = path[Math.min(n - 1, i + 1)];
      tangents.push(b.clone().sub(a).normalize());
    }
    let normal = new THREE.Vector3(0, 0, 1);
    if (Math.abs(tangents[0].dot(normal)) > 0.9) normal.set(1, 0, 0);
    normal.sub(tangents[0].clone().multiplyScalar(normal.dot(tangents[0]))).normalize();
    const rings: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        // Parallel transport the normal
        const axis = new THREE.Vector3().crossVectors(tangents[i - 1], tangents[i]);
        const len = axis.length();
        if (len > 1e-6) {
          axis.multiplyScalar(1 / len);
          const ang = Math.acos(THREE.MathUtils.clamp(tangents[i - 1].dot(tangents[i]), -1, 1));
          normal.applyAxisAngle(axis, ang);
        }
      }
      const binormal = new THREE.Vector3().crossVectors(tangents[i], normal);
      const t = i / (n - 1);
      const r = radius(t);
      const c = color(t);
      const g = glow(t);
      rings.push(this.vertexCount);
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        const dir = normal.clone().multiplyScalar(Math.cos(a)).addScaledVector(binormal, Math.sin(a));
        this.vertex(path[i].clone().addScaledVector(dir, r), dir, c, g);
      }
    }
    for (let i = 0; i < n - 1; i++)
      for (let s = 0; s < sides; s++) {
        const a = rings[i] + s, b = rings[i] + s + 1, c = rings[i + 1] + s + 1, d = rings[i + 1] + s;
        this.quad(a, d, c, b);
      }
    if (cap && radius(1) > 0.001) {
      const tip = this.vertex(path[n - 1].clone().addScaledVector(tangents[n - 1], radius(1) * 0.8), tangents[n - 1], color(1), glow(1));
      const last = rings[n - 1];
      for (let s = 0; s < sides; s++) this.tri(last + s, last + s + 1, tip);
    }
  }

  /** Surface of revolution around +Y. profile: [radius, y] pairs from bottom to top. */
  lathe(profile: [number, number][], sides: number, color: (v: number, a: number) => RGB, glow: (v: number) => number = () => 0, wobble = 0, seed = 0): void {
    if (this.lod) sides = Math.max(4, Math.ceil(sides / 2));
    const rows: number[] = [];
    const n = profile.length;
    for (let i = 0; i < n; i++) {
      const [r, y] = profile[i];
      const prev = profile[Math.max(0, i - 1)], next = profile[Math.min(n - 1, i + 1)];
      const dr = next[0] - prev[0], dy = next[1] - prev[1];
      // Outward normal of the profile curve (dy, -dr), normalised
      let nr = dy, ny = -dr;
      const nl = Math.hypot(nr, ny) || 1;
      nr /= nl;
      ny /= nl;
      const v = i / (n - 1);
      rows.push(this.vertexCount);
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        const w = wobble ? 1 + wobble * Math.sin(a * 3 + seed + y * 2) * Math.sin(a * 5 + seed * 2) : 1;
        const ca = Math.cos(a), sa = Math.sin(a);
        this.vertex(_v1.set(ca * r * w, y, sa * r * w), _v2.set(ca * nr, ny, sa * nr), color(v, a), glow(v));
      }
    }
    for (let i = 0; i < n - 1; i++)
      for (let s = 0; s < sides; s++) {
        const a = rows[i] + s, b = rows[i] + s + 1, c = rows[i + 1] + s + 1, d = rows[i + 1] + s;
        this.quad(a, d, c, b);
      }
  }

  /** Icosphere with optional displacement. */
  blob(center: V3, scale: V3, detail: number, color: (p: V3, n: V3) => RGB, glow = 0, displace?: (dir: V3) => number): void {
    if (this.lod) detail = Math.max(0, detail - 1);
    const geo = new THREE.IcosahedronGeometry(1, detail);
    const merged = mergeVertices(geo);
    const p = merged.getAttribute('position');
    const base = this.vertexCount;
    const dirs: V3[] = [];
    const pts: V3[] = [];
    for (let i = 0; i < p.count; i++) {
      const d = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)).normalize();
      const k = displace ? 1 + displace(d) : 1;
      dirs.push(d);
      pts.push(new THREE.Vector3(d.x * scale.x * k, d.y * scale.y * k, d.z * scale.z * k).add(center));
    }
    // Normals from faces
    const index = merged.getIndex()!;
    const acc = pts.map(() => new THREE.Vector3());
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
      const fn = new THREE.Vector3().subVectors(pts[b], pts[a]).cross(new THREE.Vector3().subVectors(pts[c], pts[a]));
      acc[a].add(fn);
      acc[b].add(fn);
      acc[c].add(fn);
    }
    for (let i = 0; i < pts.length; i++) {
      const nn = acc[i].normalize();
      this.vertex(pts[i], nn, color(pts[i], nn), glow);
    }
    for (let i = 0; i < index.count; i += 3) this.tri(base + index.getX(i), base + index.getX(i + 1), base + index.getX(i + 2));
    geo.dispose();
    merged.dispose();
  }

  /** A curved, tapered ribbon (grass blade, leaf, tendril). */
  blade(base: V3, dir: V3, side: V3, length: number, width: number, bend: V3, segs: number, c0: RGB, c1: RGB, glowTip = 0): void {
    const start = this.vertexCount;
    const nrm = new THREE.Vector3().crossVectors(side, dir).normalize();
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const p = base.clone().addScaledVector(dir, length * t).addScaledVector(bend, length * t * t);
      const w = width * (1 - t * 0.92);
      const c: RGB = [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
      this.vertex(p.clone().addScaledVector(side, -w), nrm, c, glowTip * t * t);
      this.vertex(p.clone().addScaledVector(side, w), nrm, c, glowTip * t * t);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      this.quad(a, a + 1, a + 3, a + 2);
    }
  }

  /** n-sided prism with a pointed tip, from base along dir. */
  prism(base: V3, dir: V3, radius: number, length: number, sides: number, tipFrac: number, c0: RGB, c1: RGB, glow0: number, glow1: number): void {
    const up = dir.clone().normalize();
    const side = new THREE.Vector3(1, 0, 0);
    if (Math.abs(up.dot(side)) > 0.9) side.set(0, 0, 1);
    const u = new THREE.Vector3().crossVectors(up, side).normalize();
    const v = new THREE.Vector3().crossVectors(up, u);
    const body = length * (1 - tipFrac);
    const tip = base.clone().addScaledVector(up, length);
    for (let s = 0; s < sides; s++) {
      const a0 = (s / sides) * Math.PI * 2, a1 = ((s + 1) / sides) * Math.PI * 2;
      const d0 = u.clone().multiplyScalar(Math.cos(a0)).addScaledVector(v, Math.sin(a0));
      const d1 = u.clone().multiplyScalar(Math.cos(a1)).addScaledVector(v, Math.sin(a1));
      const fn = d0.clone().add(d1).normalize();
      const b0 = base.clone().addScaledVector(d0, radius), b1 = base.clone().addScaledVector(d1, radius);
      const t0 = b0.clone().addScaledVector(up, body), t1 = b1.clone().addScaledVector(up, body);
      const i0 = this.vertex(b0, fn, c0, glow0), i1 = this.vertex(b1, fn, c0, glow0);
      const i2 = this.vertex(t1, fn, c1, glow1), i3 = this.vertex(t0, fn, c1, glow1);
      this.quad(i0, i1, i2, i3);
      const tn = fn.clone().add(up).normalize();
      const j0 = this.vertex(t0, tn, c1, glow1), j1 = this.vertex(t1, tn, c1, glow1), j2 = this.vertex(tip, tn, c1, glow1 * 1.2);
      this.tri(j0, j1, j2);
    }
  }

  build(windScale: number): THREE.BufferGeometry {
    let maxY = 0.01;
    for (let i = 1; i < this.pos.length; i += 3) maxY = Math.max(maxY, Math.abs(this.pos[i]));
    const wind = new Float32Array(this.wind.length);
    for (let i = 0; i < wind.length; i++) {
      const w = this.wind[i];
      const h = Math.abs(this.pos[i * 3 + 1]) / maxY;
      wind[i] = (Number.isNaN(w) ? Math.pow(h, 1.6) : w) * windScale * Math.min(1, maxY * 0.25 + 0.2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glow, 1));
    g.setAttribute('aWind', new THREE.BufferAttribute(wind, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/** Minimal vertex welding for icosahedron geometry (position-only). */
function mergeVertices(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const map = new Map<string, number>();
  const verts: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = verts.length / 3;
      verts.push(x, y, z);
      map.set(key, id);
    }
    index.push(id);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(index);
  return g;
}

export function v3(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z);
}
