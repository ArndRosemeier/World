import * as THREE from 'three';
import { FaunaDef } from '../world/WorldParams';
import { World } from '../world/World';
import { Prim, PrimStyle, segmentMatrix, trsMatrix } from '../render/Primitives';
import { RNG } from '../core/rng';
import { RGB, clamp, lerp, mixRGB, scaleRGB } from '../core/math';

// ---------------------------------------------------------------------------------------------
// Procedural creatures: a body plan (segmented spine, legs, head, tail, wings, tentacles) is
// derived from the species genome and animated procedurally: legs plant feet on the real
// terrain and step with two-bone IK, bodies follow the spine, hoppers jump ballistically in
// the local gravity, flyers flap and glide, floaters drift with trailing tentacles.
// ---------------------------------------------------------------------------------------------

export interface PrimSink {
  add(p: Prim, m: THREE.Matrix4, st: PrimStyle): void;
}

export interface LegDef {
  seg: number;
  side: number;
  out: number;
  along: number;
  upper: number;
  lower: number;
  group: number;
  radius: number;
}

/** Everything about a species' body that doesn't change per individual. */
export class Species {
  readonly def: FaunaDef;
  readonly s: number;
  readonly segCount: number;
  readonly spacing: number;
  readonly segR: [number, number, number][];
  readonly bodyHeight: number;
  readonly legs: LegDef[] = [];
  readonly headR: number;
  readonly neck: number;
  readonly eyes: { x: number; y: number; z: number; r: number }[] = [];
  readonly horns: { x: number; y: number; z: number; len: number; tilt: number }[] = [];
  readonly tailSegs: number;
  readonly tailLen: number;
  readonly upright: boolean;
  readonly stepLen: number;
  readonly stepTime: number;
  readonly body: PrimStyle;
  readonly limb: PrimStyle;
  readonly eyeStyle: PrimStyle;
  readonly hornStyle: PrimStyle;
  readonly crest: boolean;

  constructor(def: FaunaDef) {
    this.def = def;
    const r = new RNG(def.seed);
    const s = def.size;
    this.s = s;
    this.upright = def.plan === 'sapient';
    this.segCount = Math.max(1, def.segments);
    this.spacing = (s * (def.plan === 'crawler' ? 0.45 : 0.6)) / Math.max(1, this.segCount * 0.6);
    this.segR = [];
    for (let i = 0; i < this.segCount; i++) {
      const t = this.segCount === 1 ? 0.5 : i / (this.segCount - 1);
      const bulge = Math.sin((0.2 + t * 0.8) * Math.PI) * 0.35 + 0.65;
      const w = s * 0.22 * def.bulk * bulge * (def.plan === 'crawler' ? 0.9 : 1);
      this.segR.push([w, w * r.range(0.7, 1.0), this.spacing * 0.75 + w * 0.35]);
    }
    const legLen = s * def.legLength * 0.7;
    this.bodyHeight = def.plan === 'crawler' ? legLen * 0.45 : def.plan === 'floater' || def.plan === 'flyer' ? 0 : legLen * 0.82;
    const pairs = def.legPairs;
    for (let i = 0; i < pairs; i++) {
      const seg = pairs === 1 ? Math.floor(this.segCount / 2) : Math.round((i / Math.max(1, pairs - 1)) * (this.segCount - 1));
      for (const side of [-1, 1]) {
        this.legs.push({
          seg, side,
          out: 0.8,
          along: def.plan === 'crawler' ? 0 : (pairs === 1 ? 0 : (0.5 - i / Math.max(1, pairs - 1)) * 0.4 * s),
          upper: legLen * (def.plan === 'crawler' ? 0.6 : 0.55),
          lower: legLen * (def.plan === 'crawler' ? 0.75 : 0.62),
          group: (i + (side > 0 ? 1 : 0)) % 2,
          radius: s * 0.045 * def.bulk,
        });
      }
    }
    this.headR = s * (this.upright ? 0.16 : 0.17) * r.range(0.8, 1.25);
    this.neck = s * def.neck * 0.7;
    const nEyes = def.eyes;
    for (let i = 0; i < nEyes; i++) {
      const row = Math.floor(i / 2);
      const side = nEyes === 1 ? 0 : i % 2 === 0 ? -1 : 1;
      this.eyes.push({ x: side * 0.45, y: 0.35 + row * 0.25, z: 0.7 - row * 0.15, r: (0.2 - row * 0.03) * (nEyes === 1 ? 1.6 : 1) });
    }
    for (let i = 0; i < def.horns; i++) {
      const side = def.horns === 1 ? 0 : i % 2 === 0 ? -1 : 1;
      this.horns.push({ x: side * 0.4, y: 0.7, z: 0.1 - Math.floor(i / 2) * 0.3, len: r.range(0.6, 1.6), tilt: r.range(-0.5, 0.7) });
    }
    this.crest = r.chance(0.35);
    this.tailSegs = def.tail > 0.05 ? Math.max(2, Math.round(def.tail * 6)) : 0;
    this.tailLen = s * def.tail * 0.8;
    this.stepLen = legLen * 0.7 + 0.1;
    this.stepTime = clamp(0.18 + legLen * 0.12, 0.15, 0.5);
    const glow = def.glow;
    this.body = { color: def.color, color2: def.color2, pattern: glow > 0.3 ? (def.pattern || 2) : def.pattern, freq: def.patternFreq, emissive: glow > 0.3 ? glow * 0.9 : 0 };
    this.limb = { color: mixRGB(def.color, def.color2, 0.4), color2: scaleRGB(def.color, 0.6), pattern: 3, freq: 4 };
    this.eyeStyle = { color: def.eye, emissive: glow > 0 || def.eye[0] + def.eye[1] + def.eye[2] > 1.4 ? 2.2 : 0 };
    this.hornStyle = { color: scaleRGB(mixRGB(def.color2, [0.9, 0.85, 0.75], 0.6), 0.9), emissive: glow > 0.5 ? 0.5 : 0, color2: def.color2 };
  }
}

