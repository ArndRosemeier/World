import * as THREE from 'three';
import { WorkerPool } from '../world/WorkerPool';
import { WorldParams } from '../world/WorldParams';
import { NOISE_GLSL } from './materials';
import { hash01 } from '../core/rng';

// ---------------------------------------------------------------------------------------------
// Liquids. Instead of per-chunk water quads (which never line up across LODs), each liquid
// layer is one camera-centred radial mesh at its level. Where liquid exists, and how deep it
// is, comes from depth masks baked in the workers (a near mask for shorelines, a far mask for
// the horizon). The shader does Gerstner waves whose speed follows the local gravity, shore and
// crest foam, fresnel sky reflection, sun glints, depth colour and an underwater view.
// ---------------------------------------------------------------------------------------------

const RES = 256;

class Mask {
  readonly tex: THREE.DataTexture;
  readonly data = new Uint8Array(RES * RES * 4);
  readonly origin = new THREE.Vector2(1e9, 1e9);
  ready = false;
  pending = false;
  constructor(readonly size: number) {
    this.tex = new THREE.DataTexture(this.data, RES, RES, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping;
    this.tex.needsUpdate = true;
  }

  /** Depth in metres (channel 0 = sea, 1 = underworld lake), or null outside the mask. */
  depth(x: number, z: number, ch: number): number | null {
    if (!this.ready) return null;
    const u = (x - this.origin.x) / this.size, v = (z - this.origin.y) / this.size;
    if (u < 0 || v < 0 || u >= 1 || v >= 1) return null;
    const i = Math.floor(u * RES), j = Math.floor(v * RES);
    return this.data[(i + j * RES) * 4 + ch] / 2 - 16;
  }
}

const VERT = /* glsl */ `
uniform vec3 uCenter;
uniform float uTime;
uniform float uAmp;
uniform float uG;
uniform vec2 uWind;
uniform sampler2D uNearTex; uniform vec2 uNearOrigin; uniform float uNearSize;
uniform sampler2D uFarTex; uniform vec2 uFarOrigin; uniform float uFarSize;
uniform float uChannel;
varying vec3 vW;
varying float vDepth;
varying vec3 vN;
varying float vCrest;
varying float vDist;

float decodeDepth(vec4 t) { float v = uChannel < 0.5 ? t.r : t.g; return v * 127.5 - 16.0; }
float liquidDepth(vec2 p) {
  vec2 uf = (p - uFarOrigin) / uFarSize;
  float d = decodeDepth(texture2D(uFarTex, uf));
  vec2 un = (p - uNearOrigin) / uNearSize;
  float e = min(min(un.x, un.y), min(1.0 - un.x, 1.0 - un.y));
  if (e > 0.0) d = mix(d, decodeDepth(texture2D(uNearTex, un)), smoothstep(0.0, 0.08, e));
  return d;
}

// One Gerstner wave; accumulates tangent frame for the normal.
vec3 wave(vec2 p, vec2 dir, float steep, float wl, inout vec3 tan, inout vec3 bin) {
  float k = 6.28318 / wl;
  float c = sqrt(uG / k);
  vec2 d = normalize(dir);
  float f = k * (dot(d, p) - c * uTime);
  float a = steep / k;
  float s = sin(f), co = cos(f);
  tan += vec3(-d.x * d.x * steep * s, d.x * steep * co, -d.x * d.y * steep * s);
  bin += vec3(-d.x * d.y * steep * s, d.y * steep * co, -d.y * d.y * steep * s);
  return vec3(d.x * a * co, a * s, d.y * a * co);
}

void main() {
  vec3 w = uCenter + position;
  float depth = liquidDepth(w.xz);
  float dist = length(w.xz - cameraPosition.xz);
  float k = uAmp * smoothstep(0.3, 9.0, depth) * (1.0 - smoothstep(220.0, 650.0, dist));
  vec3 tan = vec3(1.0, 0.0, 0.0), bin = vec3(0.0, 0.0, 1.0);
  vec3 disp = vec3(0.0);
  vec2 wd = uWind;
  vec2 wp = vec2(-wd.y, wd.x);
  disp += wave(w.xz, wd, 0.13 * k, 58.0, tan, bin);
  disp += wave(w.xz, wd + wp * 0.6, 0.11 * k, 31.0, tan, bin);
  disp += wave(w.xz, wd - wp * 0.7, 0.09 * k, 17.0, tan, bin);
  disp += wave(w.xz, wp + wd * 0.3, 0.07 * k, 9.0, tan, bin);
  disp += wave(w.xz, -wp + wd * 0.5, 0.05 * k, 5.3, tan, bin);
  w += disp;
  vW = w;
  vDepth = depth;
  vN = normalize(cross(bin, tan));
  vCrest = disp.y / max(0.05, 2.2 * k);
  vDist = dist;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyTop;
uniform vec3 uHorizon;
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uGlow;
uniform float uLight;
varying vec3 vW;
varying float vDepth;
varying vec3 vN;
varying float vCrest;
varying float vDist;
${NOISE_GLSL}

vec3 ripple(vec2 p, float t, float fade) {
  float e = 0.35;
  float h0 = vnoise(vec3(p * 0.9, t * 0.35)) + 0.5 * vnoise(vec3(p * 2.3 + 17.0, t * 0.6));
  float hx = vnoise(vec3((p + vec2(e, 0.0)) * 0.9, t * 0.35)) + 0.5 * vnoise(vec3((p + vec2(e, 0.0)) * 2.3 + 17.0, t * 0.6));
  float hz = vnoise(vec3((p + vec2(0.0, e)) * 0.9, t * 0.35)) + 0.5 * vnoise(vec3((p + vec2(0.0, e)) * 2.3 + 17.0, t * 0.6));
  return vec3(-(hx - h0), 0.0, -(hz - h0)) * 1.4 * fade;
}

void main() {
  if (vDepth < -0.4) discard;
  vec3 V = normalize(cameraPosition - vW);
  float fade = 1.0 - smoothstep(40.0, 260.0, vDist);
  vec3 N = normalize(vN + ripple(vW.xz, uTime, fade));
  bool under = !gl_FrontFacing;
  if (under) N = -N;
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  // Body colour from depth
  float dk = smoothstep(0.0, 28.0, vDepth);
  vec3 body = mix(uShallow, uDeep, dk);
  float sunUp = clamp(uSunDir.y * 3.0 + 0.2, 0.0, 1.0);
  vec3 lit = body * (uAmbient + uSunColor * 0.25 * sunUp * max(dot(N, uSunDir), 0.0));
  // Light scattering through wave crests
  lit += uShallow * uSunColor * 0.12 * max(vCrest, 0.0) * sunUp;

  // Reflection of the sky and the sun
  vec3 R = reflect(-V, N);
  vec3 sky = mix(uHorizon, uSkyTop, clamp(R.y * 1.6, 0.0, 1.0));
  float spec = pow(max(dot(R, uSunDir), 0.0), 700.0) * 25.0 + pow(max(dot(R, uSunDir), 0.0), 60.0) * 0.5;
  vec3 refl = sky * uLight + uSunColor * spec * sunUp;

  vec3 col = mix(lit, refl, fres * (1.0 - uGlow * 0.7));
  float alpha = mix(0.35, 0.94, smoothstep(0.0, 5.0, vDepth));
  alpha = mix(alpha, 1.0, fres * 0.8);

  // Foam: bands rolling onto the shore, plus whitecaps on crests
  float n = vnoise(vec3(vW.xz * 0.45, uTime * 0.3));
  float shore = 1.0 - smoothstep(0.0, 2.6, vDepth);
  float bands = 0.5 + 0.5 * sin(vDepth * 4.2 - uTime * 1.7 + n * 5.0);
  float foam = shore * smoothstep(0.45, 0.85, bands * (0.6 + n * 0.8));
  foam += (1.0 - smoothstep(0.0, 0.35, vDepth)) * 0.5;
  foam += smoothstep(0.55, 1.0, vCrest) * smoothstep(0.4, 0.7, n) * 0.7;
  foam = clamp(foam, 0.0, 1.0) * (1.0 - uGlow * 0.5);
  vec3 foamCol = (uAmbient * 1.1 + uSunColor * 0.22 * sunUp) * mix(vec3(1.0), uShallow * 2.0, 0.15);
  col = mix(col, foamCol, foam * 0.85);
  alpha = max(alpha, foam);

  // Glowing liquids: slow luminous currents
  if (uGlow > 0.0) {
    vec2 flow = vW.xz * 0.05 + vec2(uTime * 0.02, uTime * 0.013);
    float veins = smoothstep(0.55, 0.8, vnoise(vec3(flow * 3.0, uTime * 0.08)) * 0.7 + vnoise(vec3(flow * 9.0, uTime * 0.2)) * 0.4);
    col = col * 0.5 + uColor * uGlow * (0.1 + 0.85 * veins) * (0.8 + 0.2 * sin(uTime * 1.3 + vW.x * 0.05));
    alpha = max(alpha, 0.8);
  }

  if (under) {
    // Looking up from below: a bright Snell window, dark total internal reflection outside it
    float window = smoothstep(0.55, 0.75, ndv);
    col = mix(uDeep * uAmbient * 2.0, sky * uLight * 0.9, window);
    alpha = 0.95;
  }

  float fog = 1.0 - exp(-pow(uFogDensity * vDist, 2.0));
  col = mix(col, uFogColor, fog);
  gl_FragColor = vec4(col, alpha);
}
`;

function radialGrid(segments: number, rings: number, r0: number, growth: number): THREE.BufferGeometry {
  const pos: number[] = [0, 0, 0];
  const idx: number[] = [];
  for (let i = 1; i <= rings; i++) {
    const r = r0 * (Math.pow(growth, i) - 1) / (growth - 1);
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
  }
  const ring = (i: number, s: number) => 1 + (i - 1) * segments + (s % segments);
  for (let s = 0; s < segments; s++) idx.push(0, ring(1, s + 1), ring(1, s));
  for (let i = 1; i < rings; i++)
    for (let s = 0; s < segments; s++) {
      const a = ring(i, s), b = ring(i, s + 1), c = ring(i + 1, s + 1), d = ring(i + 1, s);
      idx.push(a, b, c, a, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

export interface LiquidLighting {
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  skyTop: THREE.Color;
  horizon: THREE.Color;
  ambient: THREE.Color;
  fogColor: THREE.Color;
  fogDensity: number;
  light: number;
}

export class Liquids {
  readonly group = new THREE.Group();
  private near = new Mask(1024);
  private far = new Mask(9000);
  private sea: THREE.Mesh;
  private lake: THREE.Mesh;
  private seaMat: THREE.ShaderMaterial;
  private lakeMat: THREE.ShaderMaterial;

  constructor(private params: WorldParams, private pool: WorkerPool) {
    const geo = radialGrid(160, 120, 0.35, 1.068);
    const lin = (c: [number, number, number], k = 1) => new THREE.Color().setRGB(c[0] * k, c[1] * k, c[2] * k, THREE.SRGBColorSpace);
    const windA = hash01(params.seed, 71) * Math.PI * 2;
    const make = (level: number, channel: number, color: [number, number, number], glow: number, amp: number) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          uCenter: { value: new THREE.Vector3(0, level, 0) },
          uTime: { value: 0 },
          uAmp: { value: amp },
          uG: { value: params.gravity },
          uWind: { value: new THREE.Vector2(Math.cos(windA), Math.sin(windA)) },
          uNearTex: { value: this.near.tex },
          uNearOrigin: { value: this.near.origin },
          uNearSize: { value: this.near.size },
          uFarTex: { value: this.far.tex },
          uFarOrigin: { value: this.far.origin },
          uFarSize: { value: this.far.size },
          uChannel: { value: channel },
          uColor: { value: lin(color) },
          uDeep: { value: lin(color, 0.22) },
          uShallow: { value: lin([Math.min(1, color[0] * 1.25 + 0.08), Math.min(1, color[1] * 1.25 + 0.1), Math.min(1, color[2] * 1.25 + 0.1)]) },
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uSunColor: { value: new THREE.Color() },
          uSkyTop: { value: new THREE.Color() },
          uHorizon: { value: new THREE.Color() },
          uAmbient: { value: new THREE.Color() },
          uFogColor: { value: new THREE.Color() },
          uFogDensity: { value: 0 },
          uGlow: { value: glow },
          uLight: { value: 1 },
        },
      });
      const mesh = new THREE.Mesh(geo, m);
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      this.group.add(mesh);
      return { mesh, m };
    };
    // Low-gravity worlds get taller, slower swells
    const amp = Math.min(1.8, Math.max(0.6, 9.8 / params.gravity)) * 0.85;
    const s = make(params.seaLevel, 0, params.liquid, params.liquidGlow, amp);
    const l = make(params.under.liquidLevel, 1, params.under.liquid, 0.9, 0.18);
    this.sea = s.mesh;
    this.seaMat = s.m;
    this.lake = l.mesh;
    this.lakeMat = l.m;
    this.lake.visible = false;
  }

