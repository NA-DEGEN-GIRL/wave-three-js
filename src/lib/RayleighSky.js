// RayleighSky — physically-inspired procedural sky.
//
// Implements Rayleigh + Mie scattering on a large inverted sphere using TSL.
// The sky becomes blue at high sun, red/orange near sunset, and the sun disc
// has a smooth Mie halo. Clouds are a separate volumetric FBM overlay.

import * as THREE from "three/webgpu";
import {
  Fn, vec3, vec4, float, uniform, normalize, dot, mix, clamp, pow,
  sin, cos, exp, length, smoothstep, max, min, fract, floor, abs, sqrt, time,
  positionWorld, cameraPosition,
} from "three/tsl";

const DEG = Math.PI / 180;

function dirFromAngles(elevDeg, azimDeg) {
  const e = elevDeg * DEG;
  const a = azimDeg * DEG;
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)).normalize();
}

export class RayleighSky {
  constructor(params = {}) {
    const s = params.sun ?? {};
    const a = params.atmosphere ?? {};
    const c = params.clouds ?? {};

    const sunDir = dirFromAngles(s.elevation ?? 18, s.azimuth ?? 220);

    this.sunUniforms = {
      direction: uniform(sunDir),
      intensity: uniform(s.intensity ?? 1.5),
    };
    this.sunDiskUniforms = {
      radius: uniform(s.diskRadius ?? 0.008),
      color: uniform(new THREE.Color(s.diskColor ?? "#fff2e6")),
      emissiveColor: uniform(new THREE.Color(s.diskEmissiveColor ?? "#ffeed9")),
      emissiveIntensity: uniform(s.diskEmissiveIntensity ?? 100),
    };
    this.atmosphereUniforms = {
      rayleighCoefficient: uniform(a.rayleighCoefficient ?? 1.0),
      mieCoefficient: uniform(a.mieCoefficient ?? 0.005),
      mieDirectionalG: uniform(a.mieDirectionalG ?? 0.78),
      turbidity: uniform(a.turbidity ?? 2.5),
      skyColor: uniform(new THREE.Color(a.skyColor ?? "#1a4080")),
      skyBrightness: uniform(a.skyBrightness ?? 1.0),
    };
    this.cloudUniforms = {
      enabled: uniform(c.enabled === false ? 0 : 1),
      coverage: uniform(c.coverage ?? 0.45),
      color: uniform(new THREE.Color(c.color ?? "#ffffff")),
      shadowColor: uniform(new THREE.Color(c.shadowColor ?? "#a0a8b0")),
      height: uniform(c.height ?? 0.5),
      thickness: uniform(c.thickness ?? 0.5),
      intensity: uniform(c.intensity ?? 1.0),
      opacityFalloff: uniform(c.opacityFalloff ?? 0.3),
      octaves: uniform(c.octaves ?? 4),
      lacunarity: uniform(c.lacunarity ?? 2.0),
      persistence: uniform(c.persistence ?? 0.5),
      scale: uniform(c.scale ?? 0.0003),
      speed: uniform(c.speed ?? 0.02),
    };

    this._buildMesh();
  }

