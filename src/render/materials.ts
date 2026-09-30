import * as THREE from 'three';

// ---------------------------------------------------------------------------------------------
// Materials are three.js standard materials extended through onBeforeCompile, so they keep
// PBR lighting, shadows and fog while adding: baked sky occlusion (caves go dark), underworld
// ambient glow, the player's lamp, procedural surface detail, wind and emission.
// ---------------------------------------------------------------------------------------------

export const shared = {
  uTime: { value: 0 },
  uLampView: { value: new THREE.Vector3() },
  uLampColor: { value: new THREE.Color(0, 0, 0) },
  uLampRange: { value: 22 },
  uUnderAmbient: { value: new THREE.Color(0.1, 0.05, 0.15) },
  uCaveAmbient: { value: new THREE.Color(0.012, 0.012, 0.016) },
  uEmitBoost: { value: 1 },
  uWind: { value: new THREE.Vector2(1, 0.3) },
  uSkyColor: { value: new THREE.Color(0.5, 0.6, 0.8) },
  uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
};

export const NOISE_GLSL = /* glsl */ `
float xh13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(xh13(i), xh13(i + vec3(1,0,0)), f.x), mix(xh13(i + vec3(0,1,0)), xh13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(xh13(i + vec3(0,0,1)), xh13(i + vec3(1,0,1)), f.x), mix(xh13(i + vec3(0,1,1)), xh13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
`;

const LIGHT_UNIFORMS = /* glsl */ `
uniform float uTime;
uniform vec3 uLampView;
uniform vec3 uLampColor;
uniform float uLampRange;
uniform vec3 uUnderAmbient;
uniform vec3 uCaveAmbient;
uniform float uEmitBoost;
`;

/** Applies sky occlusion, underworld ambient and the player lamp to reflectedLight. */
const LIGHT_PATCH = /* glsl */ `
{
  float skyV = clamp(vSkyV, 0.0, 1.0);
  float sunV = smoothstep(0.02, 0.6, skyV);
  reflectedLight.directDiffuse *= sunV;
  reflectedLight.directSpecular *= sunV;
  reflectedLight.indirectDiffuse *= (skyV * 0.97 + 0.03) * vAOV;
  reflectedLight.indirectSpecular *= skyV;
  float under = 1.0 - smoothstep(-245.0, -185.0, vWPos.y);
  vec3 alb = diffuseColor.rgb;
  reflectedLight.indirectDiffuse += alb * (uUnderAmbient * under + uCaveAmbient * (1.0 - skyV)) * vAOV;
  vec3 lp = uLampView + vViewPosition;
  float ld = length(lp);
  vec3 L = lp / max(ld, 1e-3);
  float att = 1.0 - clamp(ld / uLampRange, 0.0, 1.0);
  att *= att;
  float ndl = max(dot(normal, L), 0.0) * 0.85 + 0.15;
  reflectedLight.directDiffuse += alb * uLampColor * ndl * att;
}
`;

function patchCommon(shader: THREE.WebGLProgramParametersWithUniforms): void {
  Object.assign(shader.uniforms, shared);
}

// --- Terrain ---------------------------------------------------------------------------------

