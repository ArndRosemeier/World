import * as THREE from 'three';
import { WorldParams, FloraDef } from '../world/WorldParams';
import { PROP_STRIDE } from '../world/Scatter';
import { buildFloraVariant, floraTint } from './FloraGen';
import { createFloraMaterial } from '../render/materials';
import { PropSink } from '../world/ChunkManager';
import { hash01 } from '../core/rng';
import { ColliderSource } from '../player/Player';

interface MeshSlot {
  tier: number;
  mesh: THREE.InstancedMesh;
  capacity: number;
  def: FloraDef;
  inst: THREE.InstancedBufferAttribute;
}

interface ChunkGroup {
  mats: Float32Array;
  cols: Float32Array;
  inst: Float32Array;
  count: number;
}

interface ChunkProps {
  level: number;
  data: Float32Array;
  groups: Map<number, ChunkGroup>;
  colliders: Collider[];
}

export interface Collider {
  x: number; y: number; z: number;
  ux: number; uy: number; uz: number;
  r: number; h: number;
  uid: number;
}

export interface DestroyedProp {
  def: FloraDef;
  position: THREE.Vector3;
  up: THREE.Vector3;
  scale: number;
}

function slotKey(floraId: number, variant: number, tier: number): number {
  return floraId * 16 + variant * 2 + tier;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _u = new THREE.Vector3();
const _s = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

/** Streams instanced flora for visible chunks; handles colliders and destruction. */
export class PropManager implements PropSink, ColliderSource {
  readonly group = new THREE.Group();
  private slots = new Map<number, MeshSlot>();
  private chunks = new Map<string, ChunkProps>();
  readonly destroyed = new Set<number>();
  private dirty = false;
  private material = createFloraMaterial();
  private params: WorldParams;
  colliders: Collider[] = [];
  instanceCount = 0;

  constructor(params: WorldParams) {
    this.params = params;
    this.group.name = 'props';
  }

  /** Builds all species geometry up front (a few hundred ms), so streaming never stalls. */
  prebuild(): void {
    for (const def of this.params.flora)
      for (let v = 0; v < def.variants; v++) {
        this.slot(def.id, v, 0);
        if (def.maxLevel >= 2) this.slot(def.id, v, 1);
      }
  }

  /** Tier 0: full detail with shadows (near chunks); tier 1: simplified, no shadows (far). */
  private slot(floraId: number, variant: number, tier: number): MeshSlot {
    const key = slotKey(floraId, variant, tier);
    let s = this.slots.get(key);
    if (s) return s;
    const def = this.params.flora[floraId];
    const geo = buildFloraVariant(def, variant, tier);
    s = this.makeSlot(geo, def, 64, tier);
    this.slots.set(key, s);
    return s;
  }

  private makeSlot(geo: THREE.BufferGeometry, def: FloraDef, capacity: number, tier: number): MeshSlot {
    const mesh = new THREE.InstancedMesh(geo, this.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const inst = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    geo.setAttribute('aInst', inst);
    mesh.count = 0;
    mesh.frustumCulled = false;
    const big = def.kind !== 'grass' && def.kind !== 'pebble' && def.kind !== 'vine' && def.kind !== 'glowcap' && def.kind !== 'stalactite';
    mesh.castShadow = big && tier === 0;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return { mesh, capacity, def, inst, tier };
  }

  private grow(s: MeshSlot, need: number): void {
    let cap = s.capacity;
    while (cap < need) cap *= 2;
    const geo = s.mesh.geometry;
    this.group.remove(s.mesh);
    s.mesh.dispose();
    const fresh = this.makeSlot(geo, s.def, cap, s.tier);
    s.mesh = fresh.mesh;
    s.capacity = cap;
    s.inst = fresh.inst;
  }

  setChunkProps(key: string, level: number, data: Float32Array | null): void {
    if (!data) {
      if (this.chunks.delete(key)) this.dirty = true;
      return;
    }
    this.chunks.set(key, this.prepare(level, data));
    this.dirty = true;
  }

  private prepare(level: number, data: Float32Array): ChunkProps {
    const counts = new Map<number, number>();
    const n = data.length / PROP_STRIDE;
    const tier = level <= 1 ? 0 : 1;
    for (let i = 0; i < n; i++) {
      const o = i * PROP_STRIDE;
      if (this.destroyed.has(data[o + 10])) continue;
      const key = slotKey(data[o], data[o + 1], this.params.flora[data[o]].maxLevel >= 2 ? tier : 0);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const groups = new Map<number, ChunkGroup>();
    for (const [k, c] of counts) groups.set(k, { mats: new Float32Array(c * 16), cols: new Float32Array(c * 3), inst: new Float32Array(c * 4), count: 0 });
    const colliders: Collider[] = [];
    for (let i = 0; i < n; i++) {
      const o = i * PROP_STRIDE;
      const uid = data[o + 10];
      if (this.destroyed.has(uid)) continue;
      const fid = data[o], variant = data[o + 1];
      const def = this.params.flora[fid];
      const g = groups.get(slotKey(fid, variant, def.maxLevel >= 2 ? tier : 0))!;
      _p.set(data[o + 2], data[o + 3], data[o + 4]);
      _u.set(data[o + 5], data[o + 6], data[o + 7]);
      const scale = data[o + 9];
      _q.setFromUnitVectors(Y, _u);
      _q2.setFromAxisAngle(Y, data[o + 8]);
      _q.multiply(_q2);
      _s.setScalar(scale);
      _m.compose(_p, _q, _s);
      _m.toArray(g.mats, g.count * 16);
      const t = floraTint(uid);
      g.cols.set(t, g.count * 3);
      g.inst[g.count * 4] = data[o + 11];
      g.inst[g.count * 4 + 1] = hash01(uid) * 20;
      g.inst[g.count * 4 + 2] = 1;
      g.count++;
      if (def.collider > 0 && level <= 1) {
        colliders.push({ x: _p.x, y: _p.y, z: _p.z, ux: _u.x, uy: _u.y, uz: _u.z, r: def.collider * scale, h: def.colliderHeight * scale, uid });
      }
    }
    return { level, data, groups, colliders };
  }

  update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const totals = new Map<number, number>();
    for (const c of this.chunks.values()) for (const [k, g] of c.groups) totals.set(k, (totals.get(k) ?? 0) + g.count);
    this.instanceCount = 0;
    for (const [k, s] of this.slots) {
      const need = totals.get(k) ?? 0;
      if (need > s.capacity) this.grow(s, need);
      let off = 0;
      const mArr = s.mesh.instanceMatrix.array as Float32Array;
      const cArr = s.mesh.instanceColor!.array as Float32Array;
      const iArr = s.inst.array as Float32Array;
      if (need > 0)
        for (const c of this.chunks.values()) {
          const g = c.groups.get(k);
          if (!g || g.count === 0) continue;
          mArr.set(g.mats.subarray(0, g.count * 16), off * 16);
          cArr.set(g.cols.subarray(0, g.count * 3), off * 3);
          iArr.set(g.inst.subarray(0, g.count * 4), off * 4);
          off += g.count;
        }
      s.mesh.count = off;
      s.mesh.instanceMatrix.needsUpdate = true;
      s.mesh.instanceColor!.needsUpdate = true;
      s.inst.needsUpdate = true;
      this.instanceCount += off;
    }
    this.colliders = [];
    for (const c of this.chunks.values()) for (const col of c.colliders) this.colliders.push(col);
  }

  /** Capsule colliders for trees, big fungi, crystals and rocks. */
  resolveSphere(center: THREE.Vector3, radius: number, push: THREE.Vector3, normal: THREE.Vector3): boolean {
    let best = 0;
    for (const c of this.colliders) {
      const reach = c.r + c.h + radius;
      if (Math.abs(center.x - c.x) > reach || Math.abs(center.z - c.z) > reach || Math.abs(center.y - c.y) > reach) continue;
      // Closest point on the capsule axis
      const dx = center.x - c.x, dy = center.y - c.y, dz = center.z - c.z;
      const t = Math.max(0, Math.min(c.h, dx * c.ux + dy * c.uy + dz * c.uz));
      const px = c.x + c.ux * t, py = c.y + c.uy * t, pz = c.z + c.uz * t;
      const ex = center.x - px, ey = center.y - py, ez = center.z - pz;
      const d = Math.hypot(ex, ey, ez);
      const pen = c.r + radius - d;
      if (pen > best && d > 1e-4) {
        best = pen;
        normal.set(ex / d, ey / d, ez / d);
        push.copy(normal).multiplyScalar(pen);
      }
    }
    return best > 0;
  }

  /** Destroys every prop within the sphere; returns what was destroyed (for debris). */
  destroyInSphere(center: THREE.Vector3, radius: number): DestroyedProp[] {
    const out: DestroyedProp[] = [];
    for (const [key, c] of this.chunks) {
      const n = c.data.length / PROP_STRIDE;
      let changed = false;
      for (let i = 0; i < n; i++) {
        const o = i * PROP_STRIDE;
        const uid = c.data[o + 10];
        if (this.destroyed.has(uid)) continue;
        const def = this.params.flora[c.data[o]];
        const scale = c.data[o + 9];
        const reach = radius + Math.max(def.collider, 0.4) * scale;
        const dx = c.data[o + 2] - center.x, dy = c.data[o + 3] - center.y, dz = c.data[o + 4] - center.z;
        if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
        this.destroyed.add(uid);
        changed = true;
        out.push({
          def,
          position: new THREE.Vector3(c.data[o + 2], c.data[o + 3], c.data[o + 4]),
          up: new THREE.Vector3(c.data[o + 5], c.data[o + 6], c.data[o + 7]),
          scale,
        });
      }
      if (changed) this.chunks.set(key, this.prepare(c.level, c.data));
    }
    if (out.length) this.dirty = true;
    return out;
  }
}
