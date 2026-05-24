# AGENTS.md

Onboarding guide for LLM agents (Claude, GPT, Gemini, etc.) inheriting this project.

> **Picking up where the last session left off?** Read `HANDOFF.md` in the
> repo root. It contains a current-state summary, the visual gap analysis
> versus the commercial benchmark, the three quick wins ranked by impact,
> and the architecture footguns to avoid.

## What this project is
A from-scratch open-source reimplementation of the commercial `threejs-water-pro` library (API at `docs.threejswaterpro.com`). Three.js r181+ / WebGPU / TSL. The goal is a commercial-quality real-time ocean rendering library — Phillips/JONSWAP-weighted Gerstner waves, persistent foam accumulation RT, planar reflection, scene-depth refraction, Rayleigh sky, GPU buoyancy.

## Repository layout

```
.
├── src/lib/                       # The library (what gets published)
│   ├── index.js                   # public re-exports
│   ├── index.d.ts                 # TypeScript definitions
│   ├── WaterSystem.js             # main class, holds the big TSL material
│   ├── Gerstner.js                # spectrum-weighted wave bank
│   ├── FoamSimulation.js          # persistent ping-pong foam RT
│   ├── Reflector.js               # planar mirror reflection RT
│   ├── RefractionPass.js          # scene-depth refraction RT
│   ├── RayleighSky.js             # procedural sky + clouds
│   ├── GradientSky.js             # cheap fallback sky
│   ├── OceanFloor.js              # sand floor + caustics + seaweed factory
│   ├── Buoyancy.js                # CPU multi-point floating physics
│   ├── WetMaterial.js             # applyWetness() — Lagarde wet-surface shader
│   ├── QualityLevels.js           # low/medium/high/ultra tier table
│   └── presets.js                 # 10 environment presets
├── src/main.js                    # demo scene (boats, rocks, palms, GUI)
├── index.html                     # demo entry
├── vite.config.js                 # demo dev config
├── vite.lib.config.js             # library build config (peer-ext three.js)
├── package.json                   # demo deps
├── package.lib.json               # library publish manifest
└── README.md                      # bilingual KR/EN
```

## How to run

```bash
npm install
npm run dev                # demo on :5173
npm run build:lib          # library dist
npm run build:demo         # demo build
```

URL debug params (use during interactive development):
- `?preset=tropical|sunset|tranquil|moonlit|storm|choppy|hurricane|arctic|foggy|seaOfThieves`
- `?cam=x,y,z`  (y<0 enters dive mode)
- `?lookat=x,y,z`
- `?clarity=2.5` `?refl=0.15` `?contact=0..2` `?wavesFoam=0..2` `?surfaceFoam=0..1` `?splash=0..3`

The dev server typically lives in a tmux session called `waterpro` on the developer's remote machine — `tmux ls` to check.

## Architecture in 5 minutes

```
                  ┌────────────────────────────────┐
camera frame -->  │  WaterSystem.update(dt)        │
                  │                                │
                  │  1. update CPU-derived uniforms│   (windScale, cos/sin(windDir), sunDir)
                  │  2. update foam sim ping-pong  │   ← FoamSimulation
                  │  3. update planar reflection   │   ← Reflector  (hides underwater objs)
                  │  4. update refraction RT       │   ← RefractionPass
                  │  5. update buoyancy            │
                  │  6. fragment shader samples:   │
                  │     • foam RT (persistent)     │
                  │     • reflection RT            │
                  │     • refraction RT (+ depth)  │
                  │     • Gerstner waves (TSL Fn)  │
                  └────────────────────────────────┘
```

### Wave field
- `Gerstner.js` builds a deterministic bank of ~18 waves split into SWELL (long, energy-carrying) + RIPPLE (sub-meter chop). Each wave has `{dirAngle, wavelength, amplitude, steepness, phase, k, isSwell}`.
- Per-wave amplitudes are drawn from a Phillips × JONSWAP-γ spectrum, then RMS-normalised so total displacement stays bounded.
- The shader (in `WaterSystem._buildMaterial`) loops over `gerstner.waves[]` in `evalGerstner` (vertex displacement + foamSeed) and `evalNormal` (normal + Jacobian). Both currently iterate the loop independently — a known perf debt (see *Open work* below).

