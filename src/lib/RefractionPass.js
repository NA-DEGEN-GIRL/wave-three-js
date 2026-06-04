// RefractionPass — renders the scene (without the water surface) from the main
// camera into a colour + depth target. The water material samples this for:
//   • refraction (see seabed/objects beneath the water through a normal-distorted UV)
//   • contact foam (compare scene depth vs water-fragment depth → bright at near contact)
//
// Like Reflector, we temporarily promote materials to DoubleSide and disable scene
// fog so the captured colour isn't double-fogged when the water material later applies
// its own atmospheric blend.

import * as THREE from "three/webgpu";

function sanitizeWebGpuRenderableGeometry(obj) {
  const geometry = obj?.geometry;
  if (!geometry || !geometry.isBufferGeometry) return 0;
  let fixed = 0;
  if (geometry.index === undefined) {
    geometry.index = null;
    fixed += 1;
  }
  if (geometry.indirect === undefined) {
    geometry.indirect = null;
    fixed += 1;
  }
  const attrs = geometry.attributes || {};
  for (const key of Object.keys(attrs)) {
    if (attrs[key] == null) {
      delete attrs[key];
      fixed += 1;
    }
  }
  const morphAttrs = geometry.morphAttributes || {};
  for (const key of Object.keys(morphAttrs)) {
    if (!Array.isArray(morphAttrs[key])) continue;
    const next = morphAttrs[key].filter(Boolean);
    if (next.length !== morphAttrs[key].length) {
      morphAttrs[key] = next;
      fixed += 1;
    }
  }
  return fixed;
}

function sanitizeWebGpuSceneGeometries(scene) {
  let fixed = 0;
  scene?.traverse?.((obj) => {
    fixed += sanitizeWebGpuRenderableGeometry(obj);
  });
  return fixed;
}

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
    let renderError = null;
    try {
      renderer.setRenderTarget(this.target);
      renderer.clear();
      sanitizeWebGpuSceneGeometries(scene);
      try {
        renderer.render(scene, camera);
      } catch (err) {
        // Some WebGPU render-object caches are created while a procedural scene
        // is changing; retry once after normalizing buffer geometry metadata.
        sanitizeWebGpuSceneGeometries(scene);
        renderer.render(scene, camera);
      }
    } catch (err) {
      renderError = err;
    } finally {
      renderer.setRenderTarget(prevTarget);
      scene.fog = prevFog;
      for (const { m, side } of sideStates) m.side = side;
      for (let i = 0; i < hideList.length; i++) hideList[i].visible = vis[i];
    }
    if (renderError) throw renderError;
  }

  dispose() {
    this.target.dispose();
    if (this.target.depthTexture) this.target.depthTexture.dispose();
  }
}
