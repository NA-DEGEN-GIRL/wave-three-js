// PresetStore — save / load / export user-tuned presets.
//
// Two layers:
//   1. snapshot(water, sky)   → plain JS object capturing every public knob
//   2. applySnapshot(water, sky, obj) → puts those values back
//   3. PresetStore class wraps localStorage and gives list/save/load/delete + JSON I/O
//
// Snapshots are JSON-safe so they can be exported, shared, version-controlled.

import * as THREE from "three/webgpu";

const STORAGE_KEY = "wave-three-js:userPresets";
const SCHEMA_VERSION = 1;

// ---------- Snapshot helpers ----------

function colToHex(c) { return "#" + c.getHexString(); }

/**
 * Capture every public tweakable parameter from a WaterSystem + (optional) RayleighSky
 * into a plain JS object. Symmetric with `applySnapshot()`.
 */
export function snapshot(water, sky = null) {
  const w = water;
  const out = {
    version: SCHEMA_VERSION,
    waves: {
      windSpeed: w.waves.windSpeed.value,
      windDirection: w.waves.windDirection.value,
      choppiness: w.waves.choppiness.value,
      amplitude: w.waves.amplitude.value,
      jonswapGamma: w.waves.jonswapGamma.value,
      directionalSpreading: w.waves.directionalSpreading.value,
      standingWaveRatio: w.waves.standingWaveRatio.value,
      animationSpeed: w.waves.animationSpeed,
      rippleAmplitude: w.waves.rippleAmplitude.value,
      rippleFrequency: w.waves.rippleFrequency.value,
      microAmplitude: w.waves.microAmplitude.value,
      microFrequency: w.waves.microFrequency.value,
    },
    gerstner: {
      count: w.gerstner.count,
      wavelength: w.gerstner.wavelength,
      amplitude: w.gerstner.amplitude,
      wavelengthSpread: w.gerstner.wavelengthSpread,
      directionalSpread: w.gerstner.directionalSpread,
      jonswapGamma: w.gerstner.jonswapGamma,
    },
    color: {
      shallowWaterColor: colToHex(w.color.shallowWaterColor),
      deepWaterColor: colToHex(w.color.deepWaterColor),
      depthFalloff: w.color.depthFalloff,
      alpha: w.color.alpha,
      transmissionColor: colToHex(w.color.transmissionColor),
      clarity: w.color.clarity,
    },
    fresnel: { ...w.fresnel },
    sparkle: { ...w.sparkle },
    sss: { ...w.sss },
    ssr: { ...w.ssr },
    sun: {
      direction: w.sun.direction.value.toArray(),
      intensity: w.sun.intensity.value,
    },
    foam: {
      surface: { ...w.foam.surface, color: colToHex(w.foam.surface.color), foamTexture: null },
      waves:   { ...w.foam.waves,   color: colToHex(w.foam.waves.color),   foamTexture: null },
      shoreline:{ ...w.foam.shoreline,color: colToHex(w.foam.shoreline.color),foamTexture: null },
      contact: { ...w.foam.contact, color: colToHex(w.foam.contact.color) },
    },
    splash: { ...w.splash },
    reflection: { ...w.reflection },
    fog: { ...w.fog },
    waterline: { ...w.waterline },
    sunShafts: { ...w.sunShafts },
    underwater: {
      enabled: w.underwater.enabled,
      fogColor: colToHex(w.underwater.fogUniforms.color.value),
      fogDensity: w.underwater.fogUniforms.density.value,
      distortionEnabled: w.underwater.distortionUniforms.enabled.value,
      distortionIntensity: w.underwater.distortionUniforms.intensity.value,
      distortionSpeed: w.underwater.distortionUniforms.speed.value,
      distortionScale: w.underwater.distortionUniforms.scale.value,
    },
    sky: sky ? {
      sun: {
        direction: sky.sunUniforms.direction.value.toArray(),
        intensity: sky.sunUniforms.intensity.value,
      },
      sunDisk: {
        radius: sky.sunDiskUniforms.radius.value,
        color: colToHex(sky.sunDiskUniforms.color.value),
        emissiveColor: colToHex(sky.sunDiskUniforms.emissiveColor.value),
        emissiveIntensity: sky.sunDiskUniforms.emissiveIntensity.value,
      },
      atmosphere: {
        rayleighCoefficient: sky.atmosphereUniforms.rayleighCoefficient.value,
        mieCoefficient: sky.atmosphereUniforms.mieCoefficient.value,
        mieDirectionalG: sky.atmosphereUniforms.mieDirectionalG.value,
        turbidity: sky.atmosphereUniforms.turbidity.value,
        skyColor: colToHex(sky.atmosphereUniforms.skyColor.value),
        skyBrightness: sky.atmosphereUniforms.skyBrightness.value,
      },
      clouds: {
        enabled: sky.cloudUniforms.enabled.value,
        coverage: sky.cloudUniforms.coverage.value,
        color: colToHex(sky.cloudUniforms.color.value),
        shadowColor: colToHex(sky.cloudUniforms.shadowColor.value),
        height: sky.cloudUniforms.height.value,
        thickness: sky.cloudUniforms.thickness.value,
        intensity: sky.cloudUniforms.intensity.value,
        opacityFalloff: sky.cloudUniforms.opacityFalloff.value,
        octaves: sky.cloudUniforms.octaves.value,
        lacunarity: sky.cloudUniforms.lacunarity.value,
        persistence: sky.cloudUniforms.persistence.value,
        scale: sky.cloudUniforms.scale.value,
        speed: sky.cloudUniforms.speed.value,
      },
    } : null,
  };
  return out;
}