interface Leg {
  def: LegDef;
  foot: THREE.Vector3;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
}

export type CState = 'wander' | 'graze' | 'flee' | 'follow' | 'idle' | 'walkTo' | 'talk';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _right = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _basis = new THREE.Matrix4();
const _g = new THREE.Vector3();
const _n = new THREE.Vector3();

export class Creature {
  readonly sp: Species;
  readonly pos = new THREE.Vector3();
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly fwd = new THREE.Vector3(1, 0, 0);
  readonly vel = new THREE.Vector3();
  readonly segs: THREE.Vector3[] = [];
  readonly tail: THREE.Vector3[] = [];
  readonly tentacles: THREE.Vector3[][] = [];
  legs: Leg[] = [];
  head = new THREE.Vector3();
  speed = 0;
  targetSpeed = 0;
  state: CState = 'wander';
  stateTime = 0;
  turn = 0;
  target = new THREE.Vector3();
  threat = new THREE.Vector3();
  leader: Creature | null = null;
  alive = true;
  sky = 1;
  phase: number;
  airborne = false;
  hopTimer = 0;
  graze = 0;
  lookAt: THREE.Vector3 | null = null;
  altitude = 0;
  flock: { center: THREE.Vector3; vel: THREE.Vector3 } | null = null;
  armSwing = 0;
  carry: 0 | 1 | 2 = 0;
  tint: RGB;
  private frameSkip = 0;
  private stuck = 0;
  id: number;

  constructor(sp: Species, pos: THREE.Vector3, rng: RNG, id: number) {
    this.sp = sp;
    this.id = id;
    this.pos.copy(pos);
    this.phase = rng.next() * 100;
    const a = rng.next() * Math.PI * 2;
    this.fwd.set(Math.cos(a), 0, Math.sin(a));
    const k = 0.9 + rng.next() * 0.2;
    this.tint = [k, k, k];
    for (let i = 0; i < sp.segCount; i++) this.segs.push(pos.clone().addScaledVector(this.fwd, -i * sp.spacing).add(new THREE.Vector3(0, sp.bodyHeight, 0)));
    for (let i = 0; i < sp.tailSegs; i++) this.tail.push(this.segs[this.segs.length - 1].clone());
    for (const l of sp.legs) this.legs.push({ def: l, foot: pos.clone(), from: pos.clone(), to: pos.clone(), t: 1 });
    for (let i = 0; i < sp.def.tentacles; i++) {
      const chain: THREE.Vector3[] = [];
      for (let k2 = 0; k2 < 6; k2++) chain.push(pos.clone());
      this.tentacles.push(chain);
    }
    this.altitude = sp.def.plan === 'flyer' ? rng.range(18, 55) : sp.def.plan === 'floater' ? (sp.def.habitat === 'sky' ? rng.range(70, 140) : rng.range(5, 25)) : 0;
  }

