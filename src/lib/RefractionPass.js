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

function cameraCanRenderObject(camera, object) {
  return !camera?.layers || !object?.layers || camera.layers.test(object.layers);
}

function sanitizeWebGpuSceneGeometries(scene, camera = null) {
  let fixed = 0;
  scene?.traverseVisible?.((obj) => {
    if (!cameraCanRenderObject(camera, obj)) return;
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
    this.lastDiagnostics = Object.freeze({
      candidateObjects: 0,
      visibleDrawables: 0,
      sideMutations: 0,
      sanitizeFixes: 0,
      retries: 0,
    });
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
    const visitedMaterials = new Set();
    let candidateObjects = 0;
    let visibleDrawables = 0;
    let sideMutations = 0;
    scene.traverseVisible((o) => {
      // A map may dedicate a camera layer to submerged objects. Respect the
      // same layer mask here that renderer.render() will use, otherwise an
      // underwater-only pass still walks and mutates every avatar, prop,
      // weather particle and snow material in the full scene.
      if (!cameraCanRenderObject(camera, o)) return;
      candidateObjects += 1;
      if (o.visible !== false && o.material) {
        visibleDrawables += 1;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          // Shared materials can appear on many meshes. Saving them repeatedly
          // after the first mutation would restore the later DoubleSide state
          // instead of the original side and permanently corrupt culling.
          if (!m || visitedMaterials.has(m)) continue;
          visitedMaterials.add(m);
          if (m.side === THREE.DoubleSide) continue;
          sideStates.push({ m, side: m.side });
          m.side = THREE.DoubleSide;
          sideMutations += 1;
        }
      }
    });

    const prevTarget = renderer.getRenderTarget();
    let renderError = null;
    let sanitizeFixes = 0;
    let retries = 0;
    try {
      renderer.setRenderTarget(this.target);
      renderer.clear();
      sanitizeFixes += sanitizeWebGpuSceneGeometries(scene, camera);
      try {
        renderer.render(scene, camera);
      } catch (err) {
        // Some WebGPU render-object caches are created while a procedural scene
        // is changing; retry once after normalizing buffer geometry metadata.
        retries += 1;
        sanitizeFixes += sanitizeWebGpuSceneGeometries(scene, camera);
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
    this.lastDiagnostics = Object.freeze({
      candidateObjects,
      visibleDrawables,
      sideMutations,
      sanitizeFixes,
      retries,
    });
    if (renderError) throw renderError;
  }

  dispose() {
    this.target.dispose();
    if (this.target.depthTexture) this.target.depthTexture.dispose();
  }
}
