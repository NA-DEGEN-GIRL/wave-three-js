// Two-cascade Gerstner wave bank with Phillips-spectrum-weighted amplitudes.
//
// Replaces the previous 6-wave hand-tuned bank. The improvement comes from:
//   1. SHORTER base wavelength (5-10x) so visible chop appears at any framing.
//   2. Two cascades: SWELL (long waves) + RIPPLE (short waves) — matches the
//      docs' "JONSWAP spectrum with 2 cascades (waves, ripples)" description.
//   3. Random direction + phase with cos² spread weighting around the wind
//      so we get short-crested 3D peaks instead of infinite 2D rollers.
//   4. Amplitudes drawn from a Phillips spectrum so the dominant scale follows
//      the Pierson-Moskowitz peak at L = U²/g.

import * as THREE from "three/webgpu";

// Deterministic Hammersley-style sequence (avoids bunching from Math.random per session).
function hammersley(i, n) {
  let v = 0;
  let base = 1 / 2;
  let b = i;
  while (b > 0) {
    if (b & 1) v += base;
    base *= 0.5;
    b >>= 1;
  }
  return [(i + 0.5) / n, v];
}

// Phillips spectrum value at wavenumber k. Returns spectral density.
// k: scalar magnitude of wave vector (1/m)
// L = U²/g — characteristic length of largest swell driven by wind speed U
function phillips(k, L, smallWaveCutoff) {
  if (k < 1e-6) return 0;
  const k2 = k * k;
  const damp = Math.exp(-1 / (k * L) ** 2) / (k2 * k2); // exp(-1/(kL)^2) / k^4
  const smallCut = Math.exp(-k2 * smallWaveCutoff * smallWaveCutoff);
  return damp * smallCut;
}

// JONSWAP peak enhancement applied on top of Phillips: γ^r with Gaussian r.
// This gives a much more "wind-driven" peaked spectrum vs flat Phillips.
function jonswapEnhancement(k, kPeak, gamma) {
  if (gamma <= 1.0) return 1.0;
  const omega = Math.sqrt(9.81 * k);
  const omegaP = Math.sqrt(9.81 * kPeak);
  const sigma = omega <= omegaP ? 0.07 : 0.09;
  const r = Math.exp(-((omega - omegaP) ** 2) / (2 * sigma * sigma * omegaP * omegaP));
  return Math.pow(gamma, r);
}

// cos² directional weighting (matches JONSWAP cosine-squared spreading)
function dirWeight(theta, spread) {
  const c = Math.cos(theta);
  if (c < 0) return 0;
  return Math.pow(c, 2 * spread);
}

function buildCascade({
  count,
  kMin,
  kMax,
  windSpeed,
  directionalSpread,
  ampScale,
  spreadAngleHalfRange,
  jonswapGamma,
  targetRms = 0.4, // target RMS amplitude (m) summed across the cascade
  seedOffset = 0,
}) {
  // Distribute wavenumbers log-spaced over [kMin, kMax].
  const logKMin = Math.log(kMin);
  const logKMax = Math.log(kMax);
  const L = (windSpeed * windSpeed) / 9.81;
  // Peak wavenumber for JONSWAP (Pierson-Moskowitz): k_peak = g/U²·(0.85·2π) inverse.
  const kPeak = (0.85 * 2 * Math.PI * 9.81) / (windSpeed * windSpeed);
  const smallWaveCutoff = 0.5 / Math.max(kMax, 1);
  const deltaLogK = (logKMax - logKMin) / count;

  const waves = [];

  for (let i = 0; i < count; i++) {
    // Sample k near the centre of each log-band (gives even visual decade coverage).
    const tk = (i + 0.5) / count;
    const k = Math.exp(logKMin + tk * (logKMax - logKMin));
    const wavelength = (2 * Math.PI) / k;

    // Sample direction within [-spreadAngleHalfRange, +spreadAngleHalfRange] from wind.
    const [h1, h2] = hammersley(i + seedOffset, count);
    const dirT = h2 * 2 - 1; // -1..+1
    const dirAngle = dirT * spreadAngleHalfRange;

    // Phillips × JONSWAP-enhancement spectrum with directional weight.
    const phil = phillips(k, L, smallWaveCutoff);
    const jons = jonswapEnhancement(k, kPeak, jonswapGamma);
    const spec = phil * jons;
    const dirW = dirWeight(dirAngle, directionalSpread);
    // Amplitude proportional to sqrt(2 · P(k) · Δk · D(θ)). Δk in log space ≈ k·ΔlogK.
    const dk = k * deltaLogK;
    const amplitude = Math.sqrt(Math.max(0, 2 * spec * dk * dirW)) * ampScale;

    const phase = h1 * Math.PI * 2;
    // Steepness derived from k and amplitude. Real Gerstner Q ≤ 1/(k·A·N_active) to
    // avoid loop folding — we approximate via a safe constant + per-wave cap.
    const safeQ = Math.min(0.95, 1 / Math.max(0.5, k * amplitude * count * 0.3));
    const steepness = safeQ;

    waves.push({ dirAngle, wavelength, amplitude, steepness, phase, k, isSwell: false });
  }

  // Normalize: scale all amplitudes so the cascade has a controlled RMS sum.
  // Without this, Phillips-weighted amplitudes vary wildly with windSpeed and
  // can completely overwhelm the camera (or vanish entirely).
  let sumA2 = 0;
  for (const w of waves) sumA2 += w.amplitude * w.amplitude;
  const rms = Math.sqrt(sumA2 / Math.max(1, waves.length));
  if (rms > 1e-6) {
    const k = (targetRms * ampScale) / rms;
    for (const w of waves) w.amplitude *= k;
    // Re-derive steepness with normalized amplitudes.
    for (const w of waves) {
      w.steepness = Math.min(0.92, 1.0 / Math.max(0.5, w.k * w.amplitude * waves.length * 0.3));
    }
  }

  return { waves };
}

