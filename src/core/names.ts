import { RNG } from './rng';

/**
 * A tiny procedural "language". Each world seed gets its own phoneme inventory and syllable
 * structure, so names within one world sound related while different seeds sound foreign
 * to each other.
 */
export class Language {
  private onsets: string[];
  private nuclei: string[];
  private codas: string[];
  private joiner: string;
  private minSyl: number;
  private maxSyl: number;
  readonly glyphSeed: number;

  constructor(rng: RNG) {
    const consonantPool = ['k', 'th', 'v', 'z', 'r', 'l', 'sh', 'x', 'q', 'm', 'n', 'ph', 'dr', 'gl', 'tl', 'kr', 'vr', 'ss', 'y', 'h', 'b', 'd', 'g', 'tz', 'ch', 'zh', 'w', 'p', "k'", "t'"];
    const vowelPool = ['a', 'e', 'i', 'o', 'u', 'aa', 'ei', 'ou', 'ae', 'y', 'ia', 'uu', 'oe', 'ai', 'ö', 'ä', 'ī', 'ū'];
    const codaPool = ['', '', '', 'n', 'th', 'r', 'l', 'x', 'k', 'sh', 'm', 's', 'q', 'z', 'rn', 'lk'];
    this.onsets = rng.shuffle([...consonantPool]).slice(0, rng.int(7, 13));
    this.nuclei = rng.shuffle([...vowelPool]).slice(0, rng.int(4, 7));
    this.codas = rng.shuffle([...codaPool]).slice(0, rng.int(3, 7));
    this.joiner = rng.pick(['', '', '', "'", '-']);
    this.minSyl = rng.int(1, 2);
    this.maxSyl = this.minSyl + rng.int(1, 2);
    this.glyphSeed = Math.floor(rng.next() * 1e9);
  }

  syllable(rng: RNG): string {
    const onset = rng.chance(0.85) ? rng.pick(this.onsets) : '';
    return onset + rng.pick(this.nuclei) + (rng.chance(0.45) ? rng.pick(this.codas) : '');
  }

  word(rng: RNG, minSyl = this.minSyl, maxSyl = this.maxSyl): string {
    const n = rng.int(minSyl, maxSyl);
    let w = '';
    for (let i = 0; i < n; i++) {
      if (i > 0 && this.joiner && rng.chance(0.3)) w += this.joiner;
      w += this.syllable(rng);
    }
    return w.charAt(0).toUpperCase() + w.slice(1);
  }

  name(rng: RNG): string {
    return rng.chance(0.25) ? `${this.word(rng)} ${this.word(rng, 1, 2)}` : this.word(rng);
  }
}
