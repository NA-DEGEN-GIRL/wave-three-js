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

  // Volumetric-ish cloud overlay: project view dir onto a high-altitude plane,
  // sample FBM noise, light with sun direction, and return vec4(rgb, alpha).
  _cloudFn() {
    const cu = this.cloudUniforms;
    const sunDir = this.sunUniforms.direction;
    const t = time;

    const hash22 = Fn(([p]) => {
      const x = fract(sin(dot(p, vec3(127.1, 311.7, 74.7))).mul(43758.5453));
      const y = fract(sin(dot(p, vec3(269.5, 183.3, 246.1))).mul(43758.5453));
      return vec3(x, y, float(0));
    });
    const noise3 = Fn(([p]) => {
      const i = floor(p).toVar();
      const f = p.sub(i).toVar();
      const u = f.mul(f).mul(f.mul(-2.0).add(3.0));
      const a = hash22(i).x;
      const b = hash22(i.add(vec3(1, 0, 0))).x;
      const c = hash22(i.add(vec3(0, 0, 1))).x;
      const d = hash22(i.add(vec3(1, 0, 1))).x;
      const xa = mix(a, b, u.x);
      const xb = mix(c, d, u.x);
      return mix(xa, xb, u.z);
    });

    return Fn(([viewDirInput]) => {
      const v = normalize(viewDirInput).toVar();
      // Don't sample clouds if looking below the horizon.
      const aboveHoriz = smoothstep(cu.height.sub(0.15), cu.height.add(0.05), v.y);

      // Project to cloud plane at unit height.
      const proj = vec3(v.x.div(max(v.y, 0.05)), float(0.0), v.z.div(max(v.y, 0.05)));
      const drift = t.mul(cu.speed).mul(100.0);
      const p0 = vec3(proj.x.add(drift), float(0), proj.z.add(drift.mul(0.6))).mul(cu.scale.mul(1000.0)).toVar();

      let amp = float(0.5).toVar();
      let freq = float(1.0).toVar();
      let sum = float(0).toVar();
      for (let i = 0; i < 5; i++) {
        sum.addAssign(noise3(p0.mul(freq)).mul(amp));
        freq.assign(freq.mul(cu.lacunarity));
        amp.assign(amp.mul(cu.persistence));
      }

      // Coverage threshold + intensity curve.
      const density = clamp(sum.sub(float(1.0).sub(cu.coverage)).mul(float(3.0).mul(cu.intensity)), 0.0, 1.0);
      const alpha = density.mul(aboveHoriz).mul(cu.enabled);

      // Self-shadowing: clouds darker on the side facing away from sun (cheap approx).
      const sunFactor = clamp(dot(v, sunDir), 0.0, 1.0);
      const shading = mix(cu.shadowColor, cu.color, smoothstep(float(0.0), float(0.6), sunFactor).mul(0.6).add(density.mul(0.4)));
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
