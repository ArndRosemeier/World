// Deterministic hashing and seeded random numbers.
// Everything in the world derives from these, so the same seed always yields the same world
// on the main thread and inside workers.

function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash up to four integers into a well mixed unsigned 32 bit value. */
export function hash4(a: number, b = 0, c = 0, d = 0): number {
  let h = mix32((a | 0) ^ 0x9e3779b9);
  h = mix32(h ^ (b | 0));
  h = mix32((h + (c | 0)) | 0);
  h = mix32(h ^ Math.imul(d | 0, 0x632be5ab));
  return h;
}

/** Hash to a float in [0, 1). */
export function hash01(a: number, b = 0, c = 0, d = 0): number {
  return hash4(a, b, c, d) / 4294967296;
}

export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mix32(h);
}

/** Small, fast, seedable PRNG (mulberry32) with convenience helpers. */
export class RNG {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x1234567;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  /** Weighted pick; weights need not be normalised. */
  weighted<T>(arr: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }
  normal(): number {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  /** Derive an independent stream, so adding draws in one subsystem never shifts another. */
  fork(tag: string | number): RNG {
    const t = typeof tag === 'number' ? tag : hashString(tag);
    return new RNG(hash4(this.s, t, 0x51ed270b));
  }
}
