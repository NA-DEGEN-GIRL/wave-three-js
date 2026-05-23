// 10 built-in environment presets that match the threejs-water-pro names.
// Each preset configures water uniforms + a `sky` group consumed by RayleighSky.

const base = {
  waves: {
    windSpeed: 25, windDirection: 0.7, choppiness: 1.0, amplitude: 1.0,
    animationSpeed: 1.0, jonswapGamma: 3.3, directionalSpreading: 20.0, standingWaveRatio: 0.0,
  },
  gerstner: { wavelength: 45, amplitude: 0.7, wavelengthSpread: 1.4, directionalSpread: 0.6 },
  color: { shallowWaterColor: "#0fb8c4", deepWaterColor: "#0a3850", depthFalloff: 30, alpha: 1, transmissionColor: "#00ffcc" },
  fresnel: { normalStrength: 0.12, power: 3.0, fadePower: 1.0, fadeStart: 60 },
  sparkle: { enabled: true, intensity: 1.0, power: 512, minDistance: 10, fadeDistance: 500 },
  foam: {
    surface:   { enabled: true, coverage: 0.30, opacity: 0.35, color: "#ffffff", size: 80 },
    waves:     { enabled: true, coverage: 0.55, opacity: 0.6,  color: "#ffffff", crestCoverage: 0.5, peakIntensity: 1.0, rippleWeight: 1.0, waveWeight: 1.0, windBias: 0.8, windStretch: 0.5, size: 100 },
    shoreline: { enabled: true, coverage: 0.5,  opacity: 0.5,  color: "#ffffff", range: 40, size: 50 },
  },
  underwater: { fogColor: "#0a2830", fogDensity: 0.04, distortionIntensity: 0.025, distortionScale: 3.0, distortionSpeed: 0.5 },
  fog: { enabled: true, fadeStart: 700, fadePower: 1.0 },
  sun: { intensity: 1.5 },
  particles: { enabled: false, count: 200, size: 0.3, opacity: 0.4, color: "#a0c8d0", nearDistance: 2, farDistance: 50 },
  sky: {
    sun: { elevation: 18, azimuth: 220, intensity: 1.5, diskColor: "#fff2e6", diskEmissiveColor: "#ffeed9", diskEmissiveIntensity: 100, diskRadius: 0.022 },
    atmosphere: { rayleighCoefficient: 1.0, mieCoefficient: 0.003, mieDirectionalG: 0.75, turbidity: 2.5, skyColor: "#1a4080", skyBrightness: 1.0 },
    clouds: { enabled: true, coverage: 0.42, color: "#ffffff", shadowColor: "#a0a8b0", height: 0.5, thickness: 0.5, intensity: 1.0, opacityFalloff: 0.3, octaves: 4, lacunarity: 2.0, persistence: 0.5, scale: 0.0003, speed: 0.02 },
  },
};

function merge(into, from) {
  const out = Array.isArray(into) ? [...into] : { ...into };
  for (const k of Object.keys(from || {})) {
    if (from[k] && typeof from[k] === "object" && !Array.isArray(from[k])) {
      out[k] = merge(out[k] ?? {}, from[k]);
    } else out[k] = from[k];
  }
  return out;
}

