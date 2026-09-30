import * as THREE from 'three';
import { SiteInfo } from '../world/Terrain';
import { World } from '../world/World';
import { CivDef } from '../world/WorldParams';
import { Prim, PrimStyle } from '../render/Primitives';
import { RNG } from '../core/rng';
import { RGB, mixRGB, scaleRGB } from '../core/math';

// ---------------------------------------------------------------------------------------------
// Settlement generation. A settlement is a plaza with a monument, buildings in the civ's
// architectural family arranged around it, lantern-lit paths, gardens and an optional ring
// wall. Every building is a list of primitive pieces: destructible one by one, and a building
// collapses when a supporting piece is destroyed.
// ---------------------------------------------------------------------------------------------

export interface Piece {
  prim: Prim;
  m: THREE.Matrix4;
  inv: THREE.Matrix4;
  style: PrimStyle;
  building: number;
  support: boolean;
  alive: boolean;
  center: THREE.Vector3;
  radius: number;
  bottom: number;
  solid: boolean;
}

export interface Building {
  pos: THREE.Vector3;
  door: THREE.Vector3;
  radius: number;
  pieces: number[];
  collapsed: boolean;
}

export interface Dynamic {
  kind: 'orb' | 'fire';
  pos: THREE.Vector3;
  size: number;
  style: PrimStyle;
  alive: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

export class Settlement {
  readonly site: SiteInfo;
  readonly civ: CivDef;
  readonly name: string;
  readonly pieces: Piece[] = [];
  readonly buildings: Building[] = [];
  readonly dynamics: Dynamic[] = [];
  readonly plaza: THREE.Vector3;
  readonly center: THREE.Vector3;
  readonly key: string;
  villagersSpawned = false;
  discovered = false;
  sky = 1;

  private frame = new THREE.Matrix4();
  private curBuilding = -1;

  constructor(site: SiteInfo, private world: World, destroyed: Set<number>) {
    this.site = site;
    this.civ = site.civ;
    this.key = `${site.civ.id}:${site.cx}:${site.cz}`;
    const r = new RNG(site.seed);
    this.name = this.civ.lang.name(r.fork('name'));
    this.center = new THREE.Vector3(site.x, this.ground(site.x, site.z, site.y), site.z);
    this.plaza = this.center.clone();
    this.generate(r);
    for (let i = 0; i < this.pieces.length; i++) if (destroyed.has(i)) this.pieces[i].alive = false;
    for (const b of this.buildings) b.collapsed = b.pieces.some((i) => this.pieces[i].support && !this.pieces[i].alive);
    for (const b of this.buildings) if (b.collapsed) for (const i of b.pieces) this.pieces[i].alive = false;
  }

  private ground(x: number, z: number, fallback: number): number {
    const g = this.world.groundBelow(x, fallback + 25, z, 60);
    return g ?? fallback;
  }

  // --- Piece helpers -------------------------------------------------------------------------