  get plan() {
    return this.sp.def.plan;
  }

  // --- Simulation ---------------------------------------------------------------------------

  update(dt: number, world: World, t: number, near: boolean): void {
    this.stateTime += dt;
    switch (this.plan) {
      case 'flyer':
        this.updateFlyer(dt, world, t);
        return;
      case 'floater':
        this.updateFloater(dt, world, t);
        return;
      default:
        this.updateWalker(dt, world, t, near);
    }
  }

  private updateAI(dt: number, t: number): void {
    const s = this.sp.def.speed * Math.sqrt(this.sp.s);
    switch (this.state) {
      case 'wander':
        if (this.leader && this.leader.alive && this.leader !== this) {
          _v.subVectors(this.leader.pos, this.pos);
          const d = _v.length();
          if (d > this.sp.s * 5) {
            this.steerToward(_v, dt, 1.5);
            this.targetSpeed = s * (d > this.sp.s * 12 ? 1.4 : 0.8);
          } else {
            this.targetSpeed = this.leader.targetSpeed;
            this.turn = lerp(this.turn, this.leader.turn, dt);
          }
        } else {
          if (Math.sin(t * 0.3 + this.phase) > 0.6) this.turn = Math.sin(t * 0.7 + this.phase * 3) * 0.8;
          else this.turn *= 0.98;
          this.targetSpeed = s * 0.55;
        }
        if (this.stateTime > 6 + (this.phase % 7) && Math.random() < dt * 0.3) this.setState('graze');
        break;
      case 'graze':
        this.targetSpeed = 0;
        this.graze = Math.min(1, this.graze + dt);
        if (this.stateTime > 3 + (this.phase % 5)) this.setState('wander');
        break;
      case 'flee':
        _v.subVectors(this.pos, this.threat);
        this.steerToward(_v, dt, 4);
        this.targetSpeed = s * 2.3;
        if (this.stateTime > 7) this.setState('wander');
        break;
      case 'idle':
      case 'talk':
        this.targetSpeed = 0;
        break;
      case 'walkTo': {
        _v.subVectors(this.target, this.pos);
        _v.addScaledVector(this.up, -_v.dot(this.up));
        const d = _v.length();
        this.steerToward(_v, dt, 3);
        this.targetSpeed = d < 1.2 ? 0 : s * (d < 4 ? 0.5 : 0.85);
        break;
      }
      default:
        break;
    }
    if (this.state !== 'graze') this.graze = Math.max(0, this.graze - dt * 2);
  }

  setState(s: CState): void {
    this.state = s;
    this.stateTime = 0;
  }

  scare(from: THREE.Vector3): void {
    this.threat.copy(from);
    if (this.state !== 'flee') this.setState('flee');
    else this.stateTime = 0;
  }

  private steerToward(dir: THREE.Vector3, dt: number, rate: number): void {
    _v2.copy(dir).addScaledVector(this.up, -dir.dot(this.up));
    if (_v2.lengthSq() < 1e-6) return;
    _v2.normalize();
    const cross = _v3.crossVectors(this.fwd, _v2).dot(this.up);
    const dot = this.fwd.dot(_v2);
    const ang = Math.atan2(cross, dot);
    this.turn = clamp(ang * rate, -3, 3) * 0.5;
    void dt;
  }

