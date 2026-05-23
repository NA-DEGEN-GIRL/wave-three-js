// FoamSimulation — persistent ping-pong foam accumulation buffer.
//
// This is the missing piece that separates "procedural noise foam" from
// "alive ocean foam". Each frame:
//   1. Sample PREVIOUS foam at an advected UV (warped by wave-surface velocity)
//   2. Decay exponentially                                  foam *= exp(-decay·dt)
//   3. Add BIRTH from breaking waves (Jacobian < threshold) + a global growth term
//   4. Output to write target → swap targets
//
// The water material then samples THIS RT (in world-XZ projection) for the lace
// foam term, replacing the previous stateless turbulence approach. Result:
// foam streaks LINGER and TRAIL with the wave field, exactly like Sea of
// Thieves / WaveWorks foam.

import * as THREE from "three/webgpu";
import {
  Fn, vec2, vec3, vec4, float, uniform, texture, uv, fract, floor, sin, cos,
  dot, mix, clamp, max, min, abs, pow, exp, length, uniformArray,
} from "three/tsl";

const MAX_WAKE_SOURCES = 16;

// Same hash & noise primitives as WaterSystem so birth term matches the
// per-pixel foam pattern visually.
const hash22 = Fn(([p]) => {
  const x = fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
  const y = fract(sin(dot(p, vec2(269.5, 183.3))).mul(43758.5453));
  return vec2(x, y);
});

