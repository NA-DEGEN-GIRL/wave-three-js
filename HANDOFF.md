# HANDOFF — Where this project is, where it should go

This document is for whoever (human or LLM) picks up this repo next. It is
written assuming you have **no prior context** beyond the source tree and
the existing `README.md` / `AGENTS.md`. Read this first. The previous
session ended after the user compared a screenshot of the commercial
`threejs-water-pro` library to this clone and pointed out the gap is still
clearly visible. The task below is to close that gap.

---

## 1. What this repo is

A from-scratch open-source clone of the commercial
[`threejs-water-pro`](https://docs.threejswaterpro.com) library, built on
**three.js r181 + WebGPU + TSL** (Three Shading Language). Public API
mirrors the commercial library so it's a drop-in for someone who already
uses the docs there.

Live demo deployed at:
**https://NA-DEGEN-GIRL.github.io/wave-three-js/** (auto-deploy on push to
main via `.github/workflows/deploy.yml`).

## 2. Current state — what exists today

All major systems are implemented and shipping. Each module is single-file
in `src/lib/`:

| Module | Status | Notes |
|---|---|---|
| `WaterSystem.js` | shipping | ~1330 lines, main entry. TSL `positionNode` + `colorNode` material, Gerstner waves, FFT cascade (opt-in), 4-layer foam, planar reflection, SSR, refraction depth pass, underwater, sun shafts, clipmap LOD |
| `Gerstner.js` | shipping | 2-cascade (swell + ripple) with Phillips × JONSWAP-γ spectrum |
| `OceanFFT.js` | shipping | Tessendorf CPU IFFT at N=64; enabled by `quality === "ultra"` |
| `FoamSimulation.js` | shipping | Persistent ping-pong RT with birth/decay/advection, wake-source splat, interactive-gradient birth |
| `Reflector.js` | shipping | Lengyel oblique frustum clipping, distance fade |
| `RefractionPass.js` | shipping | Scene + depth pass for clarity + contact foam |
| `InteractiveWater.js` | shipping | Heightfield 2D wave-equation RT; boats splat displacement, splash impulses, foam wake auto-couples |
| `OceanFloor.js` | shipping | Sand floor + voronoi caustics modulated by foam |
| `OfficialSky.js` / `RayleighSky.js` / `GradientSky.js` | shipping | OfficialSky default (vendored three.js master SkyMesh = Hosek-Wilkie + clouds) |
| `Buoyancy.js` | shipping | CPU multi-point sampling against analytical wave field |
| `SprayParticles.js` | shipping | THREE.Points ballistic spray |
| `FishSchool.js` | shipping | InstancedMesh of N procedural fish with cohesion AI + TSL tail wiggle |
| `NaturalMaterials.js` | shipping | Baked per-vertex colors for rocks / sand (3-octave Perlin + slope-based moss) |
| `WetMaterial.js` | shipping | Wraps std materials with foam-coupled wetness; preserves `vertexColors` |
| `PresetStore.js` | shipping | localStorage-backed user preset save/load |
| `presets.js` | shipping | Built-in named presets |

**Quality levels**: low / medium / high / ultra. Most work tested on
"high" with FFT off.

**Demo / docs**:
- `index.html` — main demo
- `fish-test.html` — single-fish geometry inspector (`?view=side|top|...`)
- `verify_fish_geom.mjs` — Node script for geometry-orientation regression
- `docs/screenshots/` — 5 hero PNGs for README

## 3. The visible gap — analysis of the commercial benchmark

The user shared a screenshot of the official `threejs-water-pro` demo:
a fishing boat with bright orange trim sitting on choppy blue-grey water,
overcast sky with subtle cumulus, sharp horizon. Our clone visually
trails in **seven** specific ways, in roughly decreasing order of
impact:

### Gap 1 — Water colour gradient is too uniform (highest impact)
Commercial: deep navy in the troughs, lighter teal on the crests, *clearly*
darker farther from camera (depth cue independent of fog).
Ours: more uniform mid-blue; Beer-Lambert depth absorption fires but the
result reads "shallow pool" not "open ocean".

**Why**: `u.deep` and `u.shallow` defaults are too close in lightness
across presets; depthFalloff is tuned for visible refraction not for
dramatic depth shading. Also we apply the analytical-fog blend before
the absorption sample, washing out the contrast.

**Where to fix**: `src/lib/WaterSystem.js` `colorNode` body around line
~780-870 (the absorption + diffusion block). Try (a) widening the
shallow/deep spread in `presets.js`, (b) re-ordering absorption →
horizon mix → fog so absorption survives, (c) introducing a separate
"underwater body colour" uniform with darker default for open-ocean
look. The Sea-of-Thieves talk has the math for the analytical
dual-colour mix that reads well.

### Gap 2 — Wave shapes are visibly periodic
Commercial: small, irregular, non-repeating crests at every scale.
Ours: Gerstner 2-cascade + FFT-when-on. The FFT N=64 patch tiles every
~80 m and the tiling shows up at low-angle camera, and the Gerstner
direction spread is narrow so adjacent crests align too often.