  private updateWalker(dt: number, world: World, t: number, near: boolean): void {
    this.updateAI(dt, t);
    const sp = this.sp;
    // Gravity frame (sampled every few frames; creatures are cheap but many)
    if (this.frameSkip++ % 6 === 0) {
      world.gravity(this.pos.x, this.pos.y, this.pos.z, _g);
      const gl = _g.length();
      const gUp = gl > 0.2 ? _g.multiplyScalar(-1 / gl) : _v.set(0, 1, 0);
      const align = this.plan === 'crawler' ? 0.6 : 0.25;
      world.normal(this.pos.x, this.pos.y + 0.1, this.pos.z, _n, 0.4);
      const target = _v2.copy(gUp).lerp(_n, align).normalize();
      this.up.lerp(target, 0.35).normalize();
      this.gAcc = gl;
    }
    // Heading
    this.fwd.applyAxisAngle(this.up, this.turn * dt).addScaledVector(this.up, -this.fwd.dot(this.up)).normalize();
    this.speed = lerp(this.speed, this.targetSpeed, 1 - Math.exp(-dt * 3));

    if (this.plan === 'hopper') this.updateHop(dt, world);
    else if (this.speed > 0.01 || near) {
      _v.copy(this.pos);
      this.pos.addScaledVector(this.fwd, this.speed * dt);
      this.pos.addScaledVector(this.up, 0.6);
      if (!world.snap(this.pos, this.up, 3) || this.inLiquid(world)) {
        this.pos.copy(_v);
        this.fwd.applyAxisAngle(this.up, Math.PI * (0.6 + Math.random() * 0.4));
        this.stuck++;
      } else this.stuck = 0;
    }

    // Body chain
    const bob = Math.sin(t * 9 * Math.max(0.3, this.speed / sp.s) + this.phase) * 0.04 * sp.s * Math.min(1, this.speed);
    const hipH = this.airborne ? sp.bodyHeight * 0.8 : sp.bodyHeight * (1 - this.graze * 0.25);
    if (sp.upright) {
      // Pelvis, torso stacked vertically
      this.segs[0].copy(this.pos).addScaledVector(this.up, hipH + bob);
      for (let i = 1; i < this.segs.length; i++) this.segs[i].copy(this.segs[i - 1]).addScaledVector(this.up, sp.segR[i - 1][1] + sp.segR[i][1] * 0.9);
    } else {
      this.segs[0].copy(this.pos).addScaledVector(this.up, hipH + bob);
      for (let i = 1; i < this.segs.length; i++) {
        const prev = this.segs[i - 1];
        _v.subVectors(this.segs[i], prev);
        if (_v.lengthSq() < 1e-6) _v.copy(this.fwd).negate();
        _v.normalize().multiplyScalar(sp.spacing);
        this.segs[i].copy(prev).add(_v);
        // keep at hip height relative to the local ground plane
        const h = _v2.subVectors(this.segs[i], this.pos).dot(this.up);
        this.segs[i].addScaledVector(this.up, hipH - h + Math.sin(t * 3 + i + this.phase) * 0.02 * sp.s);
      }
    }
    this.updateHead(dt, t);
    this.updateTail(dt);
    this.updateLegs(dt, world);
    if (sp.upright) this.armSwing = Math.sin(t * 7 * Math.min(1.5, this.speed / 1.5 + 0.1) + this.phase) * Math.min(1, this.speed * 0.7);
  }

  private gAcc = 9.8;
  private hopVel = new THREE.Vector3();

  private updateHop(dt: number, world: World): void {
    const sp = this.sp;
    if (!this.airborne) {
      if (this.targetSpeed > 0.05) {
        this.hopTimer += dt;
        if (this.hopTimer > 0.35) {
          this.hopTimer = 0;
          this.airborne = true;
          const v = Math.sqrt(sp.s) * 3.6;
          this.hopVel.copy(this.fwd).multiplyScalar(this.targetSpeed * 1.6).addScaledVector(this.up, v);
          this.pos.addScaledVector(this.up, 0.05);
        }
      }
      return;
    }
    world.gravity(this.pos.x, this.pos.y, this.pos.z, _g);
    this.hopVel.addScaledVector(_g, dt);
    _v.copy(this.pos);
    this.pos.addScaledVector(this.hopVel, dt);
    const d = world.density(this.pos.x, this.pos.y, this.pos.z);
    if (d < 0.05 && this.hopVel.dot(this.up) < 0) {
      this.pos.addScaledVector(this.up, 0.5);
      world.snap(this.pos, this.up, 3);
      this.airborne = false;
    } else if (d < -1) {
      this.pos.copy(_v);
      this.hopVel.multiplyScalar(-0.3);
    }
  }

  private inLiquid(world: World): boolean {
    const P = world.params;
    if (this.pos.y < P.seaLevel - 0.3) {
      const c = world.terrain.columnAt(this.pos.x, this.pos.z);
      if (c.h < P.seaLevel) return true;
    }
    return false;
  }

