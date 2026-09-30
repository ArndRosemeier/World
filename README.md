# Xenoworld

An endless alien planet, grown from a single seed. It runs in the browser, is written entirely in TypeScript on three.js, and has no asset files: every mesh, colour, creature, building, glyph and sound is generated.

```
npm install
npm run dev        # http://localhost:5199
npm run build      # type-check + production bundle in dist/
```

URL parameters: `?seed=<text>` picks the world, `&pos=x,z` or `&pos=x,y,z` drops you at a location, `&q=low|medium|high` sets quality and `&auto=1` skips the start screen.

## What's in a world

| System | What it does |
|---|---|
| **Terrain** | A true 3D signed density field, not a heightmap. It has continents and seas, ridged mountain ranges, dunes, terraces and 3D overhangs. It also has rock spires with hoodoo caps, giant standing stone rings and floating islands. |
| **Caves** | Winding noise-intersection tunnels, huge cheese chambers, crystal veins and rare sinkhole shafts. |
| **Underworld** | A continent-wide cavern layer about 220–380 m down. It has hourglass pillars, stalactite ceilings, glowing moss, luminous lakes and its own civilisation. |
| **Gravity** | Gravity strength varies by region, and each world has its own base value (4.5–13.5 m/s²). Levitation fields drop gravity to about 16%, and lift wells reverse it. Moonlets have their own radial pull, so you can walk all the way around them. |
| **Flora** | Seeded species per biome, built with procedural generators for 17 plant kinds. Each species has variants, wind sway and bioluminescence. |
| **Fauna** | Walkers, crawlers, hoppers, flocking flyers and drifting floaters. Their bodies are procedural, their legs use IK, and they graze, herd and flee. |
| **Civilisations** | Two sapient species per world, one on the surface and one in the underworld. Each has an architectural family, a language and a glyph script. Settlements have villagers who run errands, gather at the fire at night, greet you in their script and panic at explosions. |
| **Flowing water** | A mass-based cellular automaton on a 1 m grid runs in its own worker. Seas and underworld lakes are infinite sources, so anything you dig below their level floods, and water pours through openings into caves. It levels out, sleeps when settled and is meshed smoothly with flow-advected currents and foam. You can swim in it. |
| **Waterfalls** | Procedural vistas: rivers that meander to cliff edges and plunge off, falls pouring from floating islands in slow low-gravity arcs, streams tumbling hundreds of metres down sinkholes into the underworld, and glowing falls from the cavern ceiling. Trajectories follow the real gravity field and terrain, with mist, plunge pools and a roaring sound. |
| **Liquids** | Seas and underworld lakes are single camera-centred meshes driven by depth masks baked in the workers. They have Gerstner waves whose speed follows the world's gravity, shoreline foam and whitecaps, fresnel sky reflections, sun glints, depth colour and an underwater view. The underworld lakes glow with slow currents. |
| **Traveller** | Your third-person body is procedural too: a strider, tripod or hovering form in colours complementary to the world's life, with IK legs, a thruster backpack, the multitool and sometimes a companion drone. |
| **Destruction** | You can dig and build smooth terrain at every LOD. Charges blast craters, and buildings collapse when their supports go. Plants shatter, creatures become debris, and everything persists per seed in `localStorage`. |

## Controls

- **WASD** move, **Shift** sprint, **Space** jump. Hold Space in the air to use the jetpack.
- **V** toggles flight (**Space/Ctrl** for up/down), **C** switches between first and third person.
- **Esc** opens the menu: resume, view, quality, field manual, back to the main screen, or reset the world.
- **1–4** or **Q/E** choose a tool: excavate, shape, charge, scanner.
- **LMB/RMB** use the tool, **wheel** changes its size, **F** throws a charge anywhere.
- **M** opens the map (double-click on it to travel). **L** toggles the lamp, holding **T** speeds up time, **G** cycles quality, **F3** shows stats and **H** shows help.

## Architecture

```
src/
  core/         rng (hash + seeded PRNG), noise (simplex, fbm, ridged), names (procedural language), math
  world/
    WorldParams   the world "genome": a pure function of the seed (biomes, species, civs, sky, physics)
    Terrain       the density field: column data + 3D terms, plus surface shading
    Edits         ordered smooth CSG sphere edits (dig/add); resolution independent
    ChunkBuilder  worker side: density grid → Surface Nets mesh + AO + sky visibility + liquids
    Scatter       deterministic, LOD-stable prop placement (floors, ceilings, moonlets)
    ChunkManager  sparse octree LOD streaming; keeps old meshes until replacements are ready
    WorkerPool    prioritised job queue across N workers (also renders map tiles)
    World         main-thread facade: exact density, normals, raycasts, gravity field, snapping
  water/        FluidSim + fluid.worker (flow simulation), Fluids (rendering), Waterfalls, WaterShaders
  flora/        FloraGen (geometry generators), PropManager (instancing, LOD tiers, colliders, destruction)
  fauna/        Creature (body plans, IK locomotion, AI states), CreatureManager (spawning, herds, flocks)
  civ/          Settlement (layout + buildings from primitives), SettlementManager (villagers, collisions), Glyphs
  render/       materials (shared lighting model), Sky, Liquids, Primitives (instanced parts), Effects (debris, particles), GeoBuilder
  player/       Player (arbitrary-gravity controller), Avatar (procedural traveller), Tools, Input, Audio (synthesised)
  ui/           Hud, MapView
  Game.ts       wires everything together, environment blending, persistence, frame loop
```

### Key ideas

- **Determinism everywhere.** Everything derives from `WorldParams` (seed → genome) and integer hashing, so workers and the main thread agree exactly. Use `RNG.fork(tag)` for new subsystems, so that adding random draws never shifts existing worlds.
- **One density function.** `Terrain.density()` is the single source of truth for rendering (workers), physics, creature footing, raycasts and prop placement. New landforms are just new SDF terms combined with `min` (solid) or `max(d, -cave)` (carve). Keep the cheap `column()` data and the `top` bound up to date so the fast air path stays valid.
- **Edits as CSG.** Because edits are spheres rather than voxels, every LOD re-applies them, which keeps distant views of your excavations correct. `ChunkManager.onEdit` bumps node versions, and chunks re-mesh while still showing their old mesh.
- **Octree LOD.** Every chunk has 32³ cells, and coarser levels double the voxel size. Chunks overlap by one cell to hide LOD seams. Distant chunks that lie wholly below the surface are culled while you're outdoors.
- **Lighting.** Vertices bake ambient occlusion and *sky visibility* (probes up the column). The shared shader patch darkens caves, adds underworld ambient and the player's lamp, and props/creatures/buildings carry the same per-instance sky value.
- **Everything is instanced primitives.** Creatures, buildings and debris draw from nine unit primitives in two batches (static and dynamic). A destroyed building piece becomes debris of the same primitive.

### Extending

- **New biome:** add an `Archetype` in `WorldParams.ts` with its terrain parameters and flora/fauna in `buildBiome`.
- **New plant:** add a `FloraKind`, defaults in `floraDefaults` and a generator in `FloraGen.ts`.
- **New creature body plan:** extend `BodyPlan`, `faunaDefaults` and the `Creature.update*` / `render` branches.
- **New architecture:** add an `ArchFamily` and a case in `Settlement.building()`.
- **New landform:** add a cell cache plus an SDF in `Terrain`, include it in `column()` (`top` bound!) and `density()`, and give it shading in `shade()`.
- **New gravity anomaly:** add it to `World.gravity()`. The player, creatures and debris all read it.
