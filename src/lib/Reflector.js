// Simple planar reflector. Renders the scene from a camera reflected across the
// water plane (y=0) into a RenderTarget which the water material samples.
//
// The implementation is intentionally lightweight (no oblique frustum clipping,
// no separate underwater/abovewater split) — just enough to give boats, rocks,
// and the sky a recognisable mirror image on the surface.

import * as THREE from "three/webgpu";

const _reflectMatrix = new THREE.Matrix4().makeScale(1, -1, 1);
const _clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // y >= 0 (water plane)
const _clipPlaneView = new THREE.Vector4();
const _q = new THREE.Vector4();
const _tmpProj = new THREE.Matrix4();

/**
 * Modify the projection matrix in-place to clip against an arbitrary plane,
 * given in EYE/view space, per Eric Lengyel's "Modifying the Projection Matrix
 * to Perform Oblique Near-plane Clipping" (Game Programming Gems 5, 2004).
 *
 * This makes the mirror camera's near clip plane align with the water plane,
 * which means anything below water is automatically clipped from the reflection
 * pass — no need for the user to tag every underwater object with userData.
 */
function applyObliqueClip(projectionMatrix, clipPlaneView) {
  const m = projectionMatrix.elements;
  // Compute the perpendicular point in clip space corresponding to the plane.
  _q.set(
    (Math.sign(clipPlaneView.x) + m[8]) / m[0],
    (Math.sign(clipPlaneView.y) + m[9]) / m[5],
    -1.0,
    (1.0 + m[10]) / m[14],
  );
  // c = clipPlaneView * (2 / dot(clipPlaneView, q))
  const dot = clipPlaneView.x * _q.x + clipPlaneView.y * _q.y + clipPlaneView.z * _q.z + clipPlaneView.w * _q.w;
  const s = 2.0 / dot;
  const cx = clipPlaneView.x * s;
  const cy = clipPlaneView.y * s;
  const cz = clipPlaneView.z * s;
  const cw = clipPlaneView.w * s;
  // Replace 3rd row of projection: M[2] = c - M[3]
  m[2] = cx;
  m[6] = cy;
  m[10] = cz + 1.0;
  m[14] = cw;
}

export class WaterReflector {
  constructor({ resolution = 1024 } = {}) {
    this.resolution = resolution;
    // HalfFloat keeps tone-mapped HDR colours intact for smoother sky reflections.
    this.target = new THREE.RenderTarget(resolution, resolution, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      generateMipmaps: false,
    });
    this.target.depthTexture = new THREE.DepthTexture(resolution, resolution);
    this.mirrorCam = new THREE.PerspectiveCamera();
    this.mirrorCam.matrixAutoUpdate = false;
  }

  setSize(width, height) {
    const r = Math.min(1024, Math.max(width, height));
    if (r === this.resolution) return;
    this.resolution = r;
    this.target.setSize(r, r);
  }

  /**
   * Renders the scene reflected across y=0 into this.target.
   * @param {THREE.WebGPURenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} mainCam
   * @param {Array<THREE.Object3D>} hideList — objects to hide for this pass only
   *   (typically: the water mesh, ocean floor, and any underwater objects below
   *   y=0 — kelp, particles. Without hiding underwater geometry, its MIRROR
   *   image lands at +y in the reflection RT and shows up "above water" in the
   *   water-surface reflection sample — wrong physically and visually).
   */
  update(renderer, scene, mainCam, hideList = []) {
    // Match camera intrinsics.
    this.mirrorCam.fov = mainCam.fov;
    this.mirrorCam.aspect = mainCam.aspect;
    this.mirrorCam.near = mainCam.near;
    this.mirrorCam.far = mainCam.far;

    // Reflect main camera across y=0 plane.
    this.mirrorCam.matrixWorld.copy(mainCam.matrixWorld);
    this.mirrorCam.matrixWorld.premultiply(_reflectMatrix);
    this.mirrorCam.matrixWorldInverse.copy(this.mirrorCam.matrixWorld).invert();
    this.mirrorCam.projectionMatrix.copy(mainCam.projectionMatrix);
    this.mirrorCam.projectionMatrixInverse.copy(mainCam.projectionMatrixInverse);

    // OBLIQUE NEAR-PLANE CLIPPING (Lengyel 2004) — clip anything below the water
    // plane (y=0) in the mirror camera's frustum. This replaces the need to tag
    // every underwater object with `userData.underwater`. Reflection now shows
    // ONLY what's above the water surface, automatically.
    _clipPlane.set(new THREE.Vector3(0, 1, 0), 0);
    // Transform clip plane into mirror-camera EYE space.
    const planeNormal = _clipPlane.normal;
    const planeConstant = _clipPlane.constant;
    _clipPlaneView.set(planeNormal.x, planeNormal.y, planeNormal.z, planeConstant)
      .applyMatrix4(this.mirrorCam.matrixWorldInverse.clone().transpose());
    applyObliqueClip(this.mirrorCam.projectionMatrix, _clipPlaneView);

    // Hide the water plane (and anything else the caller wants hidden) so it
    // doesn't appear in its own reflection.
    const vis = hideList.map((o) => o.visible);
    for (const o of hideList) o.visible = false;

    // The mirror transform flips winding, which would normally make most opaque
    // meshes invisible (back-face culling kicks in). Temporarily promote every
    // material in the scene to DoubleSide for the reflection pass.
    const sideStates = [];
    scene.traverse((o) => {
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          sideStates.push({ m, side: m.side });
          m.side = THREE.DoubleSide;
        }
      }
    });

    // Disable scene fog during the reflection pass so the mirror image doesn't
    // double-fog (water material adds its own atmospheric fade on top).
    const prevFog = scene.fog;
    scene.fog = null;

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, this.mirrorCam);
    renderer.setRenderTarget(prevTarget);

    scene.fog = prevFog;
    for (const { m, side } of sideStates) m.side = side;
    for (let i = 0; i < hideList.length; i++) hideList[i].visible = vis[i];
  }

  dispose() {
    this.target.dispose();
    if (this.target.depthTexture) this.target.depthTexture.dispose();
  }
}