  private updateHead(dt: number, t: number): void {
    const sp = this.sp;
    const front = this.segs[0];
    if (sp.upright) {
      const top = this.segs[this.segs.length - 1];
      this.head.copy(top).addScaledVector(this.up, sp.segR[this.segs.length - 1][1] * 0.8 + sp.neck * 0.6 + sp.headR);
    } else {
      this.head.copy(front)
        .addScaledVector(this.fwd, sp.segR[0][2] * 0.8 + sp.neck * 0.7 + sp.headR * 0.6)
        .addScaledVector(this.up, sp.neck * 0.55 - this.graze * (sp.bodyHeight * 0.8 + sp.neck * 0.5));
    }
    this.head.addScaledVector(this.up, Math.sin(t * 2 + this.phase) * 0.02 * sp.s);
    void dt;
  }

  private updateTail(dt: number): void {
    const sp = this.sp;
    if (!sp.tailSegs) return;
    const back = this.segs[this.segs.length - 1];
    const seg = sp.tailLen / sp.tailSegs;
    let prev = back;
    for (let i = 0; i < this.tail.length; i++) {
      const p = this.tail[i];
      _v.subVectors(p, prev);
      if (_v.lengthSq() < 1e-6) _v.copy(this.fwd).negate();
      _v.normalize();
      // Tails droop slightly and curl upward at the end
      _v.addScaledVector(this.up, (i / this.tail.length - 0.4) * 0.3).normalize();
      p.copy(prev).addScaledVector(_v, seg);
      prev = p;
    }
    void dt;
  }

  private updateLegs(dt: number, world: World): void {
    const sp = this.sp;
    if (!this.legs.length) return;
    _right.crossVectors(this.fwd, this.up).normalize();
    const moving = this.speed > 0.05;
    for (const leg of this.legs) {
      const L = leg.def;
      const hip = this.hip(leg, _v3);
      // Rest position: under the hip, splayed outward
      const spread = sp.upright ? 0.12 * sp.s : (L.upper + L.lower) * 0.5;
      const rest = _v.copy(hip).addScaledVector(_right, L.side * spread).addScaledVector(this.fwd, L.along * 0.3);
      rest.addScaledVector(this.up, -_v2.subVectors(rest, this.pos).dot(this.up));
      if (this.airborne) {
        leg.foot.copy(hip).addScaledVector(this.up, -(L.upper + L.lower) * 0.6).addScaledVector(this.fwd, -0.2 * sp.s);
        leg.t = 1;
        continue;
      }
      if (leg.t < 1) {
        leg.t = Math.min(1, leg.t + dt / sp.stepTime);
        const e = leg.t * leg.t * (3 - 2 * leg.t);
        leg.foot.lerpVectors(leg.from, leg.to, e).addScaledVector(this.up, Math.sin(leg.t * Math.PI) * sp.stepLen * 0.35);
        continue;
      }
      const dist = leg.foot.distanceTo(rest);
      const other = this.legs.some((o) => o !== leg && o.t < 1 && o.def.group === L.group) ;
      const blocked = this.legs.some((o) => o.t < 1 && o.def.group !== L.group);
      if ((dist > sp.stepLen || (dist > sp.stepLen * 0.25 && !moving)) && !blocked) {
        void other;
        leg.from.copy(leg.foot);
        leg.to.copy(rest).addScaledVector(this.fwd, this.speed * sp.stepTime * 0.9);
        leg.to.addScaledVector(this.up, 0.8);
        world.snap(leg.to, this.up, 2.5);
        leg.t = 0;
      } else if (dist > sp.stepLen * 3) {
        leg.foot.copy(rest);
      }
    }
  }

  private hip(leg: Leg, out: THREE.Vector3): THREE.Vector3 {
    const sp = this.sp;
    const seg = this.segs[Math.min(leg.def.seg, this.segs.length - 1)];
    const r = sp.segR[Math.min(leg.def.seg, this.segs.length - 1)];
    _right.crossVectors(this.fwd, this.up).normalize();
    out.copy(seg).addScaledVector(_right, leg.def.side * r[0] * leg.def.out);
    if (sp.upright) out.addScaledVector(this.up, -r[1] * 0.5);
    else out.addScaledVector(this.fwd, leg.def.along * 0.3);
    return out;
  }

