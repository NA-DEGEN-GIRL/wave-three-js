// Quality tier table mirroring threejs-water-pro docs.
export const QUALITY_LEVELS = {
  low:    { meshSegments: 16,  fftWaves: 128, ripples: 0,   cascades: 1, ssr: false, refraction: false, domainWarpFoam: false, gerstnerCount: 0, sceneColorScale: 0.25 },
  medium: { meshSegments: 32,  fftWaves: 128, ripples: 0,   cascades: 1, ssr: false, refraction: false, domainWarpFoam: false, gerstnerCount: 3, sceneColorScale: 0.5  },
  high:   { meshSegments: 64,  fftWaves: 256, ripples: 256, cascades: 2, ssr: true,  refraction: true,  domainWarpFoam: true,  gerstnerCount: 6, sceneColorScale: 0.5  },
  ultra:  { meshSegments: 128, fftWaves: 256, ripples: 512, cascades: 2, ssr: true,  refraction: true,  domainWarpFoam: true,  gerstnerCount: 8, sceneColorScale: 1.0  },
};

export function getQualityConfig(level = "high") {
  return QUALITY_LEVELS[level] ?? QUALITY_LEVELS.high;
}
