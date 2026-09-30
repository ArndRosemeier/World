import * as THREE from 'three';
import { World } from '../world/World';
import { Settlement, Piece } from './Settlement';
import { PrimitiveBatch, Prim, trsMatrix } from '../render/Primitives';
import { Debris, Particles } from '../render/Effects';
import { CreatureManager } from '../fauna/CreatureManager';
import { Creature } from '../fauna/Creature';
import { ColliderSource } from '../player/Player';
import { Script } from './Glyphs';
import { RNG } from '../core/rng';
import { SiteInfo } from '../world/Terrain';

interface Villager {
  c: Creature;
  s: Settlement;
  home: number;
  timer: number;
  bubble: THREE.Sprite | null;
  bubbleTimer: number;
  greeted: boolean;
  afraid: number;
}

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _local = new THREE.Vector3();
const _closest = new THREE.Vector3();

export class SettlementManager implements ColliderSource {
  readonly settlements = new Map<string, Settlement>();
  readonly destroyed = new Map<string, Set<number>>();
  private villagers: Villager[] = [];
  private staticDirty = true;
  readonly scripts: Script[];
  private rng: RNG;
  private timer = 0;
  loadRadius = 1400;
  onDiscover: (s: Settlement) => void = () => {};
  onGreet: (s: Settlement) => void = () => {};

  constructor(
    private world: World,
    private staticBatch: PrimitiveBatch,
    private dynamicBatch: PrimitiveBatch,
    private creatures: CreatureManager,
    private debris: Debris,
    private sparks: Particles,
    private scene: THREE.Scene,
  ) {
    this.scripts = world.params.civs.map((c) => new Script(c.lang.glyphSeed + c.id * 101));
    this.rng = new RNG(world.params.seed ^ 0xc1c1);
  }

  /** Settlement sites (not necessarily loaded) around a point, for the map and compass. */
  sitesNear(x: number, z: number, radius: number): SiteInfo[] {
    const out: SiteInfo[] = [];
    this.world.params.civs.forEach((civ, i) => {
      const cs = civ.cellSize;
      const r = Math.ceil(radius / cs);
      const cx = Math.floor(x / cs), cz = Math.floor(z / cs);
      for (let a = -r; a <= r; a++)
        for (let b = -r; b <= r; b++) {
          const s = this.world.terrain.siteCell(i, cx + a, cz + b);
          if (s && Math.hypot(s.x - x, s.z - z) < radius) out.push(s);
        }
    });
    return out;
  }

  update(dt: number, t: number, player: THREE.Vector3, night: number): void {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 1;
      this.stream(player);
    }
    if (this.staticDirty) this.rebuildStatic();

