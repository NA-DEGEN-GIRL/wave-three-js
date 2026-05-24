// Public entry point that matches the threejs-water-pro package surface.
import { WaterSystem } from "./WaterSystem.js";
import { Gerstner } from "./Gerstner.js";
import { BuoyancySystem } from "./Buoyancy.js";
import { OceanFloor } from "./OceanFloor.js";
import { RayleighSky } from "./RayleighSky.js";
import { GradientSky } from "./GradientSky.js";
import { OfficialSky } from "./OfficialSky.js";
import { FishSchool } from "./FishSchool.js";
import { getPresetParams, listPresets } from "./presets.js";
import { QUALITY_LEVELS, getQualityConfig } from "./QualityLevels.js";
import { snapshot, applySnapshot, PresetStore } from "./PresetStore.js";

// Make `loadPreset("name")` work by wiring presets in here.
const _origLoadPreset = WaterSystem.prototype.loadPreset;
WaterSystem.prototype.loadPreset = function loadPreset(p) {
  if (typeof p === "string") p = getPresetParams(p);
  this.applyPreset(p);
};

export {
  WaterSystem,
  Gerstner,
  BuoyancySystem,
  OceanFloor,
  RayleighSky,
  GradientSky,
  OfficialSky,
  FishSchool,
  getPresetParams,
  listPresets,
  QUALITY_LEVELS,
  getQualityConfig,
  snapshot,
  applySnapshot,
  PresetStore,
};