  // Rayleigh + Mie atmospheric scattering. Returns vec3 sky radiance for a
  // given view direction. The approximation collapses optical-depth integrals
  // into per-view-zenith airmass terms so it runs cheaply in a fragment shader
  // while still producing the characteristic blue-day / orange-sunset gradient.
  _skyColorFn() {
    const sunDir = this.sunUniforms.direction;
    const sunInt = this.sunUniforms.intensity;
    const skyCol = this.atmosphereUniforms.skyColor;
    const rayCoef = this.atmosphereUniforms.rayleighCoefficient;
    const mieCoef = this.atmosphereUniforms.mieCoefficient;
    const mieG = this.atmosphereUniforms.mieDirectionalG;
    const turb = this.atmosphereUniforms.turbidity;
    const bright = this.atmosphereUniforms.skyBrightness;
    const diskRad = this.sunDiskUniforms.radius;
    const diskCol = this.sunDiskUniforms.color;
    const diskEmCol = this.sunDiskUniforms.emissiveColor;
    const diskEmInt = this.sunDiskUniforms.emissiveIntensity;

    return Fn(([viewDirInput]) => {
      const v = normalize(viewDirInput).toVar();
      const cosTheta = dot(v, sunDir).toVar();

      // ---- Sky gradient: zenith=skyColor (saturated), horizon=tinted+hazed ----
      const muS = clamp(sunDir.y, float(-0.1), float(1.0));
      // Sub-linear gradient — slow fade from horizon to zenith.
      const heightMix = smoothstep(float(-0.02), float(0.55), v.y);

      // Zenith: skyColor as user supplied, gently boosted by rayleighCoefficient.
      const userTint = skyCol.toVar();
      const zenithCol = userTint.mul(rayCoef.mul(0.4).add(0.7)).toVar();

      // Sun low → bigger atmosphere → orange horizon. Sun high → light haze.
      const sunLowAmt = clamp(float(0.35).sub(muS).mul(2.5), 0.0, 1.0);
      // Day-time horizon: zenith colour lightened a bit. Sunset: warm/orange.
      const dayHorizon = zenithCol.mul(1.25).add(vec3(0.05, 0.07, 0.10));
      const dustyHorizon = mix(vec3(0.72, 0.78, 0.85), zenithCol.mul(1.4), float(0.4));
      const warmHorizon = vec3(1.1, 0.55, 0.30);
      // Turbidity only adds haze when sun is reasonably up; at night it stays dark.
      const hazeAmt = clamp(turb.mul(0.10).mul(muS.add(0.1)), 0.0, 0.55);
      let horizonCol = mix(dayHorizon, dustyHorizon, hazeAmt).toVar();
      // Blend sunset warmth in proportional to sunLowAmt.
      horizonCol.assign(mix(horizonCol, warmHorizon, sunLowAmt.mul(0.65)));

      // Sun-side horizon glow (orange aura around sun direction at low altitude).
      const sunHorizDir = normalize(vec3(sunDir.x, float(0), sunDir.z));
      const viewHorizDir = normalize(vec3(v.x, float(0), v.z));
      const azimAlign = clamp(dot(viewHorizDir, sunHorizDir), 0.0, 1.0);
      const sunsetGlow = vec3(1.4, 0.55, 0.20).mul(pow(azimAlign, float(6))).mul(sunLowAmt).mul(1.0);
      horizonCol.addAssign(sunsetGlow);

      let sky = mix(horizonCol, zenithCol, heightMix).toVar();

      // ---- Mie forward scattering: glow concentrated toward sun direction ----
      const cos2 = cosTheta.mul(cosTheta);
      const g = mieG;
      const g2 = g.mul(g);
      const denom = pow(
        clamp(float(1.0).add(g2).sub(float(2.0).mul(g).mul(cosTheta)), 0.0001, 100.0),
        float(1.5),
      );
      const phaseM = float(1.0).sub(g2).mul(float(1.0).add(cos2)).div(float(2.0).add(g2).mul(denom));
      // Sun-direction Mie haze. Brighter when sun is low (more atmosphere) and at sunset.
      const mieGlow = vec3(1.0, 0.92, 0.78).mul(phaseM).mul(mieCoef.mul(40.0)).mul(sunInt);
      sky.addAssign(mieGlow);

      // Slight Rayleigh phase enhancement perpendicular to sun direction.
      const phaseR = float(0.75).mul(float(1.0).add(cos2));
      sky.addAssign(zenithCol.mul(phaseR.mul(0.04).mul(rayCoef)));

      // ---- Sun disc + halo ----
      // Core: small bright disc.
      const diskCore = smoothstep(float(1.0).sub(diskRad.mul(1.2)), float(1.0).sub(diskRad.mul(0.4)), cosTheta);
      sky.addAssign(diskCol.mul(diskCore).mul(diskEmInt.mul(0.012)));
      // Halo: tight glow just around disc (not the whole sky like before).
      const halo = pow(smoothstep(float(1.0).sub(diskRad.mul(10.0)), float(1.0), cosTheta), float(4.0));
      sky.addAssign(diskEmCol.mul(halo).mul(diskEmInt.mul(0.008)));

      // ---- Below-horizon fade ----
      const below = smoothstep(float(-0.06), float(0.02), v.y);
      sky.assign(sky.mul(below).mul(bright));

      return sky;
    });
  }

