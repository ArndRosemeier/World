import * as THREE from 'three';
import { WorldParams } from '../world/WorldParams';
import { clamp, smoothstep, RGB } from '../core/math';
import { NOISE_GLSL } from './materials';

const col = (c: RGB) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uSun; uniform vec3 uSun2;
uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uNZenith; uniform vec3 uNHorizon;
uniform vec3 uSunset; uniform vec3 uSunColor; uniform vec3 uSun2Color;
uniform float uSunSize; uniform float uSun2Size; uniform float uHasSun2;
uniform float uDay; uniform float uTime;
uniform vec3 uRingN; uniform vec2 uRingR; uniform vec3 uRingColor; uniform float uRingOpacity; uniform float uHasRing;
uniform vec3 uPlanetDir; uniform float uPlanetSize; uniform vec3 uPlanetC1; uniform vec3 uPlanetC2; uniform float uPlanetBands; uniform float uHasPlanet;
uniform vec3 uCloud; uniform float uCloudCover;
uniform float uUnder;
uniform vec3 uUnderFog;
varying vec3 vDir;
${NOISE_GLSL}
float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 zen = mix(uNZenith, uZenith, uDay);
  vec3 hor = mix(uNHorizon, uHorizon, uDay);
  vec3 c = mix(hor, zen, pow(clamp(h, 0.0, 1.0), 0.45));
  float sd = max(dot(d, uSun), 0.0);
  // Sunset glow near the horizon around the sun
  float low = 1.0 - smoothstep(-0.15, 0.45, uSun.y);
  c += uSunset * pow(sd, 5.0) * low * 1.3 * smoothstep(-0.4, 0.1, uSun.y);
  c += uSunset * pow(1.0 - abs(h), 8.0) * low * 0.35 * smoothstep(-0.3, 0.05, uSun.y);
  c += uSunColor * pow(sd, 60.0) * 0.6 * smoothstep(-0.1, 0.1, uSun.y);

  // Stars
  float night = 1.0 - uDay;
  if (night > 0.01 && h > -0.05) {
    vec3 sp = d * 280.0;
    vec3 cell = floor(sp);
    float r = xh13(cell);
    vec3 fp = fract(sp) - 0.5;
    float star = r > 0.985 ? (1.0 - smoothstep(0.0, 0.08, length(fp))) * (0.5 + 0.5 * sin(uTime * (1.0 + r * 4.0) + r * 60.0)) : 0.0;
    vec3 sc = mix(vec3(0.8, 0.9, 1.0), vec3(1.0, 0.7, 0.6), xh13(cell + 7.0));
    c += sc * star * night * 1.6;
    // Faint galactic band
    float band = exp(-pow(dot(d, normalize(vec3(0.3, 0.5, 0.8))) * 4.0, 2.0));
    c += vec3(0.25, 0.2, 0.35) * band * fbm(d * 6.0) * night * 0.5;
  }

  // Gas giant with its own phase
  if (uHasPlanet > 0.5) {
    float pd = dot(d, uPlanetDir);
    float cs = cos(uPlanetSize);
    if (pd > cs) {
      vec3 up = normalize(cross(uPlanetDir, vec3(0.3, 0.1, 1.0)));
      vec3 rt = cross(uPlanetDir, up);
      vec2 q = vec2(dot(d, rt), dot(d, up)) / sin(uPlanetSize);
      float rr = length(q);
      if (rr < 1.0) {
        vec3 n = normalize(rt * q.x + up * q.y - uPlanetDir * sqrt(1.0 - rr * rr));
        float lit = clamp(dot(-n, uSun) * 0.9 + 0.1, 0.0, 1.0);
        float bands = sin(q.y * uPlanetBands + fbm(vec3(q * 3.0, uTime * 0.01)) * 3.0) * 0.5 + 0.5;
        vec3 pc = mix(uPlanetC1, uPlanetC2, bands);
        float rim = 1.0 - smoothstep(0.94, 1.0, rr);
        c = mix(c, pc * (lit * 1.1 + 0.03), rim * (0.25 + 0.75 * max(uDay, 0.35)) + rim * 0.0);
        c += pc * pow(rr, 6.0) * 0.2 * lit;
      }
    }
  }

  // Our own planetary ring, seen from the surface as a great arc.
  if (uHasRing > 0.5) {
    vec3 C = vec3(0.0, -1.0, 0.0);
    float dn = dot(d, uRingN);
    float t = dot(C, uRingN) / dn;
    if (t > 0.0) {
      vec3 P = d * t - C;
      float r = length(P);
      if (r > uRingR.x && r < uRingR.y) {
        float u = (r - uRingR.x) / (uRingR.y - uRingR.x);
        float bands = 0.55 + 0.45 * sin(u * 70.0) * sin(u * 23.0 + 1.0);
        float gaps = smoothstep(0.02, 0.06, abs(u - 0.62)) * smoothstep(0.0, 0.05, u) * (1.0 - smoothstep(0.95, 1.0, u));
        float a = uRingOpacity * bands * gaps * smoothstep(0.0, 0.05, h + 0.05);
        vec3 rc = uRingColor * (0.25 + 0.9 * max(uDay, 0.1));
        c = mix(c, rc, a);
      }
    }
  }

  // Clouds on a curved layer
  if (h > 0.0) {
    vec2 uv = d.xz / (h + 0.12) * 1.6;
    float n = fbm(vec3(uv + vec2(uTime * 0.004, uTime * 0.002), uTime * 0.003));
    float cov = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.3, n);
    vec3 cc = uCloud * (0.15 + 0.85 * uDay) + uSunset * low * 0.6 * uDay;
    cc += uSunColor * pow(sd, 8.0) * 0.4 * uDay;
    c = mix(c, cc, cov * smoothstep(0.0, 0.25, h) * 0.85);
  }

  // Suns
  float sunDisc = smoothstep(cos(uSunSize), cos(uSunSize * 0.85), dot(d, uSun));
  c += uSunColor * sunDisc * 18.0;
  c += uSunColor * pow(sd, 900.0) * 3.0;
  if (uHasSun2 > 0.5) {
    float s2 = dot(d, uSun2);
    c += uSun2Color * smoothstep(cos(uSun2Size), cos(uSun2Size * 0.8), s2) * 14.0;
    c += uSun2Color * pow(max(s2, 0.0), 300.0) * 1.5;
  }

  if (h < 0.0) c = mix(c, hor * 0.7, (1.0 - smoothstep(-0.2, 0.0, h)));
  c = mix(c, uUnderFog, uUnder);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface SkyState {
  sunDir: THREE.Vector3;
  day: number;
  sunLight: THREE.Color;
  skyAmbient: THREE.Color;
  groundAmbient: THREE.Color;
  fog: THREE.Color;
}

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly uniforms: Record<string, THREE.IUniform>;
  private params: WorldParams;
  /** Time of day in [0, 1): 0.25 sunrise, 0.5 noon, 0.75 sunset. */
  time = 0.36;
  timeScale = 1;
  readonly state: SkyState = {
    sunDir: new THREE.Vector3(),
    day: 1,
    sunLight: new THREE.Color(),
    skyAmbient: new THREE.Color(),
    groundAmbient: new THREE.Color(),
    fog: new THREE.Color(),
  };

  constructor(params: WorldParams) {
    this.params = params;
    const S = params.sky;
    this.uniforms = {
      uSun: { value: new THREE.Vector3(0, 1, 0) },
      uSun2: { value: new THREE.Vector3(0, 1, 0) },
      uZenith: { value: col(S.zenith) },
      uHorizon: { value: col(S.horizon) },
      uNZenith: { value: col(S.nightZenith) },
      uNHorizon: { value: col(S.nightHorizon) },
      uSunset: { value: col(S.sunset) },
      uSunColor: { value: col(S.sunColor) },
      uSun2Color: { value: col(S.sun2?.color ?? [1, 1, 1]) },
      uSunSize: { value: S.sunSize },
      uSun2Size: { value: S.sun2?.size ?? 0.01 },
      uHasSun2: { value: S.sun2 ? 1 : 0 },
      uDay: { value: 1 },
      uTime: { value: 0 },
      uRingN: { value: new THREE.Vector3(...(S.ring?.normal ?? [0, 1, 0])) },
      uRingR: { value: new THREE.Vector2(1.25 + (S.ring?.inner ?? 0.4) * 1.6, 1.25 + (S.ring?.outer ?? 0.8) * 2.2) },
      uRingColor: { value: col(S.ring?.color ?? [1, 1, 1]) },
      uRingOpacity: { value: S.ring?.opacity ?? 0 },
      uHasRing: { value: S.ring ? 1 : 0 },
      uPlanetDir: { value: new THREE.Vector3(...(S.planet?.dir ?? [0, 1, 0])) },
      uPlanetSize: { value: S.planet?.size ?? 0.1 },
      uPlanetC1: { value: col(S.planet?.color ?? [1, 1, 1]) },
      uPlanetC2: { value: col(S.planet?.color2 ?? [1, 1, 1]) },
      uPlanetBands: { value: S.planet?.bands ?? 8 },
      uHasPlanet: { value: S.planet ? 1 : 0 },
      uCloud: { value: col(S.cloudColor) },
      uCloudCover: { value: S.cloudCover },
      uUnder: { value: 0 },
      uUnderFog: { value: new THREE.Color() },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    this.mesh.scale.setScalar(10000);
  }

  update(dt: number, elapsed: number, camPos: THREE.Vector3): SkyState {
    const S = this.params.sky;
    this.time = (this.time + (dt * this.timeScale) / S.dayLength) % 1;
    const a = (this.time - 0.25) * Math.PI * 2;
    const sun = this.state.sunDir.set(Math.cos(a), Math.sin(a), S.tilt).normalize();
    this.uniforms.uSun.value.copy(sun);
    if (S.sun2) {
      const a2 = a + S.sun2.offset;
      this.uniforms.uSun2.value.set(Math.cos(a2), Math.sin(a2), S.tilt * 1.3 - 0.2).normalize();
    }
    const day = smoothstep(-0.18, 0.12, sun.y);
    this.state.day = day;
    this.uniforms.uDay.value = day;
    this.uniforms.uTime.value = elapsed;
    this.mesh.position.copy(camPos);

    // Light colours derived from the sky palette
    const sunCol = col(S.sunColor);
    const sunset = col(S.sunset);
    const warm = 1 - smoothstep(0.05, 0.4, sun.y);
    this.state.sunLight.copy(sunCol).lerp(sunset, warm * 0.7).multiplyScalar(3.2 * smoothstep(-0.05, 0.12, sun.y));
    const zen = col(S.zenith).lerp(col(S.nightZenith), 1 - day);
    const hor = col(S.horizon).lerp(col(S.nightHorizon), 1 - day);
    this.state.skyAmbient.copy(zen).lerp(hor, 0.4).multiplyScalar(0.55 + 0.6 * day);
    this.state.groundAmbient.copy(hor).multiplyScalar(0.25 * day + 0.03);
    this.state.fog.copy(hor).lerp(sunset, warm * day * 0.35);
    // Night is dark but never pitch black: the gas giant and ring reflect light.
    const nightFill = (1 - day) * (0.1 + (S.planet ? 0.08 : 0) + (S.ring ? 0.06 : 0));
    this.state.skyAmbient.add(new THREE.Color(0.35, 0.4, 0.6).multiplyScalar(nightFill));
    return this.state;
  }

  setUnderground(k: number, fog: THREE.Color): void {
    this.uniforms.uUnder.value = clamp(k, 0, 1);
    this.uniforms.uUnderFog.value.copy(fog);
  }
}
