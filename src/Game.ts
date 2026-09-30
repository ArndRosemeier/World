import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { World } from './world/World';
import { WorkerPool } from './world/WorkerPool';
import { ChunkManager } from './world/ChunkManager';
import { PropManager } from './flora/PropManager';
import { Sky } from './render/Sky';
import { shared } from './render/materials';
import { PrimitiveBatch } from './render/Primitives';
import { Debris, Particles } from './render/Effects';
import { CreatureManager } from './fauna/CreatureManager';
import { SettlementManager } from './civ/SettlementManager';
import { Player } from './player/Player';
import { Input } from './player/Input';
import { Tools } from './player/Tools';
import { Audio } from './player/Audio';
import { Hud } from './ui/Hud';
import { Liquids } from './render/Liquids';
import { Fluids } from './water/Fluids';
import { Waterfalls } from './water/Waterfalls';
import { waterLight } from './water/WaterShaders';
import { Avatar } from './player/Avatar';
import { RGB } from './core/math';
import { MapView } from './ui/MapView';
import { clamp, lerp, rgbCss, smoothstep } from './core/math';

export type Quality = 'low' | 'medium' | 'high';

const QUALITY: Record<Quality, { split: number; view: number; shadow: number; bloom: boolean; ratio: number; far: number; msaa: number }> = {
  low: { split: 1.1, view: 3000, shadow: 1024, bloom: false, ratio: 1, far: 6000, msaa: 0 },
  medium: { split: 1.3, view: 4200, shadow: 2048, bloom: true, ratio: 1.25, far: 9000, msaa: 2 },
  high: { split: 1.5, view: 5600, shadow: 2048, bloom: true, ratio: 1.5, far: 12000, msaa: 4 },
};

interface SaveData {
  v: number;
  edits: number[];
  props: number[];
  pieces: Record<string, number[]>;
  player?: [number, number, number];
  time?: number;
}

/** Owns every subsystem and runs the frame loop. */
export class Game {
  readonly world: World;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  readonly pool: WorkerPool;
  readonly chunks: ChunkManager;
  readonly props: PropManager;
  readonly sky: Sky;
  private sun = new THREE.DirectionalLight(0xffffff, 1);
  private hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  private staticBatch: PrimitiveBatch;
  private dynamicBatch: PrimitiveBatch;
  readonly debris: Debris;
  private dust: Particles;
  private glow: Particles;
  readonly creatures: CreatureManager;
  readonly settlements: SettlementManager;
  readonly player: Player;
  readonly input: Input;
  readonly tools: Tools;
  readonly audio = new Audio();
  readonly hud: Hud;
  readonly map: MapView;
  private clock = new THREE.Clock();
  private frame = 0;
  private elapsed = 0;
  private quality: Quality;
  private env = { sky: 1, under: 0, skyT: 1, underT: 0 };
  private lampOn: boolean | null = null;
  private place = '';
  private placeTimer = 0;
  private saveTimer = 0;
  private savedRev = -1;
  private propsDestroyedCount = 0;
  private fps = 60;
  private menu: HTMLDivElement;
  readonly liquids: Liquids;
  fluids!: Fluids;
  readonly waterfalls: Waterfalls;
  readonly avatar: Avatar;
  thirdPerson = false;
  private camDist = 4.5;
  private submerged = 0;
  private wasInLiquid = false;
  private noSave = false;
  running = false;

