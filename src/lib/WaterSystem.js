// WaterSystem — main entry point. Mirrors the public surface of `threejs-water-pro`.
//
// V2 visuals:
//  - Gerstner sum (long swells) + multi-octave value-noise micro ripples for the
//    "alive" surface detail the reference video shows.
//  - Beer-Lambert depth absorption for physically plausible colour vs distance.
//  - GGX-ish narrow sun specular + a long anisotropic "sun bar" streak that mirrors
//    the way the real lib's sun smears along rippled water.
//  - Two-layer foam: wave-crest whitecaps (Jacobian-ish steepness mask) + a
//    wind-drift tiled foam texture; both blended on top of the water.
//  - Atmospheric horizon fade so distant water dissolves into the sky.
//
// The public API mirrors the docs: water.waves.*, water.color, water.fresnel, etc.
// Property setters are plain JS — values are mirrored into TSL uniforms each frame.

import * as THREE from "three/webgpu";
import {
  Fn, vec2, vec3, vec4, float, uniform, normalize, dot, cross, mix, clamp,
  pow, sin, cos, length, smoothstep, max, min, abs, fract, floor, exp,
  positionLocal, positionWorld, cameraPosition, uv, time, sub, add,
  texture, screenUV, cameraViewMatrix,
} from "three/tsl";

import { getQualityConfig } from "./QualityLevels.js";
import { Gerstner } from "./Gerstner.js";
import { BuoyancySystem } from "./Buoyancy.js";
import { OceanFloor } from "./OceanFloor.js";
import { WaterReflector } from "./Reflector.js";
import { RefractionPass } from "./RefractionPass.js";
import { FoamSimulation } from "./FoamSimulation.js";

const DEFAULT_GRID = { levels: 1, segments: 192, baseSize: 1600 };

class WaveSampler {
  constructor(getCtx) { this._get = getCtx; }
  async sampleAt(x, z) {
    const { waves, t, windDir, windSpeed, ampGlobal } = this._get();
    let y = 0, nx = 0, nz = 0;
    const windScale = Math.max(0.5, windSpeed * 0.1);
    for (const w of waves) {
      const dir = w.dirAngle + windDir;
      const dx = Math.cos(dir), dz = Math.sin(dir);
      const k = (2 * Math.PI) / w.wavelength;
      const omega = Math.sqrt(9.81 * k);
      const A = w.amplitude * ampGlobal * windScale;
      const theta = k * (dx * x + dz * z) - omega * t + w.phase;
      y += A * Math.sin(theta);
      nx += -dx * k * A * Math.cos(theta);
      nz += -dz * k * A * Math.cos(theta);
    }
    return { height: y, normal: new THREE.Vector3(nx, 1, nz).normalize() };
  }
}

// ---------- Reusable TSL helpers ----------

// Hash from iq-style; cheap, no texture lookup.
const hash22 = Fn(([p]) => {
  const x = fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
  const y = fract(sin(dot(p, vec2(269.5,  183.3))).mul(43758.5453));
  return vec2(x, y);
});

// 2D Worley/cellular noise — returns min distance to nearest hash-placed point
// in the 3x3 neighbourhood. Used for foam bubbles (1 - worley = bright cells).
const worley2 = Fn(([p]) => {
  const ip = floor(p).toVar();
  const fp = p.sub(ip).toVar();
  const minDist = float(1.5).toVar();
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const offset = vec2(dx, dy);
      const cell = ip.add(offset);
      const h = hash22(cell);
      // Animate point position slightly so bubbles "shift".
      const pt = offset.add(h);
      const d = length(pt.sub(fp));
      minDist.assign(min(minDist, d));
    }
  }
  return minDist;
});

// Turbulence: |fbm − 0.5| folded to give sharp ridge lines instead of smooth blobs.
// This is what gives lace/streak foam its character.
const turbulence = Fn(([p]) => {
  let amp = float(0.5).toVar();
  let freq = float(1.0).toVar();
  let sum = float(0).toVar();
  const pv = p.toVar();
  for (let i = 0; i < 5; i++) {
    const n = valueNoiseD(pv.mul(freq)).x;
    sum.addAssign(abs(n.sub(0.5)).mul(amp));
    freq.assign(freq.mul(2.13));
    amp.assign(amp.mul(0.55));
  }
  return sum;
});

// Value noise + analytical derivative. Returns vec3(value, dValue/dx, dValue/dy).
const valueNoiseD = Fn(([p]) => {
  const i = floor(p).toVar();
  const f = p.sub(i).toVar();
  const u  = f.mul(f).mul(f.mul(-2.0).add(3.0));       // smoothstep
  const du = float(6.0).mul(f).mul(float(1.0).sub(f)); // derivative of smoothstep

  const a = fract(sin(dot(i,                    vec2(127.1, 311.7))).mul(43758.5453));
  const b = fract(sin(dot(i.add(vec2(1, 0)),    vec2(127.1, 311.7))).mul(43758.5453));
  const c = fract(sin(dot(i.add(vec2(0, 1)),    vec2(127.1, 311.7))).mul(43758.5453));
  const d = fract(sin(dot(i.add(vec2(1, 1)),    vec2(127.1, 311.7))).mul(43758.5453));

  const value = a.add((b.sub(a)).mul(u.x)).add((c.sub(a)).mul(u.y)).add((a.sub(b).sub(c).add(d)).mul(u.x).mul(u.y));
  const dx = du.x.mul(b.sub(a).add((a.sub(b).sub(c).add(d)).mul(u.y)));
  const dy = du.y.mul(c.sub(a).add((a.sub(b).sub(c).add(d)).mul(u.x)));
  return vec3(value, dx, dy);
});

// FBM with derivative. Returns vec3(value, dValue/dx, dValue/dy).
function makeFbmD(octaves = 4, lacunarity = 2.05, gain = 0.5) {
  return Fn(([p]) => {
    let amp = float(0.5).toVar();
    let freq = float(1.0).toVar();
    let sum = float(0).toVar();
    let dx = float(0).toVar();
    let dy = float(0).toVar();
    const pv = p.toVar();
    for (let i = 0; i < octaves; i++) {
      const n = valueNoiseD(pv.mul(freq));
      sum.addAssign(n.x.mul(amp));
      dx.addAssign(n.y.mul(amp).mul(freq));
      dy.addAssign(n.z.mul(amp).mul(freq));
      freq.assign(freq.mul(lacunarity));
      amp.assign(amp.mul(gain));
    }
    return vec3(sum, dx, dy);
  });
}

export class WaterSystem {
  static async create(renderer, scene, camera, quality = "high") {
    const water = new WaterSystem();
    await water._init(renderer, scene, camera, quality);
    return water;
  }

  constructor() {
    this.backend = "webgpu";
    this.cameraTracking = true;
    this.wireframe = false;
    this._disposed = false;
    this._tShader = uniform(0);
    this._gridOffset = uniform(new THREE.Vector3(0, 0, 0));
    this._presetName = "sunset";
  }

  async _init(renderer, scene, camera, quality) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.config = getQualityConfig(quality);
    this.quality = quality;

    // Uniform-backed wave params (docs exposes .value).
    this.waves = {
      windSpeed:           uniform(25),
      windDirection:       uniform(0.7),
      choppiness:          uniform(1.0),
      amplitude:           uniform(1.0),
      jonswapGamma:        uniform(3.3),
      directionalSpreading:uniform(20.0),
      standingWaveRatio:   uniform(0.0),
      gravity:             uniform(9.81),
      animationSpeed:      1.0,
      // Ripple bands (new): amplitude scalars for medium chop and tiny ripples.
      rippleAmplitude:     uniform(0.55),
      rippleFrequency:     uniform(0.12),
      microAmplitude:      uniform(0.18),
      microFrequency:      uniform(1.8),
    };

