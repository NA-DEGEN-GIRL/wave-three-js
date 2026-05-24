// FishSchool — underwater fish system rendered as a single InstancedMesh.
//
// Design goals:
//   • Visually believable — procedural fish geometry with countershading,
//     swept tail, dorsal + side fins; tail wiggle driven in the vertex shader
//     so the CPU just maintains positions.
//   • Cheap — N fish = 1 draw call (InstancedMesh). Update loop is O(N) with
//     lightweight per-school cohesion (no spatial hash needed at ~150 fish).
//   • Underwater-correct — tagged userData.underwater so the planar reflection
//     pass skips them (otherwise ghost fish would float in the sky reflection).
//
// API mirrors the rest of the lib (getObject / setEnabled / setCount / dispose).
//   const fish = new FishSchool({ count: 150 });
//   scene.add(fish.getObject());
//   fish.update(dt, { x: cam.x, z: cam.z }, time);

import * as THREE from "three/webgpu";
import {
  Fn, vec3, vec4, float, uniform, sin, clamp, mix,
  instanceIndex, positionLocal, normalLocal,
} from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * Build a single fish geometry. Nose points along +X so heading=0 → swims in +X.
 * About 50 triangles total — cheap when instanced.
 */
function makeFishGeometry() {
  // Body: stretched icosahedron — gives a smooth fish-shaped silhouette.
  const body = new THREE.IcosahedronGeometry(0.35, 1);
  body.scale(2.0, 0.75, 0.5);

  // Tail fin: a cone flattened into the XY plane, rear-tip facing −X.
  // Halved on the Z axis so it reads as a forked tail when seen edge-on.
  const tail = new THREE.ConeGeometry(0.35, 0.55, 4);
  tail.rotateZ(Math.PI / 2);   // tip from +Y → +X
  tail.scale(1, 1, 0.18);      // flatten into a fin
  tail.translate(-0.85, 0, 0); // glue to rear of body
  tail.rotateY(Math.PI);       // tip now points −X (away from body)

  // Dorsal fin: small triangle on top.
  const dorsal = new THREE.ConeGeometry(0.16, 0.22, 3);
  dorsal.rotateX(Math.PI / 2);   // tip from +Y → +Z
  dorsal.scale(0.4, 1, 0.5);
  dorsal.translate(-0.1, 0.28, 0);

  // Side pectoral fins — one each side, mid-body.
  const finBase = new THREE.ConeGeometry(0.12, 0.18, 3);
  finBase.rotateZ(Math.PI / 2);
  finBase.scale(1, 0.35, 0.5);
  const finL = finBase.clone();
  finL.translate(0.15, -0.05,  0.18);
  finL.rotateY(-0.25);
  const finR = finBase.clone();
  finR.translate(0.15, -0.05, -0.18);
  finR.rotateY( 0.25);

  // mergeGeometries() refuses a mix of indexed + non-indexed inputs.
  // IcosahedronGeometry is non-indexed but ConeGeometry is indexed, so
  // coerce them all to non-indexed before merging.
  const merged = mergeGeometries([
    body.toNonIndexed(),
    tail.toNonIndexed(),
    dorsal.toNonIndexed(),
    finL.toNonIndexed(),
    finR.toNonIndexed(),
  ]);
  merged.computeVertexNormals();
  return merged;
}

