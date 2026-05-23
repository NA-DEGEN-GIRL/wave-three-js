# wave-three-js

> WebGPU / TSL 기반 Three.js 바다 시뮬레이션 라이브러리 — 상용 `threejs-water-pro`의 API를 클론하여 직접 구현.
> WebGPU / TSL ocean simulation library for Three.js — a clone of the commercial `threejs-water-pro` API, reimplemented from scratch.

| | |
|---|---|
| Stack | Three.js r181+ · WebGPU(WebGL2 fallback) · TSL · Vite |
| Bundle | 86 KB ESM (gzip 21 KB), peer-dep `three` |
| License | MIT (clone of API surface and behaviour; not the upstream commercial implementation) |

![](docs/hero.jpg)

---

## 🇰🇷 한글 문서

### 한눈에 보기

이 프로젝트는 상용 라이브러리 `threejs-water-pro`의 데모와 docs (`docs.threejswaterpro.com`)를 보고 동일 API surface로 직접 다시 만든 오픈소스 클론입니다. 같은 코드 (`WaterSystem.create(...)`, `water.loadPreset("sunset")`, `water.buoyancy.addObject(...)`)가 동작하도록 설계.

### 구현된 기능

#### 파도 시뮬레이션
- **2-cascade Gerstner 합 (~18 파)**: SWELL (장파, 에너지) + RIPPLE (수면 잔물결)
- **Phillips × JONSWAP-γ 스펙트럼** 가중 진폭 (RMS 정규화)
- **Hammersley 무작위 방향/위상** — standing-wave artifact 방지
- **Trochoidal Gerstner** with Q (steepness) cap — loop fold 방지
- 모든 wave는 `windDirection`/`windSpeed`에 결합

#### Foam (거품)
- **🌟 Persistent ping-pong RT** (`FoamSimulation.js`) — 매 프레임:
  1. 이전 foam을 wave velocity로 advection
  2. Exponential decay (`foam *= exp(-decay·dt)`)
  3. Jacobian birth (`det(I+∇D) < threshold` = 표면 fold = breaking wave)
  4. Turbulence lace 게이트
  - **이게 핵심 commercial-grade mechanic** — Sea of Thieves, WaveWorks, Horizon FW 모두 사용
- **5-layer 합성**: waves (crest), surface (ambient), shoreline (curvature), contact (scene depth), splash (burst)
- **Sun-directional Lambertian shading** — sun 측 따뜻한 tint, shadow 측 cool tint
- **Turbulence-based lace 패턴** — 정적 fbm-blur가 아닌 sharp 분기형 ridge

#### 빛 & 색
- **Beer-Lambert 깊이 흡수** (per-channel R/G/B) with `clarity` 슬라이더
- **Planar mirror reflection** RT + Reflector — 거리 fade, distortion, 강도 조절 가능
- **Refraction (scene depth)** RT — 위에서 내려다보면 floor가 비침
- **Underwater 객체 자동 hide** (`userData.underwater = true`) — ghost reflection 방지
- **Grazing-angle refraction mask** — 수평선 mirage 억제
- **GGX-narrow sun specular** + 가로 anisotropic sun bar streak
- **Sparkle** (high-freq glitter)

#### Sky
- **Rayleigh + Mie procedural sky** (TSL)
- **Sun disc** + 작은 halo
- **Volumetric-style 구름** (FBM + 시간 drift + sun direction shading)
- 10 preset (tranquil/tropical/sunset/moonlit/choppy/storm/hurricane/arctic/foggy/seaOfThieves)

#### Underwater
- 카메라가 `y < 0`이면 자동 전환
- **Caustics** (2-tap voronoi animated, sun-direction modulated)
- **Caustics × (1 - foam)** — foam 영역에서 multiple scattering으로 caustics 흐려짐
- **Snell's window** (위 보면 sky가 cone으로 모임)
- **Underwater particles** (sediment) + seaweed/kelp props
- **Sun shafts** (god rays — 시간 noise × sun alignment)

#### Wet surfaces (`applyWetness`)
- Scene props (rocks, palms, boats, hulls)에 적용
- 자동으로 waterline 근처는 darker (`pow(albedo, 1+porosity·wet)`)
- 더 glossy (`mix(roughness, 0.1, wet)`)
- Foam RT 샘플 → 거품이 친 부분은 더 wet