    this.color = {
      shallowWaterColor: new THREE.Color("#3fcfd0"),
      deepWaterColor: new THREE.Color("#021a2e"),
      depthFalloff: 18.0,
      alpha: 1.0,
      transmissionColor: new THREE.Color("#00ffcc"),
      // Clarity: 0 = opaque (no see-through), 1 = standard, 2 = crystal clear.
      // Scales how much the refraction sample contributes vs the deep body color.
      clarity: 1.0,
    };
    this.fresnel = { normalStrength: 0.12, power: 5.0, fadePower: 1.0, fadeStart: 60 };
    this.sparkle = { enabled: true, intensity: 1.2, power: 512, minDistance: 10, fadeDistance: 500 };
    this.sss = { enabled: true, intensity: 0.6, power: 4.0 };
    this.ssr = { enabled: this.config.ssr, strength: 0.8 };
    // Planar-reflection master strength. Lower values keep reflections subtle so
    // scene props (rocks, palms) don't ghost-overlay the water surface.
    this.reflection = {
      strength: 0.55,         // [0..1] master multiplier on the reflection sample
      fadeStart: 60,          // metres before distance fade kicks in
      fadeEnd: 450,           // metres where reflection ~= 0
      distortionStrength: 1.0, // multiplier on normal-perturbation distortion
    };
    this.sun = { direction: uniform(new THREE.Vector3(0.45, 0.35, 0.45).normalize()), intensity: uniform(1.5) };
    this.debug = { displacementScale: 1.0, normalCullThreshold: 0.0, visualizationMode: 0 };

    // CPU-derived uniforms — computed once per frame in update() so the shader
    // doesn't recompute `pow(windSpeed*0.07, 0.55)` and `cos/sin(windDir)` per
    // pixel per wave (the code audit flagged ~20+ redundant ops per fragment).
    this._cpuDerived = {
      windScale: uniform(1.0),
      windCosSin: uniform(new THREE.Vector2(1, 0)),
      sunDirNorm: uniform(new THREE.Vector3(0, 1, 0)),
    };

    // Internal mirror uniforms.
    this._u = {
      shallow:        uniform(new THREE.Color(this.color.shallowWaterColor)),
      deep:           uniform(new THREE.Color(this.color.deepWaterColor)),
      depthFalloff:   uniform(this.color.depthFalloff),
      alpha:          uniform(this.color.alpha),
      transmission:   uniform(new THREE.Color(this.color.transmissionColor)),
      fresnelPow:     uniform(this.fresnel.power),
      fresnelNormStr: uniform(this.fresnel.normalStrength),
      sparkleInt:     uniform(this.sparkle.intensity),
      sparklePow:     uniform(this.sparkle.power),
      sparkleEnabled: uniform(1),
      sssInt:         uniform(this.sss.intensity),
      ssrEnabled:     uniform(this.config.ssr ? 1 : 0),
      ssrStrength:    uniform(0.8),
      skyHorizon:     uniform(new THREE.Color("#cad9e8")),
      skyZenith:      uniform(new THREE.Color("#1a4080")),
      sunCol:         uniform(new THREE.Color("#fff2e6")),
      foamSurfaceColor: uniform(new THREE.Color("#ffffff")),
      foamSurfaceCoverage: uniform(0.3),
      foamSurfaceOpacity:  uniform(0.35),
      foamSurfaceSize:     uniform(80.0),
      foamWavesColor:      uniform(new THREE.Color("#ffffff")),
      foamWavesCoverage:   uniform(0.55),
      foamWavesOpacity:    uniform(0.85),
      foamWavesCrestCov:   uniform(0.5),
      foamWavesPeakInt:    uniform(1.0),
      foamWavesSize:       uniform(35.0),
      foamShoreColor:      uniform(new THREE.Color("#ffffff")),
      foamShoreCoverage:   uniform(0.5),
      foamShoreOpacity:    uniform(0.5),
      foamShoreRange:      uniform(40.0),
      foamShoreSize:       uniform(50.0),
      // Contact foam (around objects touching water) — exposed as own group.
      foamContactColor:    uniform(new THREE.Color("#ffffff")),
      foamContactCoverage: uniform(0.45),
      foamContactOpacity:  uniform(0.35),
      foamContactDistance: uniform(0.9),
      foamContactEnabled:  uniform(1),
      clarity:             uniform(1.0),
      // Splash burst: extra bright animated foam exactly where waves hit objects.
      splashIntensity:     uniform(1.0),
      splashEnabled:       uniform(1),
      // Reflection master controls (planar mirror).
      reflectionStrength:   uniform(0.55),  // [0..1] global multiplier
      reflectionFadeStart:  uniform(60),    // metres before distance fade kicks in
      reflectionFadeEnd:    uniform(450),
      reflectionDistortion: uniform(1.0),
      uwFogColor:    uniform(new THREE.Color("#0a2830")),
      uwFogDensity:  uniform(0.002),
      uwDistortionInt:     uniform(0.02),
      uwDistortionScale:   uniform(3.0),
      uwDistortionSpeed:   uniform(0.5),
      uwDistortionEnabled: uniform(1),
      fogEnabled:    uniform(1),
      fogFadeStart:  uniform(280),
      fogFadePower:  uniform(1.3),
      foamSurfaceEnabled: uniform(1),
      foamWavesEnabled:   uniform(1),
      foamShoreEnabled:   uniform(1),
      cascadeWaveAmp:   uniform(1.0),
      cascadeRippleAmp: uniform(0.3),
    };

    this.foam = {
      surface:   { enabled: true, color: new THREE.Color("#ffffff"), coverage: 0.3,  opacity: 0.35, size: 80, foamTexture: null },
      waves:     { enabled: true, color: new THREE.Color("#ffffff"), coverage: 0.55, crestCoverage: 0.5, peakIntensity: 0.85,
                   opacity: 0.75, rippleWeight: 1.0, waveWeight: 1.0, windBias: 0.8, windStretch: 0.5, size: 22, foamTexture: null },
      shoreline: { enabled: true, color: new THREE.Color("#ffffff"), coverage: 0.5,  opacity: 0.5,  range: 40, size: 50, foamTexture: null },
      // New: object-contact foam (depth-driven band where water meets opaque objects).
      contact:   { enabled: true, color: new THREE.Color("#ffffff"), coverage: 0.45, opacity: 0.35, distance: 0.9 },
    };
    this.underwater = {
      enabled: true,
      fogUniforms: { color: this._u.uwFogColor, density: this._u.uwFogDensity },
      distortionUniforms: { enabled: this._u.uwDistortionEnabled, intensity: this._u.uwDistortionInt, speed: this._u.uwDistortionSpeed, scale: this._u.uwDistortionScale },
    };
    // Splash subgroup — bright burst foam at wave-object intersections.
    this.splash = { enabled: true, intensity: 1.0 };
    this.fog = { enabled: true, fadeStart: 280, fadePower: 1.3 };
    this.waterline = { thickness: 0.5, normalStrength: 0.7, smoothness: 0.3, highlightSharpness: 3.0, highlightStrength: 0.8 };
    this.sunShafts = { enabled: true, intensity: 0.2, falloff: 1.5, fadeIn: 0.25, softness: 0.75 };
    this.underwaterSurfaceGlow = { enabled: true, intensity: 5.81, focusPower: 75.7, color: "#fef7e0" };
    this.particles = { enabled: false, updateParams: (p) => Object.assign(this.particles, p) };
    this.masking = {
      enabled: false, _set: new Set(),
      add: (m) => this.masking._set.add(m),
      remove: (m) => this.masking._set.delete(m),
      has: (m) => this.masking._set.has(m),
    };

    this.gerstner = new Gerstner({
      count: this.config.gerstnerCount > 0 ? this.config.gerstnerCount : 4,
      wavelength: 220, amplitude: 1.0, wavelengthSpread: 1.5, directionalSpread: 0.6,
    });
    this.gerstner.onChange = () => this._rebuildWaveNodes();