**Where to fix**: `OceanFFT.js` raise N to 128 (4× compute, still OK on
desktop) and increase patch size to 200 m. Then in `Gerstner.js` bump
`directionalSpread` default 0.6 → 1.2 so swell crests don't align as
strongly. Both already adjustable; just need the better defaults.

### Gap 3 — No visible water displacement around floating objects
Commercial: subtle depression under each hull, water visibly wraps
around the boat. Ours: boats bob via buoyancy but the water surface
doesn't dip — InteractiveWater splats negative Gaussian which IS
displacing the analytical surface, but the effect is tuned too small
(A = -0.04 × |v|, only fires when |v| > 0.2 m/s, so stationary boats
have ZERO depression).

**Where to fix**: in `WaterSystem.update()` add a "static displacement"
splat for *every* buoyancy-tracked object regardless of velocity, sized
to the object's beam, so stationary boats still dent the surface a bit
(amplitude ~-0.02 m per boat). The continuous splat over many frames
will equilibrate to a steady depression once damping balances input.

### Gap 4 — Specular sun reflection blows out the highlights
Commercial: balanced; sun glints are bright but not saturating.
Ours: sun specular term × bloom often saturates the central frame.
Already lowered bloom strength to 0.12, but the sun term itself in
the water shader is GGX-narrow and very bright.

**Where to fix**: `WaterSystem.js` `colorNode` sun specular block
(search `sunAlign`). Cap the specular term *before* it enters the bloom
chain; e.g. `clamp(spec, 0, 8)` and let bloom take over. Also worth
adding an HDR tone curve specifically for the highlight roll-off
(Reinhard or hand-rolled).

### Gap 5 — Reflections are too soft / lose detail
Commercial: distinct reflections of the boat and the horizon line
visible on the water. Ours: planar reflector resolution is OK but
distortion `n.xz * 0.022..0.08` smears the reflected image, and the
distance-fade kicks in too aggressively.

**Where to fix**: `WaterSystem.js` `colorNode` distortion factor (line
~705). Halve it. Also raise the reflector RT resolution from 512/1024
(quality-dependent) to 2048 in `WaterSystem` ctor when on `high`+.

### Gap 6 — Boat-prop visuals are basic
Commercial: textured / weathered PBR boat asset. Ours: untextured
proc geom with single-tone materials. Out of scope for a "water
library" but it makes the demo look worse than the lib actually is.

**Where to fix (optional)**: `src/main.js` `makeBoat` — swap the
procedural boat for a `GLTFLoader`-loaded asset (Polyhaven /
Sketchfab CC-BY). Don't put the asset in the repo; load from a CDN
or `public/`. This is purely demo polish; library users would supply
their own props.

### Gap 7 — Sky has a flat zenith
Commercial: subtle cumulus with depth + horizon haze. Ours uses the
vendored three.js master SkyMesh (Hosek-Wilkie + cloud plane). The
cloud plane is a flat projection — looks great near the horizon, flat
at the zenith. cloudCoverage > 0.5 helps but the projection is what
it is.

**Where to fix**: replace the cloud plane projection in
`vendor/SkyMesh.js` with a true volumetric raymarch (3D worley + Henyey-
Greenstein scattering). Expensive but gives believable 3D clouds.
Lower-cost path: bake a high-resolution cloud equirect texture into a
CubeRT and sample that instead of the procedural fbm.

## 4. Three "quick wins" that close most of the gap

If picking up cold and want maximum visual improvement per hour:

1. **Widen the water-body colour spread + reorder absorption / fog**.
   30 minutes. Single biggest visual lift; addresses Gap 1.
2. **Bump Gerstner `directionalSpread` to 1.2** and **raise FFT N to 128**.
   20 minutes. Addresses Gap 2; wave field stops looking tiled.
3. **Always-on static buoyancy splat at 0.6× hull beam, amp -0.02 m**.
   45 minutes. Addresses Gap 3; the surface now visibly *responds* to
   every floating object instead of just the moving ones.

After those three the screenshot comparison flips. Everything past that
is sky / props / post-FX territory.

## 5. Architecture footguns

Things that will bite you if you don't know they exist.

### TSL `Fn(() => {...})()` pattern is required
Setting `mat.colorNode = vec3(1,0,0)` works for a constant. Setting
`mat.colorNode = Fn(() => { ...; return vec4(col, 1); })()` is the
correct pattern when you need any computation. Do **not** omit the
trailing `()`. The result must be a Node, not a function.

### `MeshStandardNodeMaterial` doesn't set `isMeshStandardMaterial`
If you write a function that walks the scene and special-cases on
`isMeshStandardMaterial`, it will skip every TSL-based material.
We hit this in `WetMaterial.applyWetness` — it correctly excludes
node materials. If you ever extend that wrapping logic, check for
`isMeshStandardNodeMaterial` separately.

