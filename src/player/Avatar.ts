import * as THREE from 'three';
import { World } from '../world/World';
import { Prim, PrimStyle, segmentMatrix, trsMatrix } from '../render/Primitives';
import { PrimSink } from '../fauna/Creature';
import { Particles } from '../render/Effects';
import { RNG, hash4 } from '../core/rng';
import { RGB, clamp, hsl, lerp } from '../core/math';

// ---------------------------------------------------------------------------------------------
// The traveller: the player's body in third person. It is procedural like everything else,
// but deliberately *not from here*: its palette is the complement of the world's life hue,
// its materials are synthetic and luminous, and its body plan (strider, tripod or hover
// form) is chosen from the seed. Legs plant their feet on the real terrain with IK.
// ---------------------------------------------------------------------------------------------

type Plan = 'strider' | 'tripod' | 'hover';

interface Foot {
  pos: THREE.Vector3;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  angle: number; // around the body (radians, 0 = right)
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _basis = new THREE.Matrix4();

function hueOf(c: RGB): number {
  const [r, g, b] = c;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h / 6;
}

export class Avatar {
  readonly plan: Plan;
  private suit: PrimStyle;
  private armor: PrimStyle;
  private joint: PrimStyle;
  private glow: PrimStyle;
  private visor: PrimStyle;
  private head: number;
  private antennae: number;
  private companion: boolean;
  private scale: number;
  private feet: Foot[] = [];
  private fwd = new THREE.Vector3(1, 0, 0);
  private phase = 0;
  private lean = 0;
  thrust = 0;
  private companionPos = new THREE.Vector3();
  readonly glowColor: RGB;

  constructor(seed: number, lifeColor: RGB) {
    const r = new RNG(hash4(seed, 0x7a4e11));
    const h = (hueOf(lifeColor) + 0.5 + r.range(-0.08, 0.08)) % 1;
    this.plan = r.pick(['strider', 'strider', 'tripod', 'hover'] as const);
    const dark = r.chance(0.45);
    const suitC = dark ? hsl(h, r.range(0.15, 0.35), r.range(0.12, 0.2)) : hsl(h, r.range(0.05, 0.2), r.range(0.78, 0.9));
    const accent = hsl(h + r.range(-0.05, 0.05), r.range(0.6, 0.9), dark ? 0.5 : 0.42);
    this.glowColor = hsl(h + r.range(-0.12, 0.12), 1, 0.62);
    this.suit = { color: suitC, color2: accent, pattern: r.pick([1, 3, 3]), freq: r.range(3, 7) };
    this.armor = { color: accent, color2: suitC, pattern: 0 };
    this.joint = { color: dark ? hsl(h, 0.1, 0.35) : hsl(h, 0.15, 0.25) };
    this.glow = { color: this.glowColor, emissive: 2.6 };
    this.visor = { color: this.glowColor, color2: [1, 1, 1], pattern: 3, freq: 14, emissive: 2.2 };
    this.head = r.int(0, 2);
    this.antennae = r.int(0, 3);
    this.companion = r.chance(0.6);
    this.scale = r.range(0.95, 1.08);
    const n = this.plan === 'strider' ? 2 : this.plan === 'tripod' ? 3 : 0;
    for (let i = 0; i < n; i++) {
      const angle = n === 2 ? (i === 0 ? 0 : Math.PI) : (i / 3) * Math.PI * 2 + Math.PI / 2;
      this.feet.push({ pos: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), t: 1, angle });
    }
  }

  /** Place feet under the body (after teleports or at start). */
  reset(ground: THREE.Vector3, up: THREE.Vector3, fwd: THREE.Vector3): void {
    this.fwd.copy(fwd);
    for (const f of this.feet) {
      this.restPos(f, ground, up, _v);
      f.pos.copy(_v);
      f.t = 1;
    }
    this.companionPos.copy(ground).addScaledVector(up, 2);
  }

  private right(up: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.crossVectors(this.fwd, up).normalize();
  }

  private restPos(f: Foot, ground: THREE.Vector3, up: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const r = this.right(up, _v2);
    const spread = this.plan === 'tripod' ? 0.55 : 0.16;
    return out.copy(ground).addScaledVector(r, Math.cos(f.angle) * spread * this.scale).addScaledVector(this.fwd, Math.sin(f.angle) * spread * this.scale);
  }