  /** Adds a piece in the current building frame. */
  private add(prim: Prim, x: number, y: number, z: number, sx: number, sy: number, sz: number, style: PrimStyle, opts: { support?: boolean; rot?: THREE.Quaternion; solid?: boolean } = {}): void {
    const local = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), opts.rot ?? _q.identity(), new THREE.Vector3(sx, sy, sz));
    const m = this.frame.clone().multiply(local);
    const center = new THREE.Vector3();
    const halfY = prim === Prim.Sphere || prim === Prim.Box || prim === Prim.Torus || prim === Prim.Wing ? 0 : 0.5;
    center.set(0, halfY, 0).applyMatrix4(m);
    const s = new THREE.Vector3();
    m.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
    const radius = Math.max(Math.abs(s.x), Math.abs(s.y) * (halfY ? 0.5 : 1), Math.abs(s.z)) * (prim === Prim.Box ? 0.87 : 1);
    const bottom = new THREE.Vector3(0, prim === Prim.Sphere ? -1 : prim === Prim.Box ? -0.5 : 0, 0).applyMatrix4(m).y;
    this.pieces.push({
      prim, m, inv: m.clone().invert(), style, building: this.curBuilding, support: !!opts.support, alive: true,
      center, radius, bottom, solid: opts.solid ?? (prim !== Prim.Torus && prim !== Prim.Wing),
    });
    if (this.curBuilding >= 0) this.buildings[this.curBuilding].pieces.push(this.pieces.length - 1);
  }

  private setFrame(pos: THREE.Vector3, yaw: number): void {
    this.frame.compose(pos, new THREE.Quaternion().setFromAxisAngle(UP, yaw), new THREE.Vector3(1, 1, 1));
  }

  // --- Generation ----------------------------------------------------------------------------

  private generate(r: RNG): void {
    const civ = this.civ;
    const R = this.site.r;
    const hs = civ.heightScale;
    const wall: PrimStyle = { color: civ.wall, color2: scaleRGB(civ.wall, 0.8), pattern: r.pick([0, 1, 2, 3]), freq: r.range(2, 5) };
    const roof: PrimStyle = { color: civ.roof, color2: civ.trim, pattern: r.pick([0, 3, 1]), freq: r.range(3, 8) };
    const trim: PrimStyle = { color: civ.trim, color2: civ.roof };
    const glow: PrimStyle = { color: civ.glow, emissive: 2.4 };
    const door: PrimStyle = { color: scaleRGB(civ.trim, 0.35) };
    const bands: PrimStyle = { color: civ.wall, color2: civ.glow, pattern: 3, freq: 3.5, emissive: 0.9 };
    const under = civ.layer === 'under';

    // Plaza and monument
    this.curBuilding = -1;
    this.setFrame(this.center, 0);
    this.add(Prim.Cylinder, 0, -0.6, 0, 11, 0.75, 11, { color: mixRGB(civ.trim, civ.wall, 0.5), color2: civ.trim, pattern: 1, freq: 1.5 }, { solid: true });
    this.monument(r, civ, wall, trim, glow, bands);

    // Buildings
    const nb = Math.round(5 + r.next() * 8 + (R - 55) / 8);
    const placed: { x: number; z: number; r: number }[] = [{ x: 0, z: 0, r: 14 }];
    for (let tries = 0; tries < nb * 12 && this.buildings.length < nb; tries++) {
      const br = r.range(3, 6.5) * (civ.family === 'spire' ? 0.75 : 1);
      const a = r.next() * Math.PI * 2;
      const d = r.range(20, R * 0.88);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + br + 4.5)) continue;
      placed.push({ x, z, r: br });
      const wx = this.center.x + x, wz = this.center.z + z;
      const gy = this.ground(wx, wz, this.center.y);
      const pos = new THREE.Vector3(wx, gy, wz);
      const yaw = Math.atan2(-x, -z); // door (+z) faces the plaza
      const doorDir = new THREE.Vector3(-x, 0, -z).normalize();
      const b: Building = { pos, door: pos.clone().addScaledVector(doorDir, br + 1.5), radius: br, pieces: [], collapsed: false };
      this.buildings.push(b);
      this.curBuilding = this.buildings.length - 1;
      this.setFrame(pos, yaw);
      this.building(r, br, hs, wall, roof, trim, glow, door, bands);

      // Lantern posts along the path to the plaza
      this.curBuilding = -1;
      const steps = Math.floor((d - 14) / 9);
      for (let s = 1; s <= steps; s++) {
        if (!r.chance(0.7)) continue;
        const t = (14 + s * 9) / d;
        const px = this.center.x + x * t + Math.cos(a + Math.PI / 2) * 2.2, pz = this.center.z + z * t + Math.sin(a + Math.PI / 2) * 2.2;
        const py = this.ground(px, pz, this.center.y);
        this.setFrame(new THREE.Vector3(px, py, pz), 0);
        this.add(Prim.Cylinder, 0, 0, 0, 0.09, 2.2, 0.09, trim, { solid: false });
        this.add(Prim.Sphere, 0, 2.35, 0, 0.22, 0.28, 0.22, glow, { solid: false });
      }
      // Gardens
      if (r.chance(0.4)) {
        const gx = this.center.x + x + Math.cos(a) * (br + 5), gz = this.center.z + z + Math.sin(a) * (br + 5);
        const gy2 = this.ground(gx, gz, this.center.y);
        this.setFrame(new THREE.Vector3(gx, gy2, gz), yaw);
        const plant: PrimStyle = { color: this.world.params.biomes[0].top, color2: civ.glow, pattern: 2, freq: 6, emissive: under ? 0.6 : 0 };
        for (let row = -2; row <= 2; row++)
          for (let k = -2; k <= 2; k++) this.add(r.chance(0.5) ? Prim.Cone : Prim.Sphere, row * 0.9, 0, k * 0.9, 0.25, r.range(0.4, 0.8), 0.25, plant, { solid: false });
      }
    }

    // Ring wall with four gates
    if (civ.ringWall) {
      this.curBuilding = -1;
      const wr = R * 0.98;
      const segs = Math.round((wr * Math.PI * 2) / 5);
      for (let i = 0; i < segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        if (Math.abs(Math.sin(a * 2)) < 0.12) continue;
        const x = this.center.x + Math.cos(a) * wr, z = this.center.z + Math.sin(a) * wr;
        const y = this.ground(x, z, this.center.y);
        this.setFrame(new THREE.Vector3(x, y, z), -a);
        this.add(Prim.Box, 0, 1.1 * hs, 0, 0.8, 3.2 * hs, 5.3, wall, { support: false });
        if (i % 3 === 0) this.add(Prim.Cone, 0, 2.7 * hs, 0, 0.6, 1.4, 0.6, roof);
      }
    }
  }

  private monument(r: RNG, civ: CivDef, wall: PrimStyle, trim: PrimStyle, glow: PrimStyle, bands: PrimStyle): void {
    switch (civ.monument) {
      case 'obelisk':
        this.add(Prim.Box, 0, 0.5, 0, 4, 1, 4, trim);
        this.add(Prim.Hex, 0, 1, 0, 1.3, 14, 1.3, bands);
        this.add(Prim.Cone, 0, 15, 0, 1.3, 3, 1.3, glow);
        break;
      case 'orb':
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          this.add(Prim.Limb, Math.cos(a) * 4, 0, Math.sin(a) * 4, 0.45, 7, 0.45, wall);
        }
        this.add(Prim.Torus, 0, 7, 0, 4.2, 4, 4.2, trim);
        this.dynamics.push({ kind: 'orb', pos: new THREE.Vector3(0, 11, 0).applyMatrix4(this.frame), size: 2.2, style: glow, alive: true });
        break;
      case 'arch': {
        this.add(Prim.Cylinder, -5, 0, 0, 0.9, 9, 0.9, wall);
        this.add(Prim.Cylinder, 5, 0, 0, 0.9, 9, 0.9, wall);
        const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
        this.add(Prim.Torus, 0, 9, 0, 5, 5, 5, trim, { rot });
        this.dynamics.push({ kind: 'orb', pos: new THREE.Vector3(0, 8, 0).applyMatrix4(this.frame), size: 1.2, style: glow, alive: true });
        break;
      }
      case 'totem': {
        let y = 0;
        for (let i = 0; i < 5; i++) {
          const s = 1.6 - i * 0.15;
          this.add(i % 2 ? Prim.Sphere : Prim.Cylinder, 0, i % 2 ? y + s : y, 0, s, i % 2 ? s : s * 2, s, i % 2 ? wall : bands);
          if (i % 2) {
            this.add(Prim.Sphere, s * 0.5, y + s * 1.2, s * 0.8, 0.3, 0.3, 0.3, glow);
            this.add(Prim.Sphere, -s * 0.5, y + s * 1.2, s * 0.8, 0.3, 0.3, 0.3, glow);
          }
          y += i % 2 ? s * 2 : s * 2;
        }
        this.add(Prim.Cone, 0, y, 0, 1.4, 2.4, 0.3, trim);
        break;
      }
    }
    // Plaza fire (or glow-well underground)
    this.dynamics.push({ kind: 'fire', pos: new THREE.Vector3(0, 0, 7.5).applyMatrix4(this.frame), size: 1, style: glow, alive: true });
    this.add(Prim.Torus, 0, 0.15, 7.5, 1.3, 2, 1.3, trim, { solid: false });
    void r;
  }

  private building(r: RNG, R: number, hs: number, wall: PrimStyle, roof: PrimStyle, trim: PrimStyle, glow: PrimStyle, door: PrimStyle, bands: PrimStyle): void {
    const civ = this.civ;
    let base = 0;
    if (civ.stilts && civ.family !== 'pod') {
      base = 2.2;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        this.add(Prim.Limb, Math.cos(a) * R * 0.7, -0.5, Math.sin(a) * R * 0.7, 0.3, base + 0.6, 0.3, trim, { support: true });
      }
      this.add(Prim.Box, 0, base - 0.5, R + 0.8, 1.2, 0.2, 3.2, trim, { rot: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.6) });
    }
    const windowRing = (y: number, rr: number, n: number) => {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + 0.4;
        if (Math.abs(a - Math.PI / 2) < 0.3) continue;
        this.add(Prim.Sphere, Math.cos(a) * rr, y, Math.sin(a) * rr, 0.35, 0.45, 0.35, glow, { solid: false });
      }
    };
    const doorAt = (y: number, rr: number, h = 2.1) => this.add(Prim.Box, 0, y + h / 2, rr, 1.3, h, 0.6, door, { solid: false });

    switch (civ.family) {
      case 'dome': {
        const H = R * 0.95 * hs;
        this.add(Prim.Cylinder, 0, base - 0.3, 0, R, 1.1, R, trim, { support: true });
        this.add(Prim.Dome, 0, base + 0.8, 0, R, H, R, wall, { support: true });
        windowRing(base + 0.8 + H * 0.45, R * 0.9, r.int(3, 6));
        doorAt(base + 0.3, R * 0.93);
        this.add(Prim.Cylinder, 0, base + 0.8 + H * 0.95, 0, 0.15, R * 0.5, 0.15, trim);
        this.add(Prim.Sphere, 0, base + 0.8 + H * 0.95 + R * 0.5, 0, 0.35, 0.35, 0.35, glow, { solid: false });
        if (r.chance(0.5)) this.add(Prim.Torus, 0, base + 0.8 + H * 0.25, 0, R * 1.02, 1.2, R * 1.02, roof, { solid: false });
        break;
      }
      case 'spire': {
        const tiers = r.int(3, 5);
        let y = base - 0.3;
        for (let i = 0; i < tiers; i++) {
          const rr = R * (1 - i * 0.17);
          const h = (R * 1.3 * hs) / tiers + 1.2;
          this.add(Prim.Cylinder, 0, y, 0, rr, h, rr, i % 2 ? bands : wall, { support: i === 0 });
          this.add(Prim.Torus, 0, y + h, 0, rr * 1.08, 2, rr * 1.08, trim, { solid: false });
          y += h;
        }
        this.add(Prim.Cone, 0, y, 0, R * 0.55, R * 1.4 * hs, R * 0.55, roof);
        this.add(Prim.Sphere, 0, y + R * 1.4 * hs, 0, 0.3, 0.3, 0.3, glow, { solid: false });
        doorAt(base, R * 0.97);
        break;
      }
      case 'pod': {
        const h = 2.6;
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          this.add(Prim.Limb, Math.cos(a) * R * 0.85, -0.4, Math.sin(a) * R * 0.85, 0.28, h + R * 0.4, 0.28, trim, { support: true });
        }
        this.add(Prim.Sphere, 0, h + R * 0.75, 0, R, R * 0.8 * hs, R, wall, { support: true });
        this.add(Prim.Cone, 0, h + R * 0.75 + R * 0.6 * hs, 0, R * 0.5, R * 0.8, R * 0.5, roof);
        this.add(Prim.Torus, 0, h + R * 0.75, R * 0.95, 0.9, 0.9, 0.9, trim, { solid: false, rot: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2) });
        this.add(Prim.Sphere, 0, h + R * 0.75, R * 0.97, 0.75, 0.75, 0.25, glow, { solid: false });
        this.add(Prim.Box, 0, h * 0.5, R + 1.2, 1.1, 0.2, 3.4, trim, { rot: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.8) });
        break;
      }
      case 'mushroom': {
        const H = R * 1.1 * hs + 2.5;
        this.add(Prim.Cylinder, 0, base - 0.3, 0, R * 0.55, H, R * 0.55, wall, { support: true });
        this.add(Prim.Dome, 0, base + H - 0.3, 0, R * 1.45, R * 0.7, R * 1.45, roof, { support: false });
        this.add(Prim.Dome, 0, base + H - 0.25, 0, R * 1.4, -R * 0.18, R * 1.4, { ...trim, color2: civ.glow, pattern: 1, freq: 9, emissive: 0.5 });
        windowRing(base + H * 0.6, R * 0.53, r.int(2, 4));
        doorAt(base, R * 0.52);
        break;
      }
      case 'stack': {
        const levels = r.int(2, 4);
        let y = base - 0.3;
        let s = R * 1.5;
        for (let i = 0; i < levels; i++) {
          const h = 2.6 * hs;
          const rot = new THREE.Quaternion().setFromAxisAngle(UP, i * 0.35);
          this.add(Prim.Box, 0, y + h / 2, 0, s, h, s, i % 2 ? wall : bands, { support: i === 0, rot });
          this.add(Prim.Box, 0, y + h + 0.1, 0, s * 1.08, 0.25, s * 1.08, trim, { rot });
          y += h + 0.2;
          s *= 0.8;
        }
        this.add(Prim.Cone, 0, y, 0, s * 0.5, s * 0.7, s * 0.5, roof);
        this.add(Prim.Sphere, 0, y + s * 0.8, 0, 0.35, 0.35, 0.35, glow, { solid: false });
        doorAt(base, R * 0.76);
        break;
      }
      case 'shell': {
        const n = r.int(6, 9);
        const dirSign = r.chance(0.5) ? 1 : -1;
        for (let i = 0; i < n; i++) {
          const t = i / n;
          const s = R * Math.pow(0.8, i);
          const a = dirSign * t * Math.PI * 2.2;
          const rr = R * 0.6 * (1 - t);
          this.add(Prim.Sphere, Math.cos(a) * rr, base + s * 0.8 + t * R * 1.1 * hs, Math.sin(a) * rr, s, s * 0.9 * hs, s, i % 2 ? roof : wall, { support: i === 0 });
          if (i % 2 === 0) this.add(Prim.Cone, Math.cos(a) * (rr + s * 0.8), base + s * 1.2 + t * R * 1.1 * hs, Math.sin(a) * (rr + s * 0.8), s * 0.15, s * 0.9, s * 0.15, trim);
        }
        doorAt(base, R * 0.95);
        windowRing(base + R * 0.8, R * 0.95, r.int(2, 4));
        break;
      }
    }
    void _v;
  }

  // --- Queries ---------------------------------------------------------------------------------

  /** Destroys pieces within a sphere; supporting pieces collapse their whole building. */
  damage(center: THREE.Vector3, radius: number): Piece[] {
    const out: Piece[] = [];
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      if (!p.alive) continue;
      if (p.center.distanceTo(center) > radius + p.radius * 0.8) continue;
      p.alive = false;
      out.push(p);
      if (p.support && p.building >= 0) {
        const b = this.buildings[p.building];
        b.collapsed = true;
        for (const j of b.pieces) {
          const q = this.pieces[j];
          if (q.alive) {
            q.alive = false;
            out.push(q);
          }
        }
      }
    }
    return out;
  }

  destroyedIndices(): number[] {
    const out: number[] = [];
    this.pieces.forEach((p, i) => {
      if (!p.alive) out.push(i);
    });
    return out;
  }
}
