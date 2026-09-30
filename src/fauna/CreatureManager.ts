import * as THREE from 'three';
import { World } from '../world/World';
import { Creature, PrimSink, Species } from './Creature';
import { PrimitiveBatch, Prim, PrimStyle } from '../render/Primitives';
import { Debris } from '../render/Effects';
import { RNG } from '../core/rng';

interface Flock {
  center: THREE.Vector3;
  vel: THREE.Vector3;
  members: Creature[];
  altitude: number;
  phase: number;
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Converts rendered parts into flying debris (used when a creature is killed). */
class DebrisCapture implements PrimSink {
  constructor(private debris: Debris, private center: THREE.Vector3, private power: number) {}
  add(p: Prim, m: THREE.Matrix4, st: PrimStyle): void {
    m.decompose(_p, _q, _s);
    const dir = _v.subVectors(_p, this.center).normalize().add(new THREE.Vector3(0, 0.8, 0));
    this.debris.spawn(p, _p, _q, _s, dir.multiplyScalar(this.power * (0.5 + Math.random())), st, 6 + Math.random() * 4);
  }
}

/** Populates the surroundings of the player with fauna appropriate to the local habitat. */
export class CreatureManager {
  readonly creatures: Creature[] = [];
  private flocks: Flock[] = [];
  private species = new Map<number, Species>();
  private rng: RNG;
  private spawnTimer = 0;
  private nextId = 1;
  maxWalkers = 30;
  maxFlyers = 24;
  maxFloaters = 6;

  constructor(private world: World, private batch: PrimitiveBatch, private debris: Debris) {
    this.rng = new RNG(world.params.seed ^ 0xfa11a);
  }

  speciesFor(id: number): Species {
    let s = this.species.get(id);
    if (!s) this.species.set(id, (s = new Species(this.world.params.fauna[id])));
    return s;
  }

  add(speciesId: number, pos: THREE.Vector3): Creature {
    const c = new Creature(this.speciesFor(speciesId), pos, this.rng, this.nextId++);
    this.creatures.push(c);
    return c;
  }

