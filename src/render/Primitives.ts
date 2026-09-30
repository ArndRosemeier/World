import * as THREE from 'three';
import { createPrimitiveMaterial } from './materials';
import { RGB } from '../core/math';

// ---------------------------------------------------------------------------------------------
// Creatures, buildings and debris are all assembled from a handful of unit primitives drawn
// with instancing. A few draw calls render hundreds of creatures and whole settlements, and
// destroying a building simply turns its pieces into physics debris of the same primitives.
// ---------------------------------------------------------------------------------------------

export const enum Prim {
  Sphere = 0,
  Box = 1,
  Cylinder = 2, // y in [0, 1], radius 1
  Cone = 3, // y in [0, 1], base radius 1
  Limb = 4, // tapered cylinder y in [0, 1], radius 1 -> 0.6
  Dome = 5, // hemisphere y >= 0
  Torus = 6, // ring in the XZ plane, major radius 1
  Wing = 7, // membrane in the XZ plane, root at origin, extends along +X
  Hex = 8, // hexagonal prism y in [0, 1]
}

export const PRIM_COUNT = 9;

function makeGeometry(p: Prim): THREE.BufferGeometry {
  switch (p) {
    case Prim.Sphere:
      return new THREE.IcosahedronGeometry(1, 2);
    case Prim.Box:
      return new THREE.BoxGeometry(1, 1, 1);
    case Prim.Cylinder:
      return new THREE.CylinderGeometry(1, 1, 1, 14, 1).translate(0, 0.5, 0);
    case Prim.Cone:
      return new THREE.ConeGeometry(1, 1, 14, 1).translate(0, 0.5, 0);
    case Prim.Limb:
      return new THREE.CylinderGeometry(0.6, 1, 1, 8, 1).translate(0, 0.5, 0);
    case Prim.Dome:
      return new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    case Prim.Torus:
      return new THREE.TorusGeometry(1, 0.12, 8, 28).rotateX(Math.PI / 2);
    case Prim.Wing: {
      // A scalloped membrane with a leading-edge spar.
      const shape = new THREE.Shape();
      shape.moveTo(0, 0.25);
      shape.quadraticCurveTo(0.5, 0.45, 1, 0.05);
      shape.quadraticCurveTo(0.8, -0.15, 0.7, -0.35);
      shape.quadraticCurveTo(0.55, -0.2, 0.4, -0.45);
      shape.quadraticCurveTo(0.25, -0.25, 0, -0.35);
      shape.lineTo(0, 0.25);
      return new THREE.ShapeGeometry(shape, 6).rotateX(-Math.PI / 2);
    }
    case Prim.Hex:
      return new THREE.CylinderGeometry(1, 1, 1, 6, 1).translate(0, 0.5, 0);
  }
}

interface Slot {
  mesh: THREE.InstancedMesh;
  cap: number;
  aP: THREE.InstancedBufferAttribute;
  aC2: THREE.InstancedBufferAttribute;
  count: number;
}

export interface PrimStyle {
  color: RGB;
  color2?: RGB;
  pattern?: number;
  freq?: number;
  emissive?: number;
  sky?: number;
}

const _c = new THREE.Color();

/** One set of instanced meshes. Use one batch for static things and one for per-frame things. */
export class PrimitiveBatch {
  readonly group = new THREE.Group();
  private slots: Slot[] = [];
  private material: THREE.Material;
  private geos: THREE.BufferGeometry[];

  constructor(shadows = true, material?: THREE.Material) {
    this.material = material ?? createPrimitiveMaterial();
    this.geos = [];
    for (let p = 0; p < PRIM_COUNT; p++) {
      const g = makeGeometry(p as Prim);
      this.geos.push(g);
      this.slots.push(this.makeSlot(g, 64, shadows));
    }
  }

  private makeSlot(geo: THREE.BufferGeometry, cap: number, shadows: boolean): Slot {
    const g = geo.clone();
    const mesh = new THREE.InstancedMesh(g, this.material, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const aP = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    const aC2 = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    g.setAttribute('aP', aP);
    g.setAttribute('aC2', aC2);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return { mesh, cap, aP, aC2, count: 0 };
  }

  begin(): void {
    for (const s of this.slots) s.count = 0;
  }

  add(p: Prim, m: THREE.Matrix4, st: PrimStyle): void {
    let s = this.slots[p];
    if (s.count >= s.cap) {
      const cap = s.cap * 2;
      const fresh = this.makeSlot(this.geos[p], cap, s.mesh.castShadow);
      (fresh.mesh.instanceMatrix.array as Float32Array).set(s.mesh.instanceMatrix.array as Float32Array);
      (fresh.mesh.instanceColor!.array as Float32Array).set(s.mesh.instanceColor!.array as Float32Array);
      (fresh.aP.array as Float32Array).set(s.aP.array as Float32Array);
      (fresh.aC2.array as Float32Array).set(s.aC2.array as Float32Array);
      fresh.count = s.count;
      this.group.remove(s.mesh);
      s.mesh.geometry.dispose();
      s.mesh.dispose();
      this.slots[p] = s = fresh;
    }
    const i = s.count++;
    m.toArray(s.mesh.instanceMatrix.array as Float32Array, i * 16);
    const ca = s.mesh.instanceColor!.array as Float32Array;
    ca[i * 3] = st.color[0];
    ca[i * 3 + 1] = st.color[1];
    ca[i * 3 + 2] = st.color[2];
    const ap = s.aP.array as Float32Array;
    ap[i * 4] = st.pattern ?? 0;
    ap[i * 4 + 1] = st.freq ?? 3;
    ap[i * 4 + 2] = st.emissive ?? 0;
    ap[i * 4 + 3] = st.sky ?? 1;
    const c2 = st.color2 ?? st.color;
    const cc = s.aC2.array as Float32Array;
    cc[i * 3] = c2[0];
    cc[i * 3 + 1] = c2[1];
    cc[i * 3 + 2] = c2[2];
  }

  end(): void {
    for (const s of this.slots) {
      s.mesh.count = s.count;
      s.mesh.instanceMatrix.needsUpdate = true;
      s.mesh.instanceColor!.needsUpdate = true;
      s.aP.needsUpdate = true;
      s.aC2.needsUpdate = true;
    }
  }

  get instanceCount(): number {
    return this.slots.reduce((a, s) => a + s.count, 0);
  }
}

// --- Matrix helpers --------------------------------------------------------------------------

const _q = new THREE.Quaternion();
const _d = new THREE.Vector3();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Matrix for a Y-aligned unit primitive stretched from a to b with the given radius. */
export function segmentMatrix(a: THREE.Vector3, b: THREE.Vector3, radius: number, out: THREE.Matrix4): THREE.Matrix4 {
  _d.subVectors(b, a);
  const len = _d.length();
  if (len < 1e-5) _q.identity();
  else _q.setFromUnitVectors(UP, _d.multiplyScalar(1 / len));
  _s.set(radius, len, radius);
  return out.compose(a, _q, _s);
}

export function trsMatrix(p: THREE.Vector3, q: THREE.Quaternion, sx: number, sy: number, sz: number, out: THREE.Matrix4): THREE.Matrix4 {
  _s.set(sx, sy, sz);
  return out.compose(p, q, _s);
}

export function colorOf(c: RGB): THREE.Color {
  return _c.setRGB(c[0], c[1], c[2]);
}
