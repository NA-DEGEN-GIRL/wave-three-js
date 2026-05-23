// CPU buoyancy. The Pro library does this on GPU; we run a tiny CPU loop and
// sample the analytic Gerstner sum (via WaveSampler) at each frame.
import * as THREE from "three/webgpu";

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

export class BuoyancySystem {
  constructor(sampler) {
    this.sampler = sampler;
    this._objects = new Map();
    this._nextId = 1;
  }

  addObject(object, options = {}) {
    if (!(object instanceof THREE.Object3D)) return -1;
    const o = {
      id: this._nextId++,
      mesh: object,
      heightOffset: options.heightOffset ?? 0,
      heightSmoothing: options.heightSmoothing ?? 0.15,
      multiPoint: options.multiPoint !== false,
      rotationInfluence: options.rotationInfluence ?? 0.5,
      rotationSmoothing: options.rotationSmoothing ?? 0.2,
      rotationOffset: options.rotationOffset ?? new THREE.Euler(0, 0, 0),
      sampleLength: options.sampleLength ?? null,
      sampleWidth: options.sampleWidth ?? null,
      sampleOffset: options.sampleOffset ?? new THREE.Vector3(0, 0, 0),
      useBoundingBox: options.useBoundingBox !== false,
      _y: object.position.y,
      _rot: new THREE.Quaternion().copy(object.quaternion),
    };
    if (o.useBoundingBox && o.multiPoint && (o.sampleLength == null || o.sampleWidth == null)) {
      const box = new THREE.Box3().setFromObject(object);
      const size = new THREE.Vector3();
      box.getSize(size);
      if (o.sampleLength == null) o.sampleLength = Math.max(1, size.z);
      if (o.sampleWidth == null)  o.sampleWidth  = Math.max(1, size.x);
    } else {
      o.sampleLength ??= 4;
      o.sampleWidth ??= 4;
    }
    this._objects.set(o.id, o);
    return o.id;
  }

  removeObject(id) { return this._objects.delete(id); }
  hasObject(id) { return this._objects.has(id); }
  getObjectCount() { return this._objects.size; }
  clear() { this._objects.clear(); }
  updateObjectConfig(id, opts) {
    const o = this._objects.get(id);
    if (!o) return false;
    Object.assign(o, opts);
    return true;
  }
  getDebugData() {
    return Array.from(this._objects.values()).map((o) => ({ id: o.id, position: o.mesh.position.toArray() }));
  }

  async update(dt) {
    if (this._objects.size === 0) return;
    const lerp = (a, b, t) => a + (b - a) * Math.min(1, Math.max(0, t));
    for (const o of this._objects.values()) {
      const px = o.mesh.position.x + o.sampleOffset.x;
      const pz = o.mesh.position.z + o.sampleOffset.z;
      const center = await this.sampler.sampleAt(px, pz);

      // Smooth height
      const targetY = center.height + o.heightOffset;
      const smoothing = 1 - Math.exp(-dt / Math.max(0.001, o.heightSmoothing));
      o._y = lerp(o._y, targetY, smoothing);
      o.mesh.position.y = o._y;

      if (o.multiPoint && o.rotationInfluence > 0) {
        const hl = o.sampleLength * 0.5;
        const hw = o.sampleWidth * 0.5;
        const front = await this.sampler.sampleAt(px, pz + hl);
        const back  = await this.sampler.sampleAt(px, pz - hl);
        const right = await this.sampler.sampleAt(px + hw, pz);
        const left  = await this.sampler.sampleAt(px - hw, pz);

        // Pitch from front-back, roll from left-right (small-angle approx).
        const pitch = Math.atan2(front.height - back.height, o.sampleLength) * o.rotationInfluence;
        const roll  = Math.atan2(right.height - left.height, o.sampleWidth) * o.rotationInfluence;

        _e.set(pitch, 0, -roll);
        const target = new THREE.Quaternion().setFromEuler(_e);
        const rotSmooth = 1 - Math.exp(-dt / Math.max(0.001, o.rotationSmoothing));
        o._rot.slerp(target, rotSmooth);
        o.mesh.quaternion.copy(o._rot);
      }
    }
  }
}
