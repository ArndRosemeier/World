import * as THREE from 'three';
import { World, RayHit } from '../world/World';
import { OP_ADD, OP_DIG } from '../world/Edits';
import { ChunkManager } from '../world/ChunkManager';
import { PropManager } from '../flora/PropManager';
import { SettlementManager } from '../civ/SettlementManager';
import { CreatureManager } from '../fauna/CreatureManager';
import { Debris, Particles } from '../render/Effects';
import { Prim } from '../render/Primitives';
import { Audio } from './Audio';
import { Input } from './Input';
import { Player } from './Player';
import { RGB } from '../core/math';

export type ToolId = 'dig' | 'build' | 'blast' | 'scan';
export const TOOLS: ToolId[] = ['dig', 'build', 'blast', 'scan'];

const _dir = new THREE.Vector3();

/**
 * The player's multitool. Digging and building write smooth CSG edits into the world (which
 * re-mesh every affected LOD), the blast charge carves craters and shatters everything nearby,
 * and the scanner identifies life, places and minerals.
 */
export class Tools {
  tool: ToolId = 'dig';
  radius = 2.2;
  private cooldown = 0;
  hit: RayHit | null = null;
  readonly marker: THREE.Mesh;
  scanInfo: string | null = null;
  onScan: (text: string) => void = () => {};
  shake = 0;

