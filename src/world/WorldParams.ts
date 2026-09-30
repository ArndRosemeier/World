import { RNG, hashString } from '../core/rng';
import { hsl, mixRGB, scaleRGB, RGB, clamp, Vec3 } from '../core/math';
import { Language } from '../core/names';

// ---------------------------------------------------------------------------------------------
// The world genome: a pure function of the seed that describes biomes, flora, fauna,
// civilisations, sky and physics. It contains no geometry, so it is cheap to build in every
// worker and guarantees identical results everywhere.
// ---------------------------------------------------------------------------------------------

export type Archetype = 'meadow' | 'fungal' | 'karst' | 'dunes' | 'ember' | 'coral' | 'pale' | 'forest' | 'badlands';

export type FloraKind =
  | 'tree' | 'shrub' | 'fungus' | 'giantfungus' | 'crystal' | 'grass' | 'bulb' | 'spiral' | 'fan'
  | 'rock' | 'pebble' | 'stalactite' | 'glowcap' | 'vine' | 'kelp' | 'bonetree' | 'lantern';

export type Habitat = 'surface' | 'cave' | 'ceiling' | 'under' | 'underCeiling' | 'seafloor';

export interface FloraDef {
  id: number;
  name: string;
  kind: FloraKind;
  habitat: Habitat;
  /** World-aligned candidate grid spacing in metres. */
  spacing: number;
  /** Probability per candidate cell (before biome density weighting). */
  prob: number;
  scaleMin: number;
  scaleMax: number;
  /** Highest LOD level whose chunks still spawn this species. */
  maxLevel: number;
  /** Minimum dot(normal, up) of the surface. */
  minUp: number;
  /** 0 = grows along gravity up, 1 = grows along the surface normal. */
  alignNormal: number;
  /** Fraction of the scale that is sunk into the ground. */
  sink: number;
  /** Collision radius and height at scale 1 (0 = walk-through). */
  collider: number;
  colliderHeight: number;
  wind: number;
  glow: number;
  variants: number;
  seed: number;
  colors: { a: RGB; b: RGB; c: RGB; glow: RGB };
  /** 0..1, how strongly placement follows a clumping noise field. */
  cluster: number;
  /** Extra params interpreted by the geometry generator. */
  p: Record<string, number>;
}

export interface BiomeDef {
  id: number;
  name: string;
  archetype: Archetype;
  climate: [number, number];
  top: RGB;
  top2: RGB;
  soil: RGB;
  rock: RGB;
  strata: RGB[];
  frost: RGB;
  sand: RGB;
  cracks: RGB | null;
  baseOffset: number;
  hillAmp: number;
  hillScale: number;
  mountain: number;
  overhang: number;
  terrace: number;
  dunes: number;
  spires: number;
  frostLine: number;
  flora: { id: number; density: number }[];
  fauna: number[];
}

export type BodyPlan = 'walker' | 'crawler' | 'hopper' | 'flyer' | 'floater' | 'sapient';

export interface FaunaDef {
  id: number;
  name: string;
  plan: BodyPlan;
  habitat: 'surface' | 'cave' | 'under' | 'sky';
  size: number;
  color: RGB;
  color2: RGB;
  eye: RGB;
  pattern: number; // 0 none, 1 stripes, 2 spots, 3 bands
  patternFreq: number;
  glow: number;
  legPairs: number;
  legLength: number;
  segments: number;
  neck: number;
  tail: number;
  speed: number;
  herd: [number, number];
  horns: number;
  eyes: number;
  arms: number;
  wingSpan: number;
  tentacles: number;
  bulk: number;
  seed: number;
}

export type ArchFamily = 'dome' | 'spire' | 'pod' | 'mushroom' | 'stack' | 'shell';

export interface CivDef {
  id: number;
  name: string;
  people: string;
  layer: 'surface' | 'under';
  body: FaunaDef;
  family: ArchFamily;
  wall: RGB;
  roof: RGB;
  trim: RGB;
  glow: RGB;
  heightScale: number;
  stilts: boolean;
  ringWall: boolean;
  monument: 'obelisk' | 'orb' | 'arch' | 'totem';
  cellSize: number;
  chance: number;
  lang: Language;
}

export interface SkyDef {
  zenith: RGB;
  horizon: RGB;
  nightZenith: RGB;
  nightHorizon: RGB;
  sunset: RGB;
  sunColor: RGB;
  sunSize: number;
  sun2: { color: RGB; size: number; offset: number } | null;
  ring: { normal: Vec3; inner: number; outer: number; color: RGB; opacity: number } | null;
  planet: { dir: Vec3; size: number; color: RGB; color2: RGB; bands: number } | null;
  cloudColor: RGB;
  cloudCover: number;
  dayLength: number;
  fog: number;
  tilt: number;
}