#### Splash burst
- 물리적 trigger: `proximity × verticalEnergy × surfaceSlope × Jacobian-breaking`
- 시간 펄스 없음 (이전 sin(t) 제거) — 진짜 wave가 부서지는 순간만
- Wave displacement로 advect되는 spray turbulence + 트윙클 입자

#### Buoyancy
- CPU 다점 sampling (5-point hull) — analytic Gerstner formula
- pitch/roll from height-difference, quaternion slerp smoothing

#### Post-processing
- **Bloom** (HDR threshold 1.1로 sun specular만 glow)
- Atmospheric scene fog (FogExp2, sky color sync)
- Tone mapping (ACES Filmic)

### Quality 4단계
- `low` / `medium` / `high` / `ultra` — mesh segments, foam RT 해상도, gerstner wave 수, SSR on/off

### 빠른 시작
```js
import * as THREE from "three/webgpu";
import { WaterSystem, RayleighSky, getPresetParams, applyWetness } from "wave-three-js";

const renderer = new THREE.WebGPURenderer({ antialias: true });
await renderer.init();

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xb8c8d8, 0.0018);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 30000);
camera.position.set(28, 11, 45);

const preset = getPresetParams("tropical");
const sky = new RayleighSky(preset.sky);
scene.add(sky.getMesh());

const water = await WaterSystem.create(renderer, scene, camera, "high");
water.setSky(sky);
water.loadPreset(preset);

water.buoyancy.addObject(boatMesh, { heightOffset: -0.6, rotationInfluence: 0.7 });
applyWetness(propsGroup, water);

function animate(dt) {
  water.update(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate(0);
```

### 데모 실행
```bash
npm install
npm run dev           # http://localhost:5173/
npm run build:lib     # dist/water-pro.{js,umd.cjs}
```

### 한계점 (정직하게)

- **❌ 진짜 FFT cascade 없음**: 18 spectrum-weighted Gerstners로 시각적 90% 도달 (Tessendorf-Stockham FFT 미구현). 실제 ocean displacement map이 필요한 정확한 buoyancy GPU sampling, Tessendorf foam atlas 같은 건 안 됨.
- **❌ GPU spray particles 없음**: splash는 화면공간 shader 효과만. 수면 위로 튀어오르는 mist sprite 시스템 없음.
- **❌ Oblique frustum clipping 없음**: Reflector가 Lengyel 공식 미사용. 대신 `userData.underwater` opt-out 방식 (일반적 씬에서는 OK).
- **❌ Persistent foam이 카메라 따라 shift**: 카메라가 빠르게 움직이면 foam이 살짝 jitter (재중심화 시 texture warp 안 함). 정적/느린 카메라에선 자연스러움.
- **❌ Wake foam (보트 트레일)** 미구현 — 보트가 움직여도 뒤로 흔적 안 남김.
- **❌ Real SSR (screen-space reflection)** 없음 — planar mirror만.
- **❌ Compute shader FFT, BitonicSort** 같은 고급 GPGPU 미사용 — fragment shader 일색.
- **🟡 Cloud "3D" noise는 사실 2D projection** — 평평한 cloud layer.
- **🟡 Mesh가 단일 192² plane**, clipmap/LOD 없음 — far distance는 fog로 가림.
- **🟡 Code audit에서 발견된 perf 이슈** 일부 남음 (evalGerstner/evalNormal이 fragment에서 wave loop 2x 평가). 통합하면 약 30% 빨라짐.

### URL 디버그 파라미터 (개발 편의)
| param | 효과 |
|---|---|
| `?preset=tropical` | 10개 preset 중 선택 |
| `?cam=x,y,z` | 카메라 초기 위치 (y<0이면 dive 모드) |
| `?lookat=x,y,z` | dive 모드 lookat target |
| `?clarity=0..2.5` | 물 투명도 |
| `?contact=0..2` | contact foam 강도 |
| `?wavesFoam=0..2` | wave-crest foam 강도 |
| `?surfaceFoam=0..1` | surface ambient foam |
| `?splash=0..3` | splash burst 강도 |
| `?refl=0..1` | reflection 강도 |

---