export class FishSchool {
  /**
   * @param {object}   [opts]
   * @param {number}   [opts.count=150]            max fish (also initial)
   * @param {number}   [opts.nSchools=6]           groups (fish stick to their school)
   * @param {object}   [opts.bounds]               { radius, depthMin, depthMax }
   * @param {number}   [opts.bounds.radius=90]    metres around camera fish live in
   * @param {number}   [opts.bounds.depthMin=-7] minimum Y (deeper)
   * @param {number}   [opts.bounds.depthMax=-2] maximum Y (just under surface)
   * @param {number[]} [opts.swimSpeedRange=[0.4,1.0]]   m/s
   * @param {number[]} [opts.sizeRange=[0.45,1.0]]      world units
   */
  constructor({
    count = 150,
    nSchools = 6,
    bounds = { radius: 90, depthMin: -7, depthMax: -2 },
    swimSpeedRange = [0.4, 1.0],
    sizeRange = [0.45, 1.0],
  } = {}) {
    this._capacity = count;
    this._activeCount = count;
    this.bounds = bounds;
    this.enabled = true;
    this.swimSpeedScale = 1.0;

    const geom = makeFishGeometry();
    const mat  = new THREE.MeshStandardNodeMaterial({
      metalness: 0.35, roughness: 0.55,
    });

    // Tail wiggle uniform — animate position along local Z based on distance
    // from the nose (positive X), so the tail end sweeps side-to-side.
    this._tNode = uniform(0);
    mat.positionNode = Fn(() => {
      // tailFactor: 0 at the nose (+X end), 1 at the tail tip (−X end).
      const tailFactor = clamp(
        float(1.0).sub(positionLocal.x.add(0.9).div(1.8)),
        float(0.0), float(1.0),
      );
      // Per-instance phase offset so neighbouring fish don't wiggle in sync.
      const phase = instanceIndex.toFloat().mul(0.617);
      const w = sin(this._tNode.mul(7.5).add(phase).add(positionLocal.x.mul(2.5)))
                  .mul(tailFactor).mul(tailFactor).mul(0.22);
      return vec3(positionLocal.x, positionLocal.y, positionLocal.z.add(w));
    })();

    // Countershading: lighter belly, darker back. Reads natural underwater.
    mat.colorNode = Fn(() => {
      const back  = vec3(0.18, 0.28, 0.38);
      const belly = vec3(0.85, 0.88, 0.90);
      const t = clamp(normalLocal.y.mul(0.5).add(0.5), float(0.0), float(1.0));
      return vec4(mix(belly, back, t), 1.0);
    })();

    this._mesh = new THREE.InstancedMesh(geom, mat, count);
    this._mesh.frustumCulled = false;          // schools wander, AABB unreliable
    this._mesh.userData.underwater = true;     // hide from reflection pass
    this._mesh.castShadow = false;
    this._mesh.receiveShadow = false;

    // Per-fish state (SoA for tight loops).
    this._dummy = new THREE.Object3D();
    this._x      = new Float32Array(count);
    this._y      = new Float32Array(count);
    this._z      = new Float32Array(count);
    this._angle  = new Float32Array(count);
    this._speed  = new Float32Array(count);
    this._size   = new Float32Array(count);
    this._phase  = new Float32Array(count);
    this._baseY  = new Float32Array(count);
    this._school = new Uint8Array(count);

    // Schools wander slowly; each fish steers toward its school's center.
    this._schools = [];
    for (let s = 0; s < nSchools; s++) {
      const a = (s / nSchools) * Math.PI * 2 + Math.random() * 0.4;
      const r = 25 + Math.random() * (bounds.radius * 0.55);
      this._schools.push({
        x: Math.cos(a) * r,
        z: Math.sin(a) * r,
        goalAngle: Math.random() * Math.PI * 2,
        speed: 0.3 + Math.random() * 0.4,
      });
    }

    for (let i = 0; i < count; i++) {
      const sId = i % nSchools;
      this._school[i] = sId;
      const sch = this._schools[sId];
      const r = Math.random() * 4.5;
      const a = Math.random() * Math.PI * 2;
      this._x[i] = sch.x + Math.cos(a) * r;
      this._z[i] = sch.z + Math.sin(a) * r;
      this._baseY[i] = bounds.depthMin + Math.random() * (bounds.depthMax - bounds.depthMin);
      this._y[i]     = this._baseY[i];
      this._angle[i] = sch.goalAngle + (Math.random() - 0.5) * 0.5;
      this._speed[i] = swimSpeedRange[0] + Math.random() * (swimSpeedRange[1] - swimSpeedRange[0]);
      this._size[i]  = sizeRange[0]      + Math.random() * (sizeRange[1]      - sizeRange[0]);
      this._phase[i] = Math.random() * Math.PI * 2;
    }
    this._writeAllMatrices();
  }

