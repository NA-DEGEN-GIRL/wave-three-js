// OceanFFT — Tessendorf-style FFT ocean displacement generator.
//
// Architecture overview (matches Tessendorf 2001 / GPU Gems Ch.1.10):
//   1. CPU build of h0(k) once per parameter change:
//        h0(k) = (1/sqrt(2)) * (xi_r + i*xi_i) * sqrt(Phillips(k))
//      where xi_r, xi_i ~ N(0,1).
//   2. Per frame, evolve in frequency domain:
//        h(k, t) = h0(k) * exp(i*omega(k)*t) + conj(h0(-k)) * exp(-i*omega(k)*t)
//        omega(k) = sqrt(g*|k|)
//   3. Apply 2D IFFT to recover the spatial displacement map y(x, z, t).
//      Also IFFT the horizontal components Dx, Dz (for "choppy" sharpening) and
//      the slope channels for normal reconstruction.
//   4. Upload the result to a DataTexture; the water vertex shader samples it
//      via world-XZ → UV tiling.
//
// This MVP performs the FFT on the CPU at N=64. That's slow-ish (~3-6 ms/frame
// on modern CPUs for a single channel) but proves the pipeline end-to-end with
// no compute-shader dependency. A WebGPU compute-shader Stockham IFFT can drop
// in later behind the same `getDisplacementTexture()` API and is the ideal
// production path — see comments at the bottom for the extension sketch.

import * as THREE from "three/webgpu";

const G = 9.81;

// Box-Muller standard normal sample.
function gaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Phillips spectrum (Tessendorf eq. 23). Returns spectral density at wavenumber k.
function phillips(kx, kz, windDir, windSpeed, A) {
  const k2 = kx * kx + kz * kz;
  if (k2 < 1e-8) return 0;
  const k4 = k2 * k2;
  const L = (windSpeed * windSpeed) / G;
  const L2 = L * L;
  const wx = Math.cos(windDir);
  const wz = Math.sin(windDir);
  const kDotW = (kx * wx + kz * wz) / Math.sqrt(k2);
  const kDotW2 = kDotW * kDotW;
  const damp = Math.exp(-1 / (k2 * L2)) / k4;
  // Suppress sub-grid waves to reduce numerical noise (Tessendorf eq. 24 footnote).
  const smallWaveCut = Math.exp(-k2 * (L * 1e-3) * (L * 1e-3));
  return A * damp * kDotW2 * smallWaveCut;
}

// In-place radix-2 Cooley–Tukey FFT on a complex array stored as [re, im, re, im, ...].
// Length must be power of 2. Direction: +1 forward, -1 inverse (caller scales by 1/N).
function fft1D(buf, N, dir) {
  // Bit-reversal permutation.
  let j = 0;
  for (let i = 0; i < N; i++) {
    if (i < j) {
      const tr = buf[2 * i], ti = buf[2 * i + 1];
      buf[2 * i] = buf[2 * j]; buf[2 * i + 1] = buf[2 * j + 1];
      buf[2 * j] = tr; buf[2 * j + 1] = ti;
    }
    let m = N >> 1;
    while (m >= 1 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  // Butterflies.
  for (let size = 2; size <= N; size *= 2) {
    const half = size >> 1;
    const theta = (dir * 2 * Math.PI) / size;
    const wpr = Math.cos(theta);
    const wpi = Math.sin(theta);
    for (let s = 0; s < N; s += size) {
      let wr = 1, wi = 0;
      for (let k = 0; k < half; k++) {
        const a = s + k;
        const b = a + half;
        const tr = wr * buf[2 * b] - wi * buf[2 * b + 1];
        const ti = wr * buf[2 * b + 1] + wi * buf[2 * b];
        buf[2 * b] = buf[2 * a] - tr;
        buf[2 * b + 1] = buf[2 * a + 1] - ti;
        buf[2 * a] += tr;
        buf[2 * a + 1] += ti;
        const wrNew = wr * wpr - wi * wpi;
        wi = wr * wpi + wi * wpr;
        wr = wrNew;
      }
    }
  }
}

// 2D IFFT — column-major then row-major passes on an NxN complex grid (length 2*N*N).
function ifft2D(grid, N) {
  // Row-wise inverse.
  const row = new Float32Array(2 * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      row[2 * x] = grid[2 * (y * N + x)];
      row[2 * x + 1] = grid[2 * (y * N + x) + 1];
    }
    fft1D(row, N, -1);
    for (let x = 0; x < N; x++) {
      grid[2 * (y * N + x)] = row[2 * x];
      grid[2 * (y * N + x) + 1] = row[2 * x + 1];
    }
  }
  // Column-wise inverse.
  const col = new Float32Array(2 * N);
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) {
      col[2 * y] = grid[2 * (y * N + x)];
      col[2 * y + 1] = grid[2 * (y * N + x) + 1];
    }
    fft1D(col, N, -1);
    for (let y = 0; y < N; y++) {
      grid[2 * (y * N + x)] = col[2 * y] / (N * N);
      grid[2 * (y * N + x) + 1] = col[2 * y + 1] / (N * N);
    }
  }
}

