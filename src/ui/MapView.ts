import * as THREE from 'three';
import { WorkerPool } from '../world/WorkerPool';
import { SettlementManager } from '../civ/SettlementManager';
import { rgbCss } from '../core/math';

const TILE = 128;

/** Full-screen relief map rendered in the chunk workers, tile by tile. */
export class MapView {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tiles = new Map<string, HTMLCanvasElement | 'pending'>();
  private nextId = 1;
  scale = 4; // metres per pixel
  private center = new THREE.Vector2();
  private follow = true;
  open = false;
  onTravel: (x: number, z: number) => void = () => {};
  private drag: { x: number; y: number; cx: number; cz: number } | null = null;

  constructor(private pool: WorkerPool, private settlements: SettlementManager) {
    this.el = document.createElement('div');
    this.el.id = 'map';
    this.el.innerHTML = `<canvas></canvas><div class="map-legend">Drag to pan · wheel to zoom · <b>double-click</b> to travel · <b>M</b> close</div>`;
    this.canvas = this.el.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.scale = Math.min(64, Math.max(2, this.scale * (e.deltaY > 0 ? 2 : 0.5)));
    }, { passive: false });
    this.canvas.addEventListener('mousedown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, cx: this.center.x, cz: this.center.y };
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.drag) return;
      this.follow = false;
      this.center.set(this.drag.cx - (e.clientX - this.drag.x) * this.scale, this.drag.cz - (e.clientY - this.drag.y) * this.scale);
    });
    window.addEventListener('mouseup', () => (this.drag = null));
    this.canvas.addEventListener('dblclick', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const x = this.center.x + (e.clientX - r.left - r.width / 2) * this.scale;
      const z = this.center.y + (e.clientY - r.top - r.height / 2) * this.scale;
      this.onTravel(x, z);
    });
  }

  toggle(player: THREE.Vector3): void {
    this.open = !this.open;
    this.el.classList.toggle('open', this.open);
    if (this.open) {
      this.follow = true;
      this.center.set(player.x, player.z);
    }
  }

  private tile(tx: number, tz: number): HTMLCanvasElement | null {
    const key = `${this.scale}:${tx}:${tz}`;
    const t = this.tiles.get(key);
    if (t === 'pending') return null;
    if (t) return t;
    this.tiles.set(key, 'pending');
    const scale = this.scale;
    this.pool.requestMap({ id: this.nextId++, x0: tx * TILE * scale, z0: tz * TILE * scale, scale, w: TILE, h: TILE }, (px) => {
      const c = document.createElement('canvas');
      c.width = c.height = TILE;
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px), TILE, TILE), 0, 0);
      this.tiles.set(key, c);
    });
    return null;
  }

  draw(player: THREE.Vector3, heading: number): void {
    if (!this.open) return;
    const W = (this.canvas.width = this.canvas.clientWidth);
    const H = (this.canvas.height = this.canvas.clientHeight);
    const ctx = this.ctx;
    if (this.follow) this.center.set(player.x, player.z);
    ctx.fillStyle = '#07060c';
    ctx.fillRect(0, 0, W, H);
    const s = this.scale;
    const x0 = this.center.x - (W / 2) * s, z0 = this.center.y - (H / 2) * s;
    const tx0 = Math.floor(x0 / (TILE * s)), tx1 = Math.floor((x0 + W * s) / (TILE * s));
    const tz0 = Math.floor(z0 / (TILE * s)), tz1 = Math.floor((z0 + H * s) / (TILE * s));
    ctx.imageSmoothingEnabled = true;
    for (let tz = tz0; tz <= tz1; tz++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = this.tile(tx, tz);
        const px = (tx * TILE * s - x0) / s, pz = (tz * TILE * s - z0) / s;
        if (t) ctx.drawImage(t, px, pz, TILE + 0.5, TILE + 0.5);
        else {
          ctx.fillStyle = '#12101c';
          ctx.fillRect(px, pz, TILE, TILE);
        }
      }
    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    const gs = s < 8 ? 250 : s < 32 ? 1000 : 4000;
    for (let gx = Math.ceil(x0 / gs) * gs; gx < x0 + W * s; gx += gs) {
      ctx.beginPath();
      ctx.moveTo((gx - x0) / s, 0);
      ctx.lineTo((gx - x0) / s, H);
      ctx.stroke();
    }
    for (let gz = Math.ceil(z0 / gs) * gs; gz < z0 + H * s; gz += gs) {
      ctx.beginPath();
      ctx.moveTo(0, (gz - z0) / s);
      ctx.lineTo(W, (gz - z0) / s);
      ctx.stroke();
    }
    // Settlements
    const sites = this.settlements.sitesNear(this.center.x, this.center.y, Math.max(W, H) * s * 0.75);
    ctx.font = '600 12px Segoe UI, sans-serif';
    for (const site of sites) {
      const px = (site.x - x0) / s, pz = (site.z - z0) / s;
      const under = site.layer === 'under';
      ctx.fillStyle = rgbCss(site.civ.glow);
      ctx.strokeStyle = '#000';
      ctx.beginPath();
      if (under) ctx.arc(px, pz, 5, 0, Math.PI * 2);
      else {
        ctx.moveTo(px, pz - 7);
        ctx.lineTo(px + 6, pz);
        ctx.lineTo(px, pz + 7);
        ctx.lineTo(px - 6, pz);
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
      const loaded = [...this.settlements.settlements.values()].find((x) => x.site === site);
      const label = loaded ? loaded.name : under ? 'deep settlement' : 'settlement';
      ctx.fillStyle = under ? 'rgba(220,200,255,0.8)' : 'rgba(255,255,255,0.9)';
      ctx.fillText(label, px + 9, pz + 4);
    }
    // Player arrow
    const px = (player.x - x0) / s, pz = (player.z - z0) / s;
    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(heading);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
    // Scale bar
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    const bar = gs / s;
    ctx.fillRect(20, H - 30, bar, 3);
    ctx.fillText(`${gs >= 1000 ? gs / 1000 + ' km' : gs + ' m'}`, 20, H - 38);
  }
}
