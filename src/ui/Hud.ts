import { TOOLS, ToolId } from '../player/Tools';

const TOOL_INFO: Record<ToolId, { name: string; icon: string; hint: string }> = {
  dig: { name: 'Excavate', icon: '⛏', hint: 'LMB dig · RMB fill · wheel size' },
  build: { name: 'Shape', icon: '◆', hint: 'LMB raise · RMB dig · wheel size' },
  blast: { name: 'Charge', icon: '✹', hint: 'LMB detonate at target' },
  scan: { name: 'Scanner', icon: '◎', hint: 'LMB identify' },
};

export interface HudState {
  place: string;
  sub: string;
  pos: [number, number, number];
  gravity: number;
  gravityRel: number;
  time: string;
  tool: ToolId;
  radius: number;
  fuel: number;
  fly: boolean;
  heading: number;
  markers: { bearing: number; dist: number; label: string; color: string }[];
  stats?: string;
}

/** DOM overlay: status panel, compass, toolbar, notifications and help. */
export class Hud {
  readonly root: HTMLDivElement;
  private status: HTMLDivElement;
  private compass: HTMLDivElement;
  private toolbar: HTMLDivElement;
  private toasts: HTMLDivElement;
  private scanLine: HTMLDivElement;
  private stats: HTMLDivElement;
  private help: HTMLDivElement;
  private fuel: HTMLDivElement;
  private scanTimer = 0;
  private last = '';

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <div id="status"></div>
      <div id="compass"><div class="strip"></div><div class="needle"></div></div>
      <div id="crosshair"></div>
      <div id="toasts"></div>
      <div id="scanline"></div>
      <div id="toolbar"></div>
      <div id="fuel"><div></div></div>
      <div id="stats"></div>
      <div id="help" class="hidden">
        <h2>Field manual</h2>
        <div class="cols">
          <div>
            <p><b>WASD</b> move · <b>Shift</b> sprint</p>
            <p><b>Space</b> jump · hold in air for jetpack</p>
            <p><b>V</b> toggle flight · <b>Space/C</b> up/down</p>
            <p><b>1–4 / Q E</b> choose tool</p>
            <p><b>LMB / RMB</b> use tool · <b>wheel</b> size</p>
            <p><b>F</b> throw a charge anywhere</p>
          </div>
          <div>
            <p><b>M</b> map (double-click to travel)</p>
            <p><b>L</b> lamp · <b>T</b> hold to speed up time</p>
            <p><b>G</b> graphics quality · <b>F3</b> stats</p>
            <p><b>H</b> this manual · <b>Esc</b> release mouse</p>
          </div>
        </div>
        <p class="tip">Gravity is not constant here. Pale shimmering regions are levitation fields — jump. Moonlets have their own pull; walk around them. Lift wells carry you skyward. Sinkholes lead down to the underworld, where the ${'<i>deep dwellers</i>'} live.</p>
      </div>`;
    this.status = this.root.querySelector('#status')!;
    this.compass = this.root.querySelector('#compass .strip')!;
    this.toolbar = this.root.querySelector('#toolbar')!;
    this.toasts = this.root.querySelector('#toasts')!;
    this.scanLine = this.root.querySelector('#scanline')!;
    this.stats = this.root.querySelector('#stats')!;
    this.help = this.root.querySelector('#help')!;
    this.fuel = this.root.querySelector('#fuel')!;
    this.toolbar.innerHTML = TOOLS.map((t, i) => `<div class="tool" data-tool="${t}"><span class="key">${i + 1}</span><span class="icon">${TOOL_INFO[t].icon}</span><span class="name">${TOOL_INFO[t].name}</span></div>`).join('') + `<div class="hint"></div>`;
  }

  toggleHelp(force?: boolean): void {
    this.help.classList.toggle('hidden', force === undefined ? undefined : !force);
  }

  toggleStats(): void {
    this.stats.classList.toggle('show');
  }

  toast(title: string, sub = '', color = '#cfe8ff'): void {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<div class="t" style="color:${color}">${title}</div>${sub ? `<div class="s">${sub}</div>` : ''}`;
    this.toasts.appendChild(el);
    setTimeout(() => el.classList.add('out'), 4200);
    setTimeout(() => el.remove(), 5200);
  }

  scan(text: string): void {
    this.scanLine.textContent = text;
    this.scanLine.classList.add('show');
    this.scanTimer = 5;
  }

  update(s: HudState, dt: number): void {
    this.scanTimer -= dt;
    if (this.scanTimer <= 0) this.scanLine.classList.remove('show');
    const alt = s.pos[1];
    const html = `
      <div class="place">${s.place}</div>
      <div class="sub">${s.sub}</div>
      <div class="row"><span>POS</span>${s.pos[0].toFixed(0)}, ${s.pos[2].toFixed(0)}</div>
      <div class="row"><span>${alt >= 0 ? 'ALT' : 'DEPTH'}</span>${Math.abs(alt).toFixed(0)} m</div>
      <div class="row"><span>GRAV</span>${s.gravity.toFixed(2)} m/s² <em>${s.gravityRel.toFixed(2)}×</em>${s.fly ? ' <b class="fly">FLIGHT</b>' : ''}</div>
      <div class="row"><span>TIME</span>${s.time}</div>`;
    if (html !== this.last) {
      this.status.innerHTML = html;
      this.last = html;
    }
    // Compass: 1 degree = 4px
    const pxPerRad = 240 / Math.PI * 1.5;
    const items: string[] = [];
    const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    for (let i = 0; i < 8; i++) {
      const b = (i / 8) * Math.PI * 2;
      const d = wrap(b - s.heading);
      if (Math.abs(d) > 1.6) continue;
      items.push(`<span class="dir ${i % 2 ? 'minor' : ''}" style="left:${d * pxPerRad}px">${labels[i]}</span>`);
    }
    for (const m of s.markers) {
      const d = wrap(m.bearing - s.heading);
      if (Math.abs(d) > 1.6) continue;
      items.push(`<span class="mark" style="left:${d * pxPerRad}px;color:${m.color}">◆<i>${m.label} · ${m.dist >= 1000 ? (m.dist / 1000).toFixed(1) + 'km' : m.dist.toFixed(0) + 'm'}</i></span>`);
    }
    this.compass.innerHTML = items.join('');
    for (const el of this.toolbar.querySelectorAll<HTMLDivElement>('.tool')) el.classList.toggle('active', el.dataset.tool === s.tool);
    const hint = this.toolbar.querySelector('.hint') as HTMLDivElement;
    hint.textContent = TOOL_INFO[s.tool].hint + (s.tool === 'dig' || s.tool === 'build' ? ` · radius ${s.radius.toFixed(1)} m` : '');
    (this.fuel.firstElementChild as HTMLDivElement).style.width = `${s.fuel * 100}%`;
    this.fuel.classList.toggle('full', s.fuel >= 0.999);
    if (s.stats) this.stats.textContent = s.stats;
  }
}

function wrap(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