  // ----- Public API -----

  getObject() { return this._mesh; }

  /** Cap how many of the allocated instances are visible. Cheap — no realloc. */
  setCount(n) {
    n = Math.max(0, Math.min(this._capacity | 0, n | 0));
    this._activeCount = n;
    this._mesh.count = n;
  }

  setEnabled(on) {
    this.enabled = !!on;
    this._mesh.visible = this.enabled;
  }

  setSwimSpeedScale(s) { this.swimSpeedScale = Math.max(0, s); }

  /**
   * One frame of motion. cameraXZ = { x, z } for recycling far-away schools.
   */
  update(dt, cameraXZ, time = 0) {
    if (!this.enabled || this._activeCount === 0) return;
    this._tNode.value = time;
    const dtClamped = Math.min(dt, 0.05);
    const speedScale = this.swimSpeedScale;

    // Schools: slow wander; teleport behind the camera when they drift too far.
    const recycleSqr = this.bounds.radius * this.bounds.radius;
    for (const sch of this._schools) {
      sch.goalAngle += (Math.random() - 0.5) * dtClamped * 0.45;
      sch.x += Math.cos(sch.goalAngle) * sch.speed * speedScale * dtClamped;
      sch.z += Math.sin(sch.goalAngle) * sch.speed * speedScale * dtClamped;
      const dx = sch.x - cameraXZ.x, dz = sch.z - cameraXZ.z;
      if (dx * dx + dz * dz > recycleSqr) {
        const a = Math.atan2(-dz, -dx) + (Math.random() - 0.5) * 1.4;
        sch.x = cameraXZ.x + Math.cos(a) * this.bounds.radius * 0.65;
        sch.z = cameraXZ.z + Math.sin(a) * this.bounds.radius * 0.65;
        sch.goalAngle = a;
      }
    }

    // Fish: cohesion toward school center + small wander.
    const n = this._activeCount;
    for (let i = 0; i < n; i++) {
      const sch = this._schools[this._school[i]];
      const fdx = sch.x - this._x[i];
      const fdz = sch.z - this._z[i];
      const dSq = fdx * fdx + fdz * fdz;

      if (dSq > 36) {
        // Steer toward school centre (proportional, no overshoot).
        const targetA = Math.atan2(fdz, fdx);
        let da = targetA - this._angle[i];
        if (da >  Math.PI) da -= Math.PI * 2;
        if (da < -Math.PI) da += Math.PI * 2;
        this._angle[i] += da * Math.min(1, dtClamped * 1.6);
      } else {
        // Wander noise when inside the school radius.
        this._angle[i] += (Math.random() - 0.5) * dtClamped * 0.8;
      }

      const sp = this._speed[i] * speedScale;
      this._x[i] += Math.cos(this._angle[i]) * sp * dtClamped;
      this._z[i] += Math.sin(this._angle[i]) * sp * dtClamped;
      // Gentle depth oscillation gives the school visual lift.
      this._y[i] = this._baseY[i] + Math.sin(time * 0.45 + this._phase[i]) * 0.4;

      this._dummy.position.set(this._x[i], this._y[i], this._z[i]);
      this._dummy.rotation.set(0, -this._angle[i], 0);
      this._dummy.scale.setScalar(this._size[i]);
      this._dummy.updateMatrix();
      this._mesh.setMatrixAt(i, this._dummy.matrix);
    }
    this._mesh.instanceMatrix.needsUpdate = true;
  }

  _writeAllMatrices() {
    for (let i = 0; i < this._capacity; i++) {
      this._dummy.position.set(this._x[i], this._y[i], this._z[i]);
      this._dummy.rotation.set(0, -this._angle[i], 0);
      this._dummy.scale.setScalar(this._size[i]);
      this._dummy.updateMatrix();
      this._mesh.setMatrixAt(i, this._dummy.matrix);
    }
    this._mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this._mesh.geometry.dispose();
    this._mesh.material.dispose();
  }
}