export interface UnderworldDef {
  ambient: RGB;
  moss: RGB;
  moss2: RGB;
  rock: RGB;
  fog: RGB;
  liquid: RGB;
  crystal: RGB;
  floorBase: number;
  ceilBase: number;
  liquidLevel: number;
}

export interface WorldParams {
  seed: number;
  seedText: string;
  name: string;
  lang: Language;
  gravity: number;
  seaLevel: number;
  liquid: RGB;
  liquidName: string;
  liquidGlow: number;
  caveRock: RGB;
  crystal: RGB;
  moonRock: RGB;
  moonTop: RGB;
  builtColor: RGB;
  biomes: BiomeDef[];
  flora: FloraDef[];
  fauna: FaunaDef[];
  civs: CivDef[];
  sky: SkyDef;
  under: UnderworldDef;
  caveFlora: { id: number; density: number }[];
  underFlora: { id: number; density: number }[];
  seaFlora: { id: number; density: number }[];
  caveFauna: number[];
  underFauna: number[];
  skyFauna: number[];
  /** Levitation zone frequency (0..1) and moonlet frequency. */
  levitation: number;
  moonlets: number;
}

const BIOME_WORDS: Record<Archetype, string[]> = {
  meadow: ['Reaches', 'Meadows', 'Downs', 'Plains'],
  fungal: ['Sporelands', 'Mycel Fen', 'Rotwood', 'Gill Marsh'],
  karst: ['Needles', 'Spire Karst', 'Pillars', 'Teeth'],
  dunes: ['Glass Sea', 'Dunes', 'Drift', 'Sands'],
  ember: ['Ember Wastes', 'Cinderfield', 'Scorch', 'Ashlands'],
  coral: ['Coral Heights', 'Terraces', 'Reef Steppe', 'Shelves'],
  pale: ['Pale Wastes', 'Frost Bloom', 'Whitefields', 'Silence'],
  forest: ['Canopy', 'Deepwood', 'Thicket', 'Tanglewood'],
  badlands: ['Badlands', 'Breaks', 'Scarps', 'Mesas'],
};