### Foam (the part that took the most effort)
The reference's "alive" foam is impossible with stateless per-pixel computation alone. We use:

1. **`FoamSimulation`** — RGBA HalfFloat ping-pong RT (1024², covers ±100m around camera). Each frame:
   - Sample previous RT at `uv - waveVelocityXZ·dt/halfSize` (advection)
   - Decay: `prev *= exp(-decayRate·dt)`
   - Birth: `clamp(birthThreshold - detJ, 0, 1) · turbulenceLace · birthRate · dt`
   - Output: max-blended channel into new target → swap
   
2. The water material samples this RT in world-XZ projection for the foam *shape*.
3. Local turbulence noise is multiplied INTO the persistent value for inner *texture*.
4. Five physical foam layers (waves / surface / shoreline / contact / splash) all read from the RT, composed via weighted single-blend (not sequential mix() — that was a code-audit fix).

### Reflection & refraction
- `Reflector` renders the scene with a mirror camera (`matrixWorld.premultiply(scale(1,-1,1))`). To avoid back-face culling making everything invisible, we temporarily flip every material to `DoubleSide`. Scene fog is disabled during the pass.
- Objects below water that shouldn't reflect are tagged `userData.underwater = true` and added to the hide list automatically by `WaterSystem.update()`.
- `RefractionPass` renders the scene from main cam with the water hidden, storing both colour (RGBA) and depth (DepthTexture, FloatType).
- The water material reads scene depth, linearises (perspective formula), subtracts water-fragment view-Z, and uses the result for both Beer-Lambert and contact-foam.

### Wetness
`WetMaterial.applyWetness(root, water)` walks the object tree, replaces every MeshStandardMaterial with a MeshStandardNodeMaterial that samples `foamSim.currentTexture` at the prop's world-XZ, blends with a height-above-waterline factor, and applies the Lagarde 2013 wet-surface formula in `colorNode` and `roughnessNode`. This makes rocks/boats/palms darker and glossier near the waterline.

## Critical pitfalls (read before editing!)

### 1. TSL temporal-dead-zone bugs
TSL `Fn(...)` bodies execute JavaScript top-down at material-build time. If you reference a `const` declared LATER in the same body, you get `ReferenceError: Cannot access 'X' before initialization`. Common symptom: water turns black. Always declare all `const` helpers *above* their first use, even though they're TSL nodes.

### 2. Ping-pong texture references
TSL `texture(THREE.Texture)` binds to that specific Texture instance at material-build time. If you swap render targets each frame, the material keeps sampling the original. Solution: wrap in a `TextureNode` and reassign `.value` each frame. See `FoamSimulation._outputTextureNode` for the pattern.

### 3. Hoisting & order in `_buildMaterial`
The big `colorNode` Fn references many helper nodes. Any reordering risks a TDZ error. If you must reorder, ship to ubuntu-dev and run a quick headless capture to confirm the water still renders.

### 4. Reflection of underwater geometry
If you add anything below y=0 that shouldn't ghost into the water surface (kelp, sediment, sunken treasure, etc.), tag it: `obj.userData.underwater = true`. WaterSystem auto-collects these into the reflection hide list.

### 5. Window mismatch in TSL smoothstep
`smoothstep(edge0, edge1, x)` with `edge0 > edge1` is undefined behaviour on most backends. If you want "1 close, 0 far", use `1 - smoothstep(near, far, x)` not `smoothstep(far, near, x)`.

### 6. Default camera matters
The demo's default cam at `(28, 11, 45)` is chosen because foreground props don't clutter the view. Low cameras (y<6) close to many props trigger lots of contact foam — verify changes against multiple presets *and* multiple camera angles. The audit helpers below are calibrated for the default.

## Verification workflow

After any shader change:

```bash
# 1. Ship + library-build check (catches imports / syntax)
ssh ubuntu-dev 'cd ~/projects/wave-three-js && npx vite build 2>&1 | tail -5'

# 2. Headless screenshot to catch TSL compile errors at runtime
ssh ubuntu-dev '
  rm -rf /tmp/test && mkdir -p /tmp/test
  google-chrome --headless --no-sandbox --user-data-dir=/tmp/test/p \
    --use-gl=angle --use-angle=swiftshader --ignore-gpu-blocklist \
    --enable-features=Vulkan --window-size=1280,720 \
    --enable-logging=stderr --v=0 --virtual-time-budget=80000 \
    --screenshot=/tmp/test/x.png "http://localhost:5173/?preset=tropical" 2>/tmp/test/log
  grep -E "TSL.*Error|ReferenceError|TypeError" /tmp/test/log | head -3
'
```