  constructor(
    private world: World,
    private chunks: ChunkManager,
    private props: PropManager,
    private settlements: SettlementManager,
    private creatures: CreatureManager,
    private debris: Debris,
    private dust: Particles,
    private sparks: Particles,
    private audio: Audio,
  ) {
    const mat = new THREE.MeshBasicMaterial({ color: 0x9fe8ff, wireframe: true, transparent: true, opacity: 0.35, depthWrite: false, fog: false });
    this.marker = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), mat);
    this.marker.renderOrder = 20;
    this.marker.visible = false;
  }

  update(dt: number, input: Input, player: Player, camera: THREE.Camera): void {
    this.cooldown -= dt;
    this.shake = Math.max(0, this.shake - dt * 2.5);
    for (let i = 0; i < TOOLS.length; i++) if (input.pressed(`Digit${i + 1}`)) this.select(TOOLS[i]);
    if (input.wheel) {
      if (this.tool === 'dig' || this.tool === 'build') this.radius = Math.min(7, Math.max(0.8, this.radius - input.wheel * 0.3));
      else this.select(TOOLS[(TOOLS.indexOf(this.tool) + (input.wheel > 0 ? 1 : TOOLS.length - 1)) % TOOLS.length]);
    }
    if (input.pressed('KeyQ')) this.select(TOOLS[(TOOLS.indexOf(this.tool) + TOOLS.length - 1) % TOOLS.length]);
    if (input.pressed('KeyE')) this.select(TOOLS[(TOOLS.indexOf(this.tool) + 1) % TOOLS.length]);

    camera.getWorldDirection(_dir);
    const range = this.tool === 'blast' ? 220 : this.tool === 'scan' ? 400 : 45;
    this.hit = this.world.raycast(camera.position, _dir, range);

    const m = this.marker;
    if (this.hit && (this.tool === 'dig' || this.tool === 'build')) {
      m.visible = true;
      m.position.copy(this.hit.point);
      if (this.tool === 'build') m.position.addScaledVector(this.hit.normal, this.radius * 0.6);
      m.scale.setScalar(this.radius);
      (m.material as THREE.MeshBasicMaterial).color.set(this.tool === 'dig' ? 0x9fe8ff : 0xffd27f);
    } else if (this.hit && this.tool === 'blast') {
      m.visible = true;
      m.position.copy(this.hit.point);
      m.scale.setScalar(7.5);
      (m.material as THREE.MeshBasicMaterial).color.set(0xff6a4a);
    } else m.visible = false;

    const primary = input.held(0);
    const secondary = input.held(2);
    if (this.cooldown > 0) return;
    if (this.tool === 'dig' && (primary || secondary) && this.hit) {
      if (secondary) this.build(this.hit, player);
      else this.dig(this.hit.point, this.radius);
      this.cooldown = 0.12;
    } else if (this.tool === 'build' && (primary || secondary) && this.hit) {
      if (secondary) this.dig(this.hit.point, this.radius);
      else this.build(this.hit, player);
      this.cooldown = 0.12;
    } else if (this.tool === 'blast' && (input.clicked(0) || input.pressed('KeyF')) && this.hit) {
      this.blast(this.hit.point, player);
      this.cooldown = 0.5;
    } else if (this.tool === 'scan' && input.clicked(0)) {
      this.scan(camera, _dir);
      this.cooldown = 0.3;
    }
    if (input.pressed('KeyF') && this.tool !== 'blast' && this.hit) {
      this.blast(this.hit.point, player);
      this.cooldown = 0.5;
    }
  }

  select(t: ToolId): void {
    if (t !== this.tool) this.audio.ui();
    this.tool = t;
  }

  private terrainColors(p: THREE.Vector3): RGB[] {
    const T = this.world.terrain;
    const c = T.columnAt(p.x, p.z);
    const out = new Float32Array(6);
    const cols: RGB[] = [];
    for (let i = 0; i < 3; i++) {
      T.shade(p.x + i, p.y - i * 0.7, p.z, 0, i === 0 ? 1 : 0.2, 0, c, out);
      cols.push([out[0], out[1], out[2]]);
    }
    return cols;
  }

  dig(p: THREE.Vector3, r: number): void {
    const e = this.world.edits.add(p.x, p.y, p.z, r, OP_DIG);
    this.chunks.onEdit(e);
    const destroyed = this.props.destroyInSphere(p, r * 0.9);
    this.propDebris(destroyed, p, 3);
    if (this.settlements.damage(p, r * 0.8, 0.3) > 0) this.shake = 0.2;
    this.creatures.scareAround(p, 15);
    const cols = this.terrainColors(p);
    this.debris.burst(p, 3 + Math.floor(r), Math.max(0.12, r * 0.14), 4, cols, 5);
    for (let i = 0; i < 6; i++) {
      const c = cols[i % cols.length];
      this.dust.emit(p.clone().add(new THREE.Vector3((Math.random() - 0.5) * r, (Math.random() - 0.3) * r, (Math.random() - 0.5) * r)), new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2), c, r * 0.9, 1.6, { alpha: 0.35, drag: 1.5, grow: r * 0.6 });
    }
    this.audio.dig();
  }

  private build(hit: RayHit, player: Player): void {
    const c = hit.point.clone().addScaledVector(hit.normal, this.radius * 0.6);
    // Don't entomb yourself
    if (c.distanceTo(player.pos) < this.radius + 0.8 || c.distanceTo(player.eye) < this.radius + 0.6) return;
    const e = this.world.edits.add(c.x, c.y, c.z, this.radius, OP_ADD);
    this.chunks.onEdit(e);
    const col = this.world.params.builtColor;
    for (let i = 0; i < 5; i++) this.dust.emit(c.clone().add(new THREE.Vector3((Math.random() - 0.5) * this.radius, (Math.random() - 0.5) * this.radius, (Math.random() - 0.5) * this.radius)), new THREE.Vector3(0, 0.5, 0), col, this.radius * 0.7, 1.2, { alpha: 0.3, drag: 2, grow: this.radius * 0.4 });
    this.audio.build();
  }

  blast(p: THREE.Vector3, player: Player): void {
    const R = 7;
    // A main crater plus a few satellite bites for an irregular, natural look
    const ops = [{ x: p.x, y: p.y, z: p.z, r: R }];
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * Math.PI * 2;
      ops.push({ x: p.x + Math.cos(a) * R * 0.7, y: p.y - Math.random() * 2, z: p.z + Math.sin(a) * R * 0.7, r: R * (0.35 + Math.random() * 0.3) });
    }
    for (const o of ops) this.chunks.onEdit(this.world.edits.add(o.x, o.y, o.z, o.r, OP_DIG));
    const destroyed = this.props.destroyInSphere(p, R * 1.3);
    this.propDebris(destroyed, p, 10);
    this.settlements.damage(p, R * 1.3, 1);
    this.creatures.explosion(p, R * 1.5, 80);
    const cols = this.terrainColors(p);
    this.debris.burst(p, 26, 0.55, 14, cols, 10);
    for (let i = 0; i < 40; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize();
      this.sparks.emit(p, dir.clone().multiplyScalar(10 + Math.random() * 25), [1, 0.55 + Math.random() * 0.3, 0.25], 0.5 + Math.random() * 0.6, 0.6 + Math.random() * 0.8, { drag: 1.2, grav: 6 });
      this.dust.emit(p.clone().addScaledVector(dir, Math.random() * R), dir.multiplyScalar(3 + Math.random() * 6), cols[i % cols.length], 3 + Math.random() * 3, 3 + Math.random() * 2, { alpha: 0.5, drag: 1.2, grow: 3 });
    }
    this.sparks.emit(p, new THREE.Vector3(), [1, 0.8, 0.5], 30, 0.25, {});
    const dist = p.distanceTo(player.pos);
    this.shake = Math.min(1.2, 30 / (dist + 10));
    // Knockback
    if (dist < R * 3) {
      const push = player.pos.clone().sub(p).normalize().multiplyScalar(18 * (1 - dist / (R * 3)));
      player.vel.add(push);
    }
    this.audio.blast(dist);
  }

  private propDebris(list: ReturnType<PropManager['destroyInSphere']>, center: THREE.Vector3, power: number): void {
    for (const d of list) {
      const s = d.scale;
      const def = d.def;
      const n = Math.min(8, 2 + Math.round(s * 2));
      const colors: RGB[] = [def.colors.a, def.colors.b, def.colors.c];
      const glow = def.glow > 0 ? 1.2 : 0;
      for (let i = 0; i < n; i++) {
        const pos = d.position.clone().addScaledVector(d.up, Math.random() * s * 2.5 + 0.3);
        const vel = pos.clone().sub(center).normalize().multiplyScalar(power * (0.4 + Math.random())).add(new THREE.Vector3(0, 2, 0));
        const sz = 0.15 + s * 0.2 * Math.random();
        this.debris.spawn(i % 3 === 0 ? Prim.Limb : Prim.Sphere, pos, new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, 0)),
          new THREE.Vector3(sz, sz * (1 + Math.random() * 2), sz), vel, { color: colors[i % 3], emissive: i === 0 ? glow : 0 }, 6 + Math.random() * 4);
      }
    }
  }

  private scan(camera: THREE.Camera, dir: THREE.Vector3): void {
    const P = this.world.params;
    const c = this.creatures.pick(camera.position, dir, this.hit ? this.hit.distance : 400);
    if (c) {
      const d = c.sp.def;
      const role = d.plan === 'sapient' ? `sapient · ${P.civs.find((v) => v.body.id === d.id)?.people ?? ''}` : d.plan;
      this.onScan(`${d.name} — ${role}, ~${d.size.toFixed(1)} m${d.glow > 0.3 ? ', bioluminescent' : ''}`);
      this.audio.chirp();
      return;
    }
    if (!this.hit) {
      this.onScan('Nothing in range');
      return;
    }
    const p = this.hit.point;
    const s = this.settlements.at(p);
    if (s) {
      this.onScan(`${s.name} — settlement of the ${s.civ.people}`);
      return;
    }
    const col = this.world.terrain.columnAt(p.x, p.z);
    const b = P.biomes[col.w1 > 0.5 ? col.b1 : col.b0];
    const g = this.world.gravity(p.x, p.y, p.z, new THREE.Vector3()).length();
    const depth = col.h - p.y;
    const where = depth > 30 && p.y < col.uC + 20 ? 'underworld floor' : depth > 6 ? 'cave rock' : b.name;
    this.onScan(`${where} · ${p.y.toFixed(0)} m · gravity ${g.toFixed(2)} m/s² · ${this.hit.distance.toFixed(0)} m away`);
  }
}
