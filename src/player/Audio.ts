/** Small synthesized sound set; nothing to download, everything generated with WebAudio. */
export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private wind: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  private hum: { gain: GainNode; osc: OscillatorNode } | null = null;
  volume = 0.6;

  /** Must be called from a user gesture. */
  start(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) {
      b = 0.98 * b + 0.02 * (Math.random() * 2 - 1);
      d[i] = (Math.random() * 2 - 1) * 0.5 + b * 4;
    }
    // Ambient wind bed
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    const gain = ctx.createGain();
    gain.gain.value = 0.05;
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    this.wind = { gain, filter };
    // Underground drone
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 55;
    const hg = ctx.createGain();
    hg.gain.value = 0;
    osc.connect(hg).connect(this.master);
    osc.start();
    this.hum = { gain: hg, osc };
  }

  setAmbience(windStrength: number, underground: number, altitude: number): void {
    if (!this.ctx || !this.wind || !this.hum) return;
    const t = this.ctx.currentTime;
    this.wind.gain.gain.setTargetAtTime(0.03 + windStrength * 0.08 * (1 - underground), t, 0.5);
    this.wind.filter.frequency.setTargetAtTime(250 + altitude * 1.5 + windStrength * 300, t, 0.5);
    this.hum.gain.gain.setTargetAtTime(underground * 0.05, t, 1);
    this.hum.osc.frequency.setTargetAtTime(48 + underground * 10, t, 1);
  }

  private burst(dur: number, freq: number, q: number, gain: number, type: BiquadFilterType = 'lowpass', sweep = 0.3): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, freq * sweep), t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', slide = 1): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  dig(): void {
    this.burst(0.18, 900 + Math.random() * 400, 1.5, 0.35, 'bandpass', 0.4);
  }

  build(): void {
    this.burst(0.15, 400, 2, 0.3, 'lowpass', 0.6);
    this.tone(180, 0.12, 0.08, 'triangle', 0.7);
  }

  blast(distance: number): void {
    const k = 1 / (1 + distance / 40);
    this.burst(2.2, 600, 0.7, 1.2 * k, 'lowpass', 0.05);
    this.tone(70, 1.2, 0.5 * k, 'sine', 0.4);
  }

  step(): void {
    this.burst(0.07, 300 + Math.random() * 200, 1, 0.08, 'lowpass', 0.5);
  }

  chirp(): void {
    const f = 600 + Math.random() * 900;
    this.tone(f, 0.25, 0.06, 'sine', 1.6);
    setTimeout(() => this.tone(f * 1.3, 0.2, 0.05, 'sine', 0.8), 120);
  }

  ui(): void {
    this.tone(880, 0.08, 0.05, 'sine', 1.5);
  }
}