  // Volumetric-ish cloud overlay using REAL 3D value-noise (not 2D-projected).
  // Three altitude layers stacked for parallax depth.
  _cloudFn() {
    const cu = this.cloudUniforms;
    const sunDir = this.sunUniforms.direction;
    const t = time;

    // True 3D hash (all 3 components contribute).
    const hash3 = Fn(([p]) => {
      return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))).mul(43758.5453));
    });
    // Trilinear value noise over a 3D lattice — proper volumetric.
    const noise3D = Fn(([p]) => {
      const i = floor(p).toVar();
      const f = p.sub(i).toVar();
      const u = f.mul(f).mul(f.mul(-2.0).add(3.0));
      const n000 = hash3(i);
      const n100 = hash3(i.add(vec3(1, 0, 0)));
      const n010 = hash3(i.add(vec3(0, 1, 0)));
      const n110 = hash3(i.add(vec3(1, 1, 0)));
      const n001 = hash3(i.add(vec3(0, 0, 1)));
      const n101 = hash3(i.add(vec3(1, 0, 1)));
      const n011 = hash3(i.add(vec3(0, 1, 1)));
      const n111 = hash3(i.add(vec3(1, 1, 1)));
      const x00 = mix(n000, n100, u.x);
      const x10 = mix(n010, n110, u.x);
      const x01 = mix(n001, n101, u.x);
      const x11 = mix(n011, n111, u.x);
      const y0 = mix(x00, x10, u.y);
      const y1 = mix(x01, x11, u.y);
      return mix(y0, y1, u.z);
    });

    // FBM over the 3D noise.
    const fbm3D = Fn(([p]) => {
      let amp = float(0.5).toVar();
      let freq = float(1.0).toVar();
      let sum = float(0).toVar();
      const pv = p.toVar();
      for (let i = 0; i < 5; i++) {
        sum.addAssign(noise3D(pv.mul(freq)).mul(amp));
        freq.assign(freq.mul(cu.lacunarity));
        amp.assign(amp.mul(cu.persistence));
      }
      return sum;
    });

    return Fn(([viewDirInput]) => {
      const v = normalize(viewDirInput).toVar();
      const aboveHoriz = smoothstep(cu.height.sub(0.15), cu.height.add(0.05), v.y);

      // Project view ray to THREE altitude shells and sample each — gives parallax depth.
      // Each shell uses a different vertical slice of the same 3D noise volume.
      const drift = t.mul(cu.speed).mul(100.0);
      const baseScale = cu.scale.mul(800.0);

      // Low layer (near horizon, larger structure, slow drift).
      const proj1 = vec3(v.x.div(max(v.y, 0.05)), float(0.3), v.z.div(max(v.y, 0.05)));
      const p1 = vec3(proj1.x.add(drift), proj1.y, proj1.z.add(drift.mul(0.6))).mul(baseScale);
      const d1 = fbm3D(p1);

      // Mid layer (most visible mass).
      const proj2 = vec3(v.x.div(max(v.y, 0.06)).mul(0.6), float(0.6), v.z.div(max(v.y, 0.06)).mul(0.6));
      const p2 = vec3(proj2.x.add(drift.mul(0.8)), proj2.y, proj2.z.add(drift.mul(0.5))).mul(baseScale.mul(1.3));
      const d2 = fbm3D(p2);

      // High layer (cirrus-like, faint, fast drift).
      const proj3 = vec3(v.x.div(max(v.y, 0.08)).mul(0.35), float(0.9), v.z.div(max(v.y, 0.08)).mul(0.35));
      const p3 = vec3(proj3.x.add(drift.mul(1.4)), proj3.y, proj3.z.add(drift.mul(0.9))).mul(baseScale.mul(2.2));
      const d3 = fbm3D(p3);

      // Composite shells — each contributes additively before density curve.
      const rawDensity = d1.mul(0.5).add(d2.mul(0.35)).add(d3.mul(0.15));
      const density = clamp(rawDensity.sub(float(1.0).sub(cu.coverage)).mul(float(3.0).mul(cu.intensity)), 0.0, 1.0);
      const alpha = density.mul(aboveHoriz).mul(cu.enabled);

      // Self-shadowing via Beer's law: thicker patches darker. Combined with
      // sun-facing brightness factor for cheap volumetric lighting.
      const sunFactor = clamp(dot(v, sunDir), 0.0, 1.0);
      const beerLaw = exp(density.mul(float(2.0)).negate()); // [0..1], thicker → 0
      const litFactor = smoothstep(float(0.0), float(0.6), sunFactor).mul(beerLaw.mul(0.5).add(0.5));
      const shading = mix(cu.shadowColor, cu.color, litFactor.mul(0.7).add(density.mul(0.3)));
      // Sunset warming when sun is low.
      const sunsetTint = vec3(1.0, 0.7, 0.5).mul(pow(clamp(float(0.4).sub(sunDir.y), 0, 1), float(2.0))).mul(0.6);
      const finalCol = shading.add(sunsetTint.mul(density));

      return vec4(finalCol, alpha.mul(cu.opacityFalloff.mul(2.5)));
    });
  }

  _buildMesh() {
    const geom = new THREE.SphereGeometry(8000, 48, 24);
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });

    const skyFn = this._skyColorFn();
    const cloudFn = this._cloudFn();

    const viewDir = Fn(() => normalize(positionWorld.sub(cameraPosition)))();

    const sky = skyFn(viewDir).toVar();
    const cloud = cloudFn(viewDir).toVar();
    const combined = mix(sky, cloud.xyz, cloud.w).toVar();
    mat.colorNode = vec4(combined, 1.0);

    this._mesh = new THREE.Mesh(geom, mat);
    this._mesh.frustumCulled = false;
    this._mesh.renderOrder = -1000;
    this._skyFn = skyFn;
    this._material = mat;
  }

  // ===== SkyProvider interface =====
  getMesh() { return this._mesh; }
  getSkyBrightness() { return this.atmosphereUniforms.skyBrightness.value; }

  // Horizon color: physically tinted by sun elevation. Used by water reflection fade.
  getHorizonColor() {
    const sc = this.atmosphereUniforms.skyColor.value;
    const turb = this.atmosphereUniforms.turbidity.value;
    const sunElev = Math.max(0, this.sunUniforms.direction.value.y);
    // Low sun → warm horizon, high sun → blueish hazy horizon.
    const warm = new THREE.Color(0xff9c5e);
    const haze = new THREE.Color(0xa8c0d4);
    const sunsetAmt = Math.pow(1 - sunElev, 3);
    const hazeAmt = Math.min(0.55, turb * 0.10);
    const out = new THREE.Color(sc);
    out.lerp(haze, hazeAmt);
    out.lerp(warm, sunsetAmt * 0.5);
    return out;
  }

  createReflectionSampler() { return this._skyFn; }
  createFogSampler() { return this._skyFn; }
  dispose() { this._mesh.geometry.dispose(); this._material.dispose(); }

  setSunFromAngles(elevationDeg, azimuthDeg) {
    const d = dirFromAngles(elevationDeg, azimuthDeg);
    this.sunUniforms.direction.value.copy(d);
  }
}
