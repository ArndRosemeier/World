import * as THREE from 'three';
import { CHUNK, MAX_LEVEL, ROOT_SIZE, BEDROCK, WORLD_TOP } from './constants';
import { WorkerPool } from './WorkerPool';
import { ChunkResult } from './ChunkBuilder';
import { EditStore, Edit, editBlend } from './Edits';
import { createLiquidMaterial, createTerrainMaterial } from '../render/materials';
import { WorldParams } from './WorldParams';

// ---------------------------------------------------------------------------------------------
// Streams the world as a sparse octree of chunks. Every chunk has the same cell count, so
// nodes far from the camera cover more ground with bigger voxels. Nodes keep their old mesh
// until a replacement (split, merge or edit) is ready, so the world never shows holes while
// it streams.
// ---------------------------------------------------------------------------------------------

class Node {
  readonly key: string;
  readonly size: number;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  children: Node[] | null = null;
  mesh: THREE.Mesh | null = null;
  liquids: THREE.Mesh[] = [];
  props: Float32Array | null = null;
  ready = false;
  empty = false;
  version = 0;
  meshVersion = -1;
  requestedVersion = -1;
  visibleFrame = -1;
  desiredFrame = -1;
  propsVersion = -1;
  minH = -Infinity;
  split = false;
  disposed = false;

  constructor(readonly level: number, readonly ix: number, readonly iy: number, readonly iz: number) {
    this.key = `${level}:${ix}:${iy}:${iz}`;
    this.size = CHUNK << level;
    this.minX = ix * this.size;
    this.minY = iy * this.size;
    this.minZ = iz * this.size;
  }

  distanceTo(p: THREE.Vector3): number {
    const s = this.size;
    const dx = Math.max(this.minX - p.x, 0, p.x - (this.minX + s));
    const dy = Math.max(this.minY - p.y, 0, p.y - (this.minY + s));
    const dz = Math.max(this.minZ - p.z, 0, p.z - (this.minZ + s));
    return Math.hypot(dx, dy, dz);
  }

  /** Worth generating at all? */
  get inWorld(): boolean {
    return this.minY + this.size > BEDROCK - 64 && this.minY < WORLD_TOP;
  }
}

export interface PropSink {
  setChunkProps(key: string, level: number, props: Float32Array | null): void;
}

export class ChunkManager {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  readonly seaMaterial: THREE.MeshStandardMaterial;
  readonly glowMaterial: THREE.MeshStandardMaterial;
  private roots = new Map<string, Node>();
  private frame = 0;
  private pool: WorkerPool;
  private edits: EditStore;
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  private propSink: PropSink | null = null;
  private shownProps = new Map<string, Node>();
  /** Split when closer than splitFactor * nodeSize. Higher = more detail. */
  splitFactor = 1.4;
  viewDistance = 5200;
  /** When the viewer is outdoors, distant chunks entirely below the surface are skipped. */
  cullBuried = true;
  private camPos = new THREE.Vector3();
  stats = { nodes: 0, visible: 0, triangles: 0, pending: 0 };

  constructor(params: WorldParams, pool: WorkerPool, edits: EditStore) {
    this.pool = pool;
    this.edits = edits;
    this.material = createTerrainMaterial();
    this.seaMaterial = createLiquidMaterial(new THREE.Color().setRGB(...params.liquid, THREE.SRGBColorSpace), params.liquidGlow);
    this.glowMaterial = createLiquidMaterial(new THREE.Color().setRGB(...params.under.liquid, THREE.SRGBColorSpace), 1.2);
    this.group.name = 'terrain';
  }

  setPropSink(sink: PropSink): void {
    this.propSink = sink;
  }

  update(cam: THREE.Vector3, camera: THREE.Camera): void {
    this.frame++;
    const f = this.frame;
    this.camPos.copy(cam);
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);

    // Roots in range
    const R = this.viewDistance;
    const x0 = Math.floor((cam.x - R) / ROOT_SIZE), x1 = Math.floor((cam.x + R) / ROOT_SIZE);
    const z0 = Math.floor((cam.z - R) / ROOT_SIZE), z1 = Math.floor((cam.z + R) / ROOT_SIZE);
    const want = new Set<string>();
    for (let ix = x0; ix <= x1; ix++)
      for (let iz = z0; iz <= z1; iz++)
        for (let iy = -1; iy <= 0; iy++) {
          const key = `${MAX_LEVEL}:${ix}:${iy}:${iz}`;
          let n = this.roots.get(key);
          if (!n) {
            n = new Node(MAX_LEVEL, ix, iy, iz);
            this.roots.set(key, n);
          }
          if (n.distanceTo(cam) > R) continue;
          want.add(key);
          this.select(n, cam);
        }