If you see *black water*, it's almost certainly a TSL ReferenceError in `_buildMaterial`. Grep the log first.

### A/B parameter comparison
Use the URL debug params to capture parameter pairs and verify your shader change actually responds to user input:

```
?refl=0.15  vs  ?refl=1.0
?clarity=0.3  vs  ?clarity=2.5
?surfaceFoam=0.01  vs  ?surfaceFoam=0.5
```

## Conventions / style

- TSL uses `Fn(([arg1, arg2]) => { ... })` for functions; call as `myFn(a, b)`. `.toVar()` to materialise a node into a local variable.
- Pretty much every helper is unit-less but in *world meters* — wavelength in m, depth in m, foam contact distance in m, etc.
- All public params are exposed as either:
  - TSL `uniform(...)` with `.value = X` setter (matches docs.threejswaterpro.com API), OR
  - Plain JS properties on a group object (e.g. `water.foam.waves.coverage = 0.5`), synced to private uniforms each `update()`.
- The CPU-side `_cpuDerived` uniforms in `WaterSystem._init()` are precomputed in `update()` to save per-fragment ALU.

## Open work (prioritised)

1. **Unify `evalGerstner` / `evalNormal`** — currently the swell-wave for-loop runs twice per fragment + once per vertex. Folding into a single `evalWaveField` returning `vec3 displacement, vec3 normal, float jacobian` would save ~30% pixel cost. (`WaterSystem.js:~370-420`)
2. **GPU spray particles** — true 3D mist above the surface (instead of screen-space). See splash-specialist research notes in conversation history: spawn rate from same Jacobian birth signal as foam, atlas of pre-rendered spray puffs, soft-particle depth fade.
3. **Wake foam** — add a per-boat "splat" pass into the foam RT each frame so trails form behind moving objects.
4. **Oblique frustum clipping** for the Reflector (Lengyel formula) to replace the `userData.underwater` workaround.
5. **Foam-RT recentre warping** — when the camera moves fast, sample the PREVIOUS foam at `prevCenter` offset so foam doesn't jitter.
6. **3D cloud noise** — currently `noise3` is a 2D-projected hash. Real 3D noise + Beer's-law cloud lighting would be more polished.
7. **Real FFT cascade** — Tessendorf-Stockham IFFT on a WebGPU compute shader (refs: jbouny/fft-ocean, Barth Paléologue WebGPU port, 2Retr0/GodotOceanWaves). Big project but enables proper Tessendorf-foam-atlas and GPU buoyancy via displacement-map readback.

## Reference material in conversation history (high-signal)

If the next agent has access to this repo's chat history, the following messages contain expert briefs:

- "Splash/wake fluid simulation expert" agent report (a9850898…) — covers persistent foam RT, GPU spray, wet rocks, layered foam, latest SIGGRAPH 2022-2024 papers.
- "Comprehensive code audit" agent report (a7d43d0ce…) — 15-item prioritised punch list with file:line refs for perf and bugs.
- "Visual gap analysis" agent report (a18c8be3b…) — per-category 1-5 scoring vs the reference frames, top-5 fixes.

For new agents starting cold: read the README first, then read `src/lib/WaterSystem.js` `_buildMaterial` to understand the TSL graph, then read `FoamSimulation.js` to understand the persistent-foam mechanic that drives the foam look.

## Tests
None automated yet. The verification is visual comparison against `refs/` (frames extracted from the upstream demo videos). If you add tests, please don't snapshot-test screenshots (TSL output is hardware-dependent) — assert on the existence and shape of the TSL graph instead.

## Contact / Provenance
Original interactive build session ran across multiple iterations with Claude as the implementing agent + several expert subagents for research. See git log for evolution. Sub-agent outputs were consulted but not committed; their findings shaped the code through hand-implementation.
