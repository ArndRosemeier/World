import * as THREE from 'three';
import { Terrain } from './Terrain';
import { EditStore } from './Edits';
import { WorldParams, createWorldParams } from './WorldParams';
import { smoothstep, lerp } from '../core/math';
import { BEDROCK } from './constants';

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
}

const _moons: { x: number; y: number; z: number; r: number }[] = [];

/**
 * Main-thread view of the world: exact density queries (terrain + edits), surface normals,
 * raycasts and the gravity field. Physics, creatures and tools all go through here.
 */
export class World {
  readonly params: WorldParams;
  readonly terrain: Terrain;
  readonly edits = new EditStore();

  constructor(seed: string) {
    this.params = createWorldParams(seed);
    this.terrain = new Terrain(this.params);
  }

  density(x: number, y: number, z: number): number {
    const d = this.edits.applyAt(this.terrain.densityAt(x, y, z), x, y, z);
    return Terrain.finalize(d, y);
  }

  /** Unit surface normal (gradient direction) at a point. */
  normal(x: number, y: number, z: number, out: THREE.Vector3, e = 0.2): THREE.Vector3 {
    const dx = this.density(x + e, y, z) - this.density(x - e, y, z);
    const dy = this.density(x, y + e, z) - this.density(x, y - e, z);
    const dz = this.density(x, y, z + e) - this.density(x, y, z - e);
    out.set(dx, dy, dz);
    const l = out.length();
    if (l < 1e-6) out.set(0, 1, 0);
    else out.multiplyScalar(1 / l);
    return out;
  }

  /**
   * Approximate signed distance: density divided by gradient magnitude. Returns the distance and
   * writes the outward normal.
   */
  sdf(x: number, y: number, z: number, nOut: THREE.Vector3): number {
    const e = 0.15;
    const d0 = this.density(x, y, z);
    const dx = this.density(x + e, y, z) - this.density(x - e, y, z);
    const dy = this.density(x, y + e, z) - this.density(x, y - e, z);
    const dz = this.density(x, y, z + e) - this.density(x, y, z - e);
    const gl = Math.hypot(dx, dy, dz) / (2 * e);
    if (gl < 1e-6) {
      nOut.set(0, 1, 0);
      return d0;
    }
    nOut.set(dx, dy, dz).normalize();
    return d0 / Math.max(gl, 0.35);
  }

  /** Sphere-traced raycast against the terrain. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null {
    let t = 0;
    let prevT = 0;
    let d = this.density(origin.x, origin.y, origin.z);
    if (d < 0) return { point: origin.clone(), normal: this.normal(origin.x, origin.y, origin.z, new THREE.Vector3()), distance: 0 };
    while (t < maxDist) {
      const step = Math.min(Math.max(d * 0.55, 0.12), 4);
      prevT = t;
      t += step;
      const x = origin.x + dir.x * t, y = origin.y + dir.y * t, z = origin.z + dir.z * t;
      d = this.density(x, y, z);
      if (d < 0) {
        let a = prevT, b = t;
        for (let i = 0; i < 10; i++) {
          const m = (a + b) * 0.5;
          if (this.density(origin.x + dir.x * m, origin.y + dir.y * m, origin.z + dir.z * m) < 0) b = m;
          else a = m;
        }
        const p = origin.clone().addScaledVector(dir, (a + b) * 0.5);
        return { point: p, normal: this.normal(p.x, p.y, p.z, new THREE.Vector3()), distance: (a + b) * 0.5 };
      }
    }
    return null;
  }

  /**
   * Moves p along `up` onto the surface (Newton steps on the density). Returns false if the
   * surface is further than maxMove away (a cliff or a wall).
   */
  snap(p: THREE.Vector3, up: THREE.Vector3, maxMove = 4): boolean {
    let moved = 0;
    for (let i = 0; i < 6; i++) {
      const d = this.density(p.x, p.y, p.z);
      if (Math.abs(d) < 0.04) return true;
      const step = Math.max(-1.5, Math.min(1.5, d * 0.9));
      p.addScaledVector(up, -step);
      moved += Math.abs(step);
      if (moved > maxMove) return false;
    }
    return Math.abs(this.density(p.x, p.y, p.z)) < 0.4;
  }