  private updateFlyer(dt: number, world: World, t: number): void {
    const sp = this.sp;
    const f = this.flock;
    const speed = sp.def.speed;
    if (f) {
      _v.subVectors(f.center, this.pos);
      const d = _v.length();
      _v2.copy(f.vel);
      if (d > 3) _v2.addScaledVector(_v, 0.25);
      _v2.add(_v3.set(Math.sin(t * 0.9 + this.phase) * 2, Math.sin(t * 0.7 + this.phase * 2), Math.cos(t * 0.8 + this.phase) * 2));
      if (this.state === 'flee') _v2.addScaledVector(_v3.subVectors(this.pos, this.threat).normalize(), speed * 2).addScaledVector(this.up, 3);
      this.vel.lerp(_v2, 1 - Math.exp(-dt * 1.5));
    }
    const vl = this.vel.length();
    if (vl > speed * 1.8) this.vel.multiplyScalar((speed * 1.8) / vl);
    this.pos.addScaledVector(this.vel, dt);
    // Keep out of the ground
    const d = world.density(this.pos.x, this.pos.y, this.pos.z);
    if (d < 4) this.vel.y += (4 - d) * dt * 4;
    if (vl > 0.1) this.fwd.lerp(_v.copy(this.vel).normalize(), 1 - Math.exp(-dt * 4)).normalize();
    this.up.set(0, 1, 0);
    if (this.state === 'flee' && this.stateTime > 8) this.setState('wander');
    // Body along velocity
    for (let i = 0; i < this.segs.length; i++) this.segs[i].copy(this.pos).addScaledVector(this.fwd, -i * sp.spacing);
    this.head.copy(this.pos).addScaledVector(this.fwd, sp.segR[0][2] + sp.neck + sp.headR * 0.5);
    this.updateTail(dt);
    this.armSwing = this.vel.y > -1 ? Math.sin(t * (8 + sp.def.wingSpan) + this.phase) : Math.sin(t * 2 + this.phase) * 0.2 - 0.1;
  }

  private updateFloater(dt: number, world: World, t: number): void {
    const sp = this.sp;
    const drift = _v.set(Math.sin(t * 0.05 + this.phase), 0, Math.cos(t * 0.043 + this.phase * 1.3)).multiplyScalar(sp.def.speed);
    if (this.state === 'flee') drift.addScaledVector(_v2.subVectors(this.pos, this.threat).setY(0).normalize(), sp.def.speed * 3);
    if (this.state === 'flee' && this.stateTime > 10) this.setState('wander');
    const col = world.terrain.columnAt(this.pos.x, this.pos.z);
    const under = this.sp.def.habitat === 'under';
    const ground = under ? col.uF : Math.max(col.h, world.params.seaLevel);
    const targetY = ground + this.altitude + Math.sin(t * 0.4 + this.phase) * 2;
    this.vel.x = lerp(this.vel.x, drift.x, dt * 0.5);
    this.vel.z = lerp(this.vel.z, drift.z, dt * 0.5);
    this.vel.y = lerp(this.vel.y, clamp((targetY - this.pos.y) * 0.3, -2, 2), dt);
    if (under && this.pos.y > col.uC - sp.s * 2) this.vel.y -= dt * 3;
    this.pos.addScaledVector(this.vel, dt);
    this.up.set(0, 1, 0);
    this.segs[0].copy(this.pos);
    this.head.copy(this.pos);
    // Tentacles trail behind the motion, swaying
    this.tentacles.forEach((chain, i) => {
      const a = (i / this.tentacles.length) * Math.PI * 2;
      let prev = _v3.copy(this.pos).add(_v2.set(Math.cos(a) * sp.s * 0.35, -sp.s * 0.3, Math.sin(a) * sp.s * 0.35));
      chain[0].copy(prev);
      const L = (sp.s * 1.6) / chain.length;
      for (let k = 1; k < chain.length; k++) {
        const p = chain[k];
        _v.subVectors(p, chain[k - 1]);
        _v.y -= 0.6;
        _v.x += Math.sin(t * 1.3 + k * 0.7 + i) * 0.15 - this.vel.x * 0.1;
        _v.z += Math.cos(t * 1.1 + k * 0.6 + i) * 0.15 - this.vel.z * 0.1;
        _v.normalize();
        p.copy(chain[k - 1]).addScaledVector(_v, L);
      }
      void prev;
    });
  }

  // --- Rendering ------------------------------------------------------------------------------

