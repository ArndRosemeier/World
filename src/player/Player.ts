import * as THREE from 'three';
import { World } from '../world/World';
import { Input } from './Input';
import { clamp } from '../core/math';

/** Anything that can push the player out of solid geometry (props, buildings). */
export interface ColliderSource {
  /** Resolve a sphere against the source; returns true if it moved the sphere. */
  resolveSphere(center: THREE.Vector3, radius: number, push: THREE.Vector3, normal: THREE.Vector3): boolean;
}

const RADIUS = 0.42;
const HEAD = 0.95;
const EYE = 1.25;

const _n = new THREE.Vector3();
const _g = new THREE.Vector3();
const _c = new THREE.Vector3();
const _push = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _r = new THREE.Vector3();
const _look = new THREE.Vector3();

/**
 * First-person controller for arbitrary gravity. "Up" smoothly follows the local gravity
 * field, so you can walk all the way around a moonlet or ride a lift well into the sky.
 */
export class Player {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly forward = new THREE.Vector3(0, 0, -1);
  readonly gravity = new THREE.Vector3(0, -9.8, 0);
  pitch = 0;
  mode: 'walk' | 'fly' = 'walk';
  grounded = false;
  inLiquid = false;
  fuel = 1;
  sensitivity = 0.0022;
  sources: ColliderSource[] = [];
  private groundTime = 0;
  private bob = 0;
  stepEvent = false;

  constructor(private world: World) {}

  spawn(p: THREE.Vector3): void {
    this.pos.copy(p);
    this.vel.set(0, 0, 0);
    this.up.set(0, 1, 0);
  }

  get eye(): THREE.Vector3 {
    return _eye.copy(this.pos).addScaledVector(this.up, EYE + Math.sin(this.bob) * 0.04);
  }