  update(dt: number, world: World, ground: THREE.Vector3, up: THREE.Vector3, vel: THREE.Vector3, look: THREE.Vector3, grounded: boolean, flying: boolean, thrusting: boolean, sparks: Particles): void {
    // Face the direction of travel when moving, otherwise where the camera looks
    const tv = new THREE.Vector3().copy(vel).addScaledVector(up, -vel.dot(up));
    const speed = tv.length();
    const target = speed > 0.6 ? tv.normalize() : _v.copy(look).addScaledVector(up, -look.dot(up)).normalize();
    if (target.lengthSq() > 0.5) this.fwd.lerp(target, 1 - Math.exp(-dt * 8)).addScaledVector(up, -this.fwd.dot(up)).normalize();
    this.lean = lerp(this.lean, flying ? 0.9 : clamp(speed * 0.035, 0, 0.25), 1 - Math.exp(-dt * 5));
    this.phase += dt * (1 + speed * 0.9);
    this.thrust = lerp(this.thrust, thrusting || flying ? 1 : 0, 1 - Math.exp(-dt * 8));

    const stepLen = (0.42 + speed * 0.07) * this.scale;
    const stepTime = 0.3 / (1 + speed * 0.09);
    for (const f of this.feet) {
      if (!grounded) {
        // Legs trail and tuck in the air
        this.restPos(f, ground, up, f.pos);
        f.pos.addScaledVector(up, flying ? 0.1 : 0.35).addScaledVector(this.fwd, flying ? -0.55 : -0.12);
        f.t = 1;
        continue;
      }
      if (f.t < 1) {
        f.t = Math.min(1, f.t + dt / stepTime);
        const e = f.t * f.t * (3 - 2 * f.t);
        f.pos.lerpVectors(f.from, f.to, e).addScaledVector(up, Math.sin(f.t * Math.PI) * 0.16);
        continue;
      }
      this.restPos(f, ground, up, _v);
      const d = f.pos.distanceTo(_v);
      const busy = this.feet.some((o) => o !== f && o.t < 1);
      if ((d > stepLen || (d > 0.08 && speed < 0.3)) && !busy) {
        f.from.copy(f.pos);
        f.to.copy(_v).addScaledVector(tv.lengthSq() > 0 ? _v2.copy(vel).addScaledVector(up, -vel.dot(up)) : _v2.set(0, 0, 0), stepTime * 0.6);
        f.to.addScaledVector(up, 0.5);
        if (!world.snap(f.to, up, 1.5)) f.to.copy(_v);
        f.t = 0;
      } else if (d > 2.5) f.pos.copy(_v);
    }

    // Companion drone orbits the shoulder
    const ang = this.phase * 0.8;
    const r = this.right(up, _v2);
    const want = _v.copy(ground).addScaledVector(up, 2.1 + Math.sin(this.phase * 1.7) * 0.12).addScaledVector(r, Math.cos(ang) * 0.9).addScaledVector(this.fwd, Math.sin(ang) * 0.9 - 0.3);
    this.companionPos.lerp(want, 1 - Math.exp(-dt * 4));

    // Thruster exhaust
    if (this.thrust > 0.3 && Math.random() < this.thrust) {
      const back = this.backpack(ground, up);
      for (const side of [-1, 1]) {
        const p = _v.copy(back).addScaledVector(r, side * 0.13 * this.scale).addScaledVector(up, -0.25);
        sparks.emit(p, _v2.copy(up).multiplyScalar(-4 - Math.random() * 3).addScaledVector(this.fwd, -1), this.glowColor, 0.16, 0.35, { drag: 2 });
      }
    }
    if (this.plan === 'hover' && Math.random() < 0.5) {
      const a = Math.random() * Math.PI * 2;
      const p = _v.copy(ground).addScaledVector(up, 0.25).addScaledVector(r, Math.cos(a) * 0.3).addScaledVector(this.fwd, Math.sin(a) * 0.3);
      sparks.emit(p, _v2.copy(up).multiplyScalar(-1.2), this.glowColor, 0.1, 0.5, { drag: 1 });
    }
  }