### `applyWetness` *wraps* materials and drops `vertexColors`
Fixed in commit `dafe570` but worth knowing: `applyWetness` builds a
fresh `MeshStandardNodeMaterial` and forwards a curated set of
properties. If you add a flag to the source material expecting it to
survive, you must also forward it in `WetMaterial.js`. The current
code forwards `vertexColors` and multiplies the colorNode by
`vertexColor()` — see the file.

### `mergeGeometries()` requires uniform attribute sets
`IcosahedronGeometry` is non-indexed and lacks `uv`; `ConeGeometry`
is indexed and has `uv`. Calling `mergeGeometries([ico, cone])`
returns `null` with a console warning that's easy to miss. Pattern:
call `.toNonIndexed()` on each input and add a zero-filled `uv`
attribute for any custom `BufferGeometry`. See `FishSchool.js`
`makeFishGeometry`.

### Hard `step()` mask on a sampled RT shows the RT footprint as a square
The InteractiveWater RT covers 200 m around the camera. Using
`step(0, uv) * step(uv, 1)` to mask the contribution creates a hard
edge where the heightfield ends, visible from top-down camera angles.
Use `smoothstep` over the outer 8 % of UV instead. See
`WaterSystem.positionNode` (the interactive height block).

### Headless WebGPU does NOT work for screenshots on a server
The ubuntu-dev VM has no real GPU; both `chrome --headless --enable-
unsafe-webgpu` and `--use-angle=swiftshader` get stuck at "Compiling
shaders…". For screenshots we use Windows-side Chrome via puppeteer
where the GPU is real. See `_shots_tmp/capture.mjs` for the pattern
(the directory is gitignored — recreate as needed).

### `_waterRef` lazy-init wiring in main.js
The natural-material lazy singleton in `main.js` was previously wired
to `_waterRef.foamSim`. We dropped that hook when switching to baked
vertex colors. If you re-introduce a runtime foam-RT dependency in
those materials, make sure it's a NodeMaterial — `applyWetness` will
no longer wrap it for you.

## 6. Pre-existing improvement backlog (lower priority)

These are real follow-ups but lower impact than the gap-closing list:

- 3D volumetric clouds (replace SkyMesh's plane projection)
- IBL / HDR environment for prop lighting (replace ambient + hemisphere)
- WebGPU compute pipeline for the wave-equation step (currently
  fragment-pass) — `InteractiveWater.js` has the design note from the
  consult
- Higher-order tone mapping pass (filmic, hable, agx)
- Vegetation: dune grass, kelp swaying, mangrove roots near shore
- LOD swapping for fish at distance (use sprites past 80 m)
- Procedural boat assets — better than current `makeBoat` but worse
  than a real GLTF
- Bloom: replace with HDR pre-bloom + threshold tone-map

## 7. Quick start

```bash
git clone https://github.com/NA-DEGEN-GIRL/wave-three-js
cd wave-three-js
npm install
npm run dev          # localhost:5173
npm run build        # outputs dist/ with the production base path
```

Open `localhost:5173/?preset=tropical&cam=0,-4,12` to start in
underwater mode. The full preset list is in `src/lib/presets.js`.

GUI panel exposes nearly every uniform; hover labels for tooltips.

## 8. Useful URL params for testing

| Param | Example | Effect |
|---|---|---|
| `?preset=` | `sunset` | named preset, see `presets.js` |
| `?cam=` | `28,11,45` | camera position x,y,z |
| `?lookat=` | `0,-2,0` | underwater mode aim target |
| `?sky=` | `rayleigh` | force the legacy custom sky (default = OfficialSky) |
| `?contact=` | `0` | force contact-foam coverage |
| `?wavesFoam=` | `1` | force waves-foam coverage |
| `?clarity=` | `2.0` | water clarity |
| `?surfaceFoam=` | `0.5` | force surface-foam coverage |
| `?refl=` | `0.4` | force reflection strength |

## 9. How to verify visual changes

Headless WebGPU is broken on the dev VM, so for any change you make:

1. Run `node verify_fish_geom.mjs` (only validates fish geometry) — it
   doesn't need a GPU and catches orientation regressions.
2. Run `npm run build` and check the bundle parses + emits a
   reasonable size (~990 KB unzipped, ~280 KB gzipped is normal).
3. For visual confirmation, either ask the user to refresh the live
   demo or run the puppeteer screenshot script from Windows
   (`_shots_tmp/capture.mjs` if you re-create the dir; see commit
   `4657657` for the pattern).

## 10. Commit / push workflow

The repo is hosted at `github.com:NA-DEGEN-GIRL/wave-three-js`. The
dev server runs on `ubuntu-dev` (a Hyper-V VM) at
`~/projects/water-pro-clone/`. The Windows side at
`D:\#Programming\claude_local\water-pro-build\` is a scratch copy and
NOT a git repo — do not edit there expecting `git` to work. Work
on ubuntu-dev directly, or scp single files over and run the git
commands inside the VM. CI auto-deploys to GH Pages on push to main.

---

Good luck. The fundamentals are solid; the remaining work is colour
science + asset polish more than algorithms.
