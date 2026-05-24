// InteractiveWater — heightfield wave-equation layer that lets MOVING objects
// (boats, buoys) push displacement into the water surface. Adds:
//   • bow waves trailing a moving boat
//   • impact ripples from splash events
//   • static-rock dimples (small constant displacement)
//   • gradient feed-back into the foam sim (auto wake foam)
//
// Architecture (designed with a fluid-sim consult — see commit notes):
//   • 256² ping-pong RT covering 200 m around the camera (≈0.78 m/cell)
//   • Each RGBA16F texel stores:  R = h(t)   G = h(t-1)
//   • Wave-equation leapfrog step (k=damping, C²=(c·dt/dx)²):
//       h_new = (2-k)·h - (1-k)·h_old + C²·∇²h + Σ splats
//     with absorbing boundary (outer 4-cell ring × 0.94) and ±0.5 m clamp.
//   • c = 3 m/s, dt = 1/60 s → CFL ≈ 0.064 (very safe, no substepping needed).
//
// One-way coupling: objects → water displacement. Buoyancy still samples the
// analytical Gerstner/FFT layer for object height (avoids resonance feedback).
// This matches Sea of Thieves / AC Valhalla architecture per consult.

import * as THREE from "three/webgpu";
import {
  Fn, vec2, vec3, vec4, float, uniform, texture, uv,
  dot, mix, clamp, max, min, exp, smoothstep, step, uniformArray,
} from "three/tsl";

const MAX_SPLATS = 24;

export class InteractiveWater {
  /**
   * @param {object}  [opts]
   * @param {number}  [opts.resolution=256]  RT side (256 → 65k cells)
   * @param {number}  [opts.worldSize=200]   metres of world covered by the RT
   * @param {number}  [opts.waveSpeed=3.0]   ripple propagation speed m/s
   * @param {number}  [opts.damping=0.003]   per-step velocity damping (k)
   */
  constructor({
    resolution = 256,
    worldSize  = 200,
    waveSpeed  = 3.0,
    damping    = 0.003,
  } = {}) {
    this.resolution = resolution;
    this.worldSize  = worldSize;
    this.waveSpeed  = waveSpeed;
    this.damping    = damping;
    this.enabled    = true;

    // RGBA16F: R=h_curr, G=h_old, B/A unused for now (could carry vx/vz later).
    const opts = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    };
    this.targetA = new THREE.RenderTarget(resolution, resolution, opts);
    this.targetB = new THREE.RenderTarget(resolution, resolution, opts);

    this._prevTextureNode   = texture(this.targetA.texture);
    this._outputTextureNode = texture(this.targetA.texture);

    const dx  = worldSize / resolution;          // cell size (m)
    const dt  = 1 / 60;                          // shader assumes ~60 Hz
    const cflSq = (waveSpeed * dt / dx) ** 2;    // C² in the discretised eq

    this._u = {
      centerXZ:      uniform(new THREE.Vector2(0, 0)),
      // UV shift compensating for camera-driven centerXZ move (so the
      // simulation reads the same world-XZ from the previous frame's RT).
      recenterShift: uniform(new THREE.Vector2(0, 0)),
      worldHalfSize: uniform(worldSize * 0.5),
      cflSq:         uniform(cflSq),
      damping:       uniform(damping),

      // Splat queue. Each vec4 = (worldX, worldZ, amplitude_m, sigma_m).
      splats:        uniformArray(new Array(MAX_SPLATS).fill(0).map(() => new THREE.Vector4(0, 0, 0, 1))),
      splatCount:    uniform(0),

      // Master enable. Setting to 0 zeroes the output texture each frame
      // (sim runs cheaply but contributes nothing to the water).
      gain:          uniform(1.0),
    };

    this._simScene  = new THREE.Scene();
    this._simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._simQuad   = null;