export function createWorldParams(seedText: string): WorldParams {
  const seed = hashString(seedText.trim() || 'xeno');
  const root = new RNG(seed);
  const lang = new Language(root.fork('lang'));
  const nameRng = root.fork('names');

  // --- Global palette -------------------------------------------------------------------------
  const pal = root.fork('palette');
  const lifeHue = pal.next(); // "chlorophyll" hue of this world
  const rockHue = pal.next();
  const accentHue = (lifeHue + pal.range(0.3, 0.7)) % 1;
  const glowHue = pal.next();
  const skyHue = pal.next();

  const gravity = root.fork('gravity').range(4.5, 13.5);
  const seaLevel = 0;
  const liquidHue = pal.chance(0.5) ? (skyHue + pal.range(-0.1, 0.1)) : pal.next();
  const liquid = hsl(liquidHue, pal.range(0.4, 0.8), pal.range(0.25, 0.45));

  const caveRock = hsl(rockHue + 0.05, 0.12, 0.2);
  const crystal = hsl(glowHue, 0.85, 0.6);
  const moonHue = pal.next();
  const moonRock = hsl(moonHue, 0.18, 0.42);
  const moonTop = hsl(moonHue + 0.1, 0.45, 0.55);
  const builtColor = hsl(rockHue + 0.5, 0.15, 0.5);

  // --- Flora registry --------------------------------------------------------------------------
  const flora: FloraDef[] = [];
  const floraRng = root.fork('flora');
  const addFlora = (kind: FloraKind, habitat: Habitat, colorsIn: Partial<FloraDef['colors']>, over: Partial<FloraDef> = {}): number => {
    const r = floraRng.fork(flora.length + 1);
    const base = floraDefaults(kind, r);
    const id = flora.length;
    const colors = {
      a: colorsIn.a ?? hsl(lifeHue + r.range(-0.08, 0.08), r.range(0.3, 0.7), r.range(0.25, 0.45)),
      b: colorsIn.b ?? hsl(lifeHue + r.range(-0.15, 0.15), r.range(0.4, 0.8), r.range(0.35, 0.6)),
      c: colorsIn.c ?? hsl(accentHue + r.range(-0.1, 0.1), r.range(0.5, 0.9), r.range(0.45, 0.65)),
      glow: colorsIn.glow ?? hsl(glowHue + r.range(-0.08, 0.08), 0.9, 0.6),
    };
    flora.push({ ...base, ...over, id, kind, habitat, colors, seed: Math.floor(r.next() * 1e9), name: lang.word(r, 2, 3) } as FloraDef);
    return id;
  };

  // --- Fauna registry --------------------------------------------------------------------------
  const fauna: FaunaDef[] = [];
  const faunaRng = root.fork('fauna');
  const addFauna = (plan: BodyPlan, habitat: FaunaDef['habitat'], over: Partial<FaunaDef> = {}): number => {
    const r = faunaRng.fork(fauna.length + 11);
    const id = fauna.length;
    fauna.push({ ...faunaDefaults(plan, r, lifeHue, accentHue, glowHue), habitat, ...over, id, plan, name: lang.word(r, 2, 3) } as FaunaDef);
    return id;
  };

  // --- Biomes ----------------------------------------------------------------------------------
  const allArch: Archetype[] = ['meadow', 'fungal', 'karst', 'dunes', 'ember', 'coral', 'pale', 'forest', 'badlands'];
  const brng = root.fork('biomes');
  const chosen = brng.shuffle([...allArch]).slice(0, brng.int(6, 8));
  if (!chosen.includes('meadow') && !chosen.includes('forest')) chosen[0] = 'meadow';

  // Climate anchors spread with simple rejection sampling so biomes stay distinct.
  const anchors: [number, number][] = [];
  for (let i = 0; i < chosen.length; i++) {
    let best: [number, number] = [brng.next(), brng.next()];
    let bestD = -1;
    for (let t = 0; t < 20; t++) {
      const c: [number, number] = [brng.range(0.05, 0.95), brng.range(0.05, 0.95)];
      let d = 9;
      for (const a of anchors) d = Math.min(d, Math.hypot(a[0] - c[0], a[1] - c[1]));
      if (d > bestD) {
        bestD = d;
        best = c;
      }
    }
    anchors.push(best);
  }

  const biomes: BiomeDef[] = chosen.map((arch, i) => buildBiome(arch, i, anchors[i], brng.fork(arch)));

  function buildBiome(arch: Archetype, id: number, climate: [number, number], r: RNG): BiomeDef {
    const lh = lifeHue + r.range(-0.12, 0.12);
    const rh = rockHue + r.range(-0.1, 0.1);
    let top = hsl(lh, r.range(0.35, 0.65), r.range(0.28, 0.42));
    let top2 = hsl(lh + r.range(-0.08, 0.08), r.range(0.3, 0.6), r.range(0.2, 0.36));
    let soil = hsl(rh + 0.03, r.range(0.2, 0.4), r.range(0.22, 0.32));
    let rock = hsl(rh, r.range(0.08, 0.25), r.range(0.3, 0.45));
    const sand = hsl(rh + r.range(-0.05, 0.1), r.range(0.25, 0.5), r.range(0.55, 0.7));
    const frost = hsl(skyHue + r.range(-0.1, 0.1), r.range(0.15, 0.4), r.range(0.82, 0.92));
    let cracks: RGB | null = null;
    const strataCount = r.int(3, 6);
    const strata: RGB[] = [];
    for (let s = 0; s < strataCount; s++) strata.push(hsl(rh + r.range(-0.07, 0.07), r.range(0.1, 0.45), r.range(0.22, 0.55)));

    const b: BiomeDef = {
      id, archetype: arch, climate,
      name: `${lang.word(nameRng)} ${r.pick(BIOME_WORDS[arch])}`,
      top, top2, soil, rock, strata, frost, sand, cracks,
      baseOffset: r.range(-6, 16), hillAmp: r.range(10, 30), hillScale: r.range(160, 320),
      mountain: r.range(0.3, 0.8), overhang: 0, terrace: 0, dunes: 0, spires: 0,
      frostLine: r.range(170, 280),
      flora: [], fauna: [],
    };
    const F = (id: number, d = 1) => b.flora.push({ id, density: d });
    const topCols = { a: top2, b: top };
    const rockF = () => F(addFlora('rock', 'surface', { a: rock, b: mixRGB(rock, soil, 0.5), c: strata[0] }), r.range(0.5, 1.2));
    const pebbles = () => F(addFlora('pebble', 'surface', { a: rock, b: soil, c: strata[1] ?? rock }), 1);

    switch (arch) {
      case 'meadow':
        F(addFlora('grass', 'surface', { a: top2, b: mixRGB(top, [1, 1, 1], 0.15) }), 1);
        F(addFlora('shrub', 'surface', {}), 0.8);
        F(addFlora('tree', 'surface', {}), r.range(0.25, 0.6));
        F(addFlora('bulb', 'surface', {}), 0.6);
        rockF(); pebbles();
        b.fauna.push(addFauna('walker', 'surface'), addFauna('hopper', 'surface'));
        break;
      case 'forest':
        b.hillAmp = r.range(18, 35);
        F(addFlora('tree', 'surface', {}), 1.4);
        F(addFlora('tree', 'surface', {}), 0.9);
        F(addFlora('grass', 'surface', topCols), 0.7);
        F(addFlora('fungus', 'surface', {}), 0.7);
        F(addFlora('shrub', 'surface', {}), 1);
        rockF();
        b.fauna.push(addFauna('walker', 'surface'), addFauna('crawler', 'surface'));
        break;
      case 'fungal':
        b.hillAmp = r.range(6, 14); b.overhang = r.range(3, 7); b.mountain = r.range(0.1, 0.35);
        top = b.top = hsl(accentHue + r.range(-0.1, 0.1), r.range(0.3, 0.5), r.range(0.25, 0.35));
        F(addFlora('giantfungus', 'surface', {}), r.range(0.6, 1));
        F(addFlora('fungus', 'surface', {}), 1.2);
        F(addFlora('glowcap', 'surface', {}), 0.8);
        F(addFlora('spiral', 'surface', {}), 0.5);
        F(addFlora('grass', 'surface', { a: top2, b: top }), 0.5);
        b.fauna.push(addFauna('crawler', 'surface'), addFauna('floater', 'surface'));
        break;
      case 'karst':
        b.hillAmp = r.range(20, 40); b.overhang = r.range(14, 26); b.spires = r.range(0.6, 1); b.mountain = r.range(0.4, 0.9);
        F(addFlora('fan', 'surface', {}), 1);
        F(addFlora('shrub', 'surface', {}), 0.7);
        F(addFlora('grass', 'surface', topCols), 0.6);
        rockF();
        b.fauna.push(addFauna('hopper', 'surface'), addFauna('walker', 'surface'));
        break;
      case 'dunes':
        b.dunes = r.range(0.7, 1); b.hillAmp = r.range(4, 10); b.mountain = r.range(0.1, 0.3);
        top = b.top = sand; b.top2 = mixRGB(sand, soil, 0.25); b.soil = mixRGB(sand, soil, 0.5);
        F(addFlora('crystal', 'surface', {}), 0.7);
        F(addFlora('spiral', 'surface', {}), 0.5);
        F(addFlora('bonetree', 'surface', {}), 0.3);
        rockF();
        b.fauna.push(addFauna('crawler', 'surface'));
        break;
      case 'ember':
        b.hillAmp = r.range(15, 28); b.mountain = r.range(0.6, 1.1); b.overhang = r.range(0, 6);
        b.top = hsl(rh, 0.1, 0.13); b.top2 = hsl(rh, 0.08, 0.1); b.soil = hsl(rh, 0.1, 0.12);
        b.rock = rock = hsl(rh, 0.1, 0.16);
        for (let s = 0; s < b.strata.length; s++) b.strata[s] = hsl(rh + r.range(-0.03, 0.03), 0.12, r.range(0.1, 0.22));
        b.cracks = hsl(r.range(0.0, 0.12), 1, 0.55);
        F(addFlora('crystal', 'surface', { glow: b.cracks }), 0.6);
        F(addFlora('shrub', 'surface', { a: hsl(rh, 0.1, 0.1), b: hsl(0.05, 0.8, 0.4) }), 0.5);
        rockF();
        b.fauna.push(addFauna('crawler', 'surface', { glow: 0.8 }));
        break;
      case 'coral':
        b.terrace = r.range(9, 18); b.baseOffset = r.range(15, 45); b.hillAmp = r.range(25, 45);
        F(addFlora('fan', 'surface', {}), 1.1);
        F(addFlora('bulb', 'surface', {}), 0.8);
        F(addFlora('tree', 'surface', {}), 0.4);
        F(addFlora('grass', 'surface', topCols), 0.8);
        rockF();
        b.fauna.push(addFauna('walker', 'surface'), addFauna('floater', 'surface'));
        break;
      case 'pale':
        b.hillAmp = r.range(5, 14); b.overhang = r.range(3, 8); b.frostLine = r.range(30, 90);
        b.top = hsl(skyHue, 0.12, 0.78); b.top2 = hsl(skyHue, 0.1, 0.65);
        F(addFlora('crystal', 'surface', {}), 0.8);
        F(addFlora('bonetree', 'surface', { a: hsl(rh, 0.1, 0.8), b: hsl(rh, 0.1, 0.7) }), 0.6);
        F(addFlora('grass', 'surface', { a: hsl(lh, 0.25, 0.6), b: hsl(lh, 0.3, 0.75) }), 0.5);
        rockF();
        b.fauna.push(addFauna('walker', 'surface', { size: r.range(1.5, 3) }));
        break;
      case 'badlands':
        b.terrace = r.range(5, 10); b.mountain = r.range(0.6, 1.1); b.overhang = r.range(6, 14); b.hillAmp = r.range(25, 40);
        F(addFlora('spiral', 'surface', {}), 0.8);
        F(addFlora('shrub', 'surface', {}), 0.6);
        F(addFlora('bonetree', 'surface', {}), 0.3);
        rockF(); pebbles();
        b.fauna.push(addFauna('hopper', 'surface'));
        break;
    }
    return b;
  }

  // --- Caves, underworld and sea flora ---------------------------------------------------------
  const cr = root.fork('caves');
  const caveFlora = [
    { id: addFlora('stalactite', 'ceiling', { a: caveRock, b: mixRGB(caveRock, crystal, 0.2) }), density: 1 },
    { id: addFlora('glowcap', 'cave', {}), density: 1 },
    { id: addFlora('vine', 'ceiling', {}), density: 0.8 },
    { id: addFlora('crystal', 'cave', { glow: crystal }), density: 0.7 },
    { id: addFlora('rock', 'cave', { a: caveRock, b: caveRock, c: caveRock }), density: 0.6 },
  ];
  const uh = cr.next();
  const under: UnderworldDef = {
    ambient: hsl(uh, 0.6, 0.12),
    moss: hsl(uh + cr.range(-0.08, 0.08), 0.9, 0.5),
    moss2: hsl(uh + cr.range(0.2, 0.5), 0.8, 0.45),
    rock: hsl(rockHue + 0.5, 0.15, 0.14),
    fog: hsl(uh, 0.5, 0.07),
    liquid: hsl(uh + cr.range(0.3, 0.6), 0.95, 0.5),
    crystal: hsl(uh + cr.range(-0.2, 0.2), 0.9, 0.65),
    floorBase: -380,
    ceilBase: -215,
    liquidLevel: -372,
  };
  const underFlora = [
    { id: addFlora('giantfungus', 'under', { glow: under.moss, c: under.moss2 }, { glow: 1, scaleMin: 1.6, scaleMax: 3.2, spacing: 30 }), density: 1 },
    { id: addFlora('lantern', 'under', { glow: under.moss2 }), density: 1 },
    { id: addFlora('crystal', 'under', { glow: under.crystal }, { scaleMin: 2, scaleMax: 6, spacing: 26 }), density: 0.8 },
    { id: addFlora('grass', 'under', { a: hsl(uh, 0.4, 0.12), b: scaleRGB(under.moss, 0.55) }, { glow: 0.4 }), density: 1 },
    { id: addFlora('glowcap', 'under', { glow: under.moss }), density: 1 },
    { id: addFlora('stalactite', 'underCeiling', { a: under.rock, b: under.rock }, { scaleMin: 2, scaleMax: 7, spacing: 14 }), density: 1 },
    { id: addFlora('vine', 'underCeiling', { glow: under.moss }, { scaleMin: 2, scaleMax: 5 }), density: 1 },
  ];
  const seaFlora = [{ id: addFlora('kelp', 'seafloor', { glow: hsl(glowHue + 0.1, 0.9, 0.6) }), density: 1 }];

  const caveFauna = [addFauna('crawler', 'cave', { glow: 1, size: cr.range(0.5, 1.2) })];
  const underFauna = [addFauna('walker', 'under', { glow: 1 }), addFauna('floater', 'under', { glow: 1, size: cr.range(2, 4) })];
  const skyFauna = [addFauna('flyer', 'sky'), addFauna('flyer', 'sky'), addFauna('floater', 'sky', { size: root.fork('bigfloat').range(6, 14) })];

  // --- Civilisations ---------------------------------------------------------------------------
  const civRng = root.fork('civ');
  const families: ArchFamily[] = ['dome', 'spire', 'pod', 'mushroom', 'stack', 'shell'];
  const makeCiv = (layer: 'surface' | 'under', idx: number): CivDef => {
    const r = civRng.fork(idx + 1);
    const body = fauna[addFauna('sapient', layer === 'under' ? 'under' : 'surface', { glow: layer === 'under' ? 0.7 : r.range(0, 0.3) })];
    const people = lang.word(r, 2, 3);
    const wh = r.next();
    const glowCol = layer === 'under' ? under.moss2 : hsl(r.next(), 0.9, 0.6);
    return {
      id: idx,
      name: people,
      people: people + (people.endsWith('i') ? '' : r.pick(['i', 'ar', 'eth', 'ul', 'ae'])),
      layer,
      body,
      family: r.pick(families),
      wall: hsl(wh, r.range(0.1, 0.4), r.range(0.45, 0.75)),
      roof: hsl(wh + r.range(0.2, 0.6), r.range(0.3, 0.7), r.range(0.3, 0.5)),
      trim: hsl(wh + r.range(-0.1, 0.1), r.range(0.3, 0.6), r.range(0.2, 0.35)),
      glow: glowCol,
      heightScale: r.range(0.8, 1.6),
      stilts: r.chance(0.35),
      ringWall: r.chance(0.5),
      monument: r.pick(['obelisk', 'orb', 'arch', 'totem'] as const),
      cellSize: layer === 'under' ? 900 : 1100,
      chance: layer === 'under' ? 0.45 : 0.42,
      lang,
    };
  };
  const civs: CivDef[] = [makeCiv('surface', 0), makeCiv('under', 1)];

  // --- Sky -------------------------------------------------------------------------------------
  const sr = root.fork('sky');
  const sky: SkyDef = {
    zenith: hsl(skyHue, sr.range(0.4, 0.8), sr.range(0.25, 0.45)),
    horizon: hsl(skyHue + sr.range(-0.12, 0.12), sr.range(0.3, 0.6), sr.range(0.65, 0.82)),
    nightZenith: hsl(skyHue + 0.05, 0.5, 0.02),
    nightHorizon: hsl(skyHue + 0.1, 0.4, 0.06),
    sunset: hsl(sr.range(-0.1, 0.15), 0.85, 0.55),
    sunColor: hsl(sr.range(0, 1), sr.range(0.1, 0.5), 0.92),
    sunSize: sr.range(0.02, 0.06),
    sun2: sr.chance(0.5) ? { color: hsl(sr.next(), 0.8, 0.7), size: sr.range(0.008, 0.02), offset: sr.range(0.3, 1.2) } : null,
    ring: sr.chance(0.55)
      ? { normal: normalize3([sr.range(-0.4, 0.4), 1, sr.range(-0.6, 0.6)]), inner: sr.range(0.35, 0.55), outer: sr.range(0.6, 0.9), color: hsl(sr.next(), 0.3, 0.75), opacity: sr.range(0.35, 0.75) }
      : null,
    planet: sr.chance(0.75)
      ? { dir: normalize3([sr.range(-1, 1), sr.range(0.15, 0.7), sr.range(-1, 1)]), size: sr.range(0.08, 0.3), color: hsl(sr.next(), 0.5, 0.55), color2: hsl(sr.next(), 0.6, 0.4), bands: sr.range(4, 18) }
      : null,
    cloudColor: hsl(skyHue + sr.range(-0.2, 0.2), 0.3, 0.92),
    cloudCover: sr.range(0.2, 0.7),
    dayLength: sr.range(600, 1100),
    fog: sr.range(0.6, 1.4),
    tilt: sr.range(0.2, 0.6),
  };

  const worldName = lang.word(nameRng, 2, 3);
  return {
    seed, seedText, name: worldName, lang, gravity, seaLevel, liquid,
    liquidName: lang.word(nameRng, 1, 2) + ' Sea',
    liquidGlow: pal.chance(0.3) ? pal.range(0.1, 0.4) : 0,
    caveRock, crystal, moonRock, moonTop, builtColor,
    biomes, flora, fauna, civs, sky, under,
    caveFlora, underFlora, seaFlora, caveFauna, underFauna, skyFauna,
    levitation: root.fork('lev').range(0.35, 0.8),
    moonlets: root.fork('moon').range(0.35, 0.9),
  };
}