/** Apply a previously-captured snapshot to the WaterSystem + (optional) sky. */
export function applySnapshot(water, sky, snap) {
  if (!snap) return;
  const w = water;
  const assignIfDef = (target, key, value) => {
    if (value !== undefined) target[key] = value;
  };
  const setUni = (uni, value) => {
    if (uni && value !== undefined) uni.value = value;
  };
  // Waves
  if (snap.waves) {
    setUni(w.waves.windSpeed,         snap.waves.windSpeed);
    setUni(w.waves.windDirection,     snap.waves.windDirection);
    setUni(w.waves.choppiness,        snap.waves.choppiness);
    setUni(w.waves.amplitude,         snap.waves.amplitude);
    setUni(w.waves.jonswapGamma,      snap.waves.jonswapGamma);
    setUni(w.waves.directionalSpreading, snap.waves.directionalSpreading);
    setUni(w.waves.standingWaveRatio, snap.waves.standingWaveRatio);
    assignIfDef(w.waves, "animationSpeed", snap.waves.animationSpeed);
    setUni(w.waves.rippleAmplitude,   snap.waves.rippleAmplitude);
    setUni(w.waves.rippleFrequency,   snap.waves.rippleFrequency);
    setUni(w.waves.microAmplitude,    snap.waves.microAmplitude);
    setUni(w.waves.microFrequency,    snap.waves.microFrequency);
  }
  if (snap.gerstner) w.gerstner.update(snap.gerstner);
  if (snap.color) {
    if (snap.color.shallowWaterColor) w.color.shallowWaterColor.set(snap.color.shallowWaterColor);
    if (snap.color.deepWaterColor) w.color.deepWaterColor.set(snap.color.deepWaterColor);
    if (snap.color.transmissionColor) w.color.transmissionColor.set(snap.color.transmissionColor);
    assignIfDef(w.color, "depthFalloff", snap.color.depthFalloff);
    assignIfDef(w.color, "alpha", snap.color.alpha);
    assignIfDef(w.color, "clarity", snap.color.clarity);
  }
  Object.assign(w.fresnel, snap.fresnel ?? {});
  Object.assign(w.sparkle, snap.sparkle ?? {});
  Object.assign(w.sss,     snap.sss ?? {});
  Object.assign(w.ssr,     snap.ssr ?? {});
  if (snap.sun) {
    if (Array.isArray(snap.sun.direction)) w.sun.direction.value.fromArray(snap.sun.direction);
    setUni(w.sun.intensity, snap.sun.intensity);
  }
  if (snap.foam) {
    for (const g of ["surface", "waves", "shoreline", "contact"]) {
      if (!snap.foam[g]) continue;
      const src = snap.foam[g];
      const dst = w.foam[g];
      for (const k of Object.keys(src)) {
        if (k === "color") { dst.color.set(src.color); continue; }
        if (k === "foamTexture") continue; // never restore raw texture refs from JSON
        dst[k] = src[k];
      }
    }
  }
  Object.assign(w.splash, snap.splash ?? {});
  Object.assign(w.reflection, snap.reflection ?? {});
  Object.assign(w.fog, snap.fog ?? {});
  Object.assign(w.waterline, snap.waterline ?? {});
  Object.assign(w.sunShafts, snap.sunShafts ?? {});
  if (snap.underwater) {
    assignIfDef(w.underwater, "enabled", snap.underwater.enabled);
    if (snap.underwater.fogColor) w.underwater.fogUniforms.color.value.set(snap.underwater.fogColor);
    setUni(w.underwater.fogUniforms.density, snap.underwater.fogDensity);
    setUni(w.underwater.distortionUniforms.enabled, snap.underwater.distortionEnabled);
    setUni(w.underwater.distortionUniforms.intensity, snap.underwater.distortionIntensity);
    setUni(w.underwater.distortionUniforms.speed, snap.underwater.distortionSpeed);
    setUni(w.underwater.distortionUniforms.scale, snap.underwater.distortionScale);
  }
  // Sky
  if (sky && snap.sky) {
    if (snap.sky.sun) {
      if (Array.isArray(snap.sky.sun.direction)) sky.sunUniforms.direction.value.fromArray(snap.sky.sun.direction);
      setUni(sky.sunUniforms.intensity, snap.sky.sun.intensity);
    }
    if (snap.sky.sunDisk) {
      setUni(sky.sunDiskUniforms.radius, snap.sky.sunDisk.radius);
      if (snap.sky.sunDisk.color) sky.sunDiskUniforms.color.value.set(snap.sky.sunDisk.color);
      if (snap.sky.sunDisk.emissiveColor) sky.sunDiskUniforms.emissiveColor.value.set(snap.sky.sunDisk.emissiveColor);
      setUni(sky.sunDiskUniforms.emissiveIntensity, snap.sky.sunDisk.emissiveIntensity);
    }
    if (snap.sky.atmosphere) {
      const a = snap.sky.atmosphere;
      setUni(sky.atmosphereUniforms.rayleighCoefficient, a.rayleighCoefficient);
      setUni(sky.atmosphereUniforms.mieCoefficient, a.mieCoefficient);
      setUni(sky.atmosphereUniforms.mieDirectionalG, a.mieDirectionalG);
      setUni(sky.atmosphereUniforms.turbidity, a.turbidity);
      if (a.skyColor) sky.atmosphereUniforms.skyColor.value.set(a.skyColor);
      setUni(sky.atmosphereUniforms.skyBrightness, a.skyBrightness);
    }
    if (snap.sky.clouds) {
      const c = snap.sky.clouds;
      setUni(sky.cloudUniforms.enabled, c.enabled);
      setUni(sky.cloudUniforms.coverage, c.coverage);
      if (c.color) sky.cloudUniforms.color.value.set(c.color);
      if (c.shadowColor) sky.cloudUniforms.shadowColor.value.set(c.shadowColor);
      setUni(sky.cloudUniforms.height, c.height);
      setUni(sky.cloudUniforms.thickness, c.thickness);
      setUni(sky.cloudUniforms.intensity, c.intensity);
      setUni(sky.cloudUniforms.opacityFalloff, c.opacityFalloff);
      setUni(sky.cloudUniforms.octaves, c.octaves);
      setUni(sky.cloudUniforms.lacunarity, c.lacunarity);
      setUni(sky.cloudUniforms.persistence, c.persistence);
      setUni(sky.cloudUniforms.scale, c.scale);
      setUni(sky.cloudUniforms.speed, c.speed);
    }
  }
}