    // Planar reflection — renders scene reflected across y=0 each frame, sampled in colorNode.
    this.reflector = new WaterReflector({ resolution: this.config.ssr ? 1024 : 512 });
    // Refraction + scene depth pass — drives see-through-water and contact foam.
    this.refraction = new RefractionPass({ resolution: 1024 });
    // Persistent foam simulation: ping-pong RT with birth/decay/advection. This
    // is what makes foam STREAKS LINGER — the commercial-grade core mechanic.
    this.foamSim = new FoamSimulation({ resolution: 1024, worldSize: 200, decayRate: 0.7 });

    // Camera near/far uniforms for depth linearisation in the shader.
    this._cameraNear = uniform(camera.near);
    this._cameraFar = uniform(camera.far);

    this._geomConfig = { ...DEFAULT_GRID, segments: Math.max(96, this.config.meshSegments * 1.5) };
    this._timeAccum = 0;
    this._isUnderwater = uniform(0);
    this._buildMesh();
    this._attachFoamSim();

    this.buoyancy = new BuoyancySystem(new WaveSampler(() => ({
      waves: this.gerstner.waves,
      t: this._timeAccum,
      windDir: this.waves.windDirection.value,
      windSpeed: this.waves.windSpeed.value,
      ampGlobal: this.waves.amplitude.value,
    })));
    this.floor = new OceanFloor({
      size: this._geomConfig.baseSize * 2,
      depth: 18,
      sunDirection: this.sun.direction, // share the same uniform so caustics follow the sun
      foamSim: this.foamSim,             // so caustics get dimmed under foam (multiple scattering)
    });
    this.sampler = this.buoyancy.sampler;
    this.wake = { _list: [], add() {}, remove() {} };