  lookDir(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.forward).multiplyScalar(Math.cos(this.pitch)).addScaledVector(this.up, Math.sin(this.pitch)).normalize();
  }

  update(dt: number, input: Input, camera: THREE.Camera): void {
    // --- Look
    this.forward.applyAxisAngle(this.up, -input.mouseDX * this.sensitivity);
    this.pitch = clamp(this.pitch - input.mouseDY * this.sensitivity, -1.55, 1.55);

    // --- Gravity frame
    this.world.gravity(this.pos.x, this.pos.y, this.pos.z, this.gravity);
    const gl = this.gravity.length();
    if (gl > 0.3 && this.mode === 'walk') {
      _g.copy(this.gravity).multiplyScalar(-1 / gl);
      const ang = this.up.angleTo(_g);
      if (ang > 1e-4) {
        const k = Math.min(1, (dt * 2.6) / Math.max(ang, 0.3));
        _q.setFromUnitVectors(this.up, _g);
        _q.slerp(IDENT, 1 - k);
        this.up.applyQuaternion(_q).normalize();
        this.forward.applyQuaternion(_q);
      }
    }
    this.forward.addScaledVector(this.up, -this.forward.dot(this.up)).normalize();
    if (this.forward.lengthSq() < 0.5) this.forward.set(1, 0, 0).addScaledVector(this.up, -this.up.x).normalize();

    // --- Movement
    const right = _r.crossVectors(this.forward, this.up).normalize();
    const f = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0);
    const s = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
    const sprint = input.down('ShiftLeft') || input.down('ShiftRight');

    if (this.mode === 'fly') {
      const look = this.lookDir(_look);
      const speed = sprint ? 90 : 22;
      const wish = new THREE.Vector3().addScaledVector(look, f).addScaledVector(right, s);
      if (input.down('Space')) wish.addScaledVector(this.up, 1);
      if (input.down('ControlLeft') || input.down('KeyC')) wish.addScaledVector(this.up, -1);
      if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
      this.vel.lerp(wish, 1 - Math.exp(-dt * 6));
      this.integrate(dt);
    } else {
      const wish = new THREE.Vector3().addScaledVector(this.forward, f).addScaledVector(right, s);
      if (wish.lengthSq() > 0) wish.normalize();
      const speed = sprint ? 10.5 : 5.2;
      const vUp = this.vel.dot(this.up);
      const tangential = this.vel.clone().addScaledVector(this.up, -vUp);
      const liquid = this.checkLiquid();
      this.inLiquid = liquid;
      if (this.grounded || liquid) {
        const target = wish.multiplyScalar(liquid ? speed * 0.55 : speed);
        tangential.lerp(target, 1 - Math.exp(-dt * (liquid ? 3 : 12)));
      } else {
        tangential.addScaledVector(wish, speed * 1.4 * dt);
        const tl = tangential.length();
        if (tl > Math.max(speed, 12)) tangential.multiplyScalar(Math.max(speed, 12) / tl);
      }
      let up = vUp;
      up += -gl * dt;
      if (liquid) {
        up *= Math.exp(-dt * 2.5);
        up += gl * 0.85 * dt;
        if (input.down('Space')) up += 9 * dt;
      } else if (input.down('Space')) {
        if (this.grounded && this.groundTime > 0.05) {
          up = Math.max(up, 6.2);
          this.grounded = false;
        } else if (!this.grounded && this.fuel > 0 && up < 4) {
          // Short-burst jetpack: lets you hop gaps, climb ledges and slow falls.
          up += Math.max(gl * 1.45, 6) * dt;
          this.fuel = Math.max(0, this.fuel - dt / 2.2);
        }
      }
      if (this.grounded) this.fuel = Math.min(1, this.fuel + dt / 1.6);
      this.vel.copy(tangential).addScaledVector(this.up, up);
      // Terminal velocity scales with gravity so low-g falls feel floaty
      const tv = 55;
      if (this.vel.length() > tv) this.vel.multiplyScalar(tv / this.vel.length());
      this.integrate(dt);
      if (this.grounded) {
        this.groundTime += dt;
        const hs = tangential.length();
        const prev = Math.sin(this.bob);
        this.bob += hs * dt * 1.6;
        if (prev < 0 && Math.sin(this.bob) >= 0 && hs > 1) this.stepEvent = true;
      } else this.groundTime = 0;
    }

    // --- Camera
    _m.makeBasis(right, this.up, _c.copy(this.forward).negate());
    camera.quaternion.setFromRotationMatrix(_m);
    _q.setFromAxisAngle(X_AXIS, this.pitch);
    camera.quaternion.multiply(_q);
    camera.position.copy(this.eye);
  }

  private checkLiquid(): boolean {
    const P = this.world.params;
    const y = this.pos.y + 0.3;
    if (y < P.seaLevel) {
      const c = this.world.terrain.columnAt(this.pos.x, this.pos.z);
      if (c.h < P.seaLevel) return true;
    }
    if (y < P.under.liquidLevel && y > P.under.liquidLevel - 30) {
      const c = this.world.terrain.columnAt(this.pos.x, this.pos.z);
      if (c.uF < P.under.liquidLevel && c.uOpen > 4) return true;
    }
    return false;
  }

  private integrate(dt: number): void {
    const dist = this.vel.length() * dt;
    const steps = Math.max(1, Math.min(8, Math.ceil(dist / 0.35)));
    const h = dt / steps;
    this.grounded = false;
    for (let i = 0; i < steps; i++) {
      this.pos.addScaledVector(this.vel, h);
      this.collide();
    }
  }

  private collide(): void {
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (let k = 0; k < 2; k++) {
        _c.copy(this.pos).addScaledVector(this.up, k === 0 ? 0 : HEAD);
        const d = this.world.sdf(_c.x, _c.y, _c.z, _n);
        if (d < RADIUS) {
          this.resolve(_n, RADIUS - d);
          moved = true;
        }
        for (const src of this.sources) {
          if (src.resolveSphere(_c, RADIUS, _push, _n)) {
            const l = _push.length();
            this.resolve(_n, l);
            _c.add(_push);
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
  }

  private resolve(n: THREE.Vector3, depth: number): void {
    this.pos.addScaledVector(n, depth);
    const vn = this.vel.dot(n);
    if (vn < 0) this.vel.addScaledVector(n, -vn);
    if (n.dot(this.up) > 0.55) {
      this.grounded = true;
      // Ground friction when standing still on slopes
      if (this.mode === 'walk') {
        const vu = this.vel.dot(this.up);
        if (vu < 0) this.vel.addScaledVector(this.up, -vu);
      }
    }
  }
}

const _eye = new THREE.Vector3();
const IDENT = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);
