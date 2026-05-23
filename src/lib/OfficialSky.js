// OfficialSky — thin adapter around three.js master SkyMesh so it plays nice
// with our WaterSystem (sun direction, horizon-colour query, dispose lifecycle).
//
// The vendored SkyMesh under ./vendor/SkyMesh.js is the up-to-date version from
// mrdoob/three.js master — it has Hosek-Wilkie-style atmosphere + a volumetric
// cloud layer that the older r181 examples build doesn't ship. We re-export it
// behind the same SkyProvider interface as RayleighSky/GradientSky so calling
// code (water.setSky(sky)) doesn't change.

import * as THREE from "three/webgpu";
import { SkyMesh } from "./vendor/SkyMesh.js";

const DEG = Math.PI / 180;

/**
 * Convert (elevation, azimuth) in degrees to a Vector3 sun position.
 * Matches the convention in the three.js ocean example.
 */
function sphericalSun(elevDeg, azimDeg, radius = 1) {
  const phi = (90 - elevDeg) * DEG;
  const theta = azimDeg * DEG;
  const v = new THREE.Vector3();
  v.setFromSphericalCoords(radius, phi, theta);
  return v;
}

export class OfficialSky {
  /**
   * @param {object} [params]
   * @param {number} [params.elevation=12]  degrees above horizon
   * @param {number} [params.azimuth=180]
   * @param {number} [params.turbidity=10]
   * @param {number} [params.rayleigh=2]
   * @param {number} [params.mieCoefficient=0.005]
   * @param {number} [params.mieDirectionalG=0.8]
   * @param {number} [params.cloudScale=0.0002]
   * @param {number} [params.cloudSpeed=0.0001]
   * @param {number} [params.cloudCoverage=0.4]
   * @param {number} [params.cloudDensity=0.5]
   * @param {number} [params.cloudElevation=0.5]
   * @param {boolean}[params.showSunDisc=true]
   * @param {number} [params.size=10000]    sky-box scale (radius-ish)
   */
  constructor(params = {}) {
    const mesh = new SkyMesh();
    mesh.scale.setScalar(params.size ?? 10000);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1000;
    mesh.userData.underwater = false;
    // CRITICAL: disable scene fog on the sky material. Without this, scene.fog
    // (FogExp2) at the sky sphere's distance (10000 units after scaling) fades
    // the sky to 100% fog colour — making the whole sky look gray with no sun
    // or clouds visible.
    if (mesh.material) mesh.material.fog = false;

    // Tune uniforms.
    mesh.turbidity.value        = params.turbidity        ?? 10;
    mesh.rayleigh.value         = params.rayleigh         ?? 2;
    mesh.mieCoefficient.value   = params.mieCoefficient   ?? 0.005;
    mesh.mieDirectionalG.value  = params.mieDirectionalG  ?? 0.8;
    mesh.cloudScale.value       = params.cloudScale       ?? 0.0002;
    mesh.cloudSpeed.value       = params.cloudSpeed       ?? 0.0001;
    mesh.cloudCoverage.value    = params.cloudCoverage    ?? 0.4;
    mesh.cloudDensity.value     = params.cloudDensity     ?? 0.5;
    mesh.cloudElevation.value   = params.cloudElevation   ?? 0.5;
    mesh.showSunDisc.value      = (params.showSunDisc ?? true) ? 1 : 0;

    const sunVec = sphericalSun(params.elevation ?? 12, params.azimuth ?? 180);
    mesh.sunPosition.value.copy(sunVec);

    this._mesh = mesh;

    // -------- SkyProvider-compatible uniforms exposed for WaterSystem --------
    // The water material reads `sunUniforms.direction.value`, `sunUniforms.intensity.value`,
    // `atmosphereUniforms.skyColor.value`, etc. We shim those by mirroring SkyMesh fields.
    this.sunUniforms = {
      direction: mesh.sunPosition,       // shared! water and sky use the same Vector3
      intensity: { value: 1.0 },         // SkyMesh has no separate intensity; expose constant
    };
    this.sunDiskUniforms = {
      // SkyMesh's sun disc is procedural — we don't expose colour tuning here
      // but supply harmless defaults so PresetStore snapshot/restore doesn't crash.
      radius:            { value: 0.01 },
      color:             { value: new THREE.Color(0xfff4e0) },
      emissiveColor:     { value: new THREE.Color(0xffe6c4) },
      emissiveIntensity: { value: 1.0 },
    };
    this.atmosphereUniforms = {
      rayleighCoefficient: mesh.rayleigh,
      mieCoefficient:      mesh.mieCoefficient,
      mieDirectionalG:     mesh.mieDirectionalG,
      turbidity:           mesh.turbidity,
      // SkyMesh doesn't use a "skyColor" base; expose a dummy uniform so reflection
      // tint fallbacks still get a sensible value (snapshot/restore will round-trip).
      skyColor:            { value: new THREE.Color(0x6494c8) },
      skyBrightness:       { value: 1.0 },
    };
    this.cloudUniforms = {
      enabled:        { value: 1 },
      coverage:       mesh.cloudCoverage,
      color:          { value: new THREE.Color(0xffffff) },
      shadowColor:    { value: new THREE.Color(0xa0a8b0) },
      height:         { value: 0.5 },
      thickness:      { value: 0.5 },
      intensity:      { value: mesh.cloudDensity.value },
      opacityFalloff: { value: 0.4 },
      octaves:        { value: 5 },
      lacunarity:     { value: 2.0 },
      persistence:    { value: 0.5 },
      scale:          mesh.cloudScale,
      speed:          mesh.cloudSpeed,
    };

    this._params = { ...params };
  }

  // ----- SkyProvider interface -----

  getMesh() { return this._mesh; }

  /** Approximate horizon colour used by WaterSystem for reflection-tint fallback. */
  getHorizonColor() {
    const t = this._mesh.turbidity.value;
    const sunY = this._mesh.sunPosition.value.y;
    const sunLow = Math.max(0, 1 - sunY);
    const warm = new THREE.Color(0xff9c5e);
    const haze = new THREE.Color(0xb6c8d4);
    const out = new THREE.Color(0x6494c8);
    out.lerp(haze, Math.min(0.5, t * 0.06));
    out.lerp(warm, sunLow * 0.55);
    return out;
  }

  getSkyBrightness() { return 1.0; }

  /** Set sun by elevation/azimuth degrees (matches the official example's UX). */
  setSunFromAngles(elevDeg, azimDeg) {
    const v = sphericalSun(elevDeg, azimDeg);
    this._mesh.sunPosition.value.copy(v);
  }

  /** Stubs to satisfy the SkyProvider interface — water material uses planar reflection RT. */
  createReflectionSampler() { return null; }
  createFogSampler() { return null; }

  dispose() {
    this._mesh.geometry.dispose();
    this._mesh.material.dispose();
  }
}
