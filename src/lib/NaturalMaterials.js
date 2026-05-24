// NaturalMaterials — procedural MeshStandardNodeMaterials for rocks and sand.
// Triplanar-projected multi-octave noise color, slope-based moss, height-based
// wet zone near the waterline, optional coupling to a FoamSimulation RT so a
// crashing wave actually darkens the rocks it splashes on.
//
// Why procedural and not Polyhaven textures? Bundle weight + zero asset deps,
// while still matching what a real-looking rock needs: large color variation,
// medium tonal mottling, narrow crack lines, sub-pixel grain. With triplanar
// projection there are no visible UV seams on the icosahedron geometry, which
// was the previous flat-shaded-MeshStandard look's main giveaway.
//
// applyWetness() will skip these materials because they are NodeMaterials, not
// MeshStandardMaterial. The wet response is built in here instead.

import * as THREE from "three/webgpu";
import {
  Fn, vec2, vec3, vec4, float, uniform, texture, mix, smoothstep, clamp,
  abs, normalize, fract, floor, dot, sin, cos, pow, min, max, length,
  positionWorld, normalWorld,
} from "three/tsl";

// ------------------- Noise primitives (TSL) -------------------

const _hash21 = Fn(([p]) => {
  return fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
});

const _hash22 = Fn(([p]) => {
  const x = fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
  const y = fract(sin(dot(p, vec2(269.5, 183.3))).mul(43758.5453));
  return vec2(x, y);
});

