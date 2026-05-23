// WetMaterial — drop-in helper that takes a scene object and gives its child
// meshes NodeMaterials that read from the WaterSystem's foam RT to compute a
// "wetness" factor based on:
//   1. how close the surface is to the waterline (height above y=0)
//   2. how much persistent foam is splashing at this XZ location
// The wetness then darkens albedo and drops roughness per Lagarde 2013
// "Water drop 3b — physically based wet surfaces":
//   albedo_wet     = pow(albedo, 1 + porosity * wetness)
//   roughness_wet  = lerp(roughness, 0.1, wetness)
// This produces the "splashed rock" look you see in the reference where the
// stone around the waterline reads darker and glossier than dry stone above.

import * as THREE from "three/webgpu";
import {
  Fn, vec2, vec3, vec4, float, uniform, texture, mix, clamp, pow,
  smoothstep, max, min, dot, normalize, positionWorld, normalLocal,
} from "three/tsl";

/**
 * Apply wetness to all Mesh children of `root`. Reads from waterSystem.foamSim.
 *
 * @param {THREE.Object3D} root             — group containing meshes to wet
 * @param {WaterSystem}    waterSystem      — must have a foamSim and waterline at y=0
 * @param {object}         opts
 * @param {number}         opts.waterlineY   — y world height of the waterline (default 0)
 * @param {number}         opts.fadeRange    — meters above water where wetness fades (default 4)
 * @param {number}         opts.porosity     — material porosity (rock 0.6, wood 1.0, metal 0.0; default 0.7)
 * @param {number}         opts.foamCoupling — how much foam contact contributes to wetness (default 1.0)
 */
export function applyWetness(root, waterSystem, opts = {}) {
  const waterlineY = opts.waterlineY ?? 0;
  const fadeRange = opts.fadeRange ?? 4;
  const porosity = opts.porosity ?? 0.7;
  const foamCoupling = opts.foamCoupling ?? 1.0;

  const foamSim = waterSystem.foamSim;
  if (!foamSim) {
    console.warn("WetMaterial: waterSystem has no foamSim — wetness disabled");
    return;
  }

  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const oldMat = obj.material;
    // Only wrap MeshStandardMaterial-derived materials (rocks/palms/boats).
    if (!oldMat.isMeshStandardMaterial && !oldMat.isMeshLambertMaterial && !oldMat.isMeshPhongMaterial) return;

    const newMat = new THREE.MeshStandardNodeMaterial();
    // Inherit base properties.
    if (oldMat.color) newMat.color.copy(oldMat.color);
    newMat.roughness = oldMat.roughness ?? 0.8;
    newMat.metalness = oldMat.metalness ?? 0.0;
    newMat.side = oldMat.side;
    newMat.flatShading = oldMat.flatShading;
    newMat.transparent = oldMat.transparent;
    newMat.opacity = oldMat.opacity;
    newMat.userData.original = oldMat;

    const baseColor = uniform(newMat.color);
    const baseRoughness = uniform(newMat.roughness);
    const porosityU = uniform(porosity);
    const fadeU = uniform(fadeRange);
    const waterY = uniform(waterlineY);
    const foamCouplingU = uniform(foamCoupling);
    const foamTex = foamSim.currentTexture;
    const foamCenter = foamSim.centerXZUniform;
    const foamHalf = foamSim.halfSizeUniform;

    // Per-fragment wetness from (1) height above water and (2) foam at this XZ.
    const wetnessNode = Fn(() => {
      // Height-based wetness: 1 right at waterline, 0 at fadeRange above.
      const heightAboveWater = max(positionWorld.y.sub(waterY), float(0.0));
      const heightWet = smoothstep(fadeU, float(0.0), heightAboveWater);
      // Foam-based wetness: sample foam RT at this fragment's world XZ.
      const foamUV = vec2(
        positionWorld.x.sub(foamCenter.x).div(foamHalf).mul(0.5).add(0.5),
        positionWorld.z.sub(foamCenter.y).div(foamHalf).mul(0.5).add(0.5),
      );
      const foamHere = texture(foamTex, foamUV).r.mul(foamCouplingU);
      // Combine: max of the two — rock is wet if it's near waterline OR foam is splashing on it.
      return clamp(max(heightWet, foamHere), 0.0, 1.0);
    })();

    // Apply Lagarde wetness formula via TSL.
    const wetAlbedo = pow(baseColor, float(1.0).add(porosityU.mul(wetnessNode)));
    newMat.colorNode = wetAlbedo;
    newMat.roughnessNode = mix(baseRoughness, float(0.10), wetnessNode);

    obj.material = newMat;
  });
}
