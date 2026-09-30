import * as THREE from 'three';
import { World } from '../world/World';
import { hash01 } from '../core/rng';
import { createFallMaterial, createFlowMaterial } from './WaterShaders';
import { Particles } from '../render/Effects';
import { RGB } from '../core/math';

// ---------------------------------------------------------------------------------------------
// Waterfalls as world features: rivers that run to cliff edges and plunge off, falls pouring
// off floating islands (slow, wide arcs in the weak gravity of levitation fields), streams
// tumbling down sinkholes into the underworld, and glowing falls from the underworld ceiling.
// Every trajectory is integrated through the real gravity field and collides with the real
// terrain, so falls bend around moonlets, arc in low gravity and break over ledges.
// ---------------------------------------------------------------------------------------------

type Kind = 'cliff' | 'island' | 'shaft' | 'ceiling';

interface PathPoint {
  p: THREE.Vector3;
  fall: number;
  width: number;
  face: THREE.Vector3;
}

interface Fall {
  key: string;
  kind: Kind;
  anchor: THREE.Vector3;
  group: THREE.Group | null;
  impact: THREE.Vector3 | null;
  impactSea: boolean;
  lipPoint: THREE.Vector3;
  height: number;
  width: number;
  glow: boolean;
  path: PathPoint[];
  mistColor: RGB;
}

const CLIFF_CELL = 380;
const CEIL_CELL = 300;
const UP = new THREE.Vector3(0, 1, 0);
const _g = new THREE.Vector3();
const _n = new THREE.Vector3();

export class Waterfalls {
  readonly group = new THREE.Group();
  private falls = new Map<string, Fall>();
  private specCache = new Map<string, Fall | null>();
  private buildQueue: string[] = [];
  private scanTimer = 0;
  private fallMat: THREE.ShaderMaterial;
  private glowMat: THREE.ShaderMaterial;
  private poolMat: THREE.ShaderMaterial;
  private glowPoolMat: THREE.ShaderMaterial;
  radius = 2600;
  /** 0..1 loudness of the nearest falls (for audio). */
  roar = 0;

  constructor(private world: World, private mist: Particles) {
    const P = world.params;
    const c = P.liquid, u = P.under.liquid;
    const sea = new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
    const lake = new THREE.Color().setRGB(u[0], u[1], u[2], THREE.SRGBColorSpace);
    const speed = 3 + Math.sqrt(P.gravity) * 2.2;
    this.fallMat = createFallMaterial(sea, P.liquidGlow, speed);
    this.glowMat = createFallMaterial(lake, 0.9, speed * 0.85);
    this.poolMat = createFlowMaterial(sea.clone(), P.liquidGlow);
    this.glowPoolMat = createFlowMaterial(lake.clone(), 0.8);
    this.glowMat.uniforms.uSky.value = 0.15;
    this.glowPoolMat.uniforms.uSky.value = 0.15;
  }

  get count(): number {
    let n = 0;
    for (const f of this.falls.values()) if (f.group) n++;
    return n;
  }

  /** Brightness of the surroundings, so mist isn't glowing in dark caverns. */
  light = 1;

  update(dt: number, player: THREE.Vector3, sky: number): void {
    this.fallMat.uniforms.uSky.value = Math.max(0.15, sky);
    this.poolMat.uniforms.uSky.value = Math.max(0.15, sky);
    this.scanTimer -= dt;
    if (this.scanTimer <= 0) {
      this.scanTimer = 1.5;
      this.scan(player);
    }
    // Build one feature per frame: tracing paths uses exact terrain queries
    const t0 = performance.now();
    while (this.buildQueue.length && performance.now() - t0 < 6) {
      const key = this.buildQueue.shift()!;
      const f = this.falls.get(key);
      if (f && !f.group) this.build(f);
    }
    this.emitMist(dt, player);
  }

  // --- Discovery -----------------------------------------------------------------------------

