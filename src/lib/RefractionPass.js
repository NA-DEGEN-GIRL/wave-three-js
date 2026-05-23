// RefractionPass — renders the scene (without the water surface) from the main
// camera into a colour + depth target. The water material samples this for:
//   • refraction (see seabed/objects beneath the water through a normal-distorted UV)
//   • contact foam (compare scene depth vs water-fragment depth → bright at near contact)
//
// Like Reflector, we temporarily promote materials to DoubleSide and disable scene
// fog so the captured colour isn't double-fogged when the water material later applies
// its own atmospheric blend.

import * as THREE from "three/webgpu";

export class RefractionPass {
  constructor({ resolution = 1024 } = {}) {
    this.resolution = resolution;
    this.target = new THREE.RenderTarget(resolution, resolution, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      generateMipmaps: false,
    });
    // Linear depth via a DepthTexture attached to the same target.
    this.target.depthTexture = new THREE.DepthTexture(resolution, resolution);
    this.target.depthTexture.type = THREE.FloatType;
  }

  setSize(width, height) {
    const w = Math.min(2048, Math.max(64, width));
    const h = Math.min(2048, Math.max(64, height));
    if (w === this.target.width && h === this.target.height) return;
    this.target.setSize(w, h);
  }

  update(renderer, scene, camera, hideList = []) {
    // Hide the water (and any other objects the caller wants out of the refraction pass).
    const vis = hideList.map((o) => o.visible);
    for (const o of hideList) o.visible = false;

    // Disable scene fog during the pass — the water material composes its own.
    const prevFog = scene.fog;
    scene.fog = null;

    // Flip culling so back faces aren't dropped from below-water angles.
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

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, camera);
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