const PRESETS = {
  tranquil: merge(base, {
    waves: { windSpeed: 6, choppiness: 0.5, amplitude: 0.4, animationSpeed: 0.6 },
    gerstner: { amplitude: 0.25, wavelength: 70, directionalSpread: 0.3 },
    color: { shallowWaterColor: "#5be3d8", deepWaterColor: "#0a4a6a", depthFalloff: 40 },
    foam: { waves: { coverage: 0.1, opacity: 0.2 }, surface: { coverage: 0.05 }, shoreline: { coverage: 0.25 } },
    sky: { sun: { elevation: 35, azimuth: 200 }, atmosphere: { turbidity: 1.8 } },
  }),
  tropical: merge(base, {
    waves: { windSpeed: 10, choppiness: 0.85, amplitude: 0.5 },
    gerstner: { amplitude: 0.35, wavelength: 45, directionalSpread: 0.5 },
    color: { shallowWaterColor: "#12cab2", deepWaterColor: "#022a3e", depthFalloff: 12, transmissionColor: "#19e8c0" },
    foam: { waves: { coverage: 0.14, opacity: 0.35, peakIntensity: 0.65 }, surface: { coverage: 0.0 }, shoreline: { coverage: 0.15 } },
    fresnel: { power: 4.5 },
    sky: { sun: { elevation: 35, azimuth: 200, intensity: 1.6 }, atmosphere: { turbidity: 2.4, skyColor: "#1a6db0", skyBrightness: 1.05 }, clouds: { coverage: 0.28 } },
  }),
  sunset: merge(base, {
    waves: { windSpeed: 18, choppiness: 1.0, amplitude: 0.9 },
    color: { shallowWaterColor: "#d8835a", deepWaterColor: "#1a0828", depthFalloff: 14, transmissionColor: "#ff9a6a" },
    sun: { intensity: 1.8 },
    fresnel: { power: 2.8 },
    sky: { sun: { elevation: 6, azimuth: 210, intensity: 2.0, diskEmissiveColor: "#ff8a3a", diskEmissiveIntensity: 140 }, atmosphere: { turbidity: 4.5, rayleighCoefficient: 1.5, skyColor: "#4a1c50", skyBrightness: 1.1 }, clouds: { coverage: 0.45, color: "#ffd1a0", shadowColor: "#5a3820" } },
  }),
  moonlit: merge(base, {
    waves: { windSpeed: 18, choppiness: 1.0, amplitude: 0.9 },
    color: { shallowWaterColor: "#3a6da0", deepWaterColor: "#04101e", depthFalloff: 35, transmissionColor: "#5080a0" },
    sun: { intensity: 0.5 },
    fresnel: { power: 3.5 },
    sky: { sun: { elevation: 38, azimuth: 130, intensity: 0.5, diskColor: "#f4f0e0", diskEmissiveColor: "#aabad0", diskEmissiveIntensity: 30, diskRadius: 0.012 }, atmosphere: { rayleighCoefficient: 0.4, mieCoefficient: 0.001, turbidity: 1.0, skyColor: "#070a14", skyBrightness: 0.4 }, clouds: { coverage: 0.25, color: "#5a6878", shadowColor: "#2a3040" } },
  }),
  choppy: merge(base, {
    waves: { windSpeed: 35, choppiness: 1.4, amplitude: 1.2, animationSpeed: 1.2 },
    gerstner: { amplitude: 1.0, wavelength: 60, directionalSpread: 0.8 },
    color: { shallowWaterColor: "#0aa5b8", deepWaterColor: "#072a3e" },
    foam: { waves: { coverage: 0.7, opacity: 0.8, crestCoverage: 0.7 }, surface: { coverage: 0.4 } },
    underwater: { distortionIntensity: 0.05 },
    sky: { sun: { elevation: 22, azimuth: 245 }, atmosphere: { turbidity: 3.5 }, clouds: { coverage: 0.55 } },
  }),
  storm: merge(base, {
    waves: { windSpeed: 50, choppiness: 1.4, amplitude: 1.4, animationSpeed: 1.3 },
    gerstner: { amplitude: 1.4, wavelength: 90, directionalSpread: 0.7 },
    color: { shallowWaterColor: "#243c48", deepWaterColor: "#020812", depthFalloff: 16 },
    foam: { waves: { coverage: 0.45, opacity: 0.7, crestCoverage: 0.6 }, surface: { coverage: 0.2, opacity: 0.3 } },
    fresnel: { power: 4 },
    sun: { intensity: 0.4 },
    sky: { sun: { elevation: 12, azimuth: 200, intensity: 0.4, diskEmissiveIntensity: 20 }, atmosphere: { turbidity: 3.0, rayleighCoefficient: 0.6, skyBrightness: 0.35, skyColor: "#0e1420" }, clouds: { coverage: 0.85, color: "#3a424c", shadowColor: "#161a22" } },
  }),
  hurricane: merge(base, {
    waves: { windSpeed: 70, choppiness: 1.8, amplitude: 2.0, animationSpeed: 1.6, directionalSpreading: 35 },
    gerstner: { amplitude: 1.8, wavelength: 110, directionalSpread: 1.0 },
    color: { shallowWaterColor: "#0e3848", deepWaterColor: "#020a14", depthFalloff: 18 },
    foam: { waves: { coverage: 0.95, opacity: 1.0, crestCoverage: 0.95 }, surface: { coverage: 0.6, opacity: 0.6 }, shoreline: { coverage: 0.7 } },
    underwater: { distortionIntensity: 0.07 },
    sun: { intensity: 0.4 },
    sky: { sun: { elevation: 3, azimuth: 190, intensity: 0.4 }, atmosphere: { turbidity: 8.0, rayleighCoefficient: 0.4, skyBrightness: 0.35, skyColor: "#222630" }, clouds: { coverage: 0.95, color: "#4a525c", shadowColor: "#1a1e26" } },
  }),
  arctic: merge(base, {
    waves: { windSpeed: 32, choppiness: 1.1, amplitude: 1.1 },
    color: { shallowWaterColor: "#3c7388", deepWaterColor: "#081826", depthFalloff: 22, transmissionColor: "#6a9eb4" },
    foam: { waves: { coverage: 0.6 }, shoreline: { color: "#e0eef4" }, surface: { color: "#e8f4f8" } },
    sky: { sun: { elevation: 12, azimuth: 200, intensity: 0.9, diskEmissiveColor: "#e0e8f0" }, atmosphere: { turbidity: 2.5, skyColor: "#5a7a98", skyBrightness: 0.85 }, clouds: { coverage: 0.7, color: "#e6ecf0" } },
  }),
  foggy: merge(base, {
    waves: { windSpeed: 12, choppiness: 0.8, amplitude: 0.6 },
    color: { shallowWaterColor: "#8aa0a8", deepWaterColor: "#506068", depthFalloff: 30 },
    foam: { waves: { coverage: 0.25 } },
    fog: { enabled: true, fadeStart: 200, fadePower: 0.7 },
    sun: { intensity: 0.6 },
    sky: { sun: { elevation: 25, azimuth: 200, intensity: 0.7 }, atmosphere: { turbidity: 6.0, rayleighCoefficient: 0.3, skyBrightness: 0.7, skyColor: "#a4adb4" }, clouds: { coverage: 0.95, color: "#c0c4c8", shadowColor: "#8a8e94" } },
  }),
  seaOfThieves: merge(base, {
    waves: { windSpeed: 22, choppiness: 1.1, amplitude: 1.2, animationSpeed: 0.9 },
    gerstner: { amplitude: 1.0, wavelength: 75, directionalSpread: 0.6 },
    color: { shallowWaterColor: "#28d0c4", deepWaterColor: "#0a3a55", depthFalloff: 25 },
    foam: { waves: { coverage: 0.7, opacity: 0.85, crestCoverage: 0.8 }, surface: { coverage: 0.45 } },
    sun: { intensity: 1.6 },
    fresnel: { power: 2.6 },
    sky: { sun: { elevation: 28, azimuth: 240, intensity: 1.8, diskEmissiveColor: "#ffd49a" }, atmosphere: { turbidity: 3.0, rayleighCoefficient: 1.2, skyColor: "#1f5cb0" }, clouds: { coverage: 0.55, color: "#fff4d8", shadowColor: "#8a7058" } },
  }),
};

export function getPresetParams(name) {
  const p = PRESETS[name];
  if (!p) throw new Error(`Unknown preset: ${name}. Available: ${Object.keys(PRESETS).join(", ")}`);
  // Deep clone so callers can mutate freely.
  return JSON.parse(JSON.stringify(p));
}

export function listPresets() { return Object.keys(PRESETS); }

export const __PRESETS = PRESETS;