  private scan(player: THREE.Vector3): void {
    const want = new Set<string>();
    const consider = (key: string, make: () => Fall | null) => {
      let spec = this.specCache.get(key);
      if (spec === undefined) {
        spec = make();
        this.specCache.set(key, spec);
        if (this.specCache.size > 3000) this.specCache.clear();
      }
      if (!spec) return;
      if (spec.anchor.distanceTo(player) > this.radius) return;
      want.add(key);
      if (!this.falls.has(key)) {
        this.falls.set(key, spec);
        this.buildQueue.push(key);
      }
    };
    const T = this.world.terrain;
    const R = this.radius;
    // Cliff rivers (a limited number of new cells per scan keeps frames smooth)
    let budget = 10;
    const cx0 = Math.floor(player.x / CLIFF_CELL), cz0 = Math.floor(player.z / CLIFF_CELL);
    const rc = Math.ceil(R / CLIFF_CELL);
    const cells: [number, number, number][] = [];
    for (let i = -rc; i <= rc; i++) for (let j = -rc; j <= rc; j++) cells.push([i * i + j * j, cx0 + i, cz0 + j]);
    cells.sort((a, b) => a[0] - b[0]);
    for (const [, cx, cz] of cells) {
      const key = `c:${cx}:${cz}`;
      if (!this.specCache.has(key)) {
        if (budget-- <= 0) continue;
      }
      consider(key, () => this.cliffSpec(cx, cz));
    }
    for (const is of T.islandsInRange(player.x, player.z, R)) consider(`i:${is.cx}:${is.cz}`, () => this.islandSpec(is));
    for (const sh of T.shaftsInRange(player.x, player.z, R)) consider(`s:${sh.cx}:${sh.cz}`, () => this.shaftSpec(sh));
    if (player.y < -120) {
      const ux = Math.floor(player.x / CEIL_CELL), uz = Math.floor(player.z / CEIL_CELL);
      for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) consider(`u:${ux + i}:${uz + j}`, () => this.ceilingSpec(ux + i, uz + j));
    }
    for (const [key, f] of this.falls) {
      if (want.has(key)) continue;
      if (f.group) {
        this.group.remove(f.group);
        f.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
        f.group = null;
      }
      this.falls.delete(key);
    }
  }

  private seed(): number {
    return this.world.params.seed | 0;
  }

  private ground(x: number, z: number, fromY?: number): number | null {
    const c = this.world.terrain.columnAt(x, z);
    const top = fromY ?? c.top + 2;
    return this.world.groundBelow(x, top, z, top - Math.min(c.h, this.world.params.seaLevel) + 60);
  }

  private blank(key: string, kind: Kind, anchor: THREE.Vector3, width: number, glow: boolean): Fall {
    const P = this.world.params;
    const c = glow ? P.under.liquid : P.liquid;
    return {
      key, kind, anchor, group: null, impact: null, impactSea: false, lipPoint: anchor.clone(), height: 0, width, glow, path: [],
      mistColor: [c[0] * 0.3 + 0.7, c[1] * 0.3 + 0.7, c[2] * 0.3 + 0.7],
    };
  }

  /** Finds the most dramatic drop in a cell and a river feeding it. */
  private cliffSpec(cx: number, cz: number): Fall | null {
    const s = this.seed();
    if (hash01(cx, cz, s, 811) > 0.8) return null;
    const T = this.world.terrain;
    const P = this.world.params;
    let best: { p: THREE.Vector3; d: THREE.Vector3; drop: number; h0: number } | null = null;
    for (let k = 0; k < 22; k++) {
      const x = (cx + hash01(cx, cz, s + k, 812)) * CLIFF_CELL, z = (cz + hash01(cx, cz, s + k, 813)) * CLIFF_CELL;
      const c0 = T.columnAt(x, z);
      const h0 = c0.h;
      if (h0 < P.seaLevel + 8 || c0.settle > 0.01 || c0.lev > 0.5) continue;
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        const dx = Math.cos(ang), dz = Math.sin(ang);
        const h1 = T.columnAt(x + dx * 10, z + dz * 10).h;
        if (h0 - h1 < 9) continue;
        const h2 = T.columnAt(x + dx * 30, z + dz * 30).h;
        const drop = h0 - h2;
        if (drop > 28 && (!best || drop > best.drop)) best = { p: new THREE.Vector3(x, h0, z), d: new THREE.Vector3(dx, 0, dz), drop, h0 };
      }
    }
    if (!best) return null;
    // Walk to the lip
    let lip = best.p.clone();
    for (let k = 1; k < 30; k++) {
      const q = best.p.clone().addScaledVector(best.d, k);
      if (best.h0 - T.columnAt(q.x, q.z).h > 2.5) break;
      lip = q;
    }
    const w = 4 + hash01(cx, cz, s, 814) * 9;
    const f = this.blank(`c:${cx}:${cz}`, 'cliff', lip.clone(), w, false);
    f.lipPoint = lip;
    (f as FallInternal).dir = best.d;
    (f as FallInternal).riverLen = 50 + hash01(cx, cz, s, 815) * 120;
    return f;
  }

  private islandSpec(is: { x: number; y: number; z: number; r: number; t: number; cx: number; cz: number }): Fall | null {
    const s = this.seed();
    if (hash01(is.cx, is.cz, s, 821) > 0.7) return null;
    const a = hash01(is.cx, is.cz, s, 822) * Math.PI * 2;
    const d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const f = this.blank(`i:${is.cx}:${is.cz}`, 'island', new THREE.Vector3(is.x, is.y, is.z), 6 + hash01(is.cx, is.cz, s, 823) * 11, false);
    const fi = f as FallInternal;
    fi.dir = d;
    fi.island = is;
    return f;
  }

  private shaftSpec(sh: { x: number; z: number; r: number; cx: number; cz: number }): Fall | null {
    const s = this.seed();
    if (hash01(sh.cx, sh.cz, s, 831) > 0.75) return null;
    const a = hash01(sh.cx, sh.cz, s, 832) * Math.PI * 2;
    const f = this.blank(`s:${sh.cx}:${sh.cz}`, 'shaft', new THREE.Vector3(sh.x, 0, sh.z), 6 + hash01(sh.cx, sh.cz, s, 833) * 8, false);
    const fi = f as FallInternal;
    fi.dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    fi.shaft = sh;
    fi.riverLen = 70 + hash01(sh.cx, sh.cz, s, 834) * 90;
    return f;
  }

  private ceilingSpec(cx: number, cz: number): Fall | null {
    const s = this.seed();
    if (hash01(cx, cz, s, 841) > 0.5) return null;
    const x = (cx + 0.2 + 0.6 * hash01(cx, cz, s, 842)) * CEIL_CELL, z = (cz + 0.2 + 0.6 * hash01(cx, cz, s, 843)) * CEIL_CELL;
    const c = this.world.terrain.columnAt(x, z);
    if (c.uOpen < 70 || c.h < c.uC + 60) return null;
    const f = this.blank(`u:${cx}:${cz}`, 'ceiling', new THREE.Vector3(x, (c.uF + c.uC) / 2, z), 3 + hash01(cx, cz, s, 844) * 6, true);
    return f;
  }

  // --- Path tracing --------------------------------------------------------------------------

  /** A stream from `from` running toward `to`, hugging the ground and meandering. */
  private river(from: THREE.Vector3, to: THREE.Vector3, width: number, seed: number): PathPoint[] {
    const pts: PathPoint[] = [];
    const p = from.clone();
    const W = this.world;
    for (let i = 0; i < 80; i++) {
      const g = this.ground(p.x, p.z, p.y + 6);
      if (g !== null) p.y = g;
      W.normal(p.x, p.y + 0.05, p.z, _n, 0.6);
      pts.push({ p: p.clone().addScaledVector(_n, 0.15), fall: 0, width: width * (0.6 + 0.4 * (i / 40)), face: _n.clone() });
      const toT = new THREE.Vector3(to.x - p.x, 0, to.z - p.z);
      const dist = toT.length();
      if (dist < 4) break;
      toT.normalize();
      const side = new THREE.Vector3(-toT.z, 0, toT.x).multiplyScalar(Math.sin(i * 0.35 + seed) * 0.45 * Math.min(1, dist / 40));
      // Water prefers to run downhill
      const down = new THREE.Vector3(-_n.x, 0, -_n.z).multiplyScalar(0.6);
      p.addScaledVector(toT.add(side).add(down).normalize(), Math.min(4, dist));
    }
    return pts;
  }

  /** Free fall under the real gravity field, deflecting off walls, until it lands. */
  private fallPath(start: THREE.Vector3, v0: THREE.Vector3, width: number, face: THREE.Vector3): { pts: PathPoint[]; impact: THREE.Vector3 | null; sea: boolean; scrapes: number } {
    const W = this.world;
    const P = W.params;
    const pts: PathPoint[] = [];
    const p = start.clone();
    const v = v0.clone();
    let fallen = 0;
    let dt = 0.08;
    let scrapes = 0;
    for (let i = 0; i < 400; i++) {
      pts.push({ p: p.clone(), fall: 1, width: width * (1 + fallen * 0.0035), face: face.clone() });
      W.gravity(p.x, p.y, p.z, _g);
      // Terminal velocity: long drops stop accelerating (and look like it)
      v.addScaledVector(_g, dt);
      const sp = v.length();
      if (sp > 28) v.multiplyScalar(28 / sp);
      v.x *= 0.995;
      v.z *= 0.995;
      const step = v.clone().multiplyScalar(dt);
      // Aim for roughly 3 m between samples
      dt = Math.min(0.25, Math.max(0.03, 3 / Math.max(1, sp)));
      const q = p.clone().add(step);
      fallen += step.length();
      if (q.y < P.seaLevel && W.terrain.columnAt(q.x, q.z).h < P.seaLevel) {
        q.y = P.seaLevel;
        pts.push({ p: q, fall: 1, width: width * (1 + fallen * 0.0035), face: face.clone() });
        return { pts, impact: q, sea: true, scrapes };
      }
      const d = W.density(q.x, q.y, q.z);
      if (d < 0) {
        W.normal(q.x, q.y, q.z, _n, 0.4);
        if (_n.dot(_g.normalize().negate()) > 0.55) {
          // Landed on a floor
          const hit = W.raycast(p, step.clone().normalize(), step.length() + 2);
          const at = hit ? hit.point : q;
          pts.push({ p: at.clone(), fall: 1, width: width * (1 + fallen * 0.0035), face: face.clone() });
          return { pts, impact: at, sea: false, scrapes };
        }
        // Hit a wall or ledge: spill over it
        scrapes++;
        p.addScaledVector(_n, 1.5);
        v.set(_n.x * 1.5, Math.min(v.y, 0), _n.z * 1.5);
        continue;
      }
      p.copy(q);
      if (fallen > 700) break;
    }
    return { pts, impact: null, sea: false, scrapes };
  }

  private build(f: Fall): void {
    const fi = f as FallInternal;
    const W = this.world;
    const s = this.seed();
    let path: PathPoint[] = [];
    let lip: THREE.Vector3;
    let dir: THREE.Vector3;
    if (f.kind === 'cliff') {
      dir = fi.dir!;
      lip = f.lipPoint.clone();
      const g = this.ground(lip.x, lip.z);
      if (g === null) return this.drop(f);
      lip.y = g;
      const spring = lip.clone().addScaledVector(dir, -(fi.riverLen ?? 80));
      path = this.river(spring, lip, f.width, hash01(f.anchor.x | 0, s));
    } else if (f.kind === 'island') {
      const is = fi.island!;
      dir = fi.dir!;
      const edge = new THREE.Vector3(is.x, 0, is.z).addScaledVector(dir, is.r * 0.82);
      const top = this.ground(edge.x, edge.z, is.y + is.r * 0.5);
      if (top === null || top < is.y - is.t) return this.drop(f);
      edge.y = top;
      const spring = new THREE.Vector3(is.x, 0, is.z).addScaledVector(dir, is.r * 0.25);
      spring.y = this.ground(spring.x, spring.z, is.y + is.r * 0.5) ?? top;
      path = this.river(spring, edge, f.width, is.cx);
      lip = edge;
    } else if (f.kind === 'shaft') {
      const sh = fi.shaft!;
      dir = fi.dir!.clone().negate();
      // Find the rim: walk inward from outside until the ground drops away
      const outside = new THREE.Vector3(sh.x, 0, sh.z).addScaledVector(fi.dir!, sh.r + 45);
      let rim = outside.clone();
      rim.y = this.ground(rim.x, rim.z) ?? 0;
      for (let k = 0; k < 60; k++) {
        const q = rim.clone().addScaledVector(dir, 1);
        const g = this.ground(q.x, q.z, rim.y + 5);
        if (g === null || rim.y - g > 3) break;
        q.y = g;
        rim = q;
      }
      const spring = rim.clone().addScaledVector(dir, -(fi.riverLen ?? 90));
      path = this.river(spring, rim, f.width, sh.cx);
      lip = rim;
    } else {
      // Underworld ceiling: find the ceiling above and fall from a crack in it
      const a = f.anchor;
      const hit = W.raycast(a, UP, 260);
      if (!hit) return this.drop(f);
      lip = hit.point.clone().addScaledVector(UP, -0.5);
      dir = new THREE.Vector3(1, 0, 0);
    }
    if (path.length) path[path.length - 1].fall = 0.3;
    const v0 = f.kind === 'ceiling' ? new THREE.Vector3(0, -1, 0) : dir.clone().multiplyScalar(f.kind === 'island' ? 2.2 : 3.5).add(new THREE.Vector3(0, 0.3, 0));
    const face = dir.clone();
    const start = lip.clone().addScaledVector(dir, 0.6);
    const fall = this.fallPath(start, v0, f.width * (f.kind === 'ceiling' ? 1 : 0.9), face);
    if (fall.pts.length < 3) return this.drop(f);
    path = path.concat(fall.pts);
    f.path = path;
    f.impact = fall.impact;
    f.impactSea = fall.sea;
    f.lipPoint = lip;
    f.height = lip.y - (fall.impact?.y ?? fall.pts[fall.pts.length - 1].p.y);
    if (f.height < 8) return this.drop(f);
    // Cliff falls must be real free drops; slope-hugging trickles look broken
    if (f.kind === 'cliff' && (f.height < 30 || fall.scrapes > 2)) return this.drop(f);
    if (f.kind === 'shaft' && f.height < 40) return this.drop(f);

    const group = new THREE.Group();
    group.add(this.ribbon(path, f.glow ? this.glowMat : this.fallMat));
    // A wider, fainter veil in front of big falls
    if (f.height > 25) {
      const veil = fall.pts.map((q) => ({ ...q, p: q.p.clone().addScaledVector(q.face, 0.8), width: q.width * 1.5 }));
      group.add(this.ribbon(veil, f.glow ? this.glowMat : this.fallMat, 0.5));
    }
    if (fall.impact) {
      const flat = fall.sea || W.normal(fall.impact.x, fall.impact.y + 0.3, fall.impact.z, _n, 1).y > 0.85;
      if (flat) group.add(this.pool(fall.impact, f.width * 1.4 + 3, fall.sea, f.glow));
    }
    group.userData.key = f.key;
    f.group = group;
    this.group.add(group);
  }

  private drop(f: Fall): void {
    this.specCache.set(f.key, null);
    this.falls.delete(f.key);
  }

  /** A ribbon along the path: flat on the ground for rivers, a curved curtain in free fall. */
  private ribbon(path: PathPoint[], mat: THREE.ShaderMaterial, widthScale = 1): THREE.Mesh {
    const ACROSS = 7;
    const pos: number[] = [], nrm: number[] = [], uv: number[] = [], fall: number[] = [], wid: number[] = [];
    const idx: number[] = [];
    let dist = 0;
    for (let i = 0; i < path.length; i++) {
      const a = path[Math.max(0, i - 1)].p, b = path[Math.min(path.length - 1, i + 1)].p;
      const tan = b.clone().sub(a).normalize();
      if (i > 0) dist += path[i].p.distanceTo(path[i - 1].p);
      const pt = path[i];
      let lat = new THREE.Vector3().crossVectors(tan, pt.face);
      if (lat.lengthSq() < 1e-4) lat = new THREE.Vector3().crossVectors(tan, UP);
      if (lat.lengthSq() < 1e-4) lat.set(1, 0, 0);
      lat.normalize();
      const face = new THREE.Vector3().crossVectors(lat, tan).normalize();
      const w = pt.width * widthScale;
      for (let k = 0; k < ACROSS; k++) {
        const u = k / (ACROSS - 1);
        const x = (u - 0.5) * w;
        // Curtains bulge outward a little, like water pouring over a lip
        const bulge = pt.fall * (1 - (2 * u - 1) * (2 * u - 1)) * w * 0.12;
        const q = pt.p.clone().addScaledVector(lat, x).addScaledVector(face, bulge);
        pos.push(q.x, q.y, q.z);
        nrm.push(face.x, face.y, face.z);
        uv.push(u, dist);
        fall.push(pt.fall);
        wid.push(w);
      }
    }
    for (let i = 0; i < path.length - 1; i++)
      for (let k = 0; k < ACROSS - 1; k++) {
        const a = i * ACROSS + k, b = a + 1, c = a + ACROSS + 1, d = a + ACROSS;
        idx.push(a, b, c, a, c, d);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aFall', new THREE.Float32BufferAttribute(fall, 1));
    g.setAttribute('aWidth', new THREE.Float32BufferAttribute(wid, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.renderOrder = 5;
    return m;
  }

  /** Churning plunge pool: radial outflow with foam at the centre. */
  private pool(at: THREE.Vector3, R: number, onSea: boolean, glow: boolean): THREE.Mesh {
    const rings = 8, segs = 28;
    const pos: number[] = [], nrm: number[] = [], flow: number[] = [], foam: number[] = [], idx: number[] = [];
    const y = at.y + (onSea ? 0.08 : 0.2);
    for (let r = 0; r <= rings; r++) {
      const t = r / rings;
      for (let s = 0; s < segs; s++) {
        const a = (s / segs) * Math.PI * 2;
        const rr = t * R * (1 + 0.15 * Math.sin(a * 3 + at.x));
        pos.push(at.x + Math.cos(a) * rr, y, at.z + Math.sin(a) * rr);
        nrm.push(0, 1, 0);
        const sp = (1 - t) * 0.35 + 0.05;
        flow.push(Math.cos(a) * sp, 0, Math.sin(a) * sp);
        foam.push(Math.max(0, 1 - t * 1.1));
      }
    }
    for (let r = 0; r < rings; r++)
      for (let s = 0; s < segs; s++) {
        const a = r * segs + s, b = r * segs + ((s + 1) % segs), c = (r + 1) * segs + ((s + 1) % segs), d = (r + 1) * segs + s;
        idx.push(a, c, b, a, d, c);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 3));
    g.setAttribute('aFoam', new THREE.Float32BufferAttribute(foam, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, glow ? this.glowPoolMat : this.poolMat);
    m.renderOrder = 4;
    return m;
  }

  // --- Mist ----------------------------------------------------------------------------------

  private emitMist(dt: number, player: THREE.Vector3): void {
    let roar = 0;
    for (const f of this.falls.values()) {
      if (!f.group || f.path.length < 2) continue;
      const bottom = f.impact ?? f.path[f.path.length - 1].p;
      const d = bottom.distanceTo(player);
      const dLip = f.lipPoint.distanceTo(player);
      roar = Math.max(roar, Math.min(1, (f.height / 60) * (40 / (Math.min(d, dLip * 1.5) + 20))));
      if (d > 700) continue;
      const rate = Math.min(12, (f.height / 20) * (f.width / 4)) * (d < 250 ? 1 : 0.4);
      let n = rate * dt * 10;
      while (n > 0) {
        if (Math.random() > n) break;
        n -= 1;
        const spread = f.width * 0.8;
        const p = bottom.clone().add(new THREE.Vector3((Math.random() - 0.5) * spread, Math.random() * 2, (Math.random() - 0.5) * spread));
        const v = new THREE.Vector3((Math.random() - 0.5) * 5, 1.5 + Math.random() * 3.5, (Math.random() - 0.5) * 5);
        const L = f.glow ? Math.max(this.light, 0.45) : this.light;
        this.mist.emit(p, v, [f.mistColor[0] * L, f.mistColor[1] * L, f.mistColor[2] * L], 3 + Math.random() * 5 + f.height * 0.03, 3 + Math.random() * 3, { alpha: 0.28, drag: 0.7, grow: 2.5 + f.height * 0.02 });
      }
      // Spray peeling off the lower curtain
      if (d < 350 && f.height > 25 && Math.random() < dt * 8) {
        const i = Math.floor(f.path.length * (0.6 + Math.random() * 0.4));
        const q = f.path[Math.min(f.path.length - 1, i)];
        if (q.fall > 0.5) this.mist.emit(q.p.clone().addScaledVector(q.face, 1), q.face.clone().multiplyScalar(2).add(new THREE.Vector3(0, -2, 0)), f.mistColor, 2 + Math.random() * 3, 2.5, { alpha: 0.18, drag: 0.5, grow: 2 });
      }
    }
    this.roar = roar;
  }
}

interface FallInternal extends Fall {
  dir?: THREE.Vector3;
  riverLen?: number;
  island?: { x: number; y: number; z: number; r: number; t: number; cx: number; cz: number };
  shaft?: { x: number; z: number; r: number; cx: number; cz: number };
}
