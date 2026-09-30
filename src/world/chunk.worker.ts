/// <reference lib="webworker" />
import { createWorldParams } from './WorldParams';
import { Column, Terrain } from './Terrain';
import { ChunkBuilder, ChunkJob, ChunkResult } from './ChunkBuilder';
import { clamp, lerp } from '../core/math';

declare const self: DedicatedWorkerGlobalScope;

let builder: ChunkBuilder | null = null;
let terrain: Terrain | null = null;

/** A square depth mask for the liquid renderer. */
export interface LiquidJob {
  id: number;
  x0: number;
  z0: number;
  size: number;
  res: number;
}

export interface MapJob {
  id: number;
  x0: number;
  z0: number;
  scale: number;
  w: number;
  h: number;
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    terrain = new Terrain(createWorldParams(msg.seed));
    builder = new ChunkBuilder(terrain);
    return;
  }
  if (msg.type === 'chunk') {
    const res = builder!.build(msg.job as ChunkJob);
    self.postMessage({ type: 'chunk', res }, transferables(res));
    return;
  }
  if (msg.type === 'map') {
    const job = msg.job as MapJob;
    const px = renderMap(job);
    self.postMessage({ type: 'map', id: job.id, job, px }, [px.buffer]);
    return;
  }
  if (msg.type === 'liquid') {
    const job = msg.job as LiquidJob;
    const px = renderLiquidMask(job);
    self.postMessage({ type: 'liquid', id: job.id, job, px }, [px.buffer]);
  }
};

/**
 * Liquid depth mask. R = depth of the sea (sea level minus ground), G = depth of underworld
 * lakes. Both are encoded as (depth + 16) * 2, i.e. -16..111 m in half-metre steps.
 */
function renderLiquidMask(job: LiquidJob): Uint8ClampedArray {
  const T = terrain!;
  const P = T.p;
  const out = new Uint8ClampedArray(job.res * job.res * 4);
  const c = new Column();
  const step = job.size / job.res;
  const s = Math.max(2, Math.min(16, step));
  const ul = P.under.liquidLevel;
  for (let j = 0; j < job.res; j++)
    for (let i = 0; i < job.res; i++) {
      const x = job.x0 + (i + 0.5) * step, z = job.z0 + (j + 0.5) * step;
      T.column(x, z, c, s);
      const sea = P.seaLevel - c.h;
      const lake = c.uOpen > 4 && c.uC > ul + 1 && c.h > ul + 30 ? ul - c.uF : -16;
      const o = (i + j * job.res) * 4;
      out[o] = (sea + 16) * 2;
      out[o + 1] = (lake + 16) * 2;
      out[o + 2] = 0;
      out[o + 3] = 255;
    }
  return out;
}

function transferables(r: ChunkResult): Transferable[] {
  const t: Transferable[] = [];
  if (r.positions) t.push(r.positions.buffer, r.normals!.buffer, r.colors!.buffer, r.emit!.buffer, r.indices!.buffer);
  if (r.props) t.push(r.props.buffer);
  return t;
}

/** Top-down relief map: biome colours, hill shading, water and frost. */
function renderMap(job: MapJob): Uint8ClampedArray {
  const T = terrain!;
  const P = T.p;
  const out = new Uint8ClampedArray(job.w * job.h * 4);
  const c = new Column();
  const heights = new Float32Array((job.w + 1) * (job.h + 1));
  const s = Math.max(4, job.scale * 2);
  for (let j = 0; j <= job.h; j++)
    for (let i = 0; i <= job.w; i++) {
      T.baseHeight(job.x0 + i * job.scale, job.z0 + j * job.scale, c, s);
      heights[i + j * (job.w + 1)] = c.cont < -0.2 ? c.cont * 170 : T.column(job.x0 + i * job.scale, job.z0 + j * job.scale, c, s).h;
    }
  const shadeOut = new Float32Array(6);
  for (let j = 0; j < job.h; j++)
    for (let i = 0; i < job.w; i++) {
      const x = job.x0 + i * job.scale, z = job.z0 + j * job.scale;
      const h = heights[i + j * (job.w + 1)];
      const hx = heights[i + 1 + j * (job.w + 1)], hz = heights[i + (j + 1) * (job.w + 1)];
      T.baseHeight(x, z, c, s);
      c.h = h;
      c.settle = 0;
      c.moR = 0;
      c.isR = 0;
      c.spR = 0;
      c.riR = 0;
      c.uC = -1e9;
      c.uF = -1e9;
      c.uOpen = -1;
      const nx = -(hx - h) / job.scale, nz = -(hz - h) / job.scale;
      const nl = Math.hypot(nx, 1, nz);
      T.shade(x, h, z, nx / nl, 1 / nl, nz / nl, c, shadeOut);
      let r = shadeOut[0], g = shadeOut[1], b = shadeOut[2];
      const light = clamp(0.75 + ((hx - h) * -0.6 + (hz - h) * -0.9) / job.scale, 0.35, 1.35);
      r *= light; g *= light; b *= light;
      if (h < P.seaLevel) {
        const d = clamp((P.seaLevel - h) / 60, 0, 1);
        r = lerp(P.liquid[0] * 1.2, P.liquid[0] * 0.45, d);
        g = lerp(P.liquid[1] * 1.2, P.liquid[1] * 0.45, d);
        b = lerp(P.liquid[2] * 1.2, P.liquid[2] * 0.45, d);
      }
      const lev = T.levitation(x, z);
      if (lev > 0.05) {
        r = lerp(r, 0.7, lev * 0.15);
        g = lerp(g, 0.8, lev * 0.15);
        b = lerp(b, 1.0, lev * 0.25);
      }
      const o = (i + j * job.w) * 4;
      out[o] = Math.pow(clamp(r, 0, 1), 1 / 1.6) * 255;
      out[o + 1] = Math.pow(clamp(g, 0, 1), 1 / 1.6) * 255;
      out[o + 2] = Math.pow(clamp(b, 0, 1), 1 / 1.6) * 255;
      out[o + 3] = 255;
    }
  return out;
}
