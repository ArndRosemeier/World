import * as THREE from 'three';
import { WorldParams } from '../world/WorldParams';
import { FC } from './FluidSim';
import type { FluidMesh } from './fluid.worker';
import { createFlowMaterial } from './WaterShaders';
import { Particles } from '../render/Effects';

interface Entry {
  mesh: THREE.Mesh | null;
  occ: Uint8Array;
  ox: number;
  oy: number;
  oz: number;
}

/** Main-thread side of the water simulation: renders its meshes and answers "am I in water?". */
export class Fluids {
  readonly group = new THREE.Group();
  private worker: Worker;
  private entries = new Map<string, Entry>();
  private seaMat: THREE.ShaderMaterial;
  private lakeMat: THREE.ShaderMaterial;
  stats = { chunks: 0, awake: 0 };
  private focusTimer = 0;

  constructor(seed: string, edits: number[], private params: WorldParams, private spray: Particles) {
    this.worker = new Worker(new URL('./fluid.worker.ts', import.meta.url), { type: 'module' });
    this.worker.postMessage({ type: 'init', seed, edits });
    this.worker.onmessage = (ev) => this.onMessage(ev.data);
    const c = params.liquid, u = params.under.liquid;
    this.seaMat = createFlowMaterial(new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace), params.liquidGlow);
    this.lakeMat = createFlowMaterial(new THREE.Color().setRGB(u[0], u[1], u[2], THREE.SRGBColorSpace), 0.8);
  }

  edit(x: number, y: number, z: number, r: number, op: number): void {
    this.worker.postMessage({ type: 'edit', x, y, z, r, op });
  }

  update(dt: number, player: THREE.Vector3, sky: number): void {
    this.focusTimer -= dt;
    if (this.focusTimer <= 0) {
      this.focusTimer = 0.5;
      this.worker.postMessage({ type: 'focus', x: player.x, y: player.y, z: player.z });
    }
    this.seaMat.uniforms.uSky.value = sky;
    this.lakeMat.uniforms.uSky.value = Math.min(sky, 0.2);
  }

  private onMessage(m: any): void {
    if (m.type === 'mesh') this.applyMesh(m.mesh as FluidMesh);
    else if (m.type === 'remove') this.remove(m.key);
    else if (m.type === 'stats') this.stats = { chunks: m.chunks, awake: m.awake };
    else if (m.type === 'splash') {
      for (const s of m.s as { x: number; y: number; z: number; s: number }[]) {
        const lc = s.y < -150 ? this.params.under.liquid : this.params.liquid;
        for (let i = 0; i < 4; i++) {
          this.spray.emit(new THREE.Vector3(s.x + Math.random() - 0.5, s.y, s.z + Math.random() - 0.5),
            new THREE.Vector3((Math.random() - 0.5) * 3, 2 + Math.random() * 3, (Math.random() - 0.5) * 3),
            [lc[0] * 0.4 + 0.6, lc[1] * 0.4 + 0.6, lc[2] * 0.4 + 0.6], 0.5 + Math.random() * 0.5, 0.9, { alpha: 0.5, grav: 8, drag: 0.8, grow: 1 });
        }
      }
    }
  }

  private applyMesh(m: FluidMesh): void {
    let e = this.entries.get(m.key);
    if (!e) {
      e = { mesh: null, occ: m.occ, ox: m.ox, oy: m.oy, oz: m.oz };
      this.entries.set(m.key, e);
    }
    e.occ = m.occ;
    if (e.mesh) {
      this.group.remove(e.mesh);
      e.mesh.geometry.dispose();
      e.mesh = null;
    }
    if (m.indices.length === 0) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    g.setAttribute('aFlow', new THREE.BufferAttribute(m.flow, 3));
    g.setAttribute('aFoam', new THREE.BufferAttribute(m.foam, 1));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(m.ox + FC / 2, m.oy + FC / 2, m.oz + FC / 2), FC);
    const mesh = new THREE.Mesh(g, m.oy < -150 ? this.lakeMat : this.seaMat);
    mesh.renderOrder = 4;
    mesh.matrixAutoUpdate = false;
    e.mesh = mesh;
    this.group.add(mesh);
  }

  private remove(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    if (e.mesh) {
      this.group.remove(e.mesh);
      e.mesh.geometry.dispose();
    }
    this.entries.delete(key);
  }

  /** Is there simulated water (mass > 0.5) at this point? */
  submerged(p: THREE.Vector3): boolean {
    const cx = Math.floor(p.x / FC), cy = Math.floor(p.y / FC), cz = Math.floor(p.z / FC);
    const e = this.entries.get(`${cx},${cy},${cz}`);
    if (!e) return false;
    const i = Math.floor(p.x) - cx * FC + FC * (Math.floor(p.y) - cy * FC + FC * (Math.floor(p.z) - cz * FC));
    return (e.occ[i >> 3] & (1 << (i & 7))) !== 0;
  }
}
