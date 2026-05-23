// Simple planar reflector. Renders the scene from a camera reflected across the
// water plane (y=0) into a RenderTarget which the water material samples.
//
// The implementation is intentionally lightweight (no oblique frustum clipping,
// no separate underwater/abovewater split) — just enough to give boats, rocks,
// and the sky a recognisable mirror image on the surface.

import * as THREE from "three/webgpu";

const _reflectMatrix = new THREE.Matrix4().makeScale(1, -1, 1);

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