  constructor(readonly seed: string, quality: Quality, container: HTMLElement) {
    this.quality = quality;
    const Q = QUALITY[quality];
    this.world = new World(seed);
    const P = this.world.params;

    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, Q.ratio));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.15, Q.far);
    this.scene.fog = new THREE.FogExp2(0x888888, 0.0003);

    const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: Q.msaa });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.55, 0.55, 0.92);
    this.bloom.enabled = Q.bloom;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    const workers = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
    this.pool = new WorkerPool(seed, workers);
    this.chunks = new ChunkManager(P, this.pool, this.world.edits);
    this.chunks.splitFactor = Q.split;
    this.chunks.viewDistance = Q.view;
    this.scene.add(this.chunks.group);

    this.liquids = new Liquids(P, this.pool);
    this.scene.add(this.liquids.group);

    this.props = new PropManager(P);
    this.chunks.setPropSink(this.props);
    this.scene.add(this.props.group);

    this.sky = new Sky(P);
    this.scene.add(this.sky.mesh);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(Q.shadow, Q.shadow);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -90;
    sc.right = sc.top = 90;
    sc.near = 1;
    sc.far = 900;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target, this.hemi);

    this.staticBatch = new PrimitiveBatch(true);
    this.dynamicBatch = new PrimitiveBatch(true);
    this.scene.add(this.staticBatch.group, this.dynamicBatch.group);
    this.debris = new Debris(this.world, this.dynamicBatch);
    this.dust = new Particles(5000, false);
    this.glow = new Particles(4000, true);
    this.scene.add(this.dust.points, this.glow.points);

    this.creatures = new CreatureManager(this.world, this.dynamicBatch, this.debris);
    this.settlements = new SettlementManager(this.world, this.staticBatch, this.dynamicBatch, this.creatures, this.debris, this.glow, this.scene);

    this.player = new Player(this.world);
    this.player.sources.push(this.props, this.settlements);
    this.player.liquidTest = (p) => this.liquids.submerged(p) || !!this.fluids?.submerged(p);
    this.avatar = new Avatar(P.seed, P.biomes[0].top);
    this.input = new Input(this.renderer.domElement);
    this.tools = new Tools(this.world, this.chunks, this.props, this.settlements, this.creatures, this.debris, this.dust, this.glow, this.audio);
    this.scene.add(this.tools.marker);

    this.hud = new Hud();
    document.body.appendChild(this.hud.root);
    this.hud.root.classList.add('hidden');
    this.map = new MapView(this.pool, this.settlements);
    document.body.appendChild(this.map.el);
    this.map.onTravel = (x, z) => this.travel(x, z);
    this.tools.onScan = (t) => this.hud.scan(t);
    this.settlements.onDiscover = (s) => this.hud.toast(s.name, `a ${s.civ.layer === 'under' ? 'deep ' : ''}settlement of the ${s.civ.people}`, rgbCss(s.civ.glow));
    this.settlements.onGreet = () => this.audio.chirp();

    this.menu = this.buildMenu();
    document.body.appendChild(this.menu);
    this.input.onLockChange = (locked) => {
      this.menu.classList.toggle('hidden', locked || this.map.open || !this.running);
      if (!locked) this.refreshMenu();
    };

    addEventListener('resize', () => this.resize());
    addEventListener('beforeunload', () => this.save(true));
    this.load();
    // Dynamic water starts after loading so saved excavations flood again
    this.fluids = new Fluids(seed, this.world.edits.serialize(), P, this.dust);
    this.scene.add(this.fluids.group);
    this.world.edits.onAdd = (e) => this.fluids.edit(e.x, e.y, e.z, e.r, e.op);
    this.waterfalls = new Waterfalls(this.world, this.dust);
    this.scene.add(this.waterfalls.group);
    (window as unknown as { game: Game }).game = this;
  }

  // --- Lifecycle -----------------------------------------------------------------------------

  /** Pre-builds geometry and streams the spawn area. Resolves when it's presentable. */
  async prepare(progress: (k: number, msg: string) => void): Promise<void> {
    progress(0.02, 'Growing flora…');
    await tick();
    this.props.prebuild();
    progress(0.1, 'Surveying terrain…');
    await tick();
    const saved = this.saved?.player;
    // ?pos=x,y,z lets people share exact locations (y is optional: drops onto the ground)
    const q = new URLSearchParams(location.search).get('pos')?.split(',').map(Number);
    let spawn = saved ? new THREE.Vector3(...saved) : this.world.findSpawn();
    if (q && q.length >= 2 && q.every(Number.isFinite)) {
      const [x, a, b] = q;
      const z = q.length >= 3 ? b : a;
      const y = q.length >= 3 ? a : (this.world.groundBelow(x, this.world.terrain.columnAt(x, z).top + 5, z, 900) ?? 50) + 2;
      spawn = new THREE.Vector3(x, y, z);
    }
    this.player.spawn(spawn);
    this.player.forward.set(1, 0, 0.3).normalize();
    this.player.update(0, this.input, this.camera);
    this.camera.updateMatrixWorld();
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const step = () => {
        this.camera.updateMatrixWorld();
        this.chunks.update(this.camera.position, this.camera);
        this.liquids.prime(this.camera.position);
        const r = this.chunks.readiness(this.camera.position, 300) * (this.liquids.ready ? 1 : 0.95);
        const t = (performance.now() - start) / 1000;
        progress(0.12 + 0.86 * Math.min(1, r), `Streaming world… ${Math.round(r * 100)}%`);
        if ((r > 0.97 && t > 1) || t > 25) resolve();
        else setTimeout(step, 50);
      };
      step();
    });
    this.settlements.update(0.01, 0, this.player.pos, 0);
  }

  begin(): void {
    this.running = true;
    this.hud.root.classList.remove('hidden');
    this.audio.start();
    this.input.lock();
    this.clock.start();
    const P = this.world.params;
    this.hud.toast(P.name, `seed “${this.seed}” · gravity ${P.gravity.toFixed(1)} m/s²`, '#d8a7ff');
    const loop = () => {
      this.update();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private resize(): void {
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  private travel(x: number, z: number): void {
    const col = this.world.terrain.columnAt(x, z);
    const top = Math.max(col.top, this.world.params.seaLevel) + 4;
    const g = this.world.groundBelow(x, top, z, top - Math.min(col.h, this.world.params.seaLevel) + 40);
    this.player.spawn(new THREE.Vector3(x, (g ?? top) + 2.5, z));
    this.map.toggle(this.player.pos);
    this.input.lock();
    this.hud.toast('Travelled', `${x.toFixed(0)}, ${z.toFixed(0)}`);
  }

  // --- Frame ---------------------------------------------------------------------------------

  private update(): void {
    const dt = Math.min(this.clock.getDelta(), 0.066);
    this.elapsed += dt;
    this.frame++;
    this.fps = lerp(this.fps, 1 / Math.max(dt, 1e-3), 0.05);
    const t = this.elapsed;
    const I = this.input;

    // Global keys
    if (I.pressed('KeyM')) {
      this.map.toggle(this.player.pos);
      if (this.map.open) document.exitPointerLock();
      else I.lock();
    }
    if (I.pressed('KeyH')) this.hud.toggleHelp();
    if (I.pressed('F3')) this.hud.toggleStats();
    if (I.pressed('KeyV')) {
      this.player.mode = this.player.mode === 'fly' ? 'walk' : 'fly';
      this.hud.toast(this.player.mode === 'fly' ? 'Flight' : 'Walking', '', '#ffd27f');
    }
    if (I.pressed('KeyL')) this.lampOn = this.lampOn === null ? !this.lampAuto() : !this.lampOn;
    if (I.pressed('KeyG')) this.cycleQuality();
    if (I.pressed('KeyC')) this.toggleCamera();
    this.sky.timeScale = I.down('KeyT') ? 60 : 1;

    if (!this.map.open) {
      this.player.update(dt, I, this.camera);
      this.placeCamera(dt);
      this.tools.update(dt, I, this.player, this.camera);
      if (this.player.stepEvent) {
        this.player.stepEvent = false;
        this.audio.step();
      }
    }
    if (this.tools.shake > 0) {
      const s = this.tools.shake * 0.25;
      this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
    }
    this.camera.updateMatrixWorld();

    // Environment: how enclosed are we, and are we in the underworld?
    const eye = this.player.eye;
    if (this.frame % 6 === 0) {
      this.env.skyT = this.world.skyVisibility(eye.x, eye.y, eye.z);
      this.env.underT = this.world.underworldFactor(eye.x, eye.y, eye.z);
    }
    this.env.sky = lerp(this.env.sky, this.env.skyT, 1 - Math.exp(-dt * 2));
    this.env.under = lerp(this.env.under, this.env.underT, 1 - Math.exp(-dt * 1.5));
    const enclosed = 1 - this.env.sky;
    const under = this.env.under;

    const st = this.sky.update(dt, t, this.camera.position);
    this.applyLighting(st, enclosed, under);

    // World
    this.chunks.cullBuried = enclosed < 0.5 && under < 0.1;
    this.chunks.update(this.camera.position, this.camera);
    this.props.update();

    const night = 1 - st.day;
    this.creatures.update(dt, t, this.player.pos, Math.max(enclosed, under), this.frame);
    this.settlements.update(dt, t, this.player.pos, night);
    this.debris.update(dt, this.frame);
    this.ambientParticles(dt, t, night, enclosed, under);
    _up.copy(this.player.up);
    this.dust.update(dt, _up);
    this.glow.update(dt, _up);

    this.updateAvatarAndLiquids(dt, t, st, under);

    this.dynamicBatch.begin();
    if (this.thirdPerson && this.camDist > 0.9) this.avatar.render(this.dynamicBatch, _ground.copy(this.player.pos).addScaledVector(this.player.up, -0.42), this.player.up, this.player.lookDir(_look), this.env.sky, TOOL_GLOW[this.tools.tool], t);
    this.creatures.render();
    this.debris.render();
    this.settlements.renderDynamic(t, night);
    this.dynamicBatch.end();

    this.audio.setAmbience(0.3 + 0.7 * clamp((this.player.pos.y - 40) / 300, 0, 1), Math.max(enclosed, under), Math.max(0, this.player.pos.y));
    this.updateHud(dt);
    this.map.draw(this.player.pos, this.heading());
    this.save(false);

    if (this.bloom.enabled) this.composer.render(dt);
    else {
      this.renderer.setRenderTarget(null);
      this.composer.render(dt);
    }
    I.endFrame();
  }

  // --- Camera, avatar, liquids -------------------------------------------------------------

  private toggleCamera(): void {
    this.thirdPerson = !this.thirdPerson;
    if (this.thirdPerson) {
      this.camDist = 0.5;
      this.avatar.reset(_ground.copy(this.player.pos).addScaledVector(this.player.up, -0.42), this.player.up, this.player.forward);
    }
    this.hud.toast(this.thirdPerson ? 'Third person' : 'First person', '', '#9fe8ff');
  }

  /** Third person: an over-the-shoulder camera that never clips into the terrain. */
  private placeCamera(dt: number): void {
    if (!this.thirdPerson) return;
    const P = this.player;
    const eye = P.eye.clone();
    const look = P.lookDir(_look);
    const right = _right.crossVectors(P.forward, P.up).normalize();
    const want = 4.6;
    const offset = new THREE.Vector3().addScaledVector(look, -1).addScaledVector(right, 0.12).addScaledVector(P.up, 0.1).normalize();
    const hit = this.world.raycast(eye, offset, want + 0.4);
    let allowed = hit ? Math.max(0.2, hit.distance - 0.35) : want;
    // Also keep the camera out of trees, rocks and buildings
    const probe = new THREE.Vector3(), push = new THREE.Vector3(), n = new THREE.Vector3();
    for (let d = 0.6; d < allowed; d += 0.3) {
      probe.copy(eye).addScaledVector(offset, d);
      if (P.sources.some((src) => src.resolveSphere(probe, 0.25, push, n))) {
        allowed = Math.max(0.2, d - 0.3);
        break;
      }
    }
    this.camDist = allowed < this.camDist ? allowed : lerp(this.camDist, allowed, 1 - Math.exp(-dt * 3));
    this.camera.position.copy(eye).addScaledVector(offset, this.camDist).addScaledVector(right, 0.35 * Math.min(1, this.camDist / 2));
  }

  private updateAvatarAndLiquids(dt: number, t: number, st: Sky['state'], under: number): void {
    const P = this.player;
    const ground = _ground.copy(P.pos).addScaledVector(P.up, -0.42);
    this.avatar.update(dt, this.world, ground, P.up, P.vel, P.lookDir(_look), P.grounded, P.mode === 'fly', P.jetting, this.glow);

    // Splashes when entering or leaving a liquid
    if (P.inLiquid !== this.wasInLiquid && Math.abs(P.vel.dot(P.up)) > 1.5) {
      const lc = P.pos.y < -150 ? this.world.params.under.liquid : this.world.params.liquid;
      for (let i = 0; i < 26; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * 1.2;
        this.dust.emit(ground.clone().add(new THREE.Vector3(Math.cos(a) * r, 0.3, Math.sin(a) * r)), new THREE.Vector3(Math.cos(a) * 1.5, 3 + Math.random() * 4, Math.sin(a) * 1.5), [lc[0] * 0.6 + 0.4, lc[1] * 0.6 + 0.4, lc[2] * 0.6 + 0.4], 0.35, 1.2, { alpha: 0.7, grav: 9, drag: 0.5 });
      }
      this.audio.dig();
    }
    this.wasInLiquid = P.inLiquid;

    const fog = this.scene.fog as THREE.FogExp2;
    const sk = this.sky.uniforms;
    const skyTop = new THREE.Color().copy(sk.uZenith.value).lerp(sk.uNZenith.value, 1 - st.day);
    const horizon = new THREE.Color().copy(sk.uHorizon.value).lerp(sk.uNHorizon.value, 1 - st.day);
    this.liquids.update(t, this.camera.position, {
      sunDir: st.sunDir,
      sunColor: st.sunLight,
      skyTop,
      horizon,
      ambient: st.skyAmbient.clone().multiplyScalar(0.55),
      fogColor: fog.color,
      fogDensity: fog.density,
      light: 0.5 + 0.5 * st.day,
    }, under);
    // Flowing water and waterfalls share one lighting state
    waterLight.uTime.value = t;
    waterLight.uSunDir.value.copy(st.sunDir);
    waterLight.uSunColor.value.copy(st.sunLight);
    waterLight.uSkyTop.value.copy(skyTop);
    waterLight.uHorizon.value.copy(horizon);
    waterLight.uAmbient.value.copy(st.skyAmbient).multiplyScalar(0.55).add(new THREE.Color(shared.uUnderAmbient.value).multiplyScalar(under * 1.5));
    waterLight.uFogColor.value.copy(fog.color);
    waterLight.uFogDensity.value = fog.density;
    this.fluids.update(dt, this.player.pos, this.env.sky);
    this.waterfalls.light = Math.max(0.12, Math.min(1, (0.25 + 0.75 * st.day) * (0.2 + 0.8 * this.env.sky)));
    this.waterfalls.update(dt, this.player.pos, this.env.sky);
    this.audio.setRoar(this.waterfalls.roar);
    const target = this.liquids.submerged(this.camera.position) || this.fluids.submerged(this.camera.position) ? 1 : 0;
    this.submerged = lerp(this.submerged, target, 1 - Math.exp(-dt * 10));
  }

  // --- Pause menu ------------------------------------------------------------------------------

  private buildMenu(): HTMLDivElement {
    const el = document.createElement('div');
    el.id = 'menu';
    el.classList.add('hidden');
    el.innerHTML = `
      <div class="panel">
        <h2>${this.world.params.name}</h2>
        <div class="seed">seed “${this.seed}”</div>
        <button data-a="resume" class="primary">Resume</button>
        <button data-a="camera"></button>
        <button data-a="quality"></button>
        <button data-a="help">Field manual</button>
        <button data-a="main">Main menu</button>
        <button data-a="reset" class="danger">Reset this world</button>
        <div class="note">Your changes to this world are saved automatically.</div>
      </div>`;
    el.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('button')?.dataset.a;
      if (!a) return;
      this.audio.ui();
      switch (a) {
        case 'resume':
          this.input.lock();
          break;
        case 'camera':
          this.toggleCamera();
          break;
        case 'quality':
          this.cycleQuality();
          break;
        case 'help':
          this.hud.toggleHelp();
          break;
        case 'main':
          this.save(true);
          this.noSave = true;
          location.href = `${location.pathname}?seed=${encodeURIComponent(this.seed)}`;
          return;
        case 'reset': {
          const btn = el.querySelector<HTMLButtonElement>('button[data-a="reset"]')!;
          if (btn.dataset.confirm !== '1') {
            btn.dataset.confirm = '1';
            btn.textContent = 'Click again to erase all changes';
            return;
          }
          this.noSave = true;
          this.resetSave();
          location.href = `${location.pathname}?seed=${encodeURIComponent(this.seed)}&auto=1`;
          return;
        }
      }
      this.refreshMenu();
    });
    return el;
  }

  private refreshMenu(): void {
    const q = (a: string) => this.menu.querySelector<HTMLButtonElement>(`button[data-a="${a}"]`)!;
    q('camera').textContent = `View: ${this.thirdPerson ? 'third person' : 'first person'}  (C)`;
    q('quality').textContent = `Quality: ${this.quality}  (G)`;
    const reset = q('reset');
    reset.dataset.confirm = '';
    reset.textContent = 'Reset this world';
  }

  private lampAuto(): boolean {
    return this.env.sky < 0.45 || this.env.under > 0.3 || this.sky.state.day < 0.25;
  }

  private applyLighting(st: Sky['state'], enclosed: number, under: number): void {
    const P = this.world.params;
    const U = P.under;
    const fog = this.scene.fog as THREE.FogExp2;
    const fogCol = st.fog.clone();
    const caveFog = new THREE.Color(0.012, 0.012, 0.018);
    const underFog = new THREE.Color().setRGB(U.fog[0] * 0.9, U.fog[1] * 0.9, U.fog[2] * 0.9, THREE.SRGBColorSpace);
    fogCol.lerp(caveFog, smoothstep(0.2, 0.9, enclosed) * (1 - under));
    fogCol.lerp(underFog, under);
    fog.color.copy(fogCol);
    const baseDensity = (0.00022 * P.sky.fog * 4200) / this.chunks.viewDistance;
    fog.density = lerp(lerp(baseDensity, 0.012, smoothstep(0.3, 1, enclosed) * (1 - under)), 0.0042, under);
    // Underwater: the view closes in and takes on the liquid's colour
    if (this.submerged > 0.01) {
      const lc = under > 0.5 ? U.liquid : P.liquid;
      const deep = new THREE.Color().setRGB(lc[0] * 0.3, lc[1] * 0.3, lc[2] * 0.3, THREE.SRGBColorSpace).multiplyScalar(0.3 + 0.7 * st.day);
      fog.color.lerp(deep, this.submerged);
      fog.density = lerp(fog.density, 0.045, this.submerged);
    }

    // Sun and ambient
    const sp = this.player.pos;
    const snap = 4;
    const cx = Math.round(sp.x / snap) * snap, cy = Math.round(sp.y / snap) * snap, cz = Math.round(sp.z / snap) * snap;
    this.sun.target.position.set(cx, cy, cz);
    this.sun.position.set(cx, cy, cz).addScaledVector(st.sunDir.y > -0.05 ? st.sunDir : _moonDir.set(-0.3, 0.8, 0.2).normalize(), 450);
    const nightLight = new THREE.Color(0.25, 0.3, 0.5).multiplyScalar(0.12 * (1 - st.day));
    this.sun.color.copy(st.sunLight).add(nightLight);
    this.sun.intensity = 1;
    this.sun.castShadow = st.sunDir.y > -0.02;
    this.hemi.color.copy(st.skyAmbient);
    this.hemi.groundColor.copy(st.groundAmbient);
    this.hemi.intensity = 1.1;

    shared.uUnderAmbient.value.setRGB(U.ambient[0] * 1.3, U.ambient[1] * 1.3, U.ambient[2] * 1.3, THREE.SRGBColorSpace);
    shared.uSkyColor.value.copy(st.fog);
    shared.uEmitBoost.value = 1 + (1 - st.day) * 0.5 + enclosed * 0.3;
    const lamp = this.lampOn ?? this.lampAuto();
    const target = lamp ? 1 : 0;
    const cur = shared.uLampColor.value.r / 1.5;
    const k = lerp(cur, target, 0.1);
    shared.uLampColor.value.setRGB(1.5 * k, 1.4 * k, 1.25 * k);
    const lampPos = this.player.eye.clone().addScaledVector(this.player.up, 0.3);
    shared.uLampView.value.copy(lampPos).applyMatrix4(this.camera.matrixWorldInverse);
    shared.uWind.value.set(1 + Math.sin(this.elapsed * 0.1) * 0.3, 0.4);
    this.renderer.toneMappingExposure = lerp(1.0, 1.15, enclosed * (1 - under));
  }

  private ambientParticles(dt: number, t: number, night: number, enclosed: number, under: number): void {
    const P = this.world.params;
    const p = this.player.pos;
    const rnd = (r: number) => (Math.random() - 0.5) * 2 * r;
    // Underworld spores and cave motes
    if (under > 0.2 && Math.random() < under * 0.9) {
      const c = Math.random() < 0.5 ? P.under.moss : P.under.moss2;
      this.glow.emit(new THREE.Vector3(p.x + rnd(30), p.y + rnd(12), p.z + rnd(30)), new THREE.Vector3(rnd(0.3), 0.2 + Math.random() * 0.4, rnd(0.3)), c, 0.15 + Math.random() * 0.2, 6 + Math.random() * 4, { drag: 0.1, alpha: 0.9 });
    }
    // Fireflies at night
    if (night > 0.6 && enclosed < 0.5 && Math.random() < 0.35) {
      this.glow.emit(new THREE.Vector3(p.x + rnd(25), p.y + Math.random() * 4, p.z + rnd(25)), new THREE.Vector3(rnd(0.5), rnd(0.2), rnd(0.5)), P.crystal, 0.12, 4 + Math.random() * 3, { drag: 0.2 });
    }
    // Levitation fields shimmer with rising motes
    const lev = this.world.terrain.levitation(p.x, p.z);
    if (lev > 0.1 && enclosed < 0.5 && Math.random() < lev * 0.8) {
      this.glow.emit(new THREE.Vector3(p.x + rnd(35), p.y - 3 + Math.random() * 15, p.z + rnd(35)), new THREE.Vector3(0, 0.6 + Math.random(), 0), [0.7, 0.85, 1], 0.1, 5, { drag: 0, alpha: 0.6 });
    }
    // Lift wells: bright streams rising in a spiral
    if (this.frame % 2 === 0) {
      const w = this.world.terrain.wellAt(p.x, p.z) ?? this.nearWell(p);
      if (w) {
        for (let i = 0; i < 6; i++) {
          const a = Math.random() * Math.PI * 2;
          const r = Math.random() * w.r;
          const y = w.base + Math.random() * 40;
          this.glow.emit(new THREE.Vector3(w.x + Math.cos(a) * r, y, w.z + Math.sin(a) * r), new THREE.Vector3(-Math.sin(a) * 2, 8 + Math.random() * 10, Math.cos(a) * 2), [0.6, 0.95, 1], 0.35, 6, { drag: 0.05 });
        }
      }
    }
    void dt;
    void t;
  }

  private wellCache: { x: number; z: number; w: ReturnType<World['terrain']['wellCell']> } | null = null;

  private nearWell(p: THREE.Vector3) {
    if (this.wellCache && Math.hypot(this.wellCache.x - p.x, this.wellCache.z - p.z) < 40) return this.wellCache.w;
    const T = this.world.terrain;
    const cs = 340;
    let best = null;
    let bd = 260;
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const w = T.wellCell(Math.floor(p.x / cs) + i, Math.floor(p.z / cs) + j);
        if (!w) continue;
        const d = Math.hypot(w.x - p.x, w.z - p.z);
        if (d < bd) {
          bd = d;
          best = w;
        }
      }
    this.wellCache = { x: p.x, z: p.z, w: best };
    return best;
  }

  private heading(): number {
    const f = this.player.forward;
    return Math.atan2(f.x, -f.z);
  }

  private updateHud(dt: number): void {
    const P = this.world.params;
    const p = this.player.pos;
    this.placeTimer -= dt;
    if (this.placeTimer <= 0) {
      this.placeTimer = 0.5;
      const name = this.placeName();
      if (name.main !== this.place) {
        if (this.place && name.announce) this.hud.toast(name.main, name.sub);
        this.place = name.main;
        this.placeSub = name.sub;
      }
      this.markers = this.settlements
        .sitesNear(p.x, p.z, 3500)
        .filter((s) => (s.layer === 'under') === (this.env.under > 0.3 || p.y < -150))
        .map((s) => {
          const loaded = [...this.settlements.settlements.values()].find((x) => x.site === s);
          return {
            bearing: Math.atan2(s.x - p.x, -(s.z - p.z)),
            dist: Math.hypot(s.x - p.x, s.z - p.z),
            label: loaded?.discovered ? loaded.name : '?',
            color: rgbCss(s.civ.glow),
          };
        });
    }
    const g = this.player.gravity.length();
    const tod = this.sky.time;
    const hh = Math.floor(tod * 24), mm = Math.floor((tod * 24 - hh) * 60);
    const r = this.renderer.info.render;
    this.hud.update({
      place: this.place,
      sub: this.placeSub,
      pos: [p.x, p.y, p.z],
      gravity: g,
      gravityRel: g / P.gravity,
      time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} ${this.sky.state.day > 0.5 ? '☀' : '☾'}`,
      tool: this.tools.tool,
      radius: this.tools.radius,
      fuel: this.player.fuel,
      fly: this.player.mode === 'fly',
      heading: this.heading(),
      markers: this.markers,
      stats: this.frame % 10 === 0 ? `${this.fps.toFixed(0)} fps  ${this.quality}\nchunks ${this.chunks.stats.visible}/${this.chunks.stats.nodes}  jobs ${this.chunks.stats.pending}\ntris ${(this.chunks.stats.triangles / 1e6).toFixed(2)}M  calls ${r.calls}\nflora ${this.props.instanceCount}  life ${this.creatures.creatures.length}  debris ${this.debris.count}\nedits ${this.world.edits.edits.length}  water ${this.fluids.stats.awake}/${this.fluids.stats.chunks}  falls ${this.waterfalls.count}` : undefined,
    }, dt);
  }

  private placeSub = '';
  private markers: { bearing: number; dist: number; label: string; color: string }[] = [];

  private placeName(): { main: string; sub: string; announce: boolean } {
    const P = this.world.params;
    const p = this.player.pos;
    const T = this.world.terrain;
    const s = this.settlements.at(p);
    if (s) return { main: s.name, sub: `settlement of the ${s.civ.people}`, announce: false };
    if (this.env.underT > 0.5) return { main: `The Deep of ${P.name}`, sub: 'underworld', announce: true };
    if (this.env.skyT < 0.25) return { main: 'Caves', sub: `${(T.columnAt(p.x, p.z).h - p.y).toFixed(0)} m below the surface`, announce: true };
    const col = T.columnAt(p.x, p.z);
    const up = this.player.up;
    if (up.y < 0.7 && T.moonAt(p.x, p.z)) return { main: 'Moonlet', sub: 'local gravity well', announce: true };
    if (p.y < P.seaLevel + 0.5 && p.y > P.seaLevel - 80 && col.h < P.seaLevel) return { main: P.liquidName, sub: 'open liquid', announce: true };
    const b = P.biomes[col.w1 > 0.45 ? col.b1 : col.b0];
    if (col.isR > 0 && p.y > col.h + 20) return { main: b.name, sub: 'floating island', announce: false };
    const lev = T.levitation(p.x, p.z);
    return { main: b.name, sub: lev > 0.4 ? 'levitation field' : b.archetype, announce: true };
  }

  private cycleQuality(): void {
    const order: Quality[] = ['low', 'medium', 'high'];
    this.quality = order[(order.indexOf(this.quality) + 1) % 3];
    const Q = QUALITY[this.quality];
    this.chunks.splitFactor = Q.split;
    this.chunks.viewDistance = Q.view;
    this.bloom.enabled = Q.bloom;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, Q.ratio));
    this.camera.far = Q.far;
    this.camera.updateProjectionMatrix();
    this.resize();
    this.hud.toast(`Quality: ${this.quality}`, '', '#ffd27f');
    try {
      localStorage.setItem('xenoworld:quality', this.quality);
    } catch {
      /* storage unavailable */
    }
  }

  // --- Persistence ---------------------------------------------------------------------------

  private saved: SaveData | null = null;

  private get saveKey(): string {
    return `xenoworld:save:${this.seed}`;
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(this.saveKey);
      if (!raw) return;
      const data = JSON.parse(raw) as SaveData;
      if (data.v !== 1) return;
      this.saved = data;
      this.world.edits.load(data.edits ?? []);
      for (const id of data.props ?? []) this.props.destroyed.add(id);
      this.settlements.load(data.pieces ?? {});
      if (data.time !== undefined) this.sky.time = data.time;
      this.savedRev = this.world.edits.revision;
      this.propsDestroyedCount = this.props.destroyed.size;
    } catch {
      /* corrupt or unavailable storage: start fresh */
    }
  }

  private save(force: boolean): void {
    if (this.noSave) return;
    this.saveTimer -= 1 / 60;
    if (!force && this.saveTimer > 0) return;
    this.saveTimer = 5;
    const changed = this.world.edits.revision !== this.savedRev || this.props.destroyed.size !== this.propsDestroyedCount;
    if (!changed && !force && this.frame % 1800 !== 0) return;
    const p = this.player.pos;
    const data: SaveData = {
      v: 1,
      edits: this.world.edits.serialize(),
      props: [...this.props.destroyed],
      pieces: this.settlements.serialize(),
      player: [p.x, p.y + 0.5, p.z],
      time: this.sky.time,
    };
    try {
      localStorage.setItem(this.saveKey, JSON.stringify(data));
      this.savedRev = this.world.edits.revision;
      this.propsDestroyedCount = this.props.destroyed.size;
    } catch {
      /* quota exceeded: keep playing without persistence */
    }
  }

  resetSave(): void {
    try {
      localStorage.removeItem(this.saveKey);
    } catch {
      /* ignore */
    }
  }
}

const _up = new THREE.Vector3();
const _ground = new THREE.Vector3();
const _look = new THREE.Vector3();
const _right = new THREE.Vector3();
const TOOL_GLOW: Record<string, RGB> = { dig: [0.6, 0.92, 1], build: [1, 0.82, 0.45], blast: [1, 0.4, 0.28], scan: [0.55, 1, 0.6] };
const _moonDir = new THREE.Vector3();

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
