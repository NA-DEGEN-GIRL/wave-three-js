// TypeScript definitions for threejs-water-pro-clone
import * as THREE from "three";

// ---------- Wave parameters ----------

export interface WaveUniforms {
  windSpeed: { value: number };
  windDirection: { value: number };
  choppiness: { value: number };
  amplitude: { value: number };
  jonswapGamma: { value: number };
  directionalSpreading: { value: number };
  standingWaveRatio: { value: number };
  gravity: { value: number };
  animationSpeed: number;        // plain number, not .value
  rippleAmplitude: { value: number };
  rippleFrequency: { value: number };
  microAmplitude: { value: number };
  microFrequency: { value: number };
}

export interface WaterColor {
  shallowWaterColor: THREE.Color;
  deepWaterColor: THREE.Color;
  depthFalloff: number;
  alpha: number;
  transmissionColor: THREE.Color;
  clarity: number;               // 0=opaque, 1=standard, 2=crystal-clear
}

export interface FoamSurface {
  enabled: boolean;
  color: THREE.Color;
  coverage: number;
  opacity: number;
  size: number;
  foamTexture: THREE.Texture | null;
}
export interface FoamWaves extends FoamSurface {
  crestCoverage: number;
  peakIntensity: number;
  rippleWeight: number;
  waveWeight: number;
  windBias: number;
  windStretch: number;
}
export interface FoamShoreline extends FoamSurface {
  range: number;
}
export interface FoamContact {
  enabled: boolean;
  color: THREE.Color;
  coverage: number;
  opacity: number;
  distance: number;
}

export interface BuoyancyOptions {
  heightOffset?: number;
  heightSmoothing?: number;
  multiPoint?: boolean;
  rotationInfluence?: number;
  rotationSmoothing?: number;
  rotationOffset?: THREE.Euler;
  sampleLength?: number;
  sampleWidth?: number;
  sampleOffset?: THREE.Vector3;
  useBoundingBox?: boolean;
}

export interface BuoyancySystem {
  addObject(object: THREE.Object3D, options?: BuoyancyOptions): number;
  removeObject(id: number): boolean;
  hasObject(id: number): boolean;
  getObjectCount(): number;
  clear(): void;
  updateObjectConfig(id: number, options: Partial<BuoyancyOptions>): boolean;
  getDebugData(): Array<{ id: number; position: [number, number, number] }>;
}

export interface SkyProvider {
  getMesh(): THREE.Mesh;
  getHorizonColor(): THREE.Color;
  getSkyBrightness(): number;
  createReflectionSampler(): unknown;
  createFogSampler(): unknown;
  dispose(): void;
}

// ---------- Main class ----------

export type QualityLevel = "low" | "medium" | "high" | "ultra";

export class WaterSystem {
  static create(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    quality?: QualityLevel,
  ): Promise<WaterSystem>;

  readonly backend: "webgpu" | "webgl";
  readonly scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  cameraTracking: boolean;
  wireframe: boolean;

  waves: WaveUniforms;
  color: WaterColor;
  fresnel: { normalStrength: number; power: number; fadePower: number; fadeStart: number };
  sparkle: { enabled: boolean; intensity: number; power: number; minDistance: number; fadeDistance: number };
  sss: { enabled: boolean; intensity: number; power: number };
  ssr: { enabled: boolean; strength: number };
  sun: { direction: { value: THREE.Vector3 }; intensity: { value: number } };
  foam: { surface: FoamSurface; waves: FoamWaves; shoreline: FoamShoreline; contact: FoamContact };
  splash: { enabled: boolean; intensity: number };

  buoyancy: BuoyancySystem;
  gerstner: Gerstner;
  reflector: WaterReflector;
  refraction: RefractionPass;
  foamSim: FoamSimulation;
  floor: OceanFloor;

  update(deltaTime: number): Promise<void>;
  render(): void;
  resize(width?: number, height?: number): void;
  dispose(): Promise<void>;

  setSky(provider: SkyProvider | null): void;
  setEnvironmentMap(envMap: THREE.CubeTexture): void;
  loadPreset(preset: WaterPreset): void;
  setQualityLevel(quality: QualityLevel, params?: Partial<WaterPreset>): Promise<void>;
  rebuildGeometry(config: { levels?: number; segments?: number; baseSize?: number }): void;
  getGeometryConfig(): { levels: number; segments: number; baseSize: number };
  recreateOceanFloor(options?: { depth?: number; meshResolution?: number }): Promise<void>;
  updateCascadeConfig(index: number, config: { amplitude?: number }): void;
  setPosition(x: number, z: number): void;
  getHeightAt(x: number, z: number): Promise<number>;
  createPostProcessingNode(scenePass: unknown, inputColor?: unknown): unknown;
}

export class Gerstner {
  constructor(opts?: {
    count?: number;
    wavelength?: number;
    amplitude?: number;
    wavelengthSpread?: number;
    directionalSpread?: number;
    jonswapGamma?: number;
  });
  update(opts: Partial<{
    count: number;
    wavelength: number;
    amplitude: number;
    wavelengthSpread: number;
    directionalSpread: number;
    jonswapGamma: number;
  }>): void;
  count: number;
  wavelength: number;
  amplitude: number;
  wavelengthSpread: number;
  directionalSpread: number;
  jonswapGamma: number;
  waves: Array<{ dirAngle: number; wavelength: number; amplitude: number; steepness: number; phase: number; k: number; isSwell: boolean }>;
  swellCount: number;
  rippleCount: number;
}