    for (const s of this.settlements.values()) {
      const d = Math.hypot(player.x - s.center.x, player.z - s.center.z);
      const vertical = Math.abs(player.y - s.center.y);
      if (!s.discovered && d < s.site.r + 20 && vertical < 60) {
        s.discovered = true;
        this.onDiscover(s);
      }
      if (!s.villagersSpawned && d < 320 && vertical < 150) this.spawnVillagers(s);
      if (s.villagersSpawned && d > 420) this.despawnVillagers(s);
    }
    this.updateVillagers(dt, t, player, night);
  }

  private stream(player: THREE.Vector3): void {
    const sites = this.sitesNear(player.x, player.z, this.loadRadius);
    const keep = new Set<string>();
    for (const site of sites) {
      const key = `${site.civ.id}:${site.cx}:${site.cz}`;
      // The underworld is only streamed when the player is below ground, and vice versa.
      if (site.layer === 'under' && player.y > site.y + 260) continue;
      if (site.layer === 'surface' && player.y < site.y - 200) continue;
      keep.add(key);
      if (!this.settlements.has(key)) {
        if (!this.destroyed.has(key)) this.destroyed.set(key, new Set());
        const s = new Settlement(site, this.world, this.destroyed.get(key)!);
        s.sky = this.world.skyVisibility(s.center.x, s.center.y + 3, s.center.z);
        this.settlements.set(key, s);
        this.staticDirty = true;
      }
    }
    for (const [key, s] of this.settlements) {
      if (!keep.has(key)) {
        this.despawnVillagers(s);
        this.settlements.delete(key);
        this.staticDirty = true;
      }
    }
  }

  private rebuildStatic(): void {
    this.staticDirty = false;
    const B = this.staticBatch;
    B.begin();
    for (const s of this.settlements.values()) {
      const sky = s.sky;
      for (const p of s.pieces) if (p.alive) B.add(p.prim, p.m, { ...p.style, sky });
    }
    B.end();
  }

  /** Animated parts (floating orbs, fires) are drawn every frame. */
  renderDynamic(t: number, night: number): void {
    for (const s of this.settlements.values()) {
      for (const d of s.dynamics) {
        if (!d.alive) continue;
        if (d.kind === 'orb') {
          _p.copy(d.pos).setY(d.pos.y + Math.sin(t * 0.8) * 0.5);
          _q.setFromAxisAngle(_v.set(0, 1, 0), t * 0.3);
          this.dynamicBatch.add(Prim.Sphere, trsMatrix(_p, _q, d.size, d.size, d.size, _m), { ...d.style, color2: s.civ.trim, pattern: 4, freq: 2, emissive: 2.2 + Math.sin(t * 2) * 0.3, sky: s.sky });
        } else {
          const f = 1 + Math.sin(t * 13) * 0.08 + Math.sin(t * 7.3) * 0.1;
          this.dynamicBatch.add(Prim.Cone, trsMatrix(d.pos, _q.identity(), 0.7 * f, (1.2 + night * 0.8) * f, 0.7 * f, _m), { color: s.civ.glow, emissive: 2.6 + night });
          if (Math.random() < 0.3) this.sparks.emit(_p.copy(d.pos).setY(d.pos.y + 1), _v.set((Math.random() - 0.5) * 0.6, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 0.6), s.civ.glow, 0.25, 1.5, { drag: 0.8 });
        }
      }
    }
  }

  // --- Villagers -----------------------------------------------------------------------------

  private spawnVillagers(s: Settlement): void {
    s.villagersSpawned = true;
    const civ = s.civ;
    const n = Math.min(24, Math.round(s.buildings.filter((b) => !b.collapsed).length * 1.4) + 2);
    const r = new RNG(s.site.seed ^ 77);
    for (let i = 0; i < n; i++) {
      const home = r.int(0, Math.max(0, s.buildings.length - 1));
      const b = s.buildings[home];
      const at = b ? b.door.clone() : s.plaza.clone().add(new THREE.Vector3(r.range(-8, 8), 0, r.range(-8, 8)));
      at.y += 1;
      const c = this.creatures.add(civ.body.id, at);
      this.world.snap(c.pos, c.up, 6);
      c.setState('idle');
      c.stateTime = r.range(0, 5);
      c.sky = s.sky;
      this.villagers.push({ c, s, home, timer: r.range(1, 6), bubble: null, bubbleTimer: 0, greeted: false, afraid: 0 });
    }
  }

  private despawnVillagers(s: Settlement): void {
    if (!s.villagersSpawned) return;
    s.villagersSpawned = false;
    this.villagers = this.villagers.filter((v) => {
      if (v.s !== s) return true;
      this.creatures.remove(v.c);
      this.clearBubble(v);
      return false;
    });
  }

  private updateVillagers(dt: number, t: number, player: THREE.Vector3, night: number): void {
    for (let i = this.villagers.length - 1; i >= 0; i--) {
      const v = this.villagers[i];
      const c = v.c;
      if (!c.alive) {
        this.clearBubble(v);
        this.villagers.splice(i, 1);
        continue;
      }
      const s = v.s;
      const dp = c.pos.distanceTo(player);
      v.afraid = Math.max(0, v.afraid - dt);
      c.carry = night > 0.5 && (c.id % 3 === 0) ? 1 : 0;

      if (v.afraid > 0) {
        if (c.state !== 'flee') c.setState('flee');
        c.stateTime = 0;
        this.showBubble(v, true);
      } else if (dp < 7 && c.state !== 'flee') {
        // Curious: stop, face the visitor and talk
        if (c.state !== 'talk') {
          c.setState('talk');
          if (!v.greeted) {
            v.greeted = true;
            this.onGreet(s);
          }
        }
        c.lookAt = _v.copy(player).add(new THREE.Vector3(0, 1.5, 0)).clone();
        _v.subVectors(player, c.pos);
        const cross = new THREE.Vector3().crossVectors(c.fwd, _v.normalize()).dot(c.up);
        c.turn = cross * 2;
        this.showBubble(v, false);
      } else {
        c.lookAt = null;
        if (c.state === 'talk' || c.state === 'flee') c.setState('idle');
        if (v.bubble && v.bubbleTimer <= 0) this.clearBubble(v);
        v.timer -= dt;
        if (c.state === 'walkTo' && c.pos.distanceTo(c.target) < 1.6) {
          c.setState('idle');
          v.timer = 2 + Math.random() * 6;
        }
        if (v.timer <= 0 && c.state !== 'walkTo') {
          // Pick an errand: another house, the plaza, or home. At night most gather at the fire.
          const r = Math.random();
          const alive = s.buildings.filter((b) => !b.collapsed);
          if (night > 0.5 && r < 0.6) {
            const a = Math.random() * Math.PI * 2;
            c.target.copy(s.plaza).add(new THREE.Vector3(Math.cos(a) * 5, 0, 7.5 + Math.sin(a) * 5));
          } else if (r < 0.35 || !alive.length) {
            c.target.copy(s.plaza).add(new THREE.Vector3((Math.random() - 0.5) * 16, 0, (Math.random() - 0.5) * 16));
          } else {
            c.target.copy(alive[Math.floor(Math.random() * alive.length)].door);
          }
          c.setState('walkTo');
          v.timer = 20;
        }
      }
      if (v.bubble) {
        v.bubbleTimer -= dt;
        v.bubble.position.copy(c.head).addScaledVector(c.up, c.sp.headR * 2.2 + 0.4);
        if (v.bubbleTimer <= -2) this.clearBubble(v);
      }
    }
    void t;
  }

  private showBubble(v: Villager, exclaim: boolean): void {
    if (v.bubble && v.bubbleTimer > 0) return;
    this.clearBubble(v);
    const civ = v.s.civ;
    const tex = this.scripts[civ.id].bubble(Math.floor(Math.random() * 1e9), civ.glow, exclaim);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
    const sp = new THREE.Sprite(mat);
    const h = 0.55;
    sp.scale.set(h * tex.userData.aspect, h, 1);
    sp.renderOrder = 10;
    this.scene.add(sp);
    v.bubble = sp;
    v.bubbleTimer = exclaim ? 1.5 : 3 + Math.random() * 2;
  }

  private clearBubble(v: Villager): void {
    if (!v.bubble) return;
    this.scene.remove(v.bubble);
    v.bubble.material.map?.dispose();
    v.bubble.material.dispose();
    v.bubble = null;
  }

  // --- Destruction & alarms ------------------------------------------------------------------

  damage(center: THREE.Vector3, radius: number, power: number): number {
    let n = 0;
    for (const [key, s] of this.settlements) {
      if (s.center.distanceTo(center) > s.site.r * 1.6 + radius) continue;
      const broken = s.damage(center, radius);
      if (broken.length) {
        this.staticDirty = true;
        const set = this.destroyed.get(key)!;
        for (const idx of s.destroyedIndices()) set.add(idx);
        for (const p of broken) this.toDebris(p, center, power);
        n += broken.length;
      }
      for (const d of s.dynamics) if (d.alive && d.pos.distanceTo(center) < radius + d.size) d.alive = false;
    }
    this.alarm(center, 70);
    return n;
  }

  private toDebris(p: Piece, center: THREE.Vector3, power: number): void {
    p.m.decompose(_p, _q, _s);
    const dir = _v.copy(p.center).sub(center);
    const dist = Math.max(1, dir.length());
    dir.normalize().add(new THREE.Vector3(0, 0.6, 0));
    const speed = (power * 12) / Math.sqrt(dist) + Math.random() * 2;
    // Big pieces break into a few chunks so collapses look like rubble, not rigid blocks
    const big = Math.max(_s.x, _s.y, _s.z) > 3.5 && p.prim !== Prim.Torus;
    if (big) {
      const k = 4 + Math.floor(Math.random() * 4);
      const sz = Math.max(_s.x, _s.y, _s.z);
      for (let i = 0; i < k; i++) {
        const off = new THREE.Vector3((Math.random() - 0.5) * sz, Math.random() * sz * 0.8, (Math.random() - 0.5) * sz).multiplyScalar(0.6);
        const pos = p.center.clone().add(off);
        const s = sz * (0.2 + Math.random() * 0.22);
        this.debris.spawn(Math.random() < 0.5 ? Prim.Box : p.prim === Prim.Sphere || p.prim === Prim.Dome ? Prim.Sphere : Prim.Box, pos,
          new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, 0)), new THREE.Vector3(s, s * 0.7, s * 0.9),
          dir.clone().multiplyScalar(speed * (0.6 + Math.random() * 0.6)).add(off.multiplyScalar(0.4)), p.style, 12 + Math.random() * 6);
      }
    } else {
      this.debris.spawn(p.prim, _p, _q, _s, dir.multiplyScalar(speed), p.style, 12 + Math.random() * 6);
    }
  }

  /** Villagers near a disturbance become afraid and scatter. */
  alarm(center: THREE.Vector3, radius: number): void {
    for (const v of this.villagers) {
      if (v.c.pos.distanceTo(center) < radius) {
        v.afraid = 12;
        v.c.scare(center);
      }
    }
  }

  // --- Collision -----------------------------------------------------------------------------

  resolveSphere(center: THREE.Vector3, radius: number, push: THREE.Vector3, normal: THREE.Vector3): boolean {
    let best = 0;
    for (const s of this.settlements.values()) {
      if (Math.abs(center.x - s.center.x) > s.site.r * 1.4 || Math.abs(center.z - s.center.z) > s.site.r * 1.4) continue;
      for (const p of s.pieces) {
        if (!p.alive || !p.solid) continue;
        const reach = p.radius * 1.8 + radius;
        if (Math.abs(center.x - p.center.x) > reach || Math.abs(center.y - p.center.y) > reach || Math.abs(center.z - p.center.z) > reach) continue;
        let pen = 0;
        if (p.prim === Prim.Sphere || p.prim === Prim.Dome) {
          // Ellipsoids: approximate by scaling into unit space
          _local.copy(center).applyMatrix4(p.inv);
          const l = _local.length();
          if (p.prim === Prim.Dome && _local.y < 0) continue;
          if (l > 1 + radius / Math.max(0.3, p.radius * 0.4)) continue;
          _closest.copy(_local).multiplyScalar(1 / Math.max(l, 1e-4)).applyMatrix4(p.m);
          const d = center.distanceTo(_closest);
          const inside = l < 1;
          pen = inside ? radius + d : radius - d;
          if (pen <= 0) continue;
          normal.subVectors(center, _closest).normalize();
          if (inside) normal.negate();
        } else {
          _local.copy(center).applyMatrix4(p.inv);
          const box = p.prim === Prim.Box;
          const minY = box ? -0.5 : 0, maxY = box ? 0.5 : 1;
          const ext = box ? 0.5 : p.prim === Prim.Cone ? 1 - Math.min(1, Math.max(0, _local.y)) * 0.9 : 0.95;
          _closest.set(clamp(_local.x, -ext, ext), clamp(_local.y, minY, maxY), clamp(_local.z, -ext, ext));
          const inside = _closest.equals(_local);
          _closest.applyMatrix4(p.m);
          const d = center.distanceTo(_closest);
          if (inside) {
            // Push out through the nearest face (upward preferred so you can stand on things)
            _closest.set(0, maxY, 0).applyMatrix4(p.m);
            normal.set(0, 1, 0);
            pen = Math.max(0.05, _closest.y - center.y + radius);
            if (pen > 1.5) continue;
          } else {
            if (d >= radius) continue;
            pen = radius - d;
            normal.subVectors(center, _closest).normalize();
          }
        }
        if (pen > best) {
          best = pen;
          push.copy(normal).multiplyScalar(pen);
          _v.copy(normal);
        }
      }
    }
    if (best > 0) {
      normal.copy(_v);
      return true;
    }
    return false;
  }

  /** The settlement the point is inside, if any. */
  at(p: THREE.Vector3): Settlement | null {
    for (const s of this.settlements.values()) if (Math.hypot(p.x - s.center.x, p.z - s.center.z) < s.site.r * 1.1 && Math.abs(p.y - s.center.y) < 60) return s;
    return null;
  }

  serialize(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const [k, v] of this.destroyed) if (v.size) out[k] = [...v];
    return out;
  }

  load(data: Record<string, number[]>): void {
    for (const k in data) this.destroyed.set(k, new Set(data[k]));
  }
}

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}