export function createTerrainMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.0 });
  m.onBeforeCompile = (shader) => {
    patchCommon(shader);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aColor;
attribute vec4 aEmit;
varying vec4 vCol;
varying vec3 vEm;
varying float vSkyV;
varying float vAOV;
varying vec3 vWPos;
varying vec3 vWNorm;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vCol = aColor;
vEm = aEmit.rgb;
vSkyV = aEmit.a;
vAOV = aColor.a;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNorm = normal;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
${LIGHT_UNIFORMS}
${NOISE_GLSL}
varying vec4 vCol;
varying vec3 vEm;
varying float vSkyV;
varying float vAOV;
varying vec3 vWPos;
varying vec3 vWNorm;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float camDist = length(vViewPosition);
float fineFade = 1.0 - smoothstep(25.0, 110.0, camDist);
float macro = vnoise(vWPos * 0.043) * 0.6 + vnoise(vWPos * 0.011) * 0.4;
float fine = vnoise(vWPos * 0.9) * 0.6 + vnoise(vWPos * 3.3) * 0.4;
vec3 alb = pow(max(vCol.rgb, vec3(0.0)), vec3(2.2));
alb *= 0.82 + 0.36 * macro;
alb *= 1.0 + (fine - 0.5) * 0.35 * fineFade;
diffuseColor.rgb *= alb;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  float bumpH = (vnoise(vWPos * 1.7) * 0.6 + vnoise(vWPos * 5.1) * 0.25 + vnoise(vWPos * 0.45) * 1.2) * fineFade;
  vec3 dpdx = dFdx(-vViewPosition);
  vec3 dpdy = dFdy(-vViewPosition);
  float hx = dFdx(bumpH);
  float hy = dFdy(bumpH);
  vec3 r1 = cross(dpdy, normal);
  vec3 r2 = cross(normal, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (hx * r1 + hy * r2);
  vec3 bn = abs(det) * normal - grad * 0.22;
  if (dot(bn, bn) > 1e-20 && abs(det) > 1e-12) normal = normalize(bn);
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  vec3 em = vEm * 2.0;
  float pulse = 0.85 + 0.15 * sin(uTime * 1.3 + dot(vWPos, vec3(0.11, 0.07, 0.13)));
  totalEmissiveRadiance += em * em * 1.3 * uEmitBoost * pulse;
}`,
      )
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${LIGHT_PATCH}`);
  };
  m.customProgramCacheKey = () => 'terrain-v1';
  return m;
}

// --- Liquids ---------------------------------------------------------------------------------