export class WaterReflector {
  constructor(opts?: { resolution?: number });
  target: THREE.RenderTarget;
  update(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, hideList?: THREE.Object3D[]): void;
  dispose(): void;
}

export class RefractionPass {
  constructor(opts?: { resolution?: number });
  target: THREE.RenderTarget;
  update(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, hideList?: THREE.Object3D[]): void;
  dispose(): void;
}

export class FoamSimulation {
  constructor(opts?: { resolution?: number; worldSize?: number; decayRate?: number; advectionStrength?: number });
  readonly currentTexture: unknown;     // TextureNode
  readonly centerXZUniform: unknown;
  readonly halfSizeUniform: unknown;
  setDecayRate(r: number): void;
  setBirthRate(r: number): void;
  setWorldSize(s: number): void;
  attach(opts: { waves: unknown[]; windDir: unknown; windSpeed: unknown; choppiness: unknown; ampGlobal: unknown }): void;
  update(renderer: THREE.WebGPURenderer, camera: THREE.Camera, dt: number, tAccum: number): void;
  dispose(): void;
}

export class OceanFloor {
  constructor(opts?: { size?: number; depth?: number; meshResolution?: number; sunDirection?: unknown; foamSim?: FoamSimulation });
  getMesh(): THREE.Mesh;
  dispose(): void;
}

export class RayleighSky implements SkyProvider {
  constructor(params?: {
    sun?: Partial<{ elevation: number; azimuth: number; intensity: number; diskColor: string; diskEmissiveColor: string; diskEmissiveIntensity: number; diskRadius: number }>;
    atmosphere?: Partial<{ rayleighCoefficient: number; mieCoefficient: number; mieDirectionalG: number; turbidity: number; skyColor: string; skyBrightness: number }>;
    clouds?: Partial<{ enabled: boolean; coverage: number; color: string; shadowColor: string; height: number; thickness: number; intensity: number; opacityFalloff: number; octaves: number; lacunarity: number; persistence: number; scale: number; speed: number }>;
  });
  sunUniforms: { direction: { value: THREE.Vector3 }; intensity: { value: number } };
  atmosphereUniforms: Record<string, { value: unknown }>;
  cloudUniforms: Record<string, { value: unknown }>;
  sunDiskUniforms: Record<string, { value: unknown }>;
  setSunFromAngles(elevationDeg: number, azimuthDeg: number): void;
  getMesh(): THREE.Mesh;
  getHorizonColor(): THREE.Color;
  getSkyBrightness(): number;
  createReflectionSampler(): unknown;
  createFogSampler(): unknown;
  dispose(): void;
}

export class GradientSky implements SkyProvider {
  constructor(opts?: { topColor?: string; bottomColor?: string; sunDir?: THREE.Vector3; sunColor?: string; sunSize?: number });
  sunUniforms: { direction: { value: THREE.Vector3 }; intensity: { value: number } };
  atmosphereUniforms: Record<string, { value: unknown }>;
  sunDiskUniforms: Record<string, { value: unknown }>;
  cloudUniforms: { enabled: { value: number }; coverage: { value: number } };
  setSunFromAngles(elevationDeg: number, azimuthDeg: number): void;
  getMesh(): THREE.Mesh;
  getHorizonColor(): THREE.Color;
  getSkyBrightness(): number;
  createReflectionSampler(): unknown;
  createFogSampler(): unknown;
  dispose(): void;
}

// ---------- Presets ----------

export type WaterPreset = ReturnType<typeof getPresetParams>;
export function getPresetParams(name: string): {
  waves: Partial<{ windSpeed: number; windDirection: number; choppiness: number; amplitude: number; animationSpeed: number; jonswapGamma: number; directionalSpreading: number; standingWaveRatio: number }>;
  gerstner: { wavelength: number; amplitude: number; wavelengthSpread: number; directionalSpread: number };
  color: { shallowWaterColor: string; deepWaterColor: string; depthFalloff: number; alpha: number; transmissionColor: string };
  fresnel: { normalStrength: number; power: number; fadePower: number; fadeStart: number };
  sparkle: { enabled: boolean; intensity: number; power: number; minDistance: number; fadeDistance: number };
  foam: { surface: object; waves: object; shoreline: object };
  underwater: object;
  fog: { enabled: boolean; fadeStart: number; fadePower: number };
  sun: { intensity: number };
  particles: object;
  sky: { sun: object; atmosphere: object; clouds: object };
};
export function listPresets(): string[];
export const QUALITY_LEVELS: Record<QualityLevel, object>;
export function getQualityConfig(level?: QualityLevel): object;

// ---------- Helpers ----------

export function makeSeaweed(opts?: { x?: number; z?: number; height?: number; count?: number }): THREE.Group;
export function makeUnderwaterParticles(opts?: { count?: number; radius?: number }): THREE.Points;

export function applyWetness(
  root: THREE.Object3D,
  waterSystem: WaterSystem,
  opts?: { waterlineY?: number; fadeRange?: number; porosity?: number; foamCoupling?: number },
): void;