export class Gerstner {
  constructor({
    count = 18,
    wavelength = 50,
    amplitude = 0.8,
    wavelengthSpread = 1.4,
    directionalSpread = 0.6,
    jonswapGamma = 3.3,
  } = {}) {
    // Public API mirrors the docs: wavelength here is the SWELL peak wavelength.
    this.count = count;
    this.wavelength = wavelength;
    this.amplitude = amplitude;
    this.wavelengthSpread = wavelengthSpread;
    this.directionalSpread = directionalSpread;
    this.jonswapGamma = jonswapGamma;
    this.onChange = null;
    this._build();
  }

  _build() {
    // Split count roughly: 35% swell, 65% ripples (visual density priority).
    const swellCount = Math.max(4, Math.round(this.count * 0.35));
    const rippleCount = Math.max(6, this.count - swellCount);

    // Effective wind speed proxy (cascade builders need real-ish numbers).
    // Use base wavelength to back out a "wind speed equivalent" via Pierson-Moskowitz.
    // λ_peak ≈ 0.85 * 2π * U² / g  →  U = sqrt(λ_peak * g / (0.85 * 2π))
    const peakL = this.wavelength;
    const windSpeed = Math.max(2, Math.sqrt((peakL * 9.81) / (0.85 * 2 * Math.PI)));

    // SWELL cascade — long waves carrying most of the energy.
    const swellSpreadRad = this.directionalSpread * 0.6; // tight around wind
    const swell = buildCascade({
      count: swellCount,
      kMin: (2 * Math.PI) / (peakL * 3.5), // longest = 3.5x peak
      kMax: (2 * Math.PI) / (peakL * 0.4), // shortest = 0.4x peak
      windSpeed,
      directionalSpread: 1.5,
      ampScale: this.amplitude,
      targetRms: 0.45, // ~0.45m RMS per swell wave (sum ~1m peak)
      spreadAngleHalfRange: swellSpreadRad,
      jonswapGamma: this.jonswapGamma,
      seedOffset: 17,
    });

    // RIPPLE cascade — sub-meter to few-meter waves. These give the surface
    // its "alive, glittering" texture under sunlight.
    const rippleSpreadRad = this.directionalSpread * 1.4;
    const ripple = buildCascade({
      count: rippleCount,
      kMin: (2 * Math.PI) / 6.0, // 6m wavelength
      kMax: (2 * Math.PI) / 0.5, // 0.5m wavelength
      windSpeed: windSpeed * 0.6,
      directionalSpread: 2.5,
      ampScale: this.amplitude,
      targetRms: 0.06, // tiny — sub-meter wavelets
      spreadAngleHalfRange: rippleSpreadRad,
      jonswapGamma: Math.max(1.2, this.jonswapGamma * 0.7),
      seedOffset: 233,
    });

    // Mark swell waves so the shader can restrict foam generation to large waves.
    for (const w of swell.waves) w.isSwell = true;

    // Combine into a single bank for the shader. We keep them in one array so the
    // existing TSL `for (const w of waves)` loop works unchanged.
    this.waves = [...swell.waves, ...ripple.waves];
    this.swellCount = swell.waves.length;
    this.rippleCount = ripple.waves.length;
  }

  update(opts = {}) {
    if (opts.wavelength !== undefined) this.wavelength = opts.wavelength;
    if (opts.amplitude !== undefined) this.amplitude = opts.amplitude;
    if (opts.wavelengthSpread !== undefined) this.wavelengthSpread = opts.wavelengthSpread;
    if (opts.directionalSpread !== undefined) this.directionalSpread = opts.directionalSpread;
    if (opts.count !== undefined) this.count = opts.count;
    if (opts.jonswapGamma !== undefined) this.jonswapGamma = opts.jonswapGamma;
    this._build();
    if (this.onChange) this.onChange();
  }
}