  update(dt: number, t: number, player: THREE.Vector3, underground: number, frame: number): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 0.7;
      this.despawn(player);
      this.trySpawn(player, underground);
    }
    for (const f of this.flocks) {
      // Flock centres wander above the terrain
      const col = this.world.terrain.columnAt(f.center.x, f.center.z);
      const ground = Math.max(col.h, this.world.params.seaLevel);
      f.phase += dt * 0.1;
      const want = _v.set(Math.cos(f.phase * 1.3) * 9, (ground + f.altitude - f.center.y) * 0.3, Math.sin(f.phase) * 9);
      f.vel.lerp(want, dt * 0.4);
      f.center.addScaledVector(f.vel, dt);
    }
    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i];
      const d2 = c.pos.distanceToSquared(player);
      const near = d2 < 70 * 70;
      // Far creatures update at a lower rate
      if (!near && (frame + i) % 3 !== 0) continue;
      c.update(near ? dt : dt * 3, this.world, t, near);
      if ((frame + i) % 40 === 0) c.sky = this.world.skyVisibility(c.pos.x, c.pos.y + 0.5, c.pos.z);
    }
  }

  render(): void {
    for (const c of this.creatures) c.render(this.batch);
  }

  private despawn(player: THREE.Vector3): void {
    for (let i = this.creatures.length - 1; i >= 0; i--) {
      const c = this.creatures[i];
      if (c.sp.def.plan === 'sapient') continue;
      const d = c.pos.distanceTo(player);
      const lim = c.sp.def.plan === 'flyer' || c.sp.def.habitat === 'sky' ? 420 : 240;
      if (d > lim || !Number.isFinite(c.pos.x)) this.remove(c);
    }
    this.flocks = this.flocks.filter((f) => f.members.some((m) => m.alive));
  }

  remove(c: Creature): void {
    c.alive = false;
    const i = this.creatures.indexOf(c);
    if (i >= 0) this.creatures.splice(i, 1);
  }

  private count(pred: (c: Creature) => boolean): number {
    let n = 0;
    for (const c of this.creatures) if (pred(c)) n++;
    return n;
  }

  private trySpawn(player: THREE.Vector3, underground: number): void {
    const P = this.world.params;
    const T = this.world.terrain;
    const r = this.rng;
    const walkers = this.count((c) => c.sp.def.plan !== 'flyer' && c.sp.def.plan !== 'floater' && c.sp.def.plan !== 'sapient');
    const flyers = this.count((c) => c.sp.def.plan === 'flyer');
    const floaters = this.count((c) => c.sp.def.plan === 'floater');

    if (underground > 0.5) {
      // Caves and the underworld: spawn at the player's depth on nearby floors.
      if (walkers >= this.maxWalkers * 0.6) return;
      const col = T.columnAt(player.x, player.z);
      const inUnder = player.y < col.uC + 20 && player.y > col.uF - 20;
      const list = inUnder ? P.underFauna : P.caveFauna;
      const id = r.pick(list);
      const def = P.fauna[id];
      const a = r.next() * Math.PI * 2;
      const dist = r.range(20, 55);
      const x = player.x + Math.cos(a) * dist, z = player.z + Math.sin(a) * dist;
      if (def.plan === 'floater') {
        if (floaters >= this.maxFloaters) return;
        const c2 = T.columnAt(x, z);
        if (c2.uOpen < 20) return;
        this.add(id, new THREE.Vector3(x, c2.uF + 10, z));
        return;
      }
      const g = this.world.groundBelow(x, player.y + 8, z, 40);
      if (g === null || Math.abs(g - player.y) > 30) return;
      const n = r.int(def.herd[0], def.herd[1]);
      let leader: Creature | null = null;
      for (let k = 0; k < n; k++) {
        const c = this.add(id, new THREE.Vector3(x + r.range(-3, 3), g + 0.5, z + r.range(-3, 3)));
        this.world.snap(c.pos, c.up, 4);
        c.leader = leader ?? c;
        leader = leader ?? c;
      }
      return;
    }

    // Surface fauna from the local biome
    if (walkers < this.maxWalkers) {
      const a = r.next() * Math.PI * 2;
      const dist = r.range(45, 150);
      const x = player.x + Math.cos(a) * dist, z = player.z + Math.sin(a) * dist;
      const col = T.columnAt(x, z);
      if (col.h > P.seaLevel + 1 && col.settle < 0.3) {
        const biome = P.biomes[r.chance(1 - col.w1) ? col.b0 : col.b1];
        if (biome.fauna.length) {
          const id = r.pick(biome.fauna);
          const def = P.fauna[id];
          if (def.plan === 'floater') {
            if (floaters < this.maxFloaters) this.add(id, new THREE.Vector3(x, col.h + 12, z));
          } else {
            const g = this.world.groundBelow(x, col.top + 2, z, col.top - col.h + 40);
            if (g !== null) {
              const n = r.int(def.herd[0], def.herd[1]);
              let leader: Creature | null = null;
              for (let k = 0; k < n; k++) {
                const c = this.add(id, new THREE.Vector3(x + r.range(-4, 4), g + 1, z + r.range(-4, 4)));
                this.world.snap(c.pos, c.up, 6);
                c.leader = leader ?? c;
                leader = leader ?? c;
              }
            }
          }
        }
      }
    }
    if (flyers < this.maxFlyers && r.chance(0.35)) {
      const id = r.pick(P.skyFauna.filter((f) => P.fauna[f].plan === 'flyer'));
      const def = P.fauna[id];
      const a = r.next() * Math.PI * 2;
      const dist = r.range(120, 300);
      const center = new THREE.Vector3(player.x + Math.cos(a) * dist, 0, player.z + Math.sin(a) * dist);
      const col = T.columnAt(center.x, center.z);
      const altitude = r.range(25, 70);
      center.y = Math.max(col.h, P.seaLevel) + altitude;
      const flock: Flock = { center, vel: new THREE.Vector3(r.range(-6, 6), 0, r.range(-6, 6)), members: [], altitude, phase: r.next() * 10 };
      const n = r.int(def.herd[0], def.herd[1]);
      for (let k = 0; k < n; k++) {
        const c = this.add(id, center.clone().add(new THREE.Vector3(r.range(-8, 8), r.range(-3, 3), r.range(-8, 8))));
        c.flock = flock;
        c.vel.copy(flock.vel);
        flock.members.push(c);
      }
      this.flocks.push(flock);
    }
    if (floaters < 3 && r.chance(0.1)) {
      const big = P.skyFauna.find((f) => P.fauna[f].plan === 'floater');
      if (big !== undefined) {
        const a = r.next() * Math.PI * 2;
        const x = player.x + Math.cos(a) * 250, z = player.z + Math.sin(a) * 250;
        const c = this.add(big, new THREE.Vector3(x, 0, z));
        c.pos.y = Math.max(T.columnAt(x, z).h, P.seaLevel) + c.altitude;
      }
    }
  }

  /** Something loud happened: nearby creatures flee, those within `killRadius` die. */
  explosion(center: THREE.Vector3, killRadius: number, scareRadius: number): number {
    let killed = 0;
    for (const c of [...this.creatures]) {
      const d = c.pos.distanceTo(center);
      if (d < killRadius + c.sp.s * 0.5) {
        c.render(new DebrisCapture(this.debris, center, 9));
        this.remove(c);
        killed++;
      } else if (d < scareRadius) c.scare(center);
    }
    return killed;
  }

  scareAround(center: THREE.Vector3, radius: number): void {
    for (const c of this.creatures) if (c.pos.distanceTo(center) < radius && c.sp.def.plan !== 'sapient') c.scare(center);
  }

  /** Closest creature to a ray, for the scanner. */
  pick(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): Creature | null {
    let best: Creature | null = null;
    let bestT = maxDist;
    for (const c of this.creatures) {
      const center = c.plan === 'floater' || c.plan === 'flyer' ? c.pos : c.segs[0];
      _v.subVectors(center, origin);
      const t = _v.dot(dir);
      if (t < 0 || t > bestT) continue;
      const d2 = _v.lengthSq() - t * t;
      const r = c.sp.s * 0.7 + 0.5;
      if (d2 < r * r) {
        best = c;
        bestT = t;
      }
    }
    return best;
  }
}