    scene.add(this._mesh);
    scene.add(this.floor.getMesh());
  }

  // -------- Geometry / material --------
  _buildMesh() {
    if (this._mesh) {
      this.scene.remove(this._mesh);
      this._mesh.geometry.dispose();
      this._material?.dispose();
    }
    const { segments, baseSize } = this._geomConfig;
    // Subdivide more near centre for shore detail — simple flat plane is fine for now.
    const geom = new THREE.PlaneGeometry(baseSize, baseSize, segments, segments);
    geom.rotateX(-Math.PI / 2);

    const mat = this._buildMaterial();
    this._material = mat;
    this._mesh = new THREE.Mesh(geom, mat);
    this._mesh.frustumCulled = false;
    this._mesh.renderOrder = 0;
    if (this.scene) this.scene.add(this._mesh);
  }

  _rebuildWaveNodes() {
    this._buildMesh();
    this._attachFoamSim();
  }

  _attachFoamSim() {
    if (!this.foamSim) return;
    this.foamSim.attach({
      waves: this.gerstner.waves,
      windDir: this.waves.windDirection,
      windSpeed: this.waves.windSpeed,
      choppiness: this.waves.choppiness,
      ampGlobal: this.waves.amplitude,
    });
  }

  _buildMaterial() {
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: false, depthWrite: true, side: THREE.DoubleSide,
      wireframe: this.wireframe, fog: false,
    });

    const waves = this.gerstner.waves;
    const u = this._u;
    const tNode = this._tShader;
    const windDir = this.waves.windDirection;
    const windSpeed = this.waves.windSpeed;
    const choppiness = this.waves.choppiness;
    const ampGlobal = this.waves.amplitude;
    const rippleAmp = this.waves.rippleAmplitude;
    const rippleFreq = this.waves.rippleFrequency;
    const microAmp = this.waves.microAmplitude;
    const microFreq = this.waves.microFrequency;

    const fbmMid = makeFbmD(4);
    const fbmMicro = makeFbmD(3);

    // ---- Wave evaluation. Returns vec4(displacement.xyz, foamSeed)
    // windScale is gentler now and capped so high-wind presets don't blow up.
    const evalGerstner = Fn(([worldXZ]) => {
      const disp = vec3(0, 0, 0).toVar();
      const foamSeed = float(0).toVar();
      // sqrt scaling stays sub-linear; cap at 2.5x baseline so storms don't tower over the camera.
      const windScale = min(max(pow(max(windSpeed, float(1)).mul(0.07), float(0.55)), float(0.4)), float(2.5));
      for (const w of waves) {
        const dir = windDir.add(float(w.dirAngle));
        const dx = cos(dir); const dz = sin(dir);
        const k = float((2 * Math.PI) / w.wavelength);
        const omega = float(Math.sqrt(9.81 * (2 * Math.PI) / w.wavelength));
        const A = float(w.amplitude).mul(ampGlobal).mul(windScale);
        const theta = k.mul(dx.mul(worldXZ.x).add(dz.mul(worldXZ.y))).sub(omega.mul(tNode)).add(float(w.phase));
        const sinT = sin(theta); const cosT = cos(theta);
        const Q = float(w.steepness).mul(choppiness).div(float(waves.length));
        disp.x.addAssign(Q.mul(A).mul(dx).mul(cosT));
        disp.z.addAssign(Q.mul(A).mul(dz).mul(cosT));
        disp.y.addAssign(A.mul(sinT));
        // Steepness-based foam seed: ONLY swell waves contribute. Ripple-cascade
        // crests are too dense and would coat the surface in spurious foam.
        if (w.isSwell) {
          foamSeed.addAssign(max(sinT.sub(float(0.72)), float(0)).mul(Q).mul(3.0));
        }
      }
      return vec4(disp, foamSeed);
    });

    // Returns vec4(normal.xyz, jacobianDet) using analytic Gerstner derivatives.
    // The Jacobian determinant tells us when the surface compresses/folds — the
    // physically correct trigger for whitecaps (Tessendorf §6).
    const evalNormal = Fn(([worldXZ]) => {
      const Bx = float(0).toVar();
      const Bz = float(0).toVar();
      const By = float(0).toVar();
      const Jxx = float(0).toVar();
      const Jzz = float(0).toVar();
      const Jxz = float(0).toVar();
      const windScale = min(max(pow(max(windSpeed, float(1)).mul(0.07), float(0.55)), float(0.4)), float(2.5));
      for (const w of waves) {
        const dir = windDir.add(float(w.dirAngle));
        const dx = cos(dir); const dz = sin(dir);
        const k = float((2 * Math.PI) / w.wavelength);
        const omega = float(Math.sqrt(9.81 * (2 * Math.PI) / w.wavelength));
        const A = float(w.amplitude).mul(ampGlobal).mul(windScale);
        const theta = k.mul(dx.mul(worldXZ.x).add(dz.mul(worldXZ.y))).sub(omega.mul(tNode)).add(float(w.phase));
        const sinT = sin(theta); const cosT = cos(theta);
        const Q = float(w.steepness).mul(choppiness).div(float(waves.length));
        Bx.addAssign(dx.mul(k).mul(A).mul(cosT).negate());
        Bz.addAssign(dz.mul(k).mul(A).mul(cosT).negate());
        By.addAssign(Q.mul(k).mul(A).mul(sinT));
        // Jacobian of horizontal displacement, only meaningful for swell waves.
        if (w.isSwell) {
          const QAk = Q.mul(A).mul(k);
          Jxx.addAssign(QAk.mul(dx).mul(dx).mul(sinT).negate());
          Jzz.addAssign(QAk.mul(dz).mul(dz).mul(sinT).negate());
          Jxz.addAssign(QAk.mul(dx).mul(dz).mul(sinT).negate());
        }
      }
      // det(J) where J = I + ∂D/∂x etc. J<1 = compression, J<0 = surface folded.
      const detJ = float(1).add(Jxx).mul(float(1).add(Jzz)).sub(Jxz.mul(Jxz)).toVar();

      // Mid-frequency chop along wind direction with drift. Wind-scaled so calm seas stay mirror-flat.
      const windCos = cos(windDir); const windSin = sin(windDir);
      const drift = tNode.mul(windScale);
      const pMid = vec2(worldXZ.x.add(windCos.mul(drift.mul(0.5))),
                        worldXZ.y.add(windSin.mul(drift.mul(0.5)))).mul(rippleFreq);
      const nMid = fbmMid(pMid);
      const effRippleAmp = rippleAmp.mul(windScale).mul(1.4);
      Bx.addAssign(nMid.y.mul(effRippleAmp).negate());
      Bz.addAssign(nMid.z.mul(effRippleAmp).negate());

      // Micro ripples — high-freq glitter detail (mostly visible via sun specular).
      const pMicro = vec2(worldXZ.x.add(windCos.mul(drift.mul(2.0))),
                          worldXZ.y.add(windSin.mul(drift.mul(2.0)))).mul(microFreq);
      const nMicro = fbmMicro(pMicro);
      const effMicroAmp = microAmp.mul(windScale).mul(2.0);
      Bx.addAssign(nMicro.y.mul(effMicroAmp).negate());
      Bz.addAssign(nMicro.z.mul(effMicroAmp).negate());

      // Even tinier glitter for sparkle, sampled at very high freq.
      const pTiny = vec2(worldXZ.x.mul(5.0).add(tNode.mul(0.8)),
                         worldXZ.y.mul(5.0).add(tNode.mul(0.6)));
      const nTiny = valueNoiseD(pTiny);
      Bx.addAssign(nTiny.y.mul(windScale.mul(0.04)).negate());
      Bz.addAssign(nTiny.z.mul(windScale.mul(0.04)).negate());

      const n = normalize(vec3(Bx, float(1).sub(By).add(0.0001), Bz));
      // Pack jacobianDet into 4th channel for foam classifier.
      return vec4(n, detJ);
    });

    // ---- Vertex displacement ----
    mat.positionNode = Fn(() => {
      const wx = positionLocal.x.add(this._gridOffset.x);
      const wz = positionLocal.z.add(this._gridOffset.z);
      const xz = vec2(wx, wz);
      const w = evalGerstner(xz);

      // FBM mid + micro vertical displacement so silhouettes against the sun show
      // real ripple geometry (not just bump-mapped polygons).
      const windCos = cos(windDir); const windSin = sin(windDir);
      const windScale2 = min(max(pow(max(windSpeed, float(1)).mul(0.07), float(0.55)), float(0.4)), float(2.5));
      const drift = tNode.mul(windScale2);
      const pMid = vec2(wx.add(windCos.mul(drift.mul(0.3))),
                        wz.add(windSin.mul(drift.mul(0.3)))).mul(rippleFreq);
      const nMid = fbmMid(pMid);
      const extraYMid = nMid.x.sub(0.5).mul(rippleAmp.mul(windScale2).mul(0.9));

      const pMicroV = vec2(wx.add(windCos.mul(drift.mul(0.8))),
                           wz.add(windSin.mul(drift.mul(0.8)))).mul(microFreq);
      const nMicroV = fbmMicro(pMicroV);
      const extraYMicro = nMicroV.x.sub(0.5).mul(microAmp.mul(windScale2).mul(1.2));

      return vec3(
        positionLocal.x.add(w.x),
        positionLocal.y.add(w.y).add(extraYMid).add(extraYMicro),
        positionLocal.z.add(w.z),
      );
    })();

    // ---- Fragment color ----
    mat.colorNode = Fn(() => {
      const pWorld = positionWorld;
      const sampleXZ = vec2(pWorld.x, pWorld.z);

      const normalSample = evalNormal(sampleXZ);
      const n = normalize(normalSample.xyz).toVar();
      const jacobianDet = normalSample.w;
      // True whitecap mask: surface folding (J<1) — peaks at actual breaking waves,
      // not just tall crests like the old sin-threshold proxy.
      const whitecap = clamp(float(1.0).sub(jacobianDet).mul(2.5), 0.0, 1.0).toVar();

      const wEval = evalGerstner(sampleXZ);
      const crestFoam = wEval.w.add(whitecap.mul(0.7));
      const curvatureFoam = whitecap;

      // View / reflection
      const viewDir = normalize(cameraPosition.sub(pWorld)).toVar();
      const cosVN = clamp(dot(viewDir, n), 0.0, 1.0);
      // Schlick-style Fresnel with adjustable power.
      const f0 = float(0.02);
      const fresnel = f0.add(float(1).sub(f0).mul(pow(float(1.0).sub(cosVN), u.fresnelPow))).toVar();

      const reflectDir = normalize(viewDir.negate().sub(n.mul(float(2.0).mul(dot(viewDir.negate(), n))))).toVar();
      // Sky color via horizon/zenith mix; horizon is brighter near the sun.
      const horizonMix = smoothstep(-0.05, 0.65, reflectDir.y);
      const sunDir = normalize(this.sun.direction);
      const sunAlign = clamp(dot(reflectDir, sunDir), 0.0, 1.0);
      const horizonTint = mix(u.skyHorizon, u.sunCol, pow(sunAlign, float(8))).toVar();
      const skyColPure = mix(horizonTint, u.skyZenith, horizonMix).toVar();

      // ---- Planar reflection from the Reflector pass ----
      // Distortion grows with view distance because wave-aggregate over a long
      // ray breaks the mirror image up more. Multiplier exposed as a tunable.
      const camDist = length(pWorld.xz.sub(cameraPosition.xz));
      const distortionScale = float(0.022).add(smoothstep(float(40.0), float(400.0), camDist).mul(0.06))
        .mul(u.reflectionDistortion);
      const refUV = screenUV.add(vec2(n.x, n.z).mul(distortionScale));
      const reflSample = texture(this.reflector.target.texture, refUV).rgb;

      // Reflection contribution fades with distance (waves destroy coherent mirror).
      // Both the start/end of the fade AND the master strength are now uniforms so
      // users can dial down reflections that look too intrusive (e.g. islands
      // ghosting on the water surface around rocks).
      const reflectionFade = float(1.0).sub(smoothstep(u.reflectionFadeStart, u.reflectionFadeEnd, camDist));
      const reflectionMix = reflectionFade.mul(u.reflectionStrength);
      const skyCol = mix(skyColPure, reflSample, reflectionMix).toVar();

      // GGX-narrow sun lobe + anisotropic sun bar (elongates along view->sun vertical axis,
      // mimicking the way the rippled water smears the sun reflection into a vertical streak).
      const ggxNarrow = pow(sunAlign, float(80));
      const ggxBroad  = pow(sunAlign, float(18)).mul(0.45);
      // Sun bar: emphasizes alignment along the horizontal projection of sun dir.
      const sunHorizDir = normalize(vec3(sunDir.x, float(0), sunDir.z));
      const reflectHoriz = normalize(vec3(reflectDir.x, float(0), reflectDir.z));
      const azimAlign = clamp(dot(reflectHoriz, sunHorizDir), 0.0, 1.0);
      const sunBar = pow(azimAlign, float(60)).mul(pow(sunAlign, float(2))).mul(1.4);
      const sunSpec = ggxNarrow.add(ggxBroad).add(sunBar).mul(this.sun.intensity).mul(1.5);

      // Sparkle: fine high-freq glitter that depends on noise * sun alignment.
      const sparkleP = vec2(pWorld.x.mul(0.8), pWorld.z.mul(0.8));
      const sparkleN = valueNoiseD(sparkleP.add(vec2(tNode.mul(0.6), tNode.mul(0.5))));
      const sparkleMask = pow(max(sparkleN.x.sub(float(0.78)), float(0)).mul(3.5), float(2.0))
                          .mul(pow(sunAlign, float(20))).mul(u.sparkleInt).mul(u.sparkleEnabled);

      // ---- Sample refraction (scene rendered without water) for see-through ----
      // UV distortion scales with how oblique we're viewing: looking straight down
      // → small distortion (water is clear), grazing angle → no refraction (it would
      // expose seam artifacts at the horizon). The base distortion already gives the
      // surface a "rippled glass" look.
      const refractDistort = vec2(n.x, n.z).mul(float(0.035).mul(smoothstep(float(0.0), float(0.4), cosVN)));
      const refractUV = screenUV.add(refractDistort);
      const refractedScene = texture(this.refraction.target.texture, refractUV).rgb;

      // Sample scene depth at the (undistorted) screen position. Convert non-linear
      // depth → view-space Z using perspective formula.
      const depthSample = texture(this.refraction.target.depthTexture, screenUV).r;
      const sceneViewZ = this._cameraNear.mul(this._cameraFar).div(
        this._cameraFar.sub(depthSample.mul(this._cameraFar.sub(this._cameraNear)))
      );
      // Water fragment's own view-space Z (positive distance from camera plane).
      const waterViewPos = cameraViewMatrix.mul(vec4(pWorld, 1.0));
      const waterViewZ = waterViewPos.z.negate();
      // Distance from the water surface into the scene behind it. Two values:
      //   sceneDistRaw = actual measured distance (used for contact foam — needs big values)
      //   sceneDistAbsorb = clamped for Beer-Lambert (so open ocean with no occluder
      //                     past it doesn't go to total absorption / pure black)
      const sceneDistRaw = max(sceneViewZ.sub(waterViewZ), float(0.0)).toVar();
      const sceneDist = min(sceneDistRaw, u.depthFalloff.mul(1.8)).toVar();

      // ---- Water body color: Beer-Lambert on actual scene distance ----
      // Clarity scales absorption coefficients inversely — high clarity = low
      // absorption = see deeper. Useful for shallow tropical lagoons.
      const claritySafe = max(u.clarity, float(0.05));
      const absorption = vec3(0.45, 0.10, 0.05).div(claritySafe);
      const trans = vec3(
        exp(sceneDist.mul(absorption.x.div(u.depthFalloff)).negate()),
        exp(sceneDist.mul(absorption.y.div(u.depthFalloff)).negate()),
        exp(sceneDist.mul(absorption.z.div(u.depthFalloff)).negate()),
      );
      // Detect "no scene behind water" by checking sceneDistRaw. Use ramp from
      // 0..depthFalloff*1.5 — 1 means "occluder nearby" (full refraction blend),
      // 0 means "open water" (use deep/shallow mix instead of misleading sky lookup).
      const noOccluder = smoothstep(u.depthFalloff, u.depthFalloff.mul(2.5), sceneDistRaw);
      const hasOccluder = float(1.0).sub(noOccluder);
      const transAvg = trans.x.add(trans.y).add(trans.z).div(3.0);
      // Fallback (no occluder): traditional shallow→deep mix by view angle.
      const angleFade = smoothstep(float(0.0), float(0.6), cosVN);
      const fallbackBody = mix(u.deep, u.shallow.mul(0.7).add(u.deep.mul(0.3)), angleFade.mul(0.55).add(0.45));
      // Refraction path (occluder behind water): per-channel Beer-Lambert.
      // Boost refracted-scene visibility with clarity so kelp/sand reads as objects, not shadows.
      const visibleScene = mix(refractedScene, refractedScene.mul(1.2).add(0.03), smoothstep(float(1.0), float(2.0), u.clarity));
      // Distance-based diffusion (stronger): real water scatters light, distant
      // refracted objects should fade quickly so islands' submerged bases don't
      // ghost into giant mirage shapes at grazing angles. Coefficient bumped so
      // refraction falls off after ~depthFalloff·clarity meters.
      const diffusionFade = exp(sceneDist.mul(float(2.5).div(u.depthFalloff.mul(claritySafe))).negate());
      // Also fade out refraction at grazing view angles entirely — at low cosVN
      // the refraction sample tends to grab stretched off-axis pixels (the
      // "mirage" the user reported). Only show refraction when looking
      // reasonably-downward into the water.
      const refractionMask = smoothstep(float(0.15), float(0.55), cosVN);
      const refractedTinted = visibleScene.mul(trans).mul(diffusionFade).mul(refractionMask);
      // Body color when refraction faded: ramp to deep water color → behind a thick
      // water column you see deep color, not a giant mirror of the floor.
      const refractedBody = mix(u.deep, refractedTinted.add(u.shallow.mul(trans).mul(0.3)), transAvg.mul(diffusionFade).mul(refractionMask));
      const bodyCol = mix(fallbackBody, refractedBody, hasOccluder).toVar();

      // Subsurface scatter — light traveling through wave crests toward camera.
      const sssAmount = pow(max(dot(viewDir, sunDir), float(0)), float(3)).mul(u.sssInt).mul(max(wEval.y, float(0)).mul(0.4).add(0.15));
      bodyCol.addAssign(u.transmission.mul(sssAmount));

      // Combine: water * (1-F) + reflection * F + sun specular + sparkle.
      const F = clamp(fresnel.add(float(0.08)), float(0.08), float(0.85)).toVar();
      const reflectionTint = mix(vec3(1, 1, 1), bodyCol.mul(0.7).add(0.4), float(0.30));
      const aboveResult = mix(bodyCol, skyCol.mul(reflectionTint), F).toVar();
      aboveResult.addAssign(u.sunCol.mul(sunSpec));
      aboveResult.addAssign(vec3(1, 1, 0.9).mul(sparkleMask));

      // ---- Underwater path: viewed from below the water plane ----
      // Snell's window: looking nearly straight up, the surface acts as a circular
      // window into the sky (limited by total internal reflection at ~49°).
      // Outside the window we see darker reflected water.
      const viewUp = clamp(viewDir.y, 0, 1);
      const snellMask = smoothstep(float(0.55), float(0.85), viewUp);
      // Sun-direction glow at the window edge (the "boil" of light at TIR boundary).
      const sunSampleStrength = pow(sunAlign, float(40)).mul(this.sun.intensity);
      const underwaterTint = mix(vec3(0.05, 0.18, 0.22), vec3(0.20, 0.55, 0.55), snellMask);
      const surfaceFromBelow = mix(underwaterTint, skyCol, snellMask.mul(0.75))
        .add(u.sunCol.mul(sunSampleStrength.mul(snellMask))).toVar();
      // God-ray "caustic curtain" on the underside: animated value noise modulated
      // by sun alignment makes the surface flicker like sunlight refracting through
      // moving water onto an observer's eye.
      const causticP = vec2(pWorld.x.mul(0.4), pWorld.z.mul(0.4)).add(vec2(tNode.mul(0.5), tNode.mul(-0.3)));
      const causticNoise = valueNoiseD(causticP);
      const causticBright = pow(max(causticNoise.x.sub(float(0.45)), float(0)).mul(2.5), float(2.0));
      const godRayBoost = causticBright.mul(pow(sunAlign, float(6))).mul(this.sun.intensity).mul(0.8);
      surfaceFromBelow.addAssign(u.sunCol.mul(godRayBoost));

      // Pick path based on the camera's side of the water plane.
      let result = mix(aboveResult, surfaceFromBelow, this._isUnderwater).toVar();

      // ---- Persistent foam: sample the simulation RT ----
      // The foam simulation accumulates breaking events over time, advected by
      // wave velocity. Reading it here gives streaks that LINGER instead of
      // recomputed-each-frame turbulence. World XZ → RT UV.
      const foamHalfSize = this.foamSim.halfSizeUniform;
      const foamCenter = this.foamSim.centerXZUniform;
      const foamUVProj = vec2(
        pWorld.x.sub(foamCenter.x).div(foamHalfSize).mul(0.5).add(0.5),
        pWorld.z.sub(foamCenter.y).div(foamHalfSize).mul(0.5).add(0.5),
      );
      const persistentFoam = texture(this.foamSim.currentTexture, foamUVProj).r;
      // currentTexture is a TextureNode whose .value we swap each frame —
      // texture() above accepts a node and samples at runtime.

      // ---- Foam: NEW (turbulence-based, sharp, directional) ----
      // Aim: replace the previous "blurry paint" look with lace/streak foam matching
      // commercial ocean libraries. Three layers all share the same texture base
      // so they composite consistently.
      const windCos2 = cos(windDir); const windSin2 = sin(windDir);
      const driftFoam = tNode.mul(max(windSpeed.mul(0.04), float(0.1)));
      // UV: stretch ALONG wind direction (anisotropy 2.5x) so streaks elongate downwind.
      // Then advect with displaced position so the foam pattern flows with the water.
      const windDirVec = vec2(windCos2, windSin2);
      const perpDirVec = vec2(windSin2.negate(), windCos2);
      const advectedXZ = vec2(pWorld.x.add(wEval.x), pWorld.z.add(wEval.z));
      // Coordinate frame: u along wind, v perpendicular.
      const uAlongWind  = dot(advectedXZ.add(windDirVec.mul(driftFoam.mul(2.0))), windDirVec);
      const vCrossWind  = dot(advectedXZ.add(perpDirVec.mul(driftFoam.mul(0.4))), perpDirVec);
      // Anisotropic stretch in wind direction.
      const foamUV = vec2(uAlongWind.div(u.foamWavesSize.mul(2.0)),
                          vCrossWind.div(u.foamWavesSize));

      // Turbulence at two scales — large structure + fine detail.
      const turbBig   = turbulence(foamUV);
      const turbMed   = turbulence(foamUV.mul(2.0).add(vec2(4.1, 7.8)));
      const turbFine  = turbulence(foamUV.mul(5.0).add(vec2(11.7, 5.3)));
      // Ridge bands via smoothstep — bright cores fading at edges, like real foam.
      // Tighter band on the BIG scale ensures branching, not solid coverage.
      const lace      = smoothstep(float(0.26), float(0.13), turbBig);
      const laceMed   = smoothstep(float(0.22), float(0.10), turbMed);
      const laceFine  = smoothstep(float(0.20), float(0.08), turbFine);
      // Multiplicative combine — both medium AND fine must agree → more individuated streaks.
      const baseFoam = lace.mul(0.7).add(lace.mul(laceMed).mul(0.6));
      const detailFoam = laceMed.mul(laceFine).mul(0.5);
      const foamCombined = max(baseFoam, detailFoam);
      // Bright core highlight: where multiple lace layers overlap → pure white core.
      const foamCore = pow(lace.mul(laceMed), float(0.6)).mul(0.5);
      const foamTex = clamp(foamCombined.add(foamCore), 0.0, 1.4);

      // ---- (1) Wave-crest foam ----
      // Persistent foam (history, lingering trails) modulated by local lace texture
      // for fine inner structure. Persistent dominates the silhouette; lace shapes
      // the bright cores.
      const crestMask = clamp(pow(crestFoam, float(1.3)), 0.0, 1.5);
      const crestGate = smoothstep(float(0.10), float(0.45), crestMask);
      const localFoam = foamTex.mul(crestGate);
      // The persistent RT provides the SHAPE+HISTORY; local foam adds inner texture
      // ONLY where persistent foam is present (foamTex × persistent).
      const foamShape = persistentFoam;
      const foamInner = foamTex.mul(persistentFoam.mul(2.0).add(0.2));
      const foamCombinedSource = max(foamShape, foamInner.mul(0.6));
      const wavesFoam = clamp(foamCombinedSource, 0.0, 1.0)
                          .mul(u.foamWavesCoverage)
                          .mul(u.foamWavesPeakInt)
                          .mul(u.foamWavesOpacity)
                          .mul(u.foamWavesEnabled);

      // (2) Surface foam: residual lace streaks across the open water.
      // Coverage now means literally "fraction of pixels showing foam":
      //   coverage 0   → no foam
      //   coverage 0.5 → roughly half the eligible area
      //   coverage 1   → everywhere the noise has a ridge
      // Previously the threshold was tied to a fixed turbulence value so tiny
      // coverage values still painted the whole surface white.
      const surfTex = turbulence(foamUV.mul(0.5).add(vec2(driftFoam.mul(0.1), driftFoam.mul(0.05))));
      // surfTex range is roughly [0, 0.42] for turbulence(2D, 5 octaves).
      // Move the threshold inversely with coverage so coverage=0 keeps threshold
      // at the top end (no pixel passes) and coverage=1 brings it to 0 (everything).
      const surfThreshold = mix(float(0.42), float(-0.02), clamp(u.foamSurfaceCoverage, 0.0, 1.0));
      const surfFoam = smoothstep(surfThreshold.add(0.05), surfThreshold, surfTex)
                          .mul(u.foamSurfaceOpacity).mul(u.foamSurfaceEnabled);

      // (3) Shore foam: thin animated band where curvature spikes (Jacobian whitecap).
      const shoreTex = turbulence(foamUV.mul(1.5).add(vec2(2.7, 9.3)));
      const shoreLace = clamp(float(0.40).sub(shoreTex).mul(6.0), 0.0, 1.0);
      const shoreMask = clamp(pow(curvatureFoam, float(1.5)).mul(2.0).mul(u.foamShoreCoverage), 0.0, 1.0);
      const shoreFoam = shoreMask.mul(shoreLace).mul(u.foamShoreOpacity).mul(u.foamShoreEnabled);

      // Sun-asymmetry factor: dims foam on the lee (shadow) side of objects.
      // The user noticed identical foam on both sides of every rock — this
      // factor makes the wind/sun-facing side brighter and the lee side darker.
      const sunFacing = clamp(dot(sunDir.xz, vec2(viewDir.x, viewDir.z).negate().normalize()), 0.0, 1.0);

      // ---- Contact foam from depth comparison ----
      // Where the water surface is close to a behind-water object, a bright LACE
      // foam band appears. Uses the same turbulence base for visual coherence with
      // the rest of the foam — no more "blurry paint" look.
      const contactDist = sceneDistRaw;
      // Sharp rim band immediately at the contact, plus a wider noise-gated halo.
      const tightBand = smoothstep(u.foamContactDistance.mul(0.2), float(0.0), contactDist);
      const wideBand = smoothstep(u.foamContactDistance, float(0.0), contactDist);
      // High-frequency lace pattern around objects, advected slightly to feel "alive".
      const contactUV = vec2(pWorld.x.mul(1.2), pWorld.z.mul(1.2)).add(vec2(driftFoam.mul(0.5), driftFoam.mul(0.3)));
      const contactTurb = turbulence(contactUV);
      const contactLace = clamp(float(0.38).sub(contactTurb).mul(7.0), 0.0, 1.0);
      // Tight rim (always white at the very edge) + broader noise-gated streaks.
      const rimFoam = tightBand;
      const haloFoam = wideBand.mul(contactLace.mul(0.9).add(0.1));
      // Asymmetric contact foam: brighter where waves driven by wind+sun crash into
      // objects, dimmer on the lee side. The sunFacing factor pushes the halo
      // strongly in one direction so the user no longer sees identical foam on
      // both sides of every rock.
      const contactAsym = sunFacing.mul(0.7).add(0.3); // [0.3, 1.0] — never fully zero
      const contactFoam = clamp(rimFoam.mul(0.7).add(haloFoam.mul(0.8)), 0.0, 1.0)
        .mul(u.foamContactCoverage).mul(u.foamContactOpacity).mul(u.foamContactEnabled)
        .mul(contactAsym);

      // ---- Splash burst: PHYSICS-driven. No arbitrary time pulse.
      // Triggered only by actual wave-object collision energy:
      //   • proximity: water surface within 2m of an opaque scene object
      //   • whitecap: Jacobian fold (surface compressing → real wave breaking)
      //   • verticalEnergy: wave crest rising above resting position
      //   • surfaceSlope: how much the local normal tilts (steep wave face = high energy)
      // These multiplied give a per-fragment "splash energy" that varies organically
      // with the actual wave field rather than a sin(t) wobble.
      const proximityMask = smoothstep(float(2.0), float(0.0), contactDist);
      const verticalEnergy = clamp(wEval.y.mul(0.6), 0.0, 1.0);     // crest height above 0
      const surfaceSlope = float(1.0).sub(clamp(n.y, 0.0, 1.0));    // 0 flat, ~0.3 steep
      const breaking = clamp(whitecap.mul(1.5), 0.0, 1.0);          // Jacobian < 1
      // Multiplicative gate — splash needs ALL: close to object, wave rising, and breaking.
      const splashEnergy = proximityMask
        .mul(verticalEnergy.add(breaking))
        .mul(surfaceSlope.mul(2.0).add(0.4));
      // Splash texture: turbulence advected with the WAVE DISPLACEMENT (no time term).
      // The pattern flows naturally with the surface, which makes it feel attached to
      // the physical event instead of pulsing arbitrarily.
      const splashUV = vec2(pWorld.x.add(wEval.x).mul(2.5), pWorld.z.add(wEval.z).mul(2.5));
      const splashTurb = turbulence(splashUV);
      const splashLace = smoothstep(float(0.30), float(0.08), splashTurb);
      const splashTwinkle = pow(max(valueNoiseD(splashUV.mul(4.0)).x.sub(0.5), float(0)).mul(3.5), float(1.5));
      const splashFoam = clamp(
        splashEnergy.mul(splashLace.add(splashTwinkle.mul(1.5))).mul(u.splashIntensity).mul(1.6),
        0.0, 2.0,
      ).mul(u.splashEnabled);

      // ---- Sun-directional foam lighting ----
      const NdotL = clamp(dot(n, sunDir), 0.0, 1.0);
      const foamLit = NdotL.mul(0.8).add(0.2);
      const foamShadowTint = mix(u.skyHorizon, vec3(1.0, 1.0, 1.0), float(0.45));
      const foamLitTint = mix(foamShadowTint, u.sunCol, NdotL);

      // CORRECTED FOAM COMPOSITION — code audit flagged the previous order:
      // ambient surface foam was painted LAST and obscured wave-crest foam.
      // Now we composite physically: combine all foam intensities into a SINGLE
      // alpha, pick the colour of the strongest contributor, blend once.
      // This avoids the over-paint problem and lets crest foam stay visible
      // through ambient surface haze.
      const allFoamA = clamp(shoreFoam.add(surfFoam).add(wavesFoam).add(contactFoam).add(splashFoam), 0.0, 1.0);
      // Pick dominant colour by max intensity layer.
      const layers = [
        { color: u.foamShoreColor, a: shoreFoam },
        { color: u.foamSurfaceColor, a: surfFoam },
        { color: u.foamWavesColor, a: wavesFoam },
        { color: u.foamContactColor, a: contactFoam },
      ];
      // Weighted-average colour across layers; splash gets pure-white bonus added separately.
      const weightedColor = u.foamShoreColor.mul(shoreFoam)
        .add(u.foamSurfaceColor.mul(surfFoam))
        .add(u.foamWavesColor.mul(wavesFoam))
        .add(u.foamContactColor.mul(contactFoam))
        .div(max(allFoamA, float(0.0001)));
      const splashBoost = vec3(1.10, 1.10, 1.05).mul(splashFoam);
      const finalFoamColor = weightedColor.mul(foamLitTint).mul(foamLit).add(splashBoost);
      result = mix(result, finalFoamColor, allFoamA);

      // ---- Atmospheric horizon fade (above water only) ----
      const dist = length(pWorld.xz.sub(cameraPosition.xz));
      const fogMix = clamp(
        pow(smoothstep(u.fogFadeStart, u.fogFadeStart.mul(5.0), dist), u.fogFadePower),
        0.0, 1.0,
      ).mul(u.fogEnabled).mul(float(1.0).sub(this._isUnderwater));
      result = mix(result, mix(u.skyHorizon, u.skyZenith, float(0.15)), fogMix);

      return vec4(result, u.alpha);
    })();

    return mat;
  }

  // -------- Lifecycle --------
  async update(deltaTime = 0) {
    if (this._disposed) return;
    const speed = this.waves.animationSpeed;
    this._timeAccum += deltaTime * speed;
    this._tShader.value = this._timeAccum;

    // CPU-side derived uniform updates (saves ~20 ALU per fragment per frame).
    const ws = Math.max(1, this.waves.windSpeed.value);
    const windScaleVal = Math.min(2.5, Math.max(0.4, Math.pow(ws * 0.07, 0.55)));
    this._cpuDerived.windScale.value = windScaleVal;
    const wd = this.waves.windDirection.value;
    this._cpuDerived.windCosSin.value.set(Math.cos(wd), Math.sin(wd));
    const sd = this.sun.direction.value;
    this._cpuDerived.sunDirNorm.value.copy(sd).normalize();

    if (this.cameraTracking && this._mesh && this.camera) {
      const cx = this.camera.position.x, cz = this.camera.position.z;
      this._mesh.position.set(cx, 0, cz);
      this._gridOffset.value.set(cx, 0, cz);
      this.floor.getMesh().position.set(cx, this.floor.getMesh().position.y, cz);
    }
    // Track whether the camera is below the water plane (controls underwater fog).
    this._isUnderwater.value = this.camera.position.y < 0 ? 1 : 0;

    // Update camera near/far uniforms (in case projection changed).
    this._cameraNear.value = this.camera.near;
    this._cameraFar.value = this.camera.far;

    // Render reflection BEFORE the main render so the water material samples a
    // fresh texture. Skip the pass when underwater — it isn't visible from below.
    // Build hide-list: water mesh + ocean floor + any caller-tagged underwater
    // objects (kelp, particles, anything BELOW y=0 should not appear in the
    // above-water reflection).
    if (this.reflector && this.camera.position.y >= 0) {
      const hides = [this._mesh, this.floor.getMesh()];
      // Auto-include everything tagged `userData.underwater = true`.
      this.scene.traverse((o) => {
        if (o.userData && o.userData.underwater) hides.push(o);
      });
      this.reflector.update(this.renderer, this.scene, this.camera, hides);
    }
    // Refraction pass: render scene minus water from main camera. We keep the
    // ocean floor in this pass so refraction shows the seabed.
    if (this.refraction) {
      this.refraction.update(this.renderer, this.scene, this.camera, [this._mesh]);
    }
    // Foam simulation step — runs one ping-pong pass to evolve persistent foam.
    if (this.foamSim) {
      this.foamSim.update(this.renderer, this.camera, deltaTime, this._timeAccum);
    }

    const c = this.color, u = this._u;
    u.shallow.value.copy(c.shallowWaterColor);
    u.deep.value.copy(c.deepWaterColor);
    u.depthFalloff.value = c.depthFalloff;
    u.alpha.value = c.alpha;
    u.transmission.value.copy(c.transmissionColor);
    u.fresnelPow.value     = this.fresnel.power;
    u.fresnelNormStr.value = this.fresnel.normalStrength;
    u.sparkleInt.value     = this.sparkle.intensity;
    u.sparklePow.value     = this.sparkle.power;
    u.sparkleEnabled.value = this.sparkle.enabled ? 1 : 0;
    u.sssInt.value         = this.sss.enabled ? this.sss.intensity : 0;
    u.ssrEnabled.value     = this.ssr.enabled ? 1 : 0;
    u.ssrStrength.value    = this.ssr.strength;
    u.foamSurfaceColor.value.copy(this.foam.surface.color);
    u.foamSurfaceCoverage.value = this.foam.surface.coverage;
    u.foamSurfaceOpacity.value  = this.foam.surface.opacity;
    u.foamSurfaceSize.value     = this.foam.surface.size;
    u.foamSurfaceEnabled.value  = this.foam.surface.enabled ? 1 : 0;
    u.foamWavesColor.value.copy(this.foam.waves.color);
    u.foamWavesCoverage.value = this.foam.waves.coverage;
    u.foamWavesOpacity.value  = this.foam.waves.opacity;
    u.foamWavesCrestCov.value = this.foam.waves.crestCoverage;
    u.foamWavesPeakInt.value  = this.foam.waves.peakIntensity;
    u.foamWavesSize.value     = this.foam.waves.size;
    u.foamWavesEnabled.value  = this.foam.waves.enabled ? 1 : 0;
    u.foamShoreColor.value.copy(this.foam.shoreline.color);
    u.foamShoreCoverage.value = this.foam.shoreline.coverage;
    u.foamShoreOpacity.value  = this.foam.shoreline.opacity;
    u.foamShoreRange.value    = this.foam.shoreline.range;
    u.foamShoreSize.value     = this.foam.shoreline.size;
    u.foamShoreEnabled.value  = this.foam.shoreline.enabled ? 1 : 0;
    u.foamContactColor.value.copy(this.foam.contact.color);
    u.foamContactCoverage.value = this.foam.contact.coverage;
    u.foamContactOpacity.value  = this.foam.contact.opacity;
    u.foamContactDistance.value = this.foam.contact.distance;
    u.foamContactEnabled.value  = this.foam.contact.enabled ? 1 : 0;
    u.clarity.value             = c.clarity ?? 1.0;
    u.splashEnabled.value       = this.splash.enabled ? 1 : 0;
    u.splashIntensity.value     = this.splash.intensity;
    u.reflectionStrength.value   = this.reflection.strength;
    u.reflectionFadeStart.value  = this.reflection.fadeStart;
    u.reflectionFadeEnd.value    = this.reflection.fadeEnd;
    u.reflectionDistortion.value = this.reflection.distortionStrength;
    u.fogEnabled.value     = this.fog.enabled ? 1 : 0;
    u.fogFadeStart.value   = this.fog.fadeStart;
    u.fogFadePower.value   = this.fog.fadePower;

    if (this._sky) {
      const horizon = this._sky.getHorizonColor();
      u.skyHorizon.value.copy(horizon);
      const zen = this._sky.atmosphereUniforms?.skyColor?.value;
      if (zen) u.skyZenith.value.copy(zen);
      const sunDir = this._sky.sunUniforms?.direction?.value;
      if (sunDir) this.sun.direction.value.copy(sunDir);
      const sunCol = this._sky.sunDiskUniforms?.color?.value;
      if (sunCol) u.sunCol.value.copy(sunCol);
      const sunI = this._sky.sunUniforms?.intensity?.value;
      if (sunI != null) this.sun.intensity.value = sunI;
    }
    this._mesh.material.wireframe = this.wireframe;

    await this.buoyancy.update(deltaTime);
  }

  render() { if (!this._disposed) this.renderer.render(this.scene, this.camera); }

  resize(width, height) {
    const w = width ?? window.innerWidth, h = height ?? window.innerHeight;
    this.renderer.setSize(w, h);
  }

  async dispose() {
    this._disposed = true;
    if (this._mesh) {
      this.scene.remove(this._mesh);
      this._mesh.geometry.dispose();
      this._material?.dispose();
    }
    if (this.floor) { this.scene.remove(this.floor.getMesh()); this.floor.dispose(); }
    if (this._sky) { try { this._sky.dispose(); } catch {} }
    if (this.reflector) { this.reflector.dispose(); }
    this.buoyancy?.clear?.();
  }

  setSky(provider) {
    if (this._sky && this._sky !== provider) { try { this.scene.remove(this._sky.getMesh()); } catch {} }
    this._sky = provider ?? null;
  }
  setEnvironmentMap(/* envMap */) { /* MVP: noop */ }

  loadPreset(p) { if (typeof p === "string") throw new Error("Pass a preset object; use getPresetParams(name) first."); applyPreset(this, p); }

  async setQualityLevel(quality, params) {
    this.config = getQualityConfig(quality);
    this.quality = quality;
    this._geomConfig = { ...this._geomConfig, segments: Math.max(96, this.config.meshSegments * 1.5) };
    this.gerstner.count = this.config.gerstnerCount > 0 ? this.config.gerstnerCount : Math.max(2, this.gerstner.count);
    this.gerstner._build();
    this._buildMesh();
    if (params) applyPreset(this, params);
  }

  rebuildGeometry(cfg) { this._geomConfig = { ...this._geomConfig, ...cfg }; this._buildMesh(); }
  getGeometryConfig() { return { ...this._geomConfig }; }
  async recreateOceanFloor(opts = {}) {
    const pos = this.floor.getMesh().position.clone();
    this.scene.remove(this.floor.getMesh()); this.floor.dispose();
    this.floor = new OceanFloor({ size: this._geomConfig.baseSize * 2, depth: opts.depth ?? 18, meshResolution: opts.meshResolution ?? 64 });
    this.floor.getMesh().position.copy(pos);
    this.scene.add(this.floor.getMesh());
  }
  updateCascadeConfig(index, cfg) {
    if (index === 0 && cfg.amplitude != null) this._u.cascadeWaveAmp.value = cfg.amplitude;
    if (index === 1 && cfg.amplitude != null) this._u.cascadeRippleAmp.value = cfg.amplitude;
  }
  setPosition(x, z) { this._mesh.position.set(x, 0, z); this._gridOffset.value.set(x, 0, z); }
  async getHeightAt(x, z) { const r = await this.sampler.sampleAt(x, z); return r.height; }
  createPostProcessingNode(scenePass, inputColor) { return inputColor ?? scenePass?.getTextureNode?.("output"); }
}