  /** Height of the first floor below `y` in the column (x, z), or null. */
  groundBelow(x: number, y: number, z: number, maxDrop = 200): number | null {
    const hit = this.raycast(new THREE.Vector3(x, y, z), DOWN, maxDrop);
    return hit ? hit.point.y : null;
  }

  /** How much open sky is above a point (0 = enclosed by rock, 1 = open). */
  skyVisibility(x: number, y: number, z: number): number {
    const col = this.terrain.columnAt(x, z);
    if (y > col.top) return 1;
    if (Terrain.sealedFromSky(col, y)) return 0;
    let sky = 1;
    for (const st of [3, 7, 14, 26, 45, 80]) {
      const yy = y + st;
      if (yy > col.top) break;
      sky *= smoothstep(-3, 1.5, this.density(x, yy, z));
      if (sky < 0.01) return 0;
    }
    return sky;
  }

  /** 0 at the surface, 1 deep in the underworld. */
  underworldFactor(x: number, y: number, z: number): number {
    const col = this.terrain.columnAt(x, z);
    if (col.uOpen <= 0) return 0;
    return smoothstep(col.uC + 40, col.uC - 10, y) * smoothstep(col.uF - 60, col.uF - 10, y);
  }

  /**
   * The gravity field. Regional strength varies, levitation zones weaken it, lift wells
   * reverse it and moonlets pull toward their own centres.
   */
  gravity(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const T = this.terrain;
    const G = this.params.gravity;
    const lev = T.levitation(x, z);
    let g = G * T.gravityFactor(x, z) * lerp(1, 0.16, lev);
    if (y < -180) g *= 0.72;
    out.set(0, -g, 0);

    const w = T.wellAt(x, z);
    if (w) {
      const r = Math.hypot(x - w.x, z - w.z);
      const k = smoothstep(w.r * 1.6, w.r * 0.7, r) * smoothstep(w.base - 10, w.base + 5, y) * smoothstep(w.base + w.height, w.base + w.height - 40, y);
      if (k > 0) {
        out.y = lerp(out.y, G * 0.5, k);
        // Gentle swirl toward the axis keeps riders inside the column.
        out.x += ((w.x - x) / Math.max(r, 1)) * k * 1.5;
        out.z += ((w.z - z) / Math.max(r, 1)) * k * 1.5;
      }
    }

    T.moonsNear(x, z, _moons);
    for (const m of _moons) {
      const dx = m.x - x, dy = m.y - y, dz = m.z - z;
      const d = Math.hypot(dx, dy, dz);
      const k = smoothstep(m.r * 3.2, m.r * 1.35, d);
      if (k <= 0) continue;
      const gm = G * 0.85;
      out.x = lerp(out.x, (dx / d) * gm, k);
      out.y = lerp(out.y, (dy / d) * gm, k);
      out.z = lerp(out.z, (dz / d) * gm, k);
    }
    return out;
  }

  /** Finds a comfortable spawn point on land near the origin. */
  findSpawn(): THREE.Vector3 {
    const T = this.terrain;
    let best = new THREE.Vector3(0, 60, 0);
    let bestScore = -Infinity;
    for (let i = 0; i < 400; i++) {
      const a = i * 2.39996;
      const r = 40 * Math.sqrt(i) * 6;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const c = T.columnAt(x, z);
      if (c.h < this.params.seaLevel + 3) continue;
      const lev = T.levitation(x, z);
      const score = -Math.abs(c.h - 25) * 0.02 - r * 0.001 + (c.overhang < 3 ? 1 : 0) - lev * 2 + (c.settle > 0 ? 0.4 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = new THREE.Vector3(x, c.top + 5, z);
      }
      if (i > 60 && bestScore > 0.5) break;
    }
    const y = this.groundBelow(best.x, best.y, best.z, 800);
    best.y = (y ?? Math.max(0, best.y - 5)) + 2;
    return best;
  }

  get bedrock(): number {
    return BEDROCK;
  }
}

const DOWN = new THREE.Vector3(0, -1, 0);