## 🇺🇸 English

### Overview

Open-source reimplementation of the commercial `threejs-water-pro` library, mirroring its public API (`WaterSystem.create()`, `water.loadPreset()`, `water.buoyancy.addObject()`, etc.). Built from the demo page and online docs without seeing the upstream source.

### Implemented features

**Wave field**
- Two cascades (~18 waves total): SWELL (energy-carrying) + RIPPLE (sub-meter chop)
- Phillips × JONSWAP-γ spectrum-weighted amplitudes (RMS normalised)
- Hammersley random direction + phase (no standing-wave interference)
- Trochoidal Gerstner with steepness `Q` capped to avoid loop folding

**Foam (the commercial-grade core)**
- **Persistent ping-pong RT** (`FoamSimulation.js`): per-frame birth from Jacobian fold detection + exponential decay + wave-velocity advection + turbulence lace gate. This is the Sea of Thieves / WaveWorks / Horizon FW state-of-the-art.
- 5-layer composition: `waves`, `surface`, `shoreline`, `contact`, `splash`
- Sun-directional Lambertian shading — warm sun-side, cool shadow-side
- Sharp branching lace structure (not blurry fbm)

**Light & colour**
- Beer-Lambert per-channel depth absorption with `clarity` slider
- Planar mirror reflection with distance fade, configurable distortion + strength
- Scene-depth refraction (see floor through water)
- Underwater objects auto-hidden from reflection pass via `userData.underwater`
- Grazing-angle refraction mask suppresses horizon mirage
- GGX-narrow sun specular + anisotropic sun-bar streak
- Sparkle (high-freq glitter)

**Sky**
- Procedural Rayleigh + Mie sky (TSL), sun disc + halo, volumetric-style FBM clouds
- 10 environment presets

**Underwater (activates when `camera.y < 0`)**
- Animated voronoi caustics, sun-direction modulated, dimmed under foam
- Snell's-window cone (sky compressed when looking up)
- Sediment particles + seaweed props
- Faked god rays via time noise × sun alignment

**Wet surfaces (`applyWetness`)**
- Per-Lagarde 2013: `pow(albedo, 1+porosity·wet)`, `mix(roughness, 0.1, wet)`
- Wet factor = max(height-above-water fade, foam RT sample)

**Splash burst**
- Physics trigger: `proximity × verticalEnergy × surfaceSlope × Jacobian-breaking` — no time pulse
- Advected by wave displacement, twinkle spray particles

**Buoyancy**
- CPU multi-point hull sampling using analytic Gerstner formula
- Quaternion-slerp smoothing for pitch/roll

**Post-processing**
- HDR-threshold Bloom (sun specular glow), atmospheric FogExp2, ACES Filmic tone mapping

### Quality tiers
`low` / `medium` / `high` / `ultra` — mesh segments, foam RT resolution, gerstner count, SSR on/off.

### Quick start
See Korean section above — code identical.

### Honest limitations

- **No real FFT cascade** — ~90% of the look via 18 spectrum-weighted Gerstners. Things needing the actual displacement map (precise GPU-buoyancy, Tessendorf foam atlas) won't work.
- **No GPU spray particles** — splash is a screen-space shader effect; no above-surface mist sprite system.
- **No oblique-frustum clipping** in the Reflector — uses `userData.underwater` opt-out instead (works for typical scenes).
- **Persistent foam jitters** when the camera moves fast (foam RT recenters but doesn't warp). Static / slow camera looks great.
- **No wake foam** behind moving boats.
- **No real SSR** — planar mirror only.
- **No compute-shader FFT / BitonicSort**.
- **Cloud "3D" noise is 2D-projected** — flat cloud layer.
- **Single 192² mesh, no clipmap/LOD** — distance hidden by fog.
- **Some perf debt** flagged by audit (wave loop evaluated twice per fragment) — folding into one `evalWaveField` would save ~30%.

### URL debug params
Same as Korean section above.

---

## 라이센스 / License

MIT. 상용 `threejs-water-pro` 라이브러리의 API surface와 동작을 재현한 클론이며, 원본 구현 코드는 포함되어 있지 않습니다. / Clone of API surface and behaviour of the upstream commercial `threejs-water-pro` library; not the upstream implementation.