export class OceanFFT {
  constructor({
    N = 64,             // FFT size (must be power of 2; 64 is the CPU-friendly sweet spot)
    L = 80,             // patch size in world meters — wavelengths up to L are representable
    windSpeed = 18,
    windDirection = 0.7,
    amplitude = 0.001,  // Phillips A — small values keep displacement bounded
  } = {}) {
    this.N = N;
    this.L = L;
    this.windSpeed = windSpeed;
    this.windDirection = windDirection;
    this.amplitude = amplitude;

    // Frequency-domain initial spectrum h0(k), stored as complex N*N.
    this._h0 = new Float32Array(2 * N * N);
    // Per-frame complex grids (height, displacement x, displacement z).
    this._htBuf = new Float32Array(2 * N * N);
    this._dxBuf = new Float32Array(2 * N * N);
    this._dzBuf = new Float32Array(2 * N * N);
    // Spatial-domain result: RGBA texture, channels = (dy, dx, dz, _).
    this._textureData = new Float32Array(N * N * 4);
    this.texture = new THREE.DataTexture(this._textureData, N, N, THREE.RGBAFormat, THREE.FloatType);
    this.texture.wrapS = THREE.RepeatWrapping;
    this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;

    this._buildInitialSpectrum();
  }

  _buildInitialSpectrum() {
    const { N, L, windSpeed, windDirection, amplitude } = this;
    const buf = this._h0;
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        // Wavenumber vector (k_x, k_z). Centred so the DC component is at index N/2.
        const kx = (2 * Math.PI * (n - N / 2)) / L;
        const kz = (2 * Math.PI * (m - N / 2)) / L;
        const P = phillips(kx, kz, windDirection, windSpeed, amplitude);
        const xr = gaussian();
        const xi = gaussian();
        const s = Math.sqrt(P / 2);
        buf[2 * (m * N + n)]     = xr * s;
        buf[2 * (m * N + n) + 1] = xi * s;
      }
    }
  }

  update(time) {
    const { N, L } = this;
    const h0 = this._h0;
    const ht = this._htBuf;
    const dx = this._dxBuf;
    const dz = this._dzBuf;
    // Time evolution: h(k, t) = h0(k)·exp(iωt) + conj(h0(-k))·exp(-iωt).
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const kx = (2 * Math.PI * (n - N / 2)) / L;
        const kz = (2 * Math.PI * (m - N / 2)) / L;
        const k = Math.sqrt(kx * kx + kz * kz);
        const omega = Math.sqrt(G * k);
        const cosWt = Math.cos(omega * time);
        const sinWt = Math.sin(omega * time);

        const idx = 2 * (m * N + n);
        const h0r = h0[idx], h0i = h0[idx + 1];

        // Mirror index for (-k).
        const mn = (N - n) % N;
        const mm = (N - m) % N;
        const idxN = 2 * (mm * N + mn);
        const h0nr = h0[idxN], h0ni = -h0[idxN + 1]; // conj

        // h(k,t) = h0·(cos+i·sin) + h0n·(cos-i·sin)
        const hr = (h0r + h0nr) * cosWt - (h0i + h0ni) * sinWt;
        const hi = (h0r - h0nr) * sinWt + (h0i + h0ni) * cosWt;
        ht[idx] = hr; ht[idx + 1] = hi;

        // Horizontal displacement (Tessendorf "choppy" — D_x = i·k_x/|k|·h, etc.).
        if (k > 1e-6) {
          const kxn = kx / k;
          const kzn = kz / k;
          dx[idx]     = hi * kxn;   // multiplied by i: re becomes -im, im becomes re
          dx[idx + 1] = -hr * kxn;
          dz[idx]     = hi * kzn;
          dz[idx + 1] = -hr * kzn;
        } else {
          dx[idx] = 0; dx[idx + 1] = 0;
          dz[idx] = 0; dz[idx + 1] = 0;
        }
      }
    }
    // Three 2D inverse FFTs to get spatial fields.
    ifft2D(ht, N);
    ifft2D(dx, N);
    ifft2D(dz, N);

    // Pack real parts into the RGBA texture. Apply the standard checkerboard
    // sign flip (FFT centering) so DC isn't at the corner.
    const tex = this._textureData;
    const lambda = 1.0; // chop strength
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const sign = ((n + m) & 1) ? -1 : 1;
        const i = m * N + n;
        const c = 2 * i;
        tex[i * 4]     = ht[c] * sign;            // dy (height)
        tex[i * 4 + 1] = dx[c] * sign * lambda;   // dx
        tex[i * 4 + 2] = dz[c] * sign * lambda;   // dz
        tex[i * 4 + 3] = 0;
      }
    }
    this.texture.needsUpdate = true;
  }

  setParameters({ windSpeed, windDirection, amplitude } = {}) {
    let dirty = false;
    if (windSpeed !== undefined && windSpeed !== this.windSpeed) { this.windSpeed = windSpeed; dirty = true; }
    if (windDirection !== undefined && windDirection !== this.windDirection) { this.windDirection = windDirection; dirty = true; }
    if (amplitude !== undefined && amplitude !== this.amplitude) { this.amplitude = amplitude; dirty = true; }
    if (dirty) this._buildInitialSpectrum();
  }

  /** Sample uniforms for the water material to do world XZ → texture UV mapping. */
  get patchSize() { return this.L; }
  get displacementTexture() { return this.texture; }

  dispose() { this.texture.dispose(); }
}

// ---------------------------------------------------------------------------
// GPU UPGRADE PATH (sketch)
//
// To replace the CPU FFT with a WebGPU compute-shader Stockham IFFT:
//   1. Allocate three StorageTextureNodes (rgba16float, NxN) for ht/dx/dz.
//   2. Compute kernel A — `spectrumKernel(workgroupSize=[8,8])`: per-cell
//      compute h0(k) once at init OR each frame for animated wind.
//   3. Compute kernel B — `timeEvolution(workgroupSize=[8,8])`: per cell,
//      update h(k,t) from h0 + conj(h0(-k)) and the dispersion relation.
//   4. Compute kernel C — Stockham FFT row-pass: log2(N) dispatches of
//      `fftStage(stage)` with workgroupSize=[N/2, 1].
//   5. Compute kernel D — Stockham FFT column-pass: same shape, on columns.
//   6. The final storage texture is bound directly as this.texture; no CPU
//      readback needed.
// All TSL primitives exist (compute, storage, storageTexture). The arithmetic
// here is the canonical reference; just translate to TSL.
// ---------------------------------------------------------------------------