  render(out: PrimSink): void {
    const sp = this.sp;
    const body = { ...sp.body, sky: this.sky };
    const limb = { ...sp.limb, sky: this.sky };
    const eye = { ...sp.eyeStyle, sky: this.sky };
    const horn = { ...sp.hornStyle, sky: this.sky };
    _right.crossVectors(this.fwd, this.up).normalize();

    if (this.plan === 'floater') {
      const s = sp.s;
      const pulse = 1 + Math.sin(this.phase + performance.now() * 0.0015) * 0.05;
      _basis.makeBasis(_right, this.up, this.fwd);
      _q.setFromRotationMatrix(_basis);
      out.add(Prim.Sphere, trsMatrix(this.pos, _q, s * 0.55 * pulse, s * 0.48 / pulse, s * 0.55 * pulse, _m), { ...body, pattern: 4, freq: sp.def.patternFreq * 0.6, emissive: Math.max(0.5, sp.def.glow) });
      out.add(Prim.Dome, trsMatrix(_v.copy(this.pos).addScaledVector(this.up, -s * 0.15), _q, s * 0.62, -s * 0.2, s * 0.62, _m), limb);
      for (const chain of this.tentacles) {
        for (let k = 0; k < chain.length - 1; k++) {
          out.add(Prim.Limb, segmentMatrix(chain[k], chain[k + 1], s * 0.045 * (1 - k / chain.length) + 0.02, _m), k === chain.length - 2 ? { ...eye, emissive: 1.5 } : limb);
        }
      }
      return;
    }

    // Body segments
    for (let i = 0; i < this.segs.length; i++) {
      const r = sp.segR[i];
      const dir = i === 0 ? _v.copy(this.fwd) : _v.subVectors(this.segs[i - 1], this.segs[i]).normalize();
      if (sp.upright) dir.copy(this.fwd);
      const side = _v2.crossVectors(dir, this.up).normalize();
      const upv = _v3.crossVectors(side, dir);
      _basis.makeBasis(side, upv, dir);
      _q.setFromRotationMatrix(_basis);
      if (sp.upright) out.add(Prim.Sphere, trsMatrix(this.segs[i], _q, r[0], r[1] * 1.1, r[0] * 0.8, _m), body);
      else out.add(Prim.Sphere, trsMatrix(this.segs[i], _q, r[0], r[1], r[2], _m), body);
      if (sp.crest && !sp.upright) out.add(Prim.Cone, trsMatrix(_v.copy(this.segs[i]).addScaledVector(upv, r[1] * 0.8), _q, r[0] * 0.15, r[1] * 0.6, r[2] * 0.4, _m), horn);
    }

    // Neck and head
    const front = sp.upright ? this.segs[this.segs.length - 1] : this.segs[0];
    out.add(Prim.Limb, segmentMatrix(front, this.head, sp.headR * 0.45, _m), body);
    const look = this.lookAt ? _v.subVectors(this.lookAt, this.head).normalize() : _v.copy(this.fwd).addScaledVector(this.up, -this.graze * 0.8).normalize();
    const hs = _v2.crossVectors(look, this.up).normalize();
    const hu = _v3.crossVectors(hs, look);
    _basis.makeBasis(hs, hu, look);
    _q.setFromRotationMatrix(_basis);
    const hr = sp.headR;
    out.add(Prim.Sphere, trsMatrix(this.head, _q, hr * 0.9, hr * 0.85, hr * 1.15, _m), body);
    const headQ = _q.clone();
    for (const e of sp.eyes) {
      const p = _v.set(e.x * hr, e.y * hr * 0.7, e.z * hr).applyQuaternion(headQ).add(this.head);
      out.add(Prim.Sphere, trsMatrix(p, headQ, e.r * hr, e.r * hr, e.r * hr * 0.8, _m), eye);
    }
    for (const h of sp.horns) {
      const base = _v.set(h.x * hr, h.y * hr * 0.8, h.z * hr).applyQuaternion(headQ).add(this.head);
      const dir = _v2.set(h.x * 0.6, 1, h.tilt).normalize().applyQuaternion(headQ);
      out.add(Prim.Cone, segmentMatrix(base, _v3.copy(base).addScaledVector(dir, hr * h.len), hr * 0.14, _m), horn);
    }

    // Tail
    let prev = this.segs[this.segs.length - 1];
    for (let i = 0; i < this.tail.length; i++) {
      const tr = sp.segR[sp.segR.length - 1][0] * 0.5 * (1 - i / this.tail.length) + 0.02;
      out.add(Prim.Limb, segmentMatrix(this.tail[i], prev, tr, _m), i === this.tail.length - 1 && sp.def.glow > 0.3 ? eye : body);
      prev = this.tail[i];
    }

    // Wings
    if (sp.def.wingSpan > 0) {
      const span = sp.def.wingSpan * sp.s * 0.5;
      const flap = this.armSwing * 0.7;
      for (const side of [-1, 1]) {
        _basis.makeBasis(_v.copy(_right).multiplyScalar(side), this.up, _v2.copy(this.fwd).multiplyScalar(side));
        _q.setFromRotationMatrix(_basis);
        _q.multiply(new THREE.Quaternion().setFromAxisAngle(_v3.set(0, 0, 1), flap));
        out.add(Prim.Wing, trsMatrix(this.segs[0], _q, span, 1, span * 0.9, _m), { ...limb, color: sp.def.color2, color2: sp.def.color, pattern: 3, freq: 5, emissive: sp.def.glow });
      }
    }

    // Legs with two-bone IK
    for (const leg of this.legs) {
      const hip = this.hip(leg, new THREE.Vector3());
      const knee = this.knee(hip, leg.foot, leg.def, new THREE.Vector3());
      out.add(Prim.Limb, segmentMatrix(knee, hip, leg.def.radius, _m), limb);
      out.add(Prim.Limb, segmentMatrix(leg.foot, knee, leg.def.radius * 0.7, _m), limb);
      out.add(Prim.Sphere, trsMatrix(leg.foot, _q.identity(), leg.def.radius * 1.2, leg.def.radius * 0.8, leg.def.radius * 1.2, _m), limb);
    }

    // Arms (sapients)
    if (sp.def.arms > 0 && sp.upright) {
      const torso = this.segs[this.segs.length - 1];
      const r = sp.segR[this.segs.length - 1];
      for (let a = 0; a < sp.def.arms; a++) {
        for (const side of [-1, 1]) {
          const shoulder = new THREE.Vector3().copy(torso).addScaledVector(_right, side * r[0] * 1.05).addScaledVector(this.up, r[1] * (0.5 - a * 0.55));
          const len = sp.s * 0.3;
          const swing = this.armSwing * side * (a % 2 === 0 ? 1 : -1) * 0.6;
          const elbow = shoulder.clone().addScaledVector(this.up, -len * Math.cos(swing)).addScaledVector(this.fwd, len * Math.sin(swing)).addScaledVector(_right, side * len * 0.15);
          const hand = elbow.clone().addScaledVector(this.up, -len * 0.8).addScaledVector(this.fwd, len * (0.35 + Math.sin(swing) * 0.5));
          if (this.state === 'talk' && a === 0 && side === 1) hand.addScaledVector(this.up, len * (1.1 + Math.sin(performance.now() * 0.006) * 0.3));
          out.add(Prim.Limb, segmentMatrix(elbow, shoulder, sp.s * 0.035, _m), limb);
          out.add(Prim.Limb, segmentMatrix(hand, elbow, sp.s * 0.028, _m), limb);
          if (this.carry === 1 && a === 0 && side === -1) out.add(Prim.Sphere, trsMatrix(hand.addScaledVector(this.up, -0.12), _q.identity(), 0.12, 0.16, 0.12, _m), { color: [1, 0.8, 0.5], emissive: 2.4 });
        }
      }
    }
  }

  private knee(hip: THREE.Vector3, foot: THREE.Vector3, L: LegDef, out: THREE.Vector3): THREE.Vector3 {
    const a = L.upper, b = L.lower;
    const d = _v.subVectors(foot, hip);
    let len = d.length();
    len = clamp(len, 0.01, a + b - 0.001);
    d.normalize();
    const along = (a * a - b * b + len * len) / (2 * len);
    const h = Math.sqrt(Math.max(0, a * a - along * along));
    // Knees bend up and outward (arthropod-like) or forward (bipeds)
    const bend = this.sp.upright || this.plan === 'hopper'
      ? _v2.copy(this.fwd).multiplyScalar(this.plan === 'hopper' ? -1 : 1)
      : _v2.copy(this.up).addScaledVector(_right.crossVectors(this.fwd, this.up).normalize(), L.side * 0.6);
    bend.addScaledVector(d, -bend.dot(d)).normalize();
    return out.copy(hip).addScaledVector(d, along).addScaledVector(bend, h);
  }
}