  /** Liquid depth at a point for a layer (0 sea, 1 underworld lakes), from the baked masks. */
  depthAt(x: number, z: number, layer: 0 | 1): number {
    return this.near.depth(x, z, layer) ?? this.far.depth(x, z, layer) ?? -16;
  }

  /** True if the point is inside a body of liquid. */
  submerged(p: THREE.Vector3): boolean {
    const P = this.params;
    if (p.y < P.seaLevel && this.depthAt(p.x, p.z, 0) > P.seaLevel - p.y - 0.5) return true;
    const ul = P.under.liquidLevel;
    return p.y < ul && p.y > ul - 40 && this.depthAt(p.x, p.z, 1) > ul - p.y - 0.5;
  }

  get ready(): boolean {
    return this.near.ready && this.far.ready;
  }

  private refresh(mask: Mask, cam: THREE.Vector3): void {
    if (mask.pending) return;
    const half = mask.size / 2;
    const cx = mask.origin.x + half, cz = mask.origin.y + half;
    if (mask.ready && Math.abs(cam.x - cx) < mask.size / 5 && Math.abs(cam.z - cz) < mask.size / 5) return;
    const snap = mask.size / 16;
    const x0 = Math.round(cam.x / snap) * snap - half;
    const z0 = Math.round(cam.z / snap) * snap - half;
    mask.pending = true;
    this.pool.requestLiquid({ x0, z0, size: mask.size, res: RES }, (px, job) => {
      mask.data.set(px);
      mask.tex.needsUpdate = true;
      mask.origin.set(job.x0, job.z0);
      mask.ready = true;
      mask.pending = false;
    });
  }

