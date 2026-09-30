import * as THREE from 'three';
import { RNG } from '../core/rng';
import { RGB, rgbCss } from '../core/math';

type Stroke = { kind: 'line' | 'arc' | 'dot'; a: number[] };

/**
 * A procedural writing system. Each world has its own set of glyphs, built from strokes
 * (lines, arcs, dots) on a small grid so they look like a coherent script.
 */
export class Script {
  readonly glyphs: Stroke[][] = [];

  constructor(seed: number, count = 28) {
    const r = new RNG(seed);
    const style = { curvy: r.next(), dots: r.next(), vertical: r.next() };
    for (let g = 0; g < count; g++) {
      const strokes: Stroke[] = [];
      const n = r.int(2, 4);
      for (let s = 0; s < n; s++) {
        const k = r.next();
        const P = () => [r.int(0, 2) / 2, r.int(0, 3) / 3];
        if (k < style.curvy * 0.6) {
          const [cx, cy] = P();
          strokes.push({ kind: 'arc', a: [cx, cy, r.range(0.2, 0.5), r.next() * Math.PI * 2, r.range(1.5, 4.5)] });
        } else if (k < 0.9 || style.dots < 0.3) {
          const [x0, y0] = P();
          let [x1, y1] = P();
          if (x0 === x1 && y0 === y1) y1 = 1 - y0;
          if (style.vertical > 0.6 && s === 0) {
            x1 = x0;
            [x1, y1] = [x0, 1];
          }
          strokes.push({ kind: 'line', a: [x0, y0, x1, y1] });
        } else {
          const [x, y] = P();
          strokes.push({ kind: 'dot', a: [x, y] });
        }
      }
      this.glyphs.push(strokes);
    }
  }

  draw(ctx: CanvasRenderingContext2D, glyph: number, x: number, y: number, size: number): void {
    const strokes = this.glyphs[glyph % this.glyphs.length];
    const w = size * 0.7, h = size;
    for (const s of strokes) {
      ctx.beginPath();
      if (s.kind === 'line') {
        ctx.moveTo(x + s.a[0] * w, y + s.a[1] * h);
        ctx.lineTo(x + s.a[2] * w, y + s.a[3] * h);
      } else if (s.kind === 'arc') {
        ctx.arc(x + s.a[0] * w, y + s.a[1] * h, s.a[2] * w, s.a[3], s.a[3] + s.a[4]);
      } else {
        ctx.arc(x + s.a[0] * w, y + s.a[1] * h, size * 0.06, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.stroke();
    }
  }

  /** A speech bubble texture with a random "sentence". */
  bubble(seed: number, color: RGB, exclaim = false): THREE.CanvasTexture {
    const r = new RNG(seed);
    const words = exclaim ? 1 : r.int(2, 4);
    const glyphs: number[][] = [];
    for (let i = 0; i < words; i++) {
      const w: number[] = [];
      const n = exclaim ? 2 : r.int(1, 4);
      for (let k = 0; k < n; k++) w.push(r.int(0, this.glyphs.length - 1));
      glyphs.push(w);
    }
    const size = 34;
    const total = glyphs.reduce((a, w) => a + w.length, 0) * size * 0.85 + (words - 1) * size * 0.5;
    const cw = Math.ceil(total + 48), ch = 84;
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgba(12, 10, 20, 0.72)';
    roundRect(ctx, 2, 2, cw - 4, ch - 18, 18);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cw / 2 - 9, ch - 17);
    ctx.lineTo(cw / 2, ch - 3);
    ctx.lineTo(cw / 2 + 9, ch - 17);
    ctx.fill();
    ctx.strokeStyle = ctx.fillStyle = exclaim ? '#ff6a4a' : rgbCss(color);
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 8;
    let x = 24;
    for (const w of glyphs) {
      for (const g of w) {
        this.draw(ctx, g, x, 16, size);
        x += size * 0.85;
      }
      x += size * 0.5;
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.userData.aspect = cw / ch;
    return tex;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