    this._oneShots = [];   // queue of { x, z, amp, sigma } applied next frame
    this._buildSimulationMaterial();
  }

  _buildSimulationMaterial() {
    const geom = new THREE.PlaneGeometry(2, 2);
    const mat  = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    const u    = this._u;
    const texel = 1.0 / this.resolution;

    mat.colorNode = Fn(() => {
      // World XZ at this fragment.
      const worldXZ = uv().mul(2.0).sub(1.0).mul(u.worldHalfSize).add(u.centerXZ);

      // Sample previous RT, compensating for camera recenter.
      const prevUV = uv().add(u.recenterShift).toVar();

      // Mask cells that were OUTSIDE the previous frame's domain (camera moved
      // and exposed new cells) — these should be zeroed, not edge-clamped, to
      // avoid injecting spurious wave energy from the edge.
      const inBounds = step(0.0, prevUV.x).mul(step(prevUV.x, 1.0))
                       .mul(step(0.0, prevUV.y)).mul(step(prevUV.y, 1.0));

      const prev   = texture(this._prevTextureNode, prevUV);
      const h_curr = prev.r.mul(inBounds).toVar();
      const h_old  = prev.g.mul(inBounds).toVar();

      // 5-tap Laplacian: 4 neighbours minus 4·centre.
      const ofs = float(texel);
      const hL = texture(this._prevTextureNode, prevUV.sub(vec2(ofs, 0))).r.mul(inBounds);
      const hR = texture(this._prevTextureNode, prevUV.add(vec2(ofs, 0))).r.mul(inBounds);
      const hD = texture(this._prevTextureNode, prevUV.sub(vec2(0, ofs))).r.mul(inBounds);
      const hU = texture(this._prevTextureNode, prevUV.add(vec2(0, ofs))).r.mul(inBounds);
      const laplacian = hL.add(hR).add(hD).add(hU).sub(h_curr.mul(4.0));

      // Wave eq leapfrog with velocity damping rearranged:
      //   h_new = (2-k)·h - (1-k)·h_old + C²·∇²h
      const a = float(2.0).sub(u.damping);
      const b = float(1.0).sub(u.damping);
      const h_new = a.mul(h_curr).sub(b.mul(h_old)).add(u.cflSq.mul(laplacian)).toVar();

      // Accumulate splats (additive into h_new only — never into h_old).
      const splatSum = float(0).toVar();
      for (let i = 0; i < MAX_SPLATS; i++) {
        const s = u.splats.element(i);
        const dpos = vec2(s.x, s.y).sub(worldXZ);
        const distSq = dot(dpos, dpos);
        // Gaussian: amp · exp(-d² / (2σ²)). Add 1e-4 to σ² to dodge divide-by-zero.
        const sig2 = s.w.mul(s.w).mul(2.0).add(0.0001);
        const gauss = exp(distSq.div(sig2).negate());
        splatSum.addAssign(s.z.mul(gauss));
      }
      h_new.addAssign(splatSum);

      // Absorbing boundary — graduated fade in outer 4-cell ring (× ~0.94).
      const edge = uv().sub(0.5).abs();
      const edgeT = smoothstep(float(0.5).sub(float(texel * 4.0)), float(0.5), max(edge.x, edge.y));
      h_new.assign(h_new.mul(mix(float(1.0), float(0.94), edgeT)));

      // Gentle global decay — multiplies the whole field by ~0.999 per step
      // (~5 s half-life). Without this, asymmetric splats (hull dominates bow)
      // slowly accumulate a DC bias that lifts/sinks the entire RT and shows
      // up as a visible square footprint from high camera angles. The decay
      // is small enough that propagating wave packets still look natural.
      h_new.assign(h_new.mul(0.999));

      // Anti-runaway clamp.
      h_new.assign(clamp(h_new, float(-0.5), float(0.5)));

      // Output: R = h_new (this frame's height), G = h_curr (becomes next frame's h_old).
      const gain = u.gain;
      return vec4(h_new.mul(gain), h_curr.mul(gain), 0.0, 1.0);
    })();

    this._simMat  = mat;
    this._simQuad = new THREE.Mesh(geom, mat);
    this._simScene.add(this._simQuad);
  }

  // ----- Public API -----

  /**
   * Set the active per-frame splats (boats, static dimples). Up to MAX_SPLATS.
   * Each splat: { x, z, amp (m), sigma (m) }.
   *   amp < 0 → push water DOWN (hull, rock displacement)
   *   amp > 0 → push water UP   (bow wave lobe, splash impulse)
   * The simulation re-applies these every frame, so for continuous boat
   * displacement just keep them in the list.
   */
  setSplats(splats) {
    // Merge in any pending one-shot impulses (and consume them).
    const combined = splats.concat(this._oneShots);
    this._oneShots.length = 0;

    const arr = this._u.splats.array;
    const n   = Math.min(combined.length, MAX_SPLATS);
    for (let i = 0; i < n; i++) {
      const s = combined[i];
      arr[i].set(s.x ?? 0, s.z ?? 0, s.amp ?? 0, Math.max(0.1, s.sigma ?? 1));
    }
    for (let i = n; i < MAX_SPLATS; i++) {
      arr[i].set(0, 0, 0, 1);
    }
    this._u.splatCount.value = n;
  }

  /**
   * Queue a ONE-SHOT impulse (splash impact). Will be applied for exactly one
   * simulation step then drop out, so the impulse becomes a proper transient
   * concentric ripple instead of a static dimple.
   * @param {number} x      world X
   * @param {number} z      world Z
   * @param {number} amp    metres (typical +0.15 to +0.4)
   * @param {number} sigma  metres (typical 0.3 to 0.8)
   */
  splatImpulse(x, z, amp, sigma = 0.5) {
    this._oneShots.push({ x, z, amp, sigma });
  }

  setEnabled(on) {
    this.enabled = !!on;
    this._u.gain.value = on ? 1.0 : 0.0;
  }
  setDamping(k)   { this.damping = k;   this._u.damping.value = k; }
  setWaveSpeed(c) {
    this.waveSpeed = c;
    const dx = this.worldSize / this.resolution;
    const dt = 1 / 60;
    this._u.cflSq.value = (c * dt / dx) ** 2;
  }

  /**
   * Advance the sim one frame. Snaps the centre to integer-cell multiples and
   * records the resulting UV shift so the prev-RT sample stays world-anchored.
   */
  update(renderer, camera, dt) {
    if (!this.enabled) return;

    const dx = this.worldSize / this.resolution;
    const newX = Math.round(camera.position.x / dx) * dx;
    const newZ = Math.round(camera.position.z / dx) * dx;
    const prev = this._u.centerXZ.value.clone();
    this._u.centerXZ.value.set(newX, newZ);

    // prevUV at this fragment must be (worldXZ - prev)/(2·half) + 0.5
    //                  vs current uv = (worldXZ - new)/(2·half) + 0.5
    //   → shift = (new - prev) / (2·half)
    const half = this._u.worldHalfSize.value;
    this._u.recenterShift.value.set((newX - prev.x) / (2 * half), (newZ - prev.y) / (2 * half));

    // Bind PREV target as input, render into the OTHER target, swap.
    this._prevTextureNode.value = this.targetA.texture;
    const old = renderer.getRenderTarget();
    renderer.setRenderTarget(this.targetB);
    renderer.render(this._simScene, this._simCamera);
    renderer.setRenderTarget(old);

    const swap = this.targetA;
    this.targetA = this.targetB;
    this.targetB = swap;
    this._outputTextureNode.value = this.targetA.texture;
  }

  // ----- Accessors for shader integration (mirrors FoamSimulation surface) -----
  get currentTexture()   { return this._outputTextureNode; }
  get centerXZUniform()  { return this._u.centerXZ; }
  get halfSizeUniform()  { return this._u.worldHalfSize; }
  get cellSize()         { return this.worldSize / this.resolution; }

  dispose() {
    this.targetA.dispose();
    this.targetB.dispose();
    if (this._simQuad) {
      this._simQuad.geometry.dispose();
      this._simQuad.material.dispose();
    }
  }
}
