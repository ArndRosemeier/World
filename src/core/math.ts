export type Vec3 = [number, number, number];
export type RGB = [number, number, number];

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const saturate = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, x: number) => (x - a) / (b - a);

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Polynomial smooth minimum (union) with blend radius k. */
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = saturate(0.5 + (0.5 * (b - a)) / k);
  return lerp(b, a, h) - k * h * (1 - h);
}

/** Polynomial smooth maximum (intersection / subtraction). */
export function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

export function hsl(h: number, s: number, l: number): RGB {
  h = ((h % 1) + 1) % 1;
  s = saturate(s);
  l = saturate(l);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

export function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function scaleRGB(a: RGB, k: number): RGB {
  return [a[0] * k, a[1] * k, a[2] * k];
}

export function rgbToHex(c: RGB): number {
  const f = (x: number) => clamp(Math.round(x * 255), 0, 255);
  return (f(c[0]) << 16) | (f(c[1]) << 8) | f(c[2]);
}

export function rgbCss(c: RGB): string {
  return '#' + rgbToHex(c).toString(16).padStart(6, '0');
}