// ---------- LocalStorage-backed store ----------

export class PresetStore {
  constructor(storage = (typeof window !== "undefined" ? window.localStorage : null)) {
    this.storage = storage;
  }

  _read() {
    if (!this.storage) return {};
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      console.warn("PresetStore: failed to read", e);
      return {};
    }
  }
  _write(obj) {
    if (!this.storage) return;
    try { this.storage.setItem(STORAGE_KEY, JSON.stringify(obj)); }
    catch (e) { console.warn("PresetStore: failed to write", e); }
  }

  /** Return sorted list of saved preset names. */
  list() { return Object.keys(this._read()).sort(); }

  /** Get a saved preset's snapshot, or null if not found. */
  get(name) {
    const all = this._read();
    return all[name] ?? null;
  }

  /** Save a snapshot under the given name (overwrite if exists). */
  save(name, snap) {
    if (!name || typeof name !== "string") throw new Error("PresetStore.save: name required");
    const all = this._read();
    all[name] = snap;
    this._write(all);
  }

  /** Delete a saved preset. Returns true if it existed. */
  remove(name) {
    const all = this._read();
    if (!(name in all)) return false;
    delete all[name];
    this._write(all);
    return true;
  }

  /** Export all saved presets as a JSON string. */
  exportAll() { return JSON.stringify({ version: SCHEMA_VERSION, presets: this._read() }, null, 2); }

  /** Import a JSON blob produced by exportAll(); merges with existing presets. */
  importAll(jsonString, { overwrite = true } = {}) {
    const data = JSON.parse(jsonString);
    if (!data || !data.presets) throw new Error("PresetStore.importAll: invalid JSON");
    const current = this._read();
    for (const [name, snap] of Object.entries(data.presets)) {
      if (!overwrite && name in current) continue;
      current[name] = snap;
    }
    this._write(current);
  }
}
