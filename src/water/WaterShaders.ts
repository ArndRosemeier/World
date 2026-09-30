import * as THREE from 'three';
import { NOISE_GLSL } from '../render/materials';

// ---------------------------------------------------------------------------------------------
// Shared lighting for all moving water (flowing surfaces, streams, waterfall curtains, pools).
// Game updates these once per frame.
// ---------------------------------------------------------------------------------------------

export const waterLight = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunColor: { value: new THREE.Color() },
  uSkyTop: { value: new THREE.Color() },
  uHorizon: { value: new THREE.Color() },
  uAmbient: { value: new THREE.Color() },
  uFogColor: { value: new THREE.Color() },
  uFogDensity: { value: 0 },
  uLampView: { value: new THREE.Vector3() },
};

const COMMON = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyTop;
uniform vec3 uHorizon;
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uColor;
uniform float uGlow;
uniform float uSky;
${NOISE_GLSL}
vec3 skyReflect(vec3 R) { return mix(uHorizon, uSkyTop, clamp(R.y * 1.6, 0.0, 1.0)); }
vec3 applyFog(vec3 c, float dist) { return mix(c, uFogColor, 1.0 - exp(-pow(uFogDensity * dist, 2.0))); }
`;

// --- Flowing water surfaces (simulation meshes, pools) ---------------------------------------

const FLOW_VERT = /* glsl */ `
attribute vec3 aFlow;
attribute float aFoam;
varying vec3 vW;
varying vec3 vN;
varying vec3 vFlow;
varying float vFoam;
uniform float uTime;
void main() {
  vec3 p = position;
  // Gentle bob on calm surfaces
  float calm = 1.0 - clamp(length(aFlow) * 4.0, 0.0, 1.0);
  p.y += (sin(p.x * 0.9 + uTime * 1.7) + sin(p.z * 1.1 - uTime * 1.3)) * 0.03 * calm * max(normal.y, 0.0);
  vW = (modelMatrix * vec4(p, 1.0)).xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vFlow = aFlow;
  vFoam = aFoam;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}
`;

const FLOW_FRAG = /* glsl */ `
${COMMON}
varying vec3 vW;
varying vec3 vN;
varying vec3 vFlow;
varying float vFoam;
void main() {
  vec3 V = normalize(cameraPosition - vW);
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  float speed = length(vFlow);
  vec3 fdir = speed > 1e-4 ? vFlow / speed : vec3(0.0);
  // Advect the ripple pattern along the flow (two phases blended to hide resets)
  float t = uTime;
  float ph = fract(t * 0.5);
  float ph2 = fract(t * 0.5 + 0.5);
  vec3 off1 = fdir * ph * (2.0 + speed * 12.0);
  vec3 off2 = fdir * ph2 * (2.0 + speed * 12.0);
  float w1 = abs(ph - 0.5) * 2.0;
  float n1 = vnoise(vW * 1.3 - off1 + vec3(0.0, t * 0.2, 0.0));
  float n2 = vnoise(vW * 1.3 - off2 + vec3(7.0, t * 0.2, 3.0));
  float n = mix(n1, n2, w1);
  float nx = vnoise((vW + vec3(0.3, 0.0, 0.0)) * 1.3 - off1);
  float nz = vnoise((vW + vec3(0.0, 0.0, 0.3)) * 1.3 - off1);
  N = normalize(N + vec3(n1 - nx, 0.0, n1 - nz) * (0.6 + speed * 2.0));

  float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
  vec3 R = reflect(-V, N);
  float sunUp = clamp(uSunDir.y * 3.0 + 0.2, 0.0, 1.0) * uSky;
  vec3 body = uColor * (uAmbient * (0.35 + 0.65 * uSky) + uSunColor * 0.15 * sunUp);
  vec3 refl = skyReflect(R) * uSky + uSunColor * pow(max(dot(R, uSunDir), 0.0), 300.0) * 20.0 * sunUp;
  vec3 col = mix(body, refl, fres * 0.9);

  // Foam from turbulence and falling water
  float foam = clamp(vFoam * (0.5 + n * 0.9) + smoothstep(0.7, 0.95, n) * vFoam, 0.0, 1.0);
  vec3 foamCol = uAmbient * (1.0 + uSky) + uSunColor * 0.25 * sunUp;
  col = mix(col, foamCol, foam * 0.8);
  float alpha = mix(0.72, 0.95, max(foam, fres));
  if (uGlow > 0.0) col += uColor * uGlow * (0.25 + 0.8 * smoothstep(0.55, 0.85, n));
  gl_FragColor = vec4(applyFog(col, length(cameraPosition - vW)), alpha);
}
`;

export function createFlowMaterial(color: THREE.Color, glow: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: FLOW_VERT,
    fragmentShader: FLOW_FRAG,
    uniforms: { ...waterLight, uColor: { value: color }, uGlow: { value: glow }, uSky: { value: 1 } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// --- Waterfall curtains and streams ----------------------------------------------------------

const FALL_VERT = /* glsl */ `
attribute vec2 aUv;      // u across (0..1), v = metres along the path
attribute float aFall;   // 0 = stream on the ground, 1 = free fall
attribute float aWidth;  // width in metres at this point
varying vec2 vUv;
varying float vFall;
varying float vWidth;
varying vec3 vW;
varying vec3 vN;
void main() {
  vUv = aUv;
  vFall = aFall;
  vWidth = aWidth;
  vW = (modelMatrix * vec4(position, 1.0)).xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}
