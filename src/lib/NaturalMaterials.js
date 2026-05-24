// NaturalMaterials — rocks + sand. Now baked per-vertex colors on a regular
// MeshStandardMaterial. Earlier attempts used TSL MeshStandardNodeMaterial
// with triplanar noise in colorNode, but the colorNode never reached the
// renderer (rocks stayed default white-gray under lighting). Per-vertex
// baking is simpler, has zero shader-author footprint, and applyWetness()
// correctly wraps the resulting standard material to add the foam/height
// wet response on top -- so we get the same final look without the TSL
// path.

import * as THREE from "three/webgpu";
import { ImprovedNoise } from "three/addons/math/ImprovedNoise.js";

const _noise = new ImprovedNoise();

function fbm3(x, y, z, octaves = 4) {
  let sum = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += _noise.noise(x * freq, y * freq, z * freq) * amp;
    freq *= 2.07;
    amp  *= 0.5;
  }
  return sum * 0.5 + 0.5;   // map roughly to [0, 1]
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

// ------------------- Rock material -------------------

/**
 * @param {object}   [opts]
 * @returns {THREE.MeshStandardMaterial}
 */
export function createRockMaterial({
  roughness = 0.88,
  metalness = 0.02,
} = {}) {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness,
    metalness,
  });
}

/**
 * Bake per-vertex colours onto a rock geometry. Call once after geometry
 * construction. Reads existing `position` + `normal` attributes, writes
 * `color`. The mesh material must have vertexColors: true.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {object} [opts]
 * @param {number[]} [opts.baseColors=[0x6b4a30, 0x9c7d54, 0xc4a07c]]
 * @param {number}   [opts.mossColor=0x55763d]
 * @param {number}   [opts.scale=0.35]  noise scale (smaller = bigger features)
 * @param {number}   [opts.seed=0]      noise seed offset
 */
export function paintRockColors(geometry, opts = {}) {
  const c1 = new THREE.Color(opts.baseColors?.[0] ?? 0x6b4a30);
  const c2 = new THREE.Color(opts.baseColors?.[1] ?? 0x9c7d54);
  const c3 = new THREE.Color(opts.baseColors?.[2] ?? 0xc4a07c);
  const cMoss = new THREE.Color(opts.mossColor ?? 0x55763d);
  const scale = opts.scale ?? 0.35;
  const seed  = opts.seed ?? 0;

  const pos = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  if (!normal) { geometry.computeVertexNormals(); }
  const N = pos.count;
  const colors = new Float32Array(N * 3);

  const tmp = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ny = normal.getY(i);

    // Large-scale tone variation (which of the 3 palette colours dominates).
    const big = fbm3(x * scale + seed, y * scale, z * scale, 3);
    const med = fbm3((x * scale + 7.2) * 2.4 + seed, y * scale * 2.4, z * scale * 2.4, 3);
    // Fine grain: per-vertex darkening pattern.
    const fine = fbm3(x * scale * 7 + seed * 0.5, y * scale * 7, z * scale * 7, 2);

    tmp.copy(c1).lerp(c2, big);
    tmp.lerp(c3, Math.pow(med, 0.55) * 0.65);
    // Fine grain modulation (0.78..1.06 brightness)
    const grain = 0.78 + fine * 0.28;
    tmp.multiplyScalar(grain);

    // Moss on upward-facing flat surfaces, sparser via low-freq noise mask.
    if (ny > 0.32) {
      const mossNoise = fbm3(x * 0.45 + seed, 0, z * 0.45, 2);
      const upT = clamp01((ny - 0.32) / 0.5);
      const mossAmt = upT * clamp01((mossNoise - 0.42) * 4) * 0.7;
      tmp.lerp(cMoss, mossAmt);
    }

    colors[i * 3]     = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

// ------------------- Sand material -------------------

export function createSandMaterial({
  roughness = 1.0,
  metalness = 0.0,
} = {}) {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness,
    metalness,
  });
}

/**
 * Bake per-vertex colours onto a sand-mound geometry.
 *
 * The sand mound is built with concentric rings, so vertices near the edge
 * (low y, close to the waterline) get a darker, wetter colour, and central
 * vertices get the bright dry tone. Adds noise variation so the pattern
 * doesn't look like a perfect ring.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {object} [opts]
 * @param {number} [opts.baseColor=0xe2c089]
 * @param {number} [opts.shadowColor=0xb0915e]
 * @param {number} [opts.wetColor=0x8c6e44]
 * @param {number} [opts.waterlineY=0]
 * @param {number} [opts.scale=0.4]
 */
export function paintSandColors(geometry, opts = {}) {
  const c1 = new THREE.Color(opts.baseColor ?? 0xe2c089);
  const c2 = new THREE.Color(opts.shadowColor ?? 0xb0915e);
  const cWet = new THREE.Color(opts.wetColor ?? 0x8c6e44);
  const scale = opts.scale ?? 0.4;
  const waterY = opts.waterlineY ?? 0;

  const pos = geometry.attributes.position;
  const N = pos.count;
  const colors = new Float32Array(N * 3);
  const tmp = new THREE.Color();

  for (let i = 0; i < N; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);

    // Base XZ-projected variation + fine grain.
    const variation = fbm3(x * scale, 0, z * scale, 3);
    const grain     = fbm3(x * scale * 7, 0, z * scale * 7, 2);

    tmp.copy(c1).lerp(c2, variation * 0.6);
    tmp.multiplyScalar(0.88 + grain * 0.24);

    // Wet sand band near the waterline (tight: ~±0.3 m around waterY).
    const dyW = y - waterY;
    if (dyW < 0.3 && dyW > -0.4) {
      const wet = Math.exp(-((dyW + 0.05) * (dyW + 0.05)) / 0.04) * 0.65;
      tmp.lerp(cWet, wet);
    }

    colors[i * 3]     = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}