export function createLiquidMaterial(color: THREE.Color, glow: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.08,
    metalness: 0.1,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    emissive: color.clone().multiplyScalar(glow),
  });
  m.onBeforeCompile = (shader) => {
    patchCommon(shader);
    shader.uniforms.uGlow = { value: glow };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aDepth;\nvarying float vDepth;\nvarying vec3 vWPos;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vDepth = aDepth;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
transformed.y += (sin(vWPos.x * 0.21 + uTime * 1.1) + sin(vWPos.z * 0.17 - uTime * 0.9)) * 0.12;`,
      )
      .replace('#include <common>', `#include <common>\nuniform float uTime;`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
${LIGHT_UNIFORMS}
${NOISE_GLSL}
uniform vec3 uSkyColor;
uniform float uGlow;
varying float vDepth;
varying vec3 vWPos;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  vec2 p = vWPos.xz;
  float t = uTime;
  float h = vnoise(vec3(p * 0.35 + vec2(t * 0.3, t * 0.2), t * 0.2)) * 0.6 + vnoise(vec3(p * 1.3 - vec2(t * 0.5, -t * 0.4), t * 0.4)) * 0.3;
  vec3 dpdx = dFdx(-vViewPosition);
  vec3 dpdy = dFdy(-vViewPosition);
  vec3 r1 = cross(dpdy, normal);
  vec3 r2 = cross(normal, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  vec3 bn = abs(det) * normal - grad * 0.6;
  if (dot(bn, bn) > 1e-20 && abs(det) > 1e-12) normal = normalize(bn);
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float shallow = 1.0 - smoothstep(0.0, 6.0, vDepth);
diffuseColor.a = mix(0.93, 0.35, shallow);
diffuseColor.rgb = mix(diffuseColor.rgb * 0.55, diffuseColor.rgb * 1.3, shallow * 0.7);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float fres = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 4.0);
  totalEmissiveRadiance += uSkyColor * fres * 0.5 * (1.0 - uGlow);
  float veins = smoothstep(0.62, 0.75, vnoise(vec3(vWPos.xz * 0.08, uTime * 0.15)));
  totalEmissiveRadiance *= (0.6 + 0.9 * veins) * (uGlow > 0.0 ? 1.6 : 1.0);
  float foam = (1.0 - smoothstep(0.0, 1.2, vDepth)) * (0.5 + 0.5 * sin(uTime * 2.0 + vWPos.x * 0.6));
  totalEmissiveRadiance += vec3(foam) * 0.15;
}`,
      );
  };
  m.customProgramCacheKey = () => 'liquid-v1';
  return m;
}

// --- Flora (instanced) -----------------------------------------------------------------------

/**
 * Flora geometry carries vertex colour (sRGB), aWind (sway weight) and aGlow (emission).
 * Instances carry a tint (instanceColor) and aInst = (sky, phase, glowMul, unused).
 */
export function createFloraMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0, vertexColors: true, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    patchCommon(shader);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform vec2 uWind;
attribute float aWind;
attribute float aGlow;
attribute vec4 aInst;
varying float vSkyV;
varying float vAOV;
varying float vGlow;
varying vec3 vWPos;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  float ph = aInst.y + dot(ip, vec3(0.05, 0.0, 0.07));
  float gust = 0.6 + 0.4 * sin(uTime * 0.35 + ip.x * 0.013 + ip.z * 0.011);
  float sway = aWind * gust;
  transformed.x += sway * (sin(uTime * 1.7 + ph) * 0.6 + sin(uTime * 3.1 + ph * 1.7) * 0.25) * uWind.x;
  transformed.z += sway * (cos(uTime * 1.3 + ph * 1.3) * 0.5) * uWind.y;
  vSkyV = aInst.x;
  vAOV = 1.0;
  vGlow = aGlow * aInst.z;
}`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
${LIGHT_UNIFORMS}
varying float vSkyV;
varying float vAOV;
varying float vGlow;
varying vec3 vWPos;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
diffuseColor.rgb = pow(max(diffuseColor.rgb, vec3(0.0)), vec3(2.2));`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * vGlow * 1.6 * uEmitBoost * (0.8 + 0.2 * sin(uTime * 2.0 + vWPos.x));`,
      )
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${LIGHT_PATCH}`);
  };
  m.customProgramCacheKey = () => 'flora-v1';
  return m;
}

// --- Instanced primitives (creatures, buildings, debris) -------------------------------------

/**
 * Per instance: instanceColor = base colour (sRGB), aP = (pattern, frequency, emission, sky),
 * aC2 = secondary pattern colour.
 */
export function createPrimitiveMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.05, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    patchCommon(shader);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aP;
attribute vec3 aC2;
varying vec4 vP;
varying vec3 vC2;
varying vec3 vLocal;
varying float vSkyV;
varying float vAOV;
varying vec3 vWPos;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vP = aP;
vC2 = aC2;
vLocal = position;
vSkyV = aP.w;
vAOV = 1.0;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
${LIGHT_UNIFORMS}
${NOISE_GLSL}
varying vec4 vP;
varying vec3 vC2;
varying vec3 vLocal;
varying float vSkyV;
varying float vAOV;
varying vec3 vWPos;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float patMask = 0.0;
{
  float pt = vP.x;
  float fq = vP.y;
  if (pt > 0.5 && pt < 1.5) patMask = smoothstep(0.35, 0.5, abs(fract(vLocal.z * fq * 0.5 + vnoise(vLocal * 3.0) * 0.4) - 0.5) * 2.0);
  else if (pt > 1.5 && pt < 2.5) patMask = smoothstep(0.62, 0.7, vnoise(vLocal * fq * 1.3));
  else if (pt > 2.5 && pt < 3.5) patMask = smoothstep(0.4, 0.6, fract(vLocal.y * fq * 0.5));
  else if (pt > 3.5) patMask = smoothstep(0.55, 0.65, vnoise(vLocal * fq + vec3(0.0, uTime * 0.3, 0.0)));
}
vec3 baseC = pow(max(diffuseColor.rgb, vec3(0.0)), vec3(2.2));
vec3 c2 = pow(max(vC2, vec3(0.0)), vec3(2.2));
diffuseColor.rgb = mix(baseC, c2, patMask);
diffuseColor.rgb *= 0.9 + 0.2 * vnoise(vLocal * 7.0);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float em = vP.z;
  vec3 ec = em > 1.5 ? diffuseColor.rgb : mix(diffuseColor.rgb, c2, patMask) * mix(0.25, 1.0, patMask);
  totalEmissiveRadiance += ec * (em > 1.5 ? em - 1.0 : em) * 2.5 * uEmitBoost;
}`,
      )
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${LIGHT_PATCH}`);
  };
  m.customProgramCacheKey = () => 'prim-v1';
  return m;
}
