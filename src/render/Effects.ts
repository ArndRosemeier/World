import * as THREE from 'three';
import { World } from '../world/World';
import { Prim, PrimitiveBatch, PrimStyle, trsMatrix } from './Primitives';
import { RGB } from '../core/math';

// ---------------------------------------------------------------------------------------------
// Debris (rigid pieces bouncing on the terrain) and GPU point particles (dust, sparks, spores).
// ---------------------------------------------------------------------------------------------

interface Piece {
  prim: Prim;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  quat: THREE.Quaternion;
  spin: THREE.Vector3;
  scale: THREE.Vector3;
  style: PrimStyle;
  life: number;
  maxLife: number;
  radius: number;
  g: THREE.Vector3;
  resting: number;
}

const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

export class Debris {
  private pieces: Piece[] = [];
  max = 500;

  constructor(private world: World, private batch: PrimitiveBatch) {}

  spawn(prim: Prim, pos: THREE.Vector3, quat: THREE.Quaternion, scale: THREE.Vector3, vel: THREE.Vector3, style: PrimStyle, life = 10): void {
    if (this.pieces.length >= this.max) this.pieces.shift();
    const radius = Math.max(0.08, Math.min(scale.x, scale.y, scale.z) * (prim === Prim.Sphere ? 1 : 0.5));
    this.pieces.push({
      prim, pos: pos.clone(), vel: vel.clone(), quat: quat.clone(),
      spin: new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6),
      scale: scale.clone(), style: { ...style }, life, maxLife: life, radius, g: new THREE.Vector3(0, -9.8, 0), resting: 0,
    });
  }

  /** Burst of soil/rock chunks coloured like the terrain around a point. */
  burst(center: THREE.Vector3, count: number, size: number, speed: number, colors: RGB[], life = 8): void {
    for (let i = 0; i < count; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).normalize();
      const s = size * (0.4 + Math.random() * 0.8);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
      const prim = Math.random() < 0.6 ? Prim.Box : Prim.Sphere;
      const col = colors[Math.floor(Math.random() * colors.length)];
      this.spawn(prim, center.clone().addScaledVector(dir, size), q, new THREE.Vector3(s, s * (0.5 + Math.random() * 0.6), s * (0.6 + Math.random() * 0.5)), dir.multiplyScalar(speed * (0.4 + Math.random())), { color: col }, life * (0.6 + Math.random() * 0.6));
    }
  }

  update(dt: number, frame: number): void {
    const W = this.world;
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.pieces.splice(i, 1);
        continue;
      }
      if (p.resting > 1.5) continue;
      if ((frame + i) % 8 === 0) W.gravity(p.pos.x, p.pos.y, p.pos.z, p.g);
      p.vel.addScaledVector(p.g, dt);
      p.pos.addScaledVector(p.vel, dt);
      _q.setFromEuler(new THREE.Euler(p.spin.x * dt, p.spin.y * dt, p.spin.z * dt));
      p.quat.multiply(_q);
      const d = W.sdf(p.pos.x, p.pos.y, p.pos.z, _n);
      if (d < p.radius) {
        p.pos.addScaledVector(_n, p.radius - d);
        const vn = p.vel.dot(_n);
        if (vn < 0) p.vel.addScaledVector(_n, -vn * 1.35);
        p.vel.multiplyScalar(0.72);
        p.spin.multiplyScalar(0.7);
        if (p.vel.lengthSq() < 0.3) p.resting += dt * 4;
      }
    }
  }

  /** Adds live debris to the dynamic batch; pieces shrink away at the end of their life. */
  render(): void {
    for (const p of this.pieces) {
      const k = Math.min(1, p.life / Math.min(2, p.maxLife * 0.3));
      trsMatrix(p.pos, p.quat, p.scale.x * k, p.scale.y * k, p.scale.z * k, _m);
      this.batch.add(p.prim, _m, p.style);
    }
  }

  get count(): number {
    return this.pieces.length;
  }
}

// --- Particles -------------------------------------------------------------------------------

const PVERT = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
varying vec4 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (600.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const PFRAG = /* glsl */ `
varying vec4 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float a = 1.0 - smoothstep(0.0, 0.5, d);
  gl_FragColor = vec4(vColor.rgb * (1.0 + a), vColor.a * a);
}
`;

interface Particle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  color: THREE.Color;
  alpha: number;
  size: number;
  life: number;
  maxLife: number;
  drag: number;
  grav: number;
  grow: number;
}

export class Particles {
  readonly points: THREE.Points;
  private list: Particle[] = [];
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  readonly max: number;

  constructor(max = 4000, additive = true) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({
      vertexShader: PVERT,
      fragmentShader: PFRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  emit(pos: THREE.Vector3, vel: THREE.Vector3, color: THREE.Color | RGB, size: number, life: number, opts: { alpha?: number; drag?: number; grav?: number; grow?: number } = {}): void {
    if (this.list.length >= this.max) this.list.shift();
    const c = Array.isArray(color) ? new THREE.Color().setRGB(color[0], color[1], color[2], THREE.SRGBColorSpace) : color.clone();
    this.list.push({ pos: pos.clone(), vel: vel.clone(), color: c, alpha: opts.alpha ?? 1, size, life, maxLife: life, drag: opts.drag ?? 1, grav: opts.grav ?? 0, grow: opts.grow ?? 0 });
  }

  update(dt: number, up: THREE.Vector3): void {
    let n = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.list.splice(i, 1);
        continue;
      }
      p.vel.multiplyScalar(Math.exp(-p.drag * dt));
      p.vel.addScaledVector(up, -p.grav * dt);
      p.pos.addScaledVector(p.vel, dt);
      p.size += p.grow * dt;
    }
    for (const p of this.list) {
      const t = p.life / p.maxLife;
      const fade = Math.min(1, t * 3) * Math.min(1, (1 - t) * 8 + 0.2);
      this.pos[n * 3] = p.pos.x;
      this.pos[n * 3 + 1] = p.pos.y;
      this.pos[n * 3 + 2] = p.pos.z;
      this.col[n * 4] = p.color.r;
      this.col[n * 4 + 1] = p.color.g;
      this.col[n * 4 + 2] = p.color.b;
      this.col[n * 4 + 3] = p.alpha * fade;
      this.size[n] = p.size;
      n++;
    }
    const g = this.points.geometry;
    g.setDrawRange(0, n);
    g.attributes.position.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    void _v;
  }

  get count(): number {
    return this.list.length;
  }
}