  private backpack(ground: THREE.Vector3, up: THREE.Vector3): THREE.Vector3 {
    const s = this.scale;
    return new THREE.Vector3().copy(ground).addScaledVector(up, 1.22 * s).addScaledVector(this.fwd, -0.2 * s);
  }

  render(out: PrimSink, ground: THREE.Vector3, up: THREE.Vector3, look: THREE.Vector3, sky: number, toolGlow: RGB, t: number): void {
    const s = this.scale;
    const st = (p: PrimStyle): PrimStyle => ({ ...p, sky });
    const suit = st(this.suit), armor = st(this.armor), joint = st(this.joint), glow = st(this.glow), visor = st(this.visor);
    const right = this.right(up, new THREE.Vector3());
    // Leaning body axis
    const axis = up.clone().multiplyScalar(Math.cos(this.lean)).addScaledVector(this.fwd, Math.sin(this.lean)).normalize();
    const bodyFwd = this.fwd.clone().multiplyScalar(Math.cos(this.lean)).addScaledVector(up, -Math.sin(this.lean)).normalize();
    _basis.makeBasis(right, axis, bodyFwd);
    const bodyQ = new THREE.Quaternion().setFromRotationMatrix(_basis);
    const breathe = Math.sin(t * 1.8) * 0.01;
    const walkBob = this.feet.length ? Math.abs(Math.sin(this.phase * 3.2)) * 0.03 : Math.sin(t * 2.2) * 0.05;

    const hipH = this.plan === 'hover' ? 0.75 : this.plan === 'tripod' ? 0.8 : 0.92;
    const pelvis = ground.clone().addScaledVector(up, (hipH + walkBob) * s);
    const chest = pelvis.clone().addScaledVector(axis, 0.42 * s);
    const neck = chest.clone().addScaledVector(axis, 0.28 * s);
    const headC = neck.clone().addScaledVector(axis, 0.16 * s);

    // Torso
    out.add(Prim.Sphere, trsMatrix(pelvis, bodyQ, 0.17 * s, 0.13 * s, 0.13 * s, _m), joint);
    out.add(Prim.Sphere, trsMatrix(_v.copy(pelvis).addScaledVector(axis, 0.22 * s), bodyQ, 0.12 * s, 0.16 * s, 0.1 * s, _m), suit);
    out.add(Prim.Sphere, trsMatrix(chest, bodyQ, 0.21 * s, (0.2 + breathe) * s, 0.15 * s, _m), suit);
    out.add(Prim.Dome, trsMatrix(_v.copy(chest).addScaledVector(bodyFwd, 0.06 * s), bodyQ, 0.18 * s, 0.14 * s, 0.13 * s, _m), armor);
    out.add(Prim.Sphere, trsMatrix(_v.copy(chest).addScaledVector(bodyFwd, 0.15 * s).addScaledVector(axis, 0.02 * s), bodyQ, 0.035 * s, 0.035 * s, 0.02 * s, _m), glow);
    out.add(Prim.Limb, segmentMatrix(chest, neck, 0.05 * s, _m), joint);

    // Backpack and thrusters
    const pack = chest.clone().addScaledVector(bodyFwd, -0.19 * s);
    out.add(Prim.Box, trsMatrix(pack, bodyQ, 0.3 * s, 0.36 * s, 0.14 * s, _m), armor);
    for (const side of [-1, 1]) {
      const top = pack.clone().addScaledVector(right, side * 0.13 * s).addScaledVector(bodyFwd, -0.06 * s).addScaledVector(axis, 0.1 * s);
      const bot = top.clone().addScaledVector(axis, -0.32 * s);
      out.add(Prim.Cylinder, segmentMatrix(bot, top, 0.055 * s, _m), joint);
      out.add(Prim.Sphere, trsMatrix(bot, bodyQ, 0.05 * s, 0.03 * s, 0.05 * s, _m), { ...glow, emissive: 0.4 + this.thrust * 3 });
    }

    // Head
    _basis.makeBasis(new THREE.Vector3().crossVectors(look, up).normalize(), up, look.clone().addScaledVector(up, -look.dot(up) * 0.5).normalize());
    const headQ = new THREE.Quaternion().setFromRotationMatrix(_basis);
    const hs = 0.13 * s;
    const lookF = new THREE.Vector3(0, 0, 1).applyQuaternion(headQ);
    const headR = new THREE.Vector3(1, 0, 0).applyQuaternion(headQ);
    if (this.head === 0) {
      out.add(Prim.Sphere, trsMatrix(headC, headQ, hs, hs * 1.05, hs * 1.05, _m), suit);
      out.add(Prim.Sphere, trsMatrix(_v.copy(headC).addScaledVector(lookF, hs * 0.55), headQ, hs * 0.85, hs * 0.35, hs * 0.55, _m), visor);
    } else if (this.head === 1) {
      const back = headC.clone().addScaledVector(lookF, -hs * 0.5).addScaledVector(up, hs * 0.5);
      out.add(Prim.Sphere, trsMatrix(back, headQ, hs * 0.8, hs * 0.9, hs * 1.5, _m), suit);
      out.add(Prim.Sphere, trsMatrix(headC, headQ, hs * 0.75, hs * 0.8, hs * 0.9, _m), armor);
      for (let i = -1; i <= 1; i++) out.add(Prim.Sphere, trsMatrix(_v.copy(headC).addScaledVector(lookF, hs * 0.75).addScaledVector(headR, i * hs * 0.35).addScaledVector(up, (i === 0 ? 0.25 : 0) * hs), headQ, hs * 0.13, hs * 0.13, hs * 0.1, _m), glow);
    } else {
      out.add(Prim.Sphere, trsMatrix(headC, headQ, hs * 1.7, hs * 0.6, hs * 0.8, _m), suit);
      for (const side of [-1, 1]) out.add(Prim.Sphere, trsMatrix(_v.copy(headC).addScaledVector(headR, side * hs * 1.6).addScaledVector(lookF, hs * 0.2), headQ, hs * 0.22, hs * 0.22, hs * 0.22, _m), glow);
      out.add(Prim.Box, trsMatrix(_v.copy(headC).addScaledVector(lookF, hs * 0.6), headQ, hs * 1.6, hs * 0.12, hs * 0.1, _m), visor);
    }
    for (let i = 0; i < this.antennae; i++) {
      const side = this.antennae === 1 ? 0 : i === 0 ? -1 : i === 1 ? 1 : 0;
      const base = headC.clone().addScaledVector(headR, side * hs * 0.5).addScaledVector(up, hs * 0.8);
      const tip = base.clone().addScaledVector(up, hs * 2.2).addScaledVector(headR, side * hs * 0.8).addScaledVector(lookF, -hs * (0.6 + Math.sin(t * 3 + i) * 0.15));
      out.add(Prim.Limb, segmentMatrix(tip, base, 0.012 * s, _m), joint);
      out.add(Prim.Sphere, trsMatrix(tip, headQ, 0.028 * s, 0.028 * s, 0.028 * s, _m), glow);
    }

    // Arms: right hand holds the multitool, pointing where you look
    for (const side of [-1, 1]) {
      const shoulder = chest.clone().addScaledVector(right, side * 0.24 * s).addScaledVector(axis, 0.1 * s);
      out.add(Prim.Dome, trsMatrix(shoulder, bodyQ, 0.09 * s, 0.07 * s, 0.09 * s, _m), armor);
      let hand: THREE.Vector3;
      if (side > 0) hand = chest.clone().addScaledVector(right, 0.2 * s).addScaledVector(look, 0.42 * s).addScaledVector(axis, -0.05 * s);
      else {
        const swing = Math.sin(this.phase * 3.2) * 0.35 * Math.min(1, this.feet.length ? 1 : 0.3);
        hand = shoulder.clone().addScaledVector(axis, -0.5 * s).addScaledVector(this.fwd, swing * s * 0.4).addScaledVector(right, side * 0.06 * s);
      }
      const elbow = this.ik(shoulder, hand, 0.3 * s, 0.3 * s, _v.copy(right).multiplyScalar(side * 0.6).addScaledVector(bodyFwd, -1).normalize(), new THREE.Vector3());
      out.add(Prim.Limb, segmentMatrix(elbow, shoulder, 0.045 * s, _m), suit);
      out.add(Prim.Limb, segmentMatrix(hand, elbow, 0.035 * s, _m), joint);
      out.add(Prim.Sphere, trsMatrix(hand, bodyQ, 0.045 * s, 0.04 * s, 0.05 * s, _m), armor);
      if (side > 0) {
        const tip = hand.clone().addScaledVector(look, 0.34 * s);
        out.add(Prim.Hex, segmentMatrix(hand, tip, 0.035 * s, _m), armor);
        out.add(Prim.Sphere, trsMatrix(tip, bodyQ, 0.04 * s, 0.04 * s, 0.04 * s, _m), { color: toolGlow, emissive: 2.8, sky });
      }
    }

    // Lower body
    if (this.plan === 'hover') {
      const bottom = ground.clone().addScaledVector(up, (0.3 + Math.sin(t * 2.2) * 0.05) * s);
      out.add(Prim.Cone, segmentMatrix(pelvis, bottom, 0.16 * s, _m), suit);
      const ringQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
      out.add(Prim.Torus, trsMatrix(bottom, ringQ, 0.3 * s, 0.3 * s, 0.3 * s, _m), glow);
      out.add(Prim.Torus, trsMatrix(_v.copy(bottom).addScaledVector(up, 0.15 * s), ringQ, 0.2 * s, 0.2 * s, 0.2 * s, _m), armor);
    } else {
      for (const f of this.feet) {
        const hip = pelvis.clone().addScaledVector(right, Math.cos(f.angle) * 0.12 * s).addScaledVector(this.fwd, Math.sin(f.angle) * 0.12 * s);
        const ankle = f.pos.clone().addScaledVector(up, 0.13 * s).addScaledVector(this.fwd, -0.07 * s);
        const outward = this.plan === 'tripod'
          ? _v.copy(right).multiplyScalar(Math.cos(f.angle)).addScaledVector(this.fwd, Math.sin(f.angle)).addScaledVector(up, 0.8).normalize()
          : _v.copy(this.fwd).addScaledVector(right, Math.cos(f.angle) * 0.2).normalize();
        const knee = this.ik(hip, ankle, 0.46 * s, 0.44 * s, outward, new THREE.Vector3());
        out.add(Prim.Limb, segmentMatrix(knee, hip, 0.065 * s, _m), suit);
        out.add(Prim.Sphere, trsMatrix(knee, bodyQ, 0.06 * s, 0.06 * s, 0.06 * s, _m), armor);
        out.add(Prim.Limb, segmentMatrix(ankle, knee, 0.045 * s, _m), joint);
        const toe = f.pos.clone().addScaledVector(this.fwd, 0.12 * s);
        out.add(Prim.Limb, segmentMatrix(toe, ankle, 0.04 * s, _m), armor);
        out.add(Prim.Sphere, trsMatrix(_v2.copy(ankle).addScaledVector(this.fwd, -0.06 * s), bodyQ, 0.025 * s, 0.025 * s, 0.025 * s, _m), glow);
      }
    }

    // Companion drone
    if (this.companion) {
      const q = new THREE.Quaternion().setFromAxisAngle(up, t * 2);
      out.add(Prim.Sphere, trsMatrix(this.companionPos, q, 0.09, 0.07, 0.09, _m), armor);
      out.add(Prim.Torus, trsMatrix(this.companionPos, q, 0.14, 0.14, 0.14, _m), joint);
      out.add(Prim.Sphere, trsMatrix(_v.copy(this.companionPos).addScaledVector(look, 0.07), q, 0.035, 0.035, 0.035, _m), glow);
    }
    void _q;
  }

  private ik(a: THREE.Vector3, b: THREE.Vector3, l1: number, l2: number, bend: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const d = _v2.subVectors(b, a);
    let len = d.length();
    len = clamp(len, 0.01, l1 + l2 - 0.001);
    d.normalize();
    const along = (l1 * l1 - l2 * l2 + len * len) / (2 * len);
    const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
    const bn = bend.clone().addScaledVector(d, -bend.dot(d)).normalize();
    return out.copy(a).addScaledVector(d, along).addScaledVector(bn, h);
  }
}