function normalize3(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function floraDefaults(kind: FloraKind, r: RNG): Omit<FloraDef, 'id' | 'kind' | 'habitat' | 'colors' | 'seed' | 'name'> {
  const d = {
    spacing: 10, prob: 0.5, scaleMin: 0.8, scaleMax: 1.4, maxLevel: 1, minUp: 0.6, alignNormal: 0,
    sink: 0.05, collider: 0, colliderHeight: 0, wind: 0, glow: 0, variants: 3, cluster: 0.5, p: {} as Record<string, number>,
  };
  switch (kind) {
    case 'tree':
      return { ...d, spacing: r.range(9, 16), prob: 0.55, scaleMin: 0.8, scaleMax: 1.6, maxLevel: 3, minUp: 0.7, collider: 0.5, colliderHeight: 6, wind: 0.15, glow: r.chance(0.3) ? 0.6 : 0, cluster: 0.7, p: { height: r.range(7, 18), branches: r.int(2, 5), depth: r.int(2, 4), twist: r.range(-1, 1), droop: r.range(-0.4, 0.8), canopy: r.int(0, 3), trunk: r.range(0.25, 0.7) } };
    case 'bonetree':
      return { ...d, spacing: r.range(14, 24), prob: 0.5, scaleMin: 0.8, scaleMax: 1.8, maxLevel: 3, collider: 0.6, colliderHeight: 8, cluster: 0.4, p: { height: r.range(8, 16), ribs: r.int(5, 12), arc: r.range(0.4, 1.2) } };
    case 'shrub':
      return { ...d, spacing: r.range(4, 7), prob: 0.5, scaleMin: 0.6, scaleMax: 1.3, maxLevel: 1, wind: 0.3, cluster: 0.6, glow: r.chance(0.25) ? 0.8 : 0, p: { stems: r.int(4, 10), height: r.range(0.8, 2.2), style: r.int(0, 2) } };
    case 'fungus':
      return { ...d, spacing: r.range(5, 9), prob: 0.5, scaleMin: 0.6, scaleMax: 1.6, maxLevel: 2, collider: 0.25, colliderHeight: 2, cluster: 0.8, glow: r.chance(0.4) ? 0.7 : 0, p: { height: r.range(1, 3.5), cap: r.range(0.6, 1.6), caps: r.int(1, 3), flat: r.range(0.2, 0.9) } };
    case 'giantfungus':
      return { ...d, spacing: r.range(18, 30), prob: 0.55, scaleMin: 1, scaleMax: 2.2, maxLevel: 3, collider: 1.2, colliderHeight: 10, cluster: 0.5, glow: 0.5, p: { height: r.range(10, 22), cap: r.range(5, 10), caps: r.int(1, 3), flat: r.range(0.2, 0.6) } };
    case 'crystal':
      return { ...d, spacing: r.range(9, 16), prob: 0.45, scaleMin: 0.6, scaleMax: 2.2, maxLevel: 2, minUp: 0.3, alignNormal: 0.7, collider: 0.5, colliderHeight: 2, glow: 1, cluster: 0.7, p: { count: r.int(3, 9), length: r.range(1.5, 4), spread: r.range(0.2, 0.7), sides: r.pick([4, 5, 6, 6, 8]) } };
    case 'grass':
      return { ...d, spacing: r.range(1.4, 2.2), prob: 0.7, scaleMin: 0.6, scaleMax: 1.3, maxLevel: 0, minUp: 0.72, alignNormal: 0.5, wind: 1, cluster: 0.6, variants: 4, p: { blades: r.int(8, 16), height: r.range(0.4, 1.1), curl: r.range(0, 1), width: r.range(0.04, 0.1) } };
    case 'bulb':
      return { ...d, spacing: r.range(6, 11), prob: 0.4, scaleMin: 0.7, scaleMax: 1.5, maxLevel: 1, wind: 0.6, glow: r.chance(0.5) ? 0.9 : 0.2, cluster: 0.7, p: { height: r.range(1.5, 4), bulbs: r.int(1, 5), bulbSize: r.range(0.25, 0.6) } };
    case 'spiral':
      return { ...d, spacing: r.range(6, 12), prob: 0.45, scaleMin: 0.7, scaleMax: 1.6, maxLevel: 2, collider: 0.2, colliderHeight: 3, wind: 0.2, cluster: 0.5, p: { height: r.range(2, 6), turns: r.range(1.5, 5), radius: r.range(0.2, 0.7), strands: r.int(1, 3) } };
    case 'fan':
      return { ...d, spacing: r.range(5, 10), prob: 0.5, scaleMin: 0.6, scaleMax: 1.8, maxLevel: 2, wind: 0.25, cluster: 0.6, glow: r.chance(0.3) ? 0.6 : 0, p: { height: r.range(1.5, 4), depth: r.int(3, 5), spread: r.range(0.5, 1.1) } };
    case 'rock':
      return { ...d, spacing: r.range(12, 22), prob: 0.4, scaleMin: 0.6, scaleMax: 3.2, maxLevel: 3, minUp: 0.2, alignNormal: 0.8, sink: 0.3, collider: 0.9, colliderHeight: 1.5, cluster: 0.4, p: { flat: r.range(0.4, 1), rough: r.range(0.15, 0.4), size: r.range(1, 2.5) } };
    case 'pebble':
      return { ...d, spacing: r.range(3, 5), prob: 0.35, scaleMin: 0.3, scaleMax: 0.8, maxLevel: 0, minUp: 0.4, alignNormal: 0.9, sink: 0.3, cluster: 0.5, p: { flat: r.range(0.4, 0.8), rough: r.range(0.1, 0.3), size: 0.5 } };
    case 'stalactite':
      return { ...d, spacing: r.range(5, 9), prob: 0.55, scaleMin: 0.6, scaleMax: 2.5, maxLevel: 2, minUp: 0.5, sink: 0.15, cluster: 0.4, p: { length: r.range(2, 5), radius: r.range(0.3, 0.7) } };
    case 'glowcap':
      return { ...d, spacing: r.range(3, 6), prob: 0.45, scaleMin: 0.4, scaleMax: 1.2, maxLevel: 1, minUp: 0.5, glow: 1, cluster: 0.8, p: { height: r.range(0.3, 0.9), cap: r.range(0.2, 0.5), caps: r.int(3, 8), flat: r.range(0.3, 0.8) } };
    case 'vine':
      return { ...d, spacing: r.range(3, 6), prob: 0.4, scaleMin: 0.6, scaleMax: 1.8, maxLevel: 1, minUp: 0.5, glow: 1, wind: 0.2, cluster: 0.7, p: { strands: r.int(3, 9), length: r.range(1.5, 5) } };
    case 'kelp':
      return { ...d, spacing: r.range(4, 8), prob: 0.5, scaleMin: 0.8, scaleMax: 2, maxLevel: 1, minUp: 0.5, glow: 0.8, wind: 0.8, cluster: 0.7, p: { strands: r.int(2, 5), length: r.range(3, 9) } };
    case 'lantern':
      return { ...d, spacing: r.range(12, 20), prob: 0.5, scaleMin: 0.8, scaleMax: 1.8, maxLevel: 2, collider: 0.35, colliderHeight: 5, glow: 1, wind: 0.1, cluster: 0.6, p: { height: r.range(4, 9), lanterns: r.int(3, 9), droop: r.range(0.4, 1) } };
  }
}

function faunaDefaults(plan: BodyPlan, r: RNG, lifeHue: number, accentHue: number, glowHue: number): Omit<FaunaDef, 'id' | 'plan' | 'habitat' | 'name'> {
  const hue = r.chance(0.5) ? accentHue + r.range(-0.15, 0.15) : r.next();
  const base = {
    size: r.range(0.8, 2.2),
    color: hsl(hue, r.range(0.25, 0.7), r.range(0.3, 0.55)),
    color2: hsl(hue + r.range(-0.3, 0.3), r.range(0.3, 0.8), r.range(0.15, 0.7)),
    eye: r.chance(0.5) ? hsl(glowHue + r.range(-0.2, 0.2), 1, 0.6) : hsl(0, 0, r.range(0.02, 0.9)),
    pattern: r.int(0, 3),
    patternFreq: r.range(2, 7),
    glow: 0,
    legPairs: 2, legLength: 1, segments: 3, neck: 0.3, tail: 0.5, speed: r.range(1.2, 3), herd: [1, 4] as [number, number],
    horns: r.int(0, 3), eyes: r.pick([1, 2, 2, 3, 4, 6]), arms: 0, wingSpan: 0, tentacles: 0, bulk: r.range(0.8, 1.3),
    seed: Math.floor(r.next() * 1e9),
  };
  void lifeHue;
  switch (plan) {
    case 'walker':
      return { ...base, legPairs: r.int(2, 3), legLength: r.range(0.7, 2), segments: r.int(2, 4), neck: r.range(0.1, 1.2), tail: r.range(0, 1.2), herd: [2, 6] };
    case 'crawler':
      return { ...base, size: r.range(0.4, 1.4), legPairs: r.int(3, 6), legLength: r.range(0.35, 0.7), segments: r.int(4, 9), neck: 0.05, tail: r.range(0, 0.5), speed: r.range(1.5, 3.5), herd: [1, 3] };
    case 'hopper':
      return { ...base, size: r.range(0.5, 1.4), legPairs: 1, legLength: r.range(0.8, 1.4), segments: r.int(1, 2), neck: r.range(0, 0.4), tail: r.range(0.3, 1.2), herd: [2, 8] };
    case 'flyer':
      return { ...base, size: r.range(0.6, 2.5), legPairs: 1, legLength: 0.3, segments: r.int(2, 3), neck: r.range(0.1, 0.5), tail: r.range(0.3, 1.5), wingSpan: r.range(2.5, 5), speed: r.range(6, 12), herd: [3, 9] };
    case 'floater':
      return { ...base, size: r.range(1.2, 3), legPairs: 0, segments: 1, neck: 0, tail: 0, tentacles: r.int(4, 10), speed: r.range(0.5, 1.2), herd: [1, 4], glow: r.range(0.2, 0.8) };
    case 'sapient':
      return { ...base, size: r.range(1.3, 2.1), legPairs: r.pick([1, 1, 1, 2]), legLength: r.range(0.8, 1.2), segments: 2, neck: r.range(0.1, 0.5), tail: r.chance(0.4) ? r.range(0.3, 1) : 0, arms: r.pick([1, 1, 2]), speed: r.range(1.3, 2), herd: [1, 1], horns: r.int(0, 2), eyes: r.pick([1, 2, 3, 4]) };
  }
}

export function clampClimate(v: number): number {
  return clamp(v, 0, 1);
}