WaterSystem.prototype.applyPreset = function (p) { applyPreset(this, p); };

function applyPreset(water, p) {
  if (!p) return;
  if (p.waves) {
    for (const [k, v] of Object.entries(p.waves)) {
      if (water.waves[k]?.value !== undefined) water.waves[k].value = v;
      else water.waves[k] = v;
    }
  }
  if (p.gerstner) water.gerstner.update(p.gerstner);
  if (p.color) for (const [k, v] of Object.entries(p.color)) {
    if (water.color[k] instanceof THREE.Color) water.color[k].set(v);
    else water.color[k] = v;
  }
  if (p.fresnel) Object.assign(water.fresnel, p.fresnel);
  if (p.sparkle) Object.assign(water.sparkle, p.sparkle);
  if (p.sun?.intensity != null) water.sun.intensity.value = p.sun.intensity;
  if (p.foam) {
    for (const g of ["surface", "waves", "shoreline"]) {
      if (p.foam[g]) for (const [k, v] of Object.entries(p.foam[g])) {
        if (water.foam[g][k] instanceof THREE.Color) water.foam[g][k].set(v);
        else water.foam[g][k] = v;
      }
    }
  }
  if (p.underwater) {
    if (p.underwater.fogColor) water.underwater.fogUniforms.color.value.set(p.underwater.fogColor);
    if (p.underwater.fogDensity != null) water.underwater.fogUniforms.density.value = p.underwater.fogDensity;
    if (p.underwater.distortionIntensity != null) water.underwater.distortionUniforms.intensity.value = p.underwater.distortionIntensity;
    if (p.underwater.distortionScale != null) water.underwater.distortionUniforms.scale.value = p.underwater.distortionScale;
    if (p.underwater.distortionSpeed != null) water.underwater.distortionUniforms.speed.value = p.underwater.distortionSpeed;
  }
  if (p.fog) Object.assign(water.fog, p.fog);
}