const _valueNoise2 = Fn(([p]) => {
  const i = floor(p).toVar();
  const f = p.sub(i).toVar();
  const u = f.mul(f).mul(f.mul(-2.0).add(3.0));
  const a = _hash21(i);
  const b = _hash21(i.add(vec2(1, 0)));
  const c = _hash21(i.add(vec2(0, 1)));
  const d = _hash21(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

const _fbm5 = Fn(([p]) => {
  const sum  = float(0).toVar();
  const amp  = float(0.5).toVar();
  const freq = float(1.0).toVar();
  const pv   = p.toVar();
  for (let i = 0; i < 5; i++) {
    sum.addAssign(_valueNoise2(pv.mul(freq)).mul(amp));
    freq.assign(freq.mul(2.13));
    amp.assign(amp.mul(0.5));
  }
  return sum;
});

// Cellular (Worley-like) distance — used for crack lines in rock.
const _cellDist = Fn(([p]) => {
  const i = floor(p).toVar();
  const f = p.sub(i).toVar();
  const minD = float(1.0).toVar();
  for (let yo = -1; yo <= 1; yo++) {
    for (let xo = -1; xo <= 1; xo++) {
      const ofs = vec2(xo, yo);
      const h  = _hash22(i.add(ofs));
      const dp = ofs.add(h).sub(f);
      const d  = length(dp);
      minD.assign(min(minD, d));
    }
  }
  return minD;
});

// ------------------- Rock material -------------------

/**
 * @param {object}   [opts]
 * @param {number}   [opts.scale=0.22]            world-space → noise scale; smaller = bigger features
 * @param {number[]} [opts.baseColors=[0x52453a, 0x7a6a55, 0x9b8770]]   3-tone palette
 * @param {number}   [opts.mossColor=0x4d6b3a]
 * @param {number}   [opts.wetDarken=0.45]         strength of the wet-zone darkening
 * @param {number}   [opts.waterlineY=0]
 * @param {object}   [opts.foamSim]                optional — if given, foam splatter darkens the rock
 */
export function createRockMaterial({
  scale = 0.22,
  // Warmer / more saturated than the prior gray-browns. The defaults read
  // as proper sandstone-leaning-granite under both sunset and tropical
  // lighting, not the washed-out grays the previous palette produced.
  baseColors = [0x6b4a30, 0x9c7d54, 0xc4a07c],
  mossColor = 0x55763d,
  wetDarken = 0.22,
  waterlineY = 0,
  foamSim = null,
} = {}) {
  const c1 = new THREE.Color(baseColors[0]);
  const c2 = new THREE.Color(baseColors[1]);
  const c3 = new THREE.Color(baseColors[2]);
  const moss = new THREE.Color(mossColor);

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0.02 });

  // Sample base rock colour at a 2D plane projection.
  const rockColorAt = Fn(([p]) => {
    const big  = _fbm5(p).toVar();
    const med  = _fbm5(p.mul(3.0).add(vec2(7.2, 1.7))).toVar();
    const fine = _fbm5(p.mul(11.0).add(vec2(2.3, 9.7))).toVar();
    const col = mix(vec3(c1.r, c1.g, c1.b), vec3(c2.r, c2.g, c2.b), big).toVar();
    col.assign(mix(col, vec3(c3.r, c3.g, c3.b), pow(med, float(0.55))));
    // Narrow crack lines in valleys of the cellular distance field.
    const crack = _cellDist(p.mul(1.6));
    const crackMask = smoothstep(float(0.10), float(0.0), crack);
    col.assign(mix(col, col.mul(0.38), crackMask.mul(0.7)));
    // Fine grain modulation.
    col.assign(col.mul(float(0.78).add(fine.mul(0.42))));
    return col;
  });

  const sN = float(scale);
  const waterY = uniform(waterlineY);

  mat.colorNode = Fn(() => {
    const pw = positionWorld;
    const nw = normalize(normalWorld);

    // Triplanar weights (squared → sharper transitions between planes).
    const wAbs = abs(nw);
    const w2   = wAbs.mul(wAbs).toVar();
    const wSum = w2.x.add(w2.y).add(w2.z).add(0.0001);
    const wx = w2.x.div(wSum);
    const wy = w2.y.div(wSum);
    const wz = w2.z.div(wSum);

    const colYZ = rockColorAt(vec2(pw.y, pw.z).mul(sN));
    const colXZ = rockColorAt(vec2(pw.x, pw.z).mul(sN));
    const colXY = rockColorAt(vec2(pw.x, pw.y).mul(sN));
    const baseCol = colYZ.mul(wx).add(colXZ.mul(wy)).add(colXY.mul(wz)).toVar();

    // Moss on upward-facing flat tops, sparser via low-freq noise.
    const upFacing = smoothstep(float(0.35), float(0.85), nw.y);
    const mossNoise = _fbm5(pw.xz.mul(0.35));
    const mossMask  = upFacing.mul(smoothstep(float(0.40), float(0.65), mossNoise));
    baseCol.assign(mix(baseCol, vec3(moss.r, moss.g, moss.b).mul(0.75), mossMask.mul(0.7)));

    // Tight wet zone: a narrow band centred exactly on the waterline
    // (about +/- 0.4 m), not a wide gradient — the previous 2.8 m band
    // engulfed entire submerged outcrops and made them look like polished
    // baduk stones rather than wet-splashed rock.
    const dyW = pw.y.sub(waterY);
    const wetHeight = smoothstep(float(0.5), float(0.0), dyW)
                      .mul(smoothstep(float(-0.4), float(0.0), dyW));
    // Foam coupling — sample foam RT if provided.
    const wetFoam = float(0).toVar();
    if (foamSim) {
      const fHalf = foamSim.halfSizeUniform;
      const fCtr  = foamSim.centerXZUniform;
      const fUV = vec2(
        pw.x.sub(fCtr.x).div(fHalf).mul(0.5).add(0.5),
        pw.z.sub(fCtr.y).div(fHalf).mul(0.5).add(0.5),
      );
      // Far rocks will sample at the edge-clamped UV; we just multiply by an
      // in-bounds factor so far-from-camera rocks don't get a constant foam tint.
      const inB = smoothstep(float(0.02), float(0.06), fUV.x)
                   .mul(smoothstep(float(0.98), float(0.94), fUV.x))
                   .mul(smoothstep(float(0.02), float(0.06), fUV.y))
                   .mul(smoothstep(float(0.98), float(0.94), fUV.y));
      wetFoam.assign(texture(foamSim.currentTexture, fUV).r.mul(inB).mul(0.3));
    }
    const wet = clamp(max(wetHeight, wetFoam), float(0.0), float(1.0));
    baseCol.assign(baseCol.mul(float(1.0).sub(wet.mul(wetDarken))));

    return vec4(baseCol, 1.0);
  })();

  // Wet zones are slightly smoother — but never mirror-glossy. Floor at
  // 0.65 keeps the surface reading as rock, not polished stone.
  mat.roughnessNode = Fn(() => {
    const pw = positionWorld;
    const dyW = pw.y.sub(waterY);
    const wet = smoothstep(float(0.5), float(0.0), dyW)
                .mul(smoothstep(float(-0.4), float(0.0), dyW));
    return mix(float(0.92), float(0.65), wet);
  })();

  return mat;
}

// ------------------- Sand material -------------------

/**
 * @param {object} [opts]
 * @param {number} [opts.scale=0.45]        XZ noise scale
 * @param {number} [opts.baseColor=0xe2c089]
 * @param {number} [opts.shadowColor=0xb0915e]   variation colour for patches
 * @param {number} [opts.wetColor=0x8c6e44]      wet-sand colour
 * @param {number} [opts.waterlineY=0]
 */
export function createSandMaterial({
  scale = 0.45,
  baseColor = 0xe2c089,
  shadowColor = 0xb0915e,
  wetColor = 0x8c6e44,
  waterlineY = 0,
} = {}) {
  const c1 = new THREE.Color(baseColor);
  const c2 = new THREE.Color(shadowColor);
  const cWet = new THREE.Color(wetColor);

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 1.0, metalness: 0.0 });
  const sN = float(scale);
  const waterY = uniform(waterlineY);

  mat.colorNode = Fn(() => {
    const pw = positionWorld;
    const p  = pw.xz.mul(sN);

    // Fine grain + medium-scale colour variation patches.
    const grain     = _fbm5(p.mul(9.0));
    const variation = _fbm5(p.mul(1.4).add(vec2(2.7, 5.1)));

    // No more pow(0.7) — that was biasing every pixel toward the darker
    // tone and making the beach read as dull gray-brown. Linear mix keeps
    // the warm tan dominant with patches of the shadow tone for variety.
    const col = mix(vec3(c1.r, c1.g, c1.b), vec3(c2.r, c2.g, c2.b), variation).toVar();
    col.assign(col.mul(float(0.92).add(grain.mul(0.22))));

    // Wave-pattern ridges near the water line — narrow horizontal bands.
    const dyW = pw.y.sub(waterY);
    const closeToWater = smoothstep(float(0.5), float(0.0), dyW)
                          .mul(smoothstep(float(-0.4), float(0.0), dyW));
    const ripple = sin(pw.x.mul(0.6).add(_fbm5(p.mul(3.0)).mul(2.0))).mul(0.5).add(0.5);
    const rippleMask = pow(ripple, float(3.0)).mul(closeToWater).mul(0.18);
    col.assign(col.mul(float(1.0).sub(rippleMask)));

    // Tight wet sand band — a strip right at the waterline, not the whole
    // submerged half. Strength capped at 0.55 so the wet stripe doesn\'t
    // look like wet paint.
    const wet = smoothstep(float(0.4), float(0.0), dyW)
                .mul(smoothstep(float(-0.3), float(0.0), dyW));
    col.assign(mix(col, vec3(cWet.r, cWet.g, cWet.b), wet.mul(0.55)));

    return vec4(col, 1.0);
  })();

  mat.roughnessNode = Fn(() => {
    const pw = positionWorld;
    const dyW = pw.y.sub(waterY);
    const wet = smoothstep(float(0.4), float(0.0), dyW)
                .mul(smoothstep(float(-0.3), float(0.0), dyW));
    // Floor at 0.75 — wet sand is matte, not glossy.
    return mix(float(1.0), float(0.75), wet);
  })();

  return mat;
}

// Re-export TSL helpers so other modules can reuse them.
export const noiseTSL = {
  hash21: _hash21,
  hash22: _hash22,
  valueNoise2: _valueNoise2,
  fbm5: _fbm5,
  cellDist: _cellDist,
};