  /** Request the masks around a point without rendering (used while loading). */
  prime(cam: THREE.Vector3): void {
    this.refresh(this.far, cam);
    this.refresh(this.near, cam);
  }

  update(t: number, cam: THREE.Vector3, L: LiquidLighting, underworld: number): void {
    this.refresh(this.far, cam);
    this.refresh(this.near, cam);
    const snap = 4;
    const cx = Math.round(cam.x / snap) * snap, cz = Math.round(cam.z / snap) * snap;
    for (const [mesh, m] of [[this.sea, this.seaMat], [this.lake, this.lakeMat]] as const) {
      const u = m.uniforms;
      u.uCenter.value.x = cx;
      u.uCenter.value.z = cz;
      u.uTime.value = t;
      u.uSunDir.value.copy(L.sunDir);
      u.uSunColor.value.copy(L.sunColor);
      u.uSkyTop.value.copy(L.skyTop);
      u.uHorizon.value.copy(L.horizon);
      u.uAmbient.value.copy(L.ambient);
      u.uFogColor.value.copy(L.fogColor);
      u.uFogDensity.value = L.fogDensity;
      u.uLight.value = L.light;
      void mesh;
    }
    this.sea.visible = this.ready && cam.y > -120;
    this.lake.visible = this.ready && underworld > 0.05 && cam.y < -150;
    // The underworld lake is lit by the cavern glow rather than the sky
    const lu = this.lakeMat.uniforms;
    lu.uSunColor.value.setRGB(0, 0, 0);
    lu.uAmbient.value.copy(lu.uColor.value).multiplyScalar(0.1);
    lu.uSkyTop.value.copy(lu.uColor.value).multiplyScalar(0.25);
    lu.uHorizon.value.copy(lu.uColor.value).multiplyScalar(0.12);
  }
}