`;

const FALL_FRAG = /* glsl */ `
${COMMON}
uniform float uSpeed;
varying vec2 vUv;
varying float vFall;
varying float vWidth;
varying vec3 vW;
varying vec3 vN;
void main() {
  float u = vUv.x;
  float v = vUv.y;
  float speed = mix(uSpeed * 0.35, uSpeed, vFall);
  // Long vertical streaks: high frequency across, low along the flow, scrolled downstream
  float across = u * vWidth;
  float s1 = vnoise(vec3(across * 1.1, (v - uTime * speed) * 0.09, uTime * 0.15));
  float s2 = vnoise(vec3(across * 3.3 + 5.0, (v - uTime * speed * 1.3) * 0.25, uTime * 0.3));
  float s3 = vnoise(vec3(across * 0.4 + 9.0, (v - uTime * speed * 0.8) * 0.03, 0.0));
  float streak = s1 * 0.55 + s2 * 0.3 + s3 * 0.35;
  // Ragged edges that break up further down the fall
  float edge = min(u, 1.0 - u) * 2.0;
  float rag = vnoise(vec3(across * 0.8, (v - uTime * speed) * 0.05, 1.0));
  float edgeMask = smoothstep(0.0, 0.35 + 0.3 * rag * vFall, edge);
  float foam = smoothstep(0.45, 0.85, streak) * mix(0.35, 1.0, vFall);
  // Sheets thin into spray with distance fallen
  float spray = vFall * smoothstep(20.0, 160.0, v);

  vec3 V = normalize(cameraPosition - vW);
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  float sunUp = clamp(uSunDir.y * 3.0 + 0.2, 0.0, 1.0) * uSky;
  float back = pow(max(dot(-V, uSunDir), 0.0), 4.0);
  vec3 water = uColor * (uAmbient * (0.5 + 0.5 * uSky) + uSunColor * (0.18 + 0.5 * back) * sunUp);
  vec3 white = uAmbient * (0.9 + 0.5 * uSky) + uSunColor * (0.26 + back * 0.5) * sunUp;
  vec3 R = reflect(-V, N);
  float fres = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), 4.0);
  vec3 col = mix(water, white, clamp(foam + vFall * 0.35, 0.0, 1.0));
  col += skyReflect(R) * fres * 0.25 * uSky * (1.0 - vFall);
  if (uGlow > 0.0) col += uColor * uGlow * (0.4 + streak);
  float alpha = edgeMask * mix(0.78, 0.55 + 0.4 * foam, vFall) * (1.0 - spray * 0.55);
  alpha *= smoothstep(0.0, 3.0, v);
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(applyFog(col, length(cameraPosition - vW)), alpha);
}
`;

export function createFallMaterial(color: THREE.Color, glow: number, speed: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: FALL_VERT,
    fragmentShader: FALL_FRAG,
    uniforms: { ...waterLight, uColor: { value: color }, uGlow: { value: glow }, uSky: { value: 1 }, uSpeed: { value: speed } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
