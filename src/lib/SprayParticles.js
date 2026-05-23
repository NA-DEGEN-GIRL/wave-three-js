// SprayParticles — above-surface mist sprite system.
//
// Production water rendering uses GPU particles for the actual 3D mist that
// rises when waves crash on rocks/boats (the surface shader can't draw above
// the water plane). This module is a CPU-driven THREE.Points pool that emits
// particles where wave-crash conditions are met (wake source positions for
// MVP) and animates each with ballistic motion + lifetime fade.
//
// Soft-particle alpha fade against the scene depth would require sampling
// RefractionPass.target.depthTexture in a custom NodeMaterial — left as a
// future polish item to keep this MVP self-contained.

import * as THREE from "three/webgpu";

const _v = new THREE.Vector3();

export class SprayParticles {
  constructor({ maxParticles = 600, gravity = 9.8 } = {}) {
    this.maxParticles = maxParticles;
    this.gravity = gravity;

    // Per-particle state (CPU side).
    this._pos = new Float32Array(maxParticles * 3);
    this._vel = new Float32Array(maxParticles * 3);
    this._age = new Float32Array(maxParticles);      // seconds
    this._life = new Float32Array(maxParticles);     // total lifetime in seconds
    this._alive = new Uint8Array(maxParticles);

    // Geometry: one vertex per slot. We always upload the full position buffer
    // each frame so dead particles can hide off-screen (or via alpha = 0).
    const positionAttr = new THREE.BufferAttribute(this._pos, 3);
    positionAttr.usage = THREE.DynamicDrawUsage;
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", positionAttr);
    // Custom alpha attribute fed to the material's vertex shader.
    this._alphaArr = new Float32Array(maxParticles);
    const alphaAttr = new THREE.BufferAttribute(this._alphaArr, 1);
    alphaAttr.usage = THREE.DynamicDrawUsage;
    this.geometry.setAttribute("aAlpha", alphaAttr);

    // Material: white sprite with size attenuation + per-vertex alpha.
    // Using PointsNodeMaterial would let us read aAlpha via TSL; for now
    // a plain PointsMaterial gives most of the effect with transparency.
    this.material = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.45,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      sizeAttenuation: true,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.userData.underwater = false; // visible from reflection too

    this._cursor = 0;
    this._nextSpawnAccum = 0;
    this._spawnRate = 40; // particles per second of accumulated splash strength

    // Move all particles off-screen at start.
    for (let i = 0; i < this.maxParticles; i++) {
      this._pos[i * 3 + 1] = -10000;
      this._alphaArr[i] = 0;
    }
  }

  /** Spawn `count` particles at world position (x, y, z) with random radial velocity. */
  spawn(x, y, z, count, baseSpeed = 4.0) {
    for (let n = 0; n < count; n++) {
      const i = this._cursor;
      this._cursor = (this._cursor + 1) % this.maxParticles;
      this._pos[i * 3] = x + (Math.random() - 0.5) * 0.5;
      this._pos[i * 3 + 1] = y + 0.1 + Math.random() * 0.3;
      this._pos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.5;
      // Mostly upward velocity with sideways jitter.
      const yaw = Math.random() * Math.PI * 2;
      const speed = baseSpeed * (0.6 + Math.random() * 0.8);
      this._vel[i * 3]     = Math.cos(yaw) * speed * 0.35;
      this._vel[i * 3 + 1] = speed * (0.7 + Math.random() * 0.5);
      this._vel[i * 3 + 2] = Math.sin(yaw) * speed * 0.35;
      this._age[i] = 0;
      this._life[i] = 0.6 + Math.random() * 0.8;
      this._alive[i] = 1;
      this._alphaArr[i] = 1;
    }
  }

  /**
   * @param {number} dt seconds
   * @param {Array<{x,y,z,strength}>} emitters world-space splash sources
   */
  update(dt, emitters = []) {
    // Spawn from emitters proportional to accumulated strength × spawnRate.
    for (const e of emitters) {
      this._nextSpawnAccum += e.strength * this._spawnRate * dt;
      const n = Math.floor(this._nextSpawnAccum);
      if (n > 0) {
        this.spawn(e.x, e.y, e.z, n);
        this._nextSpawnAccum -= n;
      }
    }

    // Advance all particles with gravity + age.
    const g = this.gravity;
    for (let i = 0; i < this.maxParticles; i++) {
      if (!this._alive[i]) continue;
      this._age[i] += dt;
      if (this._age[i] >= this._life[i]) {
        this._alive[i] = 0;
        this._alphaArr[i] = 0;
        this._pos[i * 3 + 1] = -10000; // hide
        continue;
      }
      this._vel[i * 3 + 1] -= g * dt;
      this._pos[i * 3]     += this._vel[i * 3]     * dt;
      this._pos[i * 3 + 1] += this._vel[i * 3 + 1] * dt;
      this._pos[i * 3 + 2] += this._vel[i * 3 + 2] * dt;
      // Hide particles that fall back into water.
      if (this._pos[i * 3 + 1] < 0.05) {
        this._alive[i] = 0;
        this._alphaArr[i] = 0;
        this._pos[i * 3 + 1] = -10000;
        continue;
      }
      // Linear alpha fade from 1 → 0 over lifetime.
      this._alphaArr[i] = 1.0 - this._age[i] / this._life[i];
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }

  getObject() { return this.points; }
  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
