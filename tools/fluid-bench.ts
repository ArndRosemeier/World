// Headless water benchmark: dig a basin next to the sea and measure how it fills.
import { createWorldParams } from '../src/world/WorldParams';
import { Terrain } from '../src/world/Terrain';
import { EditStore } from '../src/world/Edits';
import { FluidSim } from '../src/water/FluidSim';

const P = createWorldParams('lumen-tide-42');
const T = new Terrain(P);
// Find a shoreline: land column with sea 20 m away
let shore: { x: number; z: number; dx: number; dz: number } | null = null;
const c = { h: 0 } as any;
outer: for (let r = 100; r < 3000; r += 15)
  for (let a = 0; a < Math.PI * 2; a += 0.08) {
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = T.columnAt(x, z).h;
    if (h < 1.5 || h > 4) continue;
    for (let b = 0; b < Math.PI * 2; b += 0.4) {
      if (T.columnAt(x + Math.cos(b) * 20, z + Math.sin(b) * 20).h < -3) {
        shore = { x, z, dx: Math.cos(b), dz: Math.sin(b) };
        break outer;
      }
    }
  }
if (!shore) throw new Error('no shore');
const edits = new EditStore();
const sim = new FluidSim(T, edits, P);
sim.focus = { x: shore.x, y: 0, z: shore.z };
sim.focusKnown = true;
// Channel from the sea into a 12 m wide basin inland, 4 m below sea level
const dig = (x: number, y: number, z: number, r: number) => { edits.add(x, y, z, r, 1); sim.onEdit(x, y, z, r); };
for (let t = 20; t >= -10; t -= 1.5) dig(shore.x + shore.dx * t, -2, shore.z + shore.dz * t, 2.4);
const bx = shore.x - shore.dx * 22, bz = shore.z - shore.dz * 22;
for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) dig(bx + i * 3, -2.5, bz + j * 3, 3);
for (let t = -10; t >= -22; t -= 1.5) dig(shore.x + shore.dx * t, -2, shore.z + shore.dz * t, 2.4);

// Measure water in the basin (non-source cells within 9 m of its centre)
function basinWater(): number {
  let m = 0;
  for (let x = Math.floor(bx - 9); x <= bx + 9; x++)
    for (let z = Math.floor(bz - 9); z <= bz + 9; z++)
      for (let y = -8; y < 1; y++) {
        const ch = sim.chunks.get(FluidSim.key(Math.floor(x / 16), Math.floor(y / 16), Math.floor(z / 16)));
        if (!ch) continue;
        const i = (x - ch.cx * 16) + 16 * ((y - ch.cy * 16) + 16 * (z - ch.cz * 16));
        if (ch.kind[i] === 0) m += ch.mass[i];
      }
  return m;
}
let air = 0;
for (let x = Math.floor(bx - 9); x <= bx + 9; x++) for (let z = Math.floor(bz - 9); z <= bz + 9; z++) for (let y = -8; y < 0; y++) {
  const ch = sim.chunks.get(FluidSim.key(Math.floor(x / 16), Math.floor(y / 16), Math.floor(z / 16)));
  if (ch && ch.kind[(x - ch.cx * 16) + 16 * ((y - ch.cy * 16) + 16 * (z - ch.cz * 16))] === 0) air++;
}
console.log('shore', shore, 'basin air cells below sea level:', air, 'chunks', sim.chunks.size);
let t0 = performance.now();
for (let s = 1; s <= 1200; s++) {
  sim.processCreates(8);
  sim.step();
  if (s % 100 === 0) console.log(`step ${s}  basin water ${basinWater().toFixed(1)} / ${air}  awake ${sim.awakeCount}/${sim.chunks.size}  ${((performance.now() - t0) / 100).toFixed(1)} ms/step`), (t0 = performance.now());
}