    // Visibility, pruning and bookkeeping
    this.stats.nodes = 0;
    this.stats.visible = 0;
    this.stats.triangles = 0;
    for (const [key, n] of this.roots) {
      const alive = this.prune(n);
      if (!want.has(key) && !alive) {
        this.disposeSubtree(n);
        this.roots.delete(key);
      }
    }
    this.stats.pending = this.pool.queued + this.pool.active;
    this.pool.pump();
    void f;
  }

  private wantsSplit(n: Node, cam: THREE.Vector3): boolean {
    if (n.level === 0) return false;
    const d = n.distanceTo(cam);
    const k = this.splitFactor * (n.split ? 1.12 : 1);
    return d < k * n.size;
  }

  /** Returns true if the node's region is fully covered by visible, ready meshes. */
  private select(n: Node, cam: THREE.Vector3): boolean {
    if (!n.inWorld) return true;
    const split = this.wantsSplit(n, cam);
    n.split = split;
    if (!split) {
      n.desiredFrame = this.frame;
      this.ensureRequested(n, cam);
      if (n.ready) {
        n.visibleFrame = this.frame;
        return true;
      }
      // Fall back to finer meshes left over from before a merge.
      if (n.children && n.children.every((c) => this.fallback(c))) return true;
      return false;
    }
    if (!n.children) n.children = this.makeChildren(n);
    let all = true;
    for (const c of n.children) if (!this.select(c, cam)) all = false;
    if (all) return true;
    if (n.ready) {
      // Children are still loading: keep showing this coarser mesh instead.
      this.hideSubtree(n);
      n.visibleFrame = this.frame;
      return true;
    }
    return false;
  }

  private fallback(n: Node): boolean {
    if (!n.inWorld) return true;
    if (n.ready) {
      n.visibleFrame = this.frame;
      return true;
    }
    if (n.children && n.children.every((c) => this.fallback(c))) return true;
    return false;
  }

  private hideSubtree(n: Node): void {
    if (!n.children) return;
    for (const c of n.children) {
      if (c.visibleFrame === this.frame) c.visibleFrame = -1;
      this.hideSubtree(c);
    }
  }

  private makeChildren(n: Node): Node[] {
    const out: Node[] = [];
    const l = n.level - 1;
    for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) out.push(new Node(l, n.ix * 2 + i, n.iy * 2 + j, n.iz * 2 + k));
    return out;
  }

  private priority(n: Node, cam: THREE.Vector3): number {
    let p = n.distanceTo(cam) / n.size;
    const c = _v.set(n.minX + n.size / 2, n.minY + n.size / 2, n.minZ + n.size / 2);
    _sphere.center.copy(c);
    _sphere.radius = n.size * 0.87;
    if (!this.frustum.intersectsSphere(_sphere)) p = p * 1.6 + 1;
    if (n.ready) p += n.meshVersion >= 0 && n.meshVersion !== n.version ? -50 : 0; // edits first
    return p - (MAX_LEVEL - n.level) * 0.02;
  }

  private ensureRequested(n: Node, cam: THREE.Vector3): void {
    if (n.meshVersion === n.version) return;
    const pr = this.priority(n, cam);
    if (n.requestedVersion === n.version) {
      this.pool.setPriority(n.key, pr);
      return;
    }
    n.requestedVersion = n.version;
    const m = CHUNK + 5;
    const s = n.size / CHUNK;
    const pad = 3 * s;
    const list = this.edits.query(n.minX - pad, n.minY - pad, n.minZ - pad, n.minX + n.size + pad, n.minY + n.size + pad, n.minZ + n.size + pad);
    void m;
    this.pool.request(
      { key: n.key, version: n.version, level: n.level, ox: n.minX, oy: n.minY, oz: n.minZ, edits: EditStore.pack(list) },
      pr,
      (r) => this.onResult(n, r),
    );
  }

  private onResult(n: Node, r: ChunkResult): void {
    if (n.requestedVersion === r.version) n.requestedVersion = -1;
    if (n.disposed || r.version < n.meshVersion) return;
    // Node may have been pruned while in flight; results for detached nodes are discarded.
    this.clearMesh(n);
    n.meshVersion = r.version;
    n.ready = true;
    n.empty = r.empty;
    n.props = r.props ?? null;
    n.minH = r.minH ?? -Infinity;
    if (!r.empty) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(r.positions!, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(r.normals!, 3));
      g.setAttribute('aColor', new THREE.BufferAttribute(r.colors!, 4, true));
      g.setAttribute('aEmit', new THREE.BufferAttribute(r.emit!, 4, true));
      g.setIndex(new THREE.BufferAttribute(r.indices!, 1));
      const s = n.size;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(n.minX + s / 2, n.minY + s / 2, n.minZ + s / 2), s * 0.9);
      g.boundingBox = new THREE.Box3(new THREE.Vector3(n.minX - s * 0.1, n.minY - s * 0.1, n.minZ - s * 0.1), new THREE.Vector3(n.minX + s * 1.1, n.minY + s * 1.1, n.minZ + s * 1.1));
      const mesh = new THREE.Mesh(g, this.material);
      mesh.castShadow = n.level <= 2;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      mesh.userData.level = n.level;
      n.mesh = mesh;
      this.group.add(mesh);
    }
    if (r.water) {
      for (const w of r.water) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(w.positions, 3));
        g.setAttribute('aDepth', new THREE.BufferAttribute(w.depth, 1));
        const nrm = new Float32Array(w.positions.length);
        for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
        g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
        g.setIndex(new THREE.BufferAttribute(w.indices, 1));
        g.computeBoundingSphere();
        const m = new THREE.Mesh(g, w.glow ? this.glowMaterial : this.seaMaterial);
        m.matrixAutoUpdate = false;
        m.visible = false;
        m.renderOrder = 2;
        n.liquids.push(m);
        this.group.add(m);
      }
    }
  }

  private clearMesh(n: Node): void {
    if (n.mesh) {
      this.group.remove(n.mesh);
      n.mesh.geometry.dispose();
      n.mesh = null;
    }
    for (const l of n.liquids) {
      this.group.remove(l);
      l.geometry.dispose();
    }
    n.liquids.length = 0;
  }

  /** Applies visibility, disposes unused meshes and subtrees. Returns whether anything below is alive. */
  private prune(n: Node): boolean {
    const f = this.frame;
    const visible = n.visibleFrame === f;
    const desired = n.desiredFrame === f;
    let childAlive = false;
    if (n.children) {
      for (const c of n.children) if (this.prune(c)) childAlive = true;
      if (!childAlive) {
        for (const c of n.children) this.disposeSubtree(c);
        n.children = null;
      }
    }
    this.stats.nodes++;
    if (n.mesh) {
      const buried = this.cullBuried && n.minY + n.size + 12 < n.minH && n.distanceTo(this.camPos) > 150;
      n.mesh.visible = visible && !buried;
      if (n.mesh.visible) {
        this.stats.visible++;
        this.stats.triangles += (n.mesh.geometry.index?.count ?? 0) / 3;
      }
    }
    for (const l of n.liquids) l.visible = visible;

    // Props follow chunk visibility.
    if (this.propSink) {
      const shown = this.shownProps.get(n.key) === n;
      const wantProps = visible && !!n.props;
      if (wantProps && (!shown || n.propsVersion !== n.meshVersion)) {
        this.propSink.setChunkProps(n.key, n.level, n.props);
        this.shownProps.set(n.key, n);
        n.propsVersion = n.meshVersion;
      } else if (!wantProps && shown) {
        this.propSink.setChunkProps(n.key, n.level, null);
        this.shownProps.delete(n.key);
        n.propsVersion = -1;
      }
    }
    const alive = visible || desired;
    if (!alive) {
      if (n.ready && f - Math.max(n.visibleFrame, n.desiredFrame) > 45) {
        this.clearMesh(n);
        n.ready = false;
        n.props = null;
        n.meshVersion = -1;
      }
      if (n.requestedVersion >= 0 && !desired) {
        this.pool.cancel(n.key);
        n.requestedVersion = -1;
      }
    }
    return alive || childAlive || (n.ready && f - Math.max(n.visibleFrame, n.desiredFrame) <= 45);
  }

  private disposeSubtree(n: Node): void {
    n.disposed = true;
    if (n.children) for (const c of n.children) this.disposeSubtree(c);
    n.children = null;
    this.clearMesh(n);
    this.pool.cancel(n.key);
    if (this.propSink && this.shownProps.get(n.key) === n) {
      this.propSink.setChunkProps(n.key, n.level, null);
      this.shownProps.delete(n.key);
    }
  }

  /** Marks every node touched by an edit as outdated; they re-mesh while showing the old mesh. */
  onEdit(e: Edit): void {
    const m = e.r + editBlend(e.r) + 1;
    const visit = (n: Node) => {
      const pad = (n.size / CHUNK) * 3;
      if (e.x + m < n.minX - pad || e.x - m > n.minX + n.size + pad) return;
      if (e.y + m < n.minY - pad || e.y - m > n.minY + n.size + pad) return;
      if (e.z + m < n.minZ - pad || e.z - m > n.minZ + n.size + pad) return;
      if (n.ready || n.requestedVersion >= 0) {
        n.version++;
        if (n.requestedVersion >= 0) {
          this.pool.cancel(n.key);
          n.requestedVersion = -1;
        }
      }
      if (n.children) for (const c of n.children) visit(c);
    };
    for (const r of this.roots.values()) visit(r);
  }

  /** Fraction of desired chunks near the camera that are ready (for the loading screen). */
  readiness(cam: THREE.Vector3, radius: number): number {
    let total = 0, ready = 0;
    const visit = (n: Node) => {
      if (!n.inWorld || n.distanceTo(cam) > radius) return;
      if (n.desiredFrame === this.frame) {
        total++;
        if (n.ready) ready++;
      }
      if (n.children) for (const c of n.children) visit(c);
    };
    for (const r of this.roots.values()) visit(r);
    return total ? ready / total : 0;
  }
}

const _v = new THREE.Vector3();
const _sphere = new THREE.Sphere();
