import './styles.css';
import { Game, Quality } from './Game';
import { createWorldParams } from './world/WorldParams';
import { rgbCss } from './core/math';

// ---------------------------------------------------------------------------------------------
// Entry point: a start screen that previews the world a seed will create, then hands over to
// the Game once the spawn area has streamed in.
// ---------------------------------------------------------------------------------------------

const WORDS = ['ember', 'drift', 'hollow', 'veil', 'lumen', 'shard', 'mire', 'aether', 'spore', 'tide', 'orbit', 'glass', 'rune', 'vast', 'deep', 'bloom'];

function randomSeed(): string {
  const w = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  return `${w()}-${w()}-${Math.floor(Math.random() * 1000)}`;
}

function preview(seed: string): string {
  const P = createWorldParams(seed);
  const swatch = (c: [number, number, number]) => `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${rgbCss(c)};margin:0 2px;vertical-align:-1px"></span>`;
  const biomes = P.biomes.slice(0, 4).map((b) => `${swatch(b.top)}${b.name}`).join(' · ');
  const civ = P.civs[0];
  return `World <b>${P.name}</b> · gravity <b>${P.gravity.toFixed(1)} m/s²</b> · ${P.sky.ring ? 'ringed' : 'ringless'}${P.sky.sun2 ? ', twin suns' : ''}<br>${biomes}<br>home of the <b>${civ.people}</b> (${civ.family} builders) and the deep-dwelling <b>${P.civs[1].people}</b>`;
}

const params = new URLSearchParams(location.search);
let stored: Quality | null = null;
try {
  stored = localStorage.getItem('xenoworld:quality') as Quality | null;
} catch {
  /* ignore */
}

const start = document.createElement('div');
start.id = 'start';
start.innerHTML = `
  <canvas class="stars"></canvas>
  <div class="card">
    <h1>XENOWORLD</h1>
    <div class="tag">an endless alien planet, grown from a single seed</div>
    <div class="row"><input id="seed" spellcheck="false" autocomplete="off" /><button id="rnd" title="Random seed">⟳</button></div>
    <div class="row">
      <select id="quality">
        <option value="low">Quality · Low</option>
        <option value="medium">Quality · Medium</option>
        <option value="high">Quality · High</option>
      </select>
    </div>
    <div class="preview"></div>
    <button class="go" id="go">DESCEND</button>
    <div class="progress"><div></div></div>
    <div class="status"></div>
    <div class="foot">Your digging and destruction are saved per seed in this browser.</div>
  </div>`;
document.body.appendChild(start);

const seedInput = start.querySelector<HTMLInputElement>('#seed')!;
const quality = start.querySelector<HTMLSelectElement>('#quality')!;
const previewEl = start.querySelector<HTMLDivElement>('.preview')!;
const go = start.querySelector<HTMLButtonElement>('#go')!;
seedInput.value = params.get('seed') ?? randomSeed();
quality.value = (params.get('q') as Quality) ?? stored ?? 'medium';
const refresh = () => (previewEl.innerHTML = preview(seedInput.value));
refresh();
seedInput.addEventListener('input', refresh);
start.querySelector('#rnd')!.addEventListener('click', () => {
  seedInput.value = randomSeed();
  refresh();
});
seedInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') go.click();
});

// Twinkling backdrop
const sc = start.querySelector<HTMLCanvasElement>('canvas.stars')!;
const stars = Array.from({ length: 220 }, () => ({ x: Math.random(), y: Math.random(), s: Math.random() * 1.6 + 0.2, p: Math.random() * 6 }));
let starsOn = true;
const drawStars = (t: number) => {
  if (!starsOn) return;
  sc.width = innerWidth;
  sc.height = innerHeight;
  const c = sc.getContext('2d')!;
  for (const s of stars) {
    c.globalAlpha = 0.35 + 0.35 * Math.sin(t * 0.001 * (1 + s.s) + s.p);
    c.fillStyle = '#dfe8ff';
    c.fillRect(s.x * sc.width, s.y * sc.height, s.s, s.s);
  }
  requestAnimationFrame(drawStars);
};
requestAnimationFrame(drawStars);

let game: Game | null = null;
let ready = false;
go.addEventListener('click', async () => {
  if (game) {
    if (!ready) return;
    starsOn = false;
    start.remove();
    game.begin();
    return;
  }
  const seed = seedInput.value.trim() || randomSeed();
  go.disabled = true;
  start.classList.add('loading');
  const bar = start.querySelector<HTMLDivElement>('.progress > div')!;
  const status = start.querySelector<HTMLDivElement>('.status')!;
  const url = new URL(location.href);
  url.searchParams.set('seed', seed);
  history.replaceState(null, '', url);
  try {
    localStorage.setItem('xenoworld:quality', quality.value);
  } catch {
    /* ignore */
  }
  game = new Game(seed, quality.value as Quality, document.getElementById('app')!);
  await game.prepare((k, msg) => {
    bar.style.width = `${Math.round(k * 100)}%`;
    status.textContent = msg;
  });
  status.textContent = '';
  go.disabled = false;
  go.textContent = 'ENTER';
  ready = true;
  if (params.has('auto')) go.click();
});

if (params.has('auto')) go.click();