const valueNoise2 = Fn(([p]) => {
  const i = floor(p).toVar();
  const f = p.sub(i).toVar();
  const u = f.mul(f).mul(f.mul(-2.0).add(3.0));
  const a = hash22(i).x;
  const b = hash22(i.add(vec2(1, 0))).x;
  const c = hash22(i.add(vec2(0, 1))).x;
  const d = hash22(i.add(vec2(1, 1))).x;
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

const turbulence2 = Fn(([p]) => {
  let amp = float(0.5).toVar();
  let freq = float(1.0).toVar();
  let sum = float(0).toVar();
  const pv = p.toVar();
  for (let i = 0; i < 4; i++) {
    sum.addAssign(abs(valueNoise2(pv.mul(freq)).sub(0.5)).mul(amp));
    freq.assign(freq.mul(2.07));
    amp.assign(amp.mul(0.55));
  }
  return sum;
});

export class FoamSimulation {
  constructor({
    resolution = 1024,
    worldSize = 200,    // RT covers ±100m around centre by default
    decayRate = 0.65,   // per second; lower = foam lingers longer
    advectionStrength = 1.0,
  } = {}) {
    this.resolution = resolution;
    this.worldSize = worldSize;
    this.decayRate = decayRate;
    this.advectionStrength = advectionStrength;

    // Ping-pong RGBA targets. Channel layout:
    //   R = persistent foam intensity [0..1]
    //   G = age / strength (for future use — wet flag)
    //   B = velocity x (for advection chaining, optional)
    //   A = velocity z
    const opts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, generateMipmaps: false };
    this.targetA = new THREE.RenderTarget(resolution, resolution, opts);
    this.targetB = new THREE.RenderTarget(resolution, resolution, opts);

    // TextureNode wrappers — `.value` is reassigned each frame so the simulation
    // material and the water material both keep a stable graph reference but
    // sample the latest ping-pong target.
    this._prevTextureNode = texture(this.targetA.texture);
    this._outputTextureNode = texture(this.targetA.texture);

    // Uniforms shared with the simulation material.
    this._u = {
      centerXZ:       uniform(new THREE.Vector2(0, 0)),
      // UV-space offset from PREVIOUS centre to current centre. Subtracted from
      // prev-sample UV so foam stays anchored to world coordinates when the camera
      // moves — without this you'd see foam jitter / drift on fast pans.
      recenterShift:  uniform(new THREE.Vector2(0, 0)),
      worldHalfSize:  uniform(worldSize * 0.5),
      decayRate:      uniform(decayRate),
      dt:             uniform(0.016),
      tAccum:         uniform(0),
      // Wave field uniforms shared from WaterSystem:
      windDir:        null,  // assigned by WaterSystem.init
      windSpeed:      null,
      choppiness:     null,
      ampGlobal:      null,
      waves:          [],    // populated when WaterSystem rebuilds
      birthRate:      uniform(0.65),
      birthThreshold: uniform(0.55), // Jacobian threshold below which foam is born
      // Wake sources — moving boats splat foam at their position each frame.
      // Each entry: vec3(worldX, worldZ, strength). Slots > wakeCount are skipped.
      wakeSources:    uniformArray(new Array(MAX_WAKE_SOURCES).fill(new THREE.Vector3())),
      wakeCount:      uniform(0),
      wakeRadius:     uniform(1.6), // metres
      wakeStrength:   uniform(2.5), // birth rate multiplier inside the wake radius
    };

    // Built when WaterSystem hands us waves+uniforms via attach()
    this._simScene = new THREE.Scene();
    this._simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._simQuad = null;
    this._attached = false;
    this._frame = 0;
  }

  /**
   * Connect the simulation to a WaterSystem (wave field) and build the
   * simulation material. Called once after the WaterSystem has its Gerstner
   * bank ready and re-called whenever the wave count changes.
   */
  attach({ waves, windDir, windSpeed, choppiness, ampGlobal }) {
    this._u.windDir = windDir;
    this._u.windSpeed = windSpeed;
    this._u.choppiness = choppiness;
    this._u.ampGlobal = ampGlobal;
    this._u.waves = waves;
    this._buildSimulationMaterial();
    this._attached = true;
  }

  _buildSimulationMaterial() {
    if (this._simQuad) {
      this._simScene.remove(this._simQuad);
      this._simQuad.geometry.dispose();
      this._simQuad.material.dispose();
    }
    const geom = new THREE.PlaneGeometry(2, 2);
    const mat = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });

    const u = this._u;
    const waves = u.waves;

    // Computes per-fragment Jacobian determinant of horizontal displacement,
    // matching WaterSystem.evalNormal — foam is born where the surface folds.
    const evalJacobian = Fn(([worldXZ, t]) => {
      const Jxx = float(0).toVar();
      const Jzz = float(0).toVar();
      const Jxz = float(0).toVar();
      const windScale = min(max(pow(max(u.windSpeed, float(1)).mul(0.07), float(0.55)), float(0.4)), float(2.5));
      for (const w of waves) {
        if (!w.isSwell) continue; // ripples don't break — only swell foam matters here
        const dir = u.windDir.add(float(w.dirAngle));
        const dx = cos(dir); const dz = sin(dir);
        const k = float((2 * Math.PI) / w.wavelength);
        const omega = float(Math.sqrt(9.81 * (2 * Math.PI) / w.wavelength));
        const A = float(w.amplitude).mul(u.ampGlobal).mul(windScale);
        const theta = k.mul(dx.mul(worldXZ.x).add(dz.mul(worldXZ.y))).sub(omega.mul(t)).add(float(w.phase));
        const sinT = sin(theta);
        const Q = float(w.steepness).mul(u.choppiness).div(float(waves.length));
        const QAk = Q.mul(A).mul(k);
        Jxx.addAssign(QAk.mul(dx).mul(dx).mul(sinT).negate());
        Jzz.addAssign(QAk.mul(dz).mul(dz).mul(sinT).negate());
        Jxz.addAssign(QAk.mul(dx).mul(dz).mul(sinT).negate());
      }
      const detJ = float(1).add(Jxx).mul(float(1).add(Jzz)).sub(Jxz.mul(Jxz));
      return detJ;
    });

    // Compute approximate surface velocity = ∂displacement / ∂t at this point.
    // Used to advect the foam (foam flows with the wave field instead of being stuck
    // in world space). Sample horizontal-displacement time derivative for swell waves.
    const evalVelocityXZ = Fn(([worldXZ, t]) => {
      const vx = float(0).toVar();
      const vz = float(0).toVar();
      const windScale = min(max(pow(max(u.windSpeed, float(1)).mul(0.07), float(0.55)), float(0.4)), float(2.5));
      for (const w of waves) {
        if (!w.isSwell) continue;
        const dir = u.windDir.add(float(w.dirAngle));
        const dx = cos(dir); const dz = sin(dir);
        const k = float((2 * Math.PI) / w.wavelength);
        const omega = float(Math.sqrt(9.81 * (2 * Math.PI) / w.wavelength));
        const A = float(w.amplitude).mul(u.ampGlobal).mul(windScale);
        const theta = k.mul(dx.mul(worldXZ.x).add(dz.mul(worldXZ.y))).sub(omega.mul(t)).add(float(w.phase));
        const Q = float(w.steepness).mul(u.choppiness).div(float(waves.length));
        // d(disp_x)/dt = Q·A·dx · ω·sin(θ); we don't need d(y)/dt for advection.
        vx.addAssign(Q.mul(A).mul(dx).mul(omega).mul(sin(theta)));
        vz.addAssign(Q.mul(A).mul(dz).mul(omega).mul(sin(theta)));
      }
      return vec2(vx, vz);
    });

    mat.colorNode = Fn(() => {
      // Reconstruct world XZ from quad UV ([0,1] → [-half, +half] centred on camera).
      const worldXZ = uv().mul(2.0).sub(1.0).mul(u.worldHalfSize).add(u.centerXZ);

      // Sample previous foam:
      //   1) Recenter shift — compensate for camera-driven centerXZ change so foam
      //      stays anchored in world space (no drift jitter when panning).
      //   2) Wave advection — shift UV against surface velocity so foam flows
      //      naturally with the water.
      const v = evalVelocityXZ(worldXZ, u.tAccum);
      const advectUVOffset = v.mul(u.dt).mul(0.5).div(u.worldHalfSize);
      const prevUV = uv().add(u.recenterShift).sub(advectUVOffset);
      const prev = texture(this._prevTextureNode, prevUV);

      // Decay previous foam.
      const decayFactor = exp(u.decayRate.mul(u.dt).negate());
      const decayed = prev.r.mul(decayFactor);

      // Birth from breaking waves (Jacobian fold).
      const detJ = evalJacobian(worldXZ, u.tAccum);
      const breakAmt = clamp(u.birthThreshold.sub(detJ).mul(2.5), 0.0, 1.0);
      const turbMod = turbulence2(worldXZ.mul(0.08));
      const lace = clamp(float(0.30).sub(turbMod).mul(8.0), 0.0, 1.0);
      const breakBirth = breakAmt.mul(lace.mul(0.7).add(0.3)).mul(u.birthRate);

      // Birth from boat wakes — splat a small Gaussian at each active source.
      // Unrolled loop over MAX_WAKE_SOURCES; entries past wakeCount have
      // strength 0 (set by setWakeSources) and contribute nothing.
      const wakeBirth = float(0).toVar();
      for (let i = 0; i < MAX_WAKE_SOURCES; i++) {
        const src = u.wakeSources.element(i);
        const d = length(vec2(src.x, src.y).sub(worldXZ));
        const falloff = clamp(float(1.0).sub(d.div(u.wakeRadius)), 0.0, 1.0);
        wakeBirth.addAssign(falloff.mul(src.z).mul(u.wakeStrength));
      }

      const birth = breakBirth.add(wakeBirth).mul(u.dt);

      // Accumulate, clamp.
      const foam = clamp(decayed.add(birth), 0.0, 1.0);

      // Optional: store velocity into BA so a future wet-rock shader can read it.
      return vec4(foam, prev.g, v.x, v.y);
    })();

    this._simMat = mat;
    this._simQuad = new THREE.Mesh(geom, mat);
    this._simScene.add(this._simQuad);
  }

  /**
   * Returns the TextureNode the WATER material should sample for foam. The node's
   * `.value` is reassigned each frame to point at the latest ping-pong target.
   */
  get currentTexture() { return this._outputTextureNode; }

  /**
   * Center/half-size uniforms so the water material can do the same world→UV
   * mapping when sampling the texture.
   */
  get centerXZUniform() { return this._u.centerXZ; }
  get halfSizeUniform() { return this._u.worldHalfSize; }

  /**
   * Public knobs.
   */
  setDecayRate(r) { this.decayRate = r; this._u.decayRate.value = r; }
  setBirthRate(r) { this._u.birthRate.value = r; }
  setWorldSize(s) { this.worldSize = s; this._u.worldHalfSize.value = s * 0.5; }

  /**
   * Register wake-emitting positions. Each source = (worldX, worldZ, strength).
   * Up to MAX_WAKE_SOURCES (16) — extras are dropped.
   * Typical use: call from WaterSystem.update() with current boat positions
   * weighted by velocity magnitude (slow boat → tiny strength, fast boat → 1).
   */
  setWakeSources(sources) {
    const arr = this._u.wakeSources.array;
    const n = Math.min(sources.length, MAX_WAKE_SOURCES);
    for (let i = 0; i < n; i++) {
      const s = sources[i];
      arr[i].set(s.x ?? 0, s.z ?? 0, s.strength ?? 0);
    }
    for (let i = n; i < MAX_WAKE_SOURCES; i++) {
      arr[i].set(0, 0, 0); // zero out unused slots
    }
    this._u.wakeCount.value = n;
  }

  /**
   * Advance the simulation by one frame.
   * - `camera` is the main scene camera; we recentre the foam RT around it.
   * - `tAccum` is the same time accumulator the water uses (so phases match).
   */
  update(renderer, camera, dt, tAccum) {
    if (!this._attached) return;
    this._frame++;

    // Re-centre the foam RT on the camera each frame.
    const prevCenter = this._u.centerXZ.value.clone();
    const newCenter = new THREE.Vector2(camera.position.x, camera.position.z);
    this._u.centerXZ.value.copy(newCenter);
    // Compute the UV-space SHIFT that compensates for the centre move so the
    // simulation reads the SAME world-XZ location from the previous frame's RT.
    //   prevUV needs (newWorldXZ - prevCenter)/(2*halfSize) + 0.5
    //         vs current uv = (newWorldXZ - newCenter)/(2*halfSize) + 0.5
    //   → diff = (newCenter - prevCenter) / (2 * halfSize)
    const dx = (newCenter.x - prevCenter.x) / (2 * this._u.worldHalfSize.value);
    const dz = (newCenter.y - prevCenter.y) / (2 * this._u.worldHalfSize.value);
    this._u.recenterShift.value.set(dx, dz);

    this._u.dt.value = Math.min(dt, 1 / 30); // clamp to avoid huge advect on tab-resume
    this._u.tAccum.value = tAccum;

    // Bind PREV target as input via the prev TextureNode; render into the OTHER target.
    this._prevTextureNode.value = this.targetA.texture;

    const oldRT = renderer.getRenderTarget();
    renderer.setRenderTarget(this.targetB);
    renderer.render(this._simScene, this._simCamera);
    renderer.setRenderTarget(oldRT);

    // Swap target references AND update the output TextureNode so the water
    // material samples the freshly-rendered target.
    const swap = this.targetA;
    this.targetA = this.targetB;
    this.targetB = swap;
    this._outputTextureNode.value = this.targetA.texture;
  }

  dispose() {
    this.targetA.dispose();
    this.targetB.dispose();
    if (this._simQuad) {
      this._simQuad.geometry.dispose();
      this._simQuad.material.dispose();
    }
  }
}
