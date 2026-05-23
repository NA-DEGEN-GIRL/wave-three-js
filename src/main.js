import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { pass } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import GUI from "lil-gui";

import {
  WaterSystem,
  RayleighSky,
  OfficialSky,
  getPresetParams,
  listPresets,
  snapshot,
  applySnapshot,
  PresetStore,
} from "./lib/index.js";
import { makeSeaweed, makeUnderwaterParticles } from "./lib/OceanFloor.js";
import { applyWetness } from "./lib/WetMaterial.js";
import { SprayParticles } from "./lib/SprayParticles.js";

// ---------- procedural assets ----------

function makeBoat(color = 0x2cb6b0) {
  const grp = new THREE.Group();
  // Hull: extruded V-shape
  const hullShape = new THREE.Shape();
  hullShape.moveTo(-3, 0);
  hullShape.quadraticCurveTo(-3.4, -1.6, 0, -2.0);
  hullShape.quadraticCurveTo(3.4, -1.6, 3, 0);
  hullShape.lineTo(3, 1.3);
  hullShape.lineTo(-3, 1.3);
  hullShape.lineTo(-3, 0);
  const hullGeom = new THREE.ExtrudeGeometry(hullShape, { depth: 10, bevelEnabled: true, bevelSize: 0.15, bevelThickness: 0.15 });
  hullGeom.translate(0, 0, -5);
  hullGeom.rotateY(Math.PI / 2);
  const hull = new THREE.Mesh(hullGeom, new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 }));
  grp.add(hull);
  // Trim
  const trim = new THREE.Mesh(
    new THREE.BoxGeometry(11, 0.3, 6.4),
    new THREE.MeshStandardMaterial({ color: 0x7b3a14, roughness: 0.8 }),
  );
  trim.position.y = 1.4;
  grp.add(trim);
  // Cabin
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(4.5, 2.6, 3.6),
    new THREE.MeshStandardMaterial({ color: 0xf2efe3, roughness: 0.5 }),
  );
  cabin.position.set(-0.5, 2.9, 0);
  grp.add(cabin);
  // Cabin roof
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(4.8, 0.3, 3.9),
    new THREE.MeshStandardMaterial({ color: 0xc8492c, roughness: 0.6 }),
  );
  roof.position.set(-0.5, 4.25, 0);
  grp.add(roof);
  // Mast
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.12, 5, 8),
    new THREE.MeshStandardMaterial({ color: 0x3a2410 }),
  );
  mast.position.set(2.5, 4, 0);
  grp.add(mast);
  return grp;
}

function makeRock(seed = 1) {
  const geom = new THREE.IcosahedronGeometry(2 + (seed % 3) * 0.7, 1);
  const pos = geom.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = Math.sin(x * 1.7 + seed) * 0.15 + Math.cos(z * 1.3 + seed * 1.7) * 0.2 + Math.sin(y * 2.1 + seed * 0.7) * 0.15;
    pos.setX(i, x * (1 + n));
    pos.setY(i, y * (1 + n * 1.3));
    pos.setZ(i, z * (1 + n));
  }
  geom.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.07, 0.4, 0.32), roughness: 0.92, metalness: 0.0 });
  const m = new THREE.Mesh(geom, mat);
  m.castShadow = true; m.receiveShadow = false;
  return m;
}

function makeRockyOutcrop(scaleY = 2) {
  const g = new THREE.Group();
  for (let i = 0; i < 6 + Math.floor(Math.random() * 4); i++) {
    const r = makeRock(i * 7 + Math.random() * 100);
    r.position.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 1.5 * scaleY, (Math.random() - 0.5) * 6);
    r.rotation.set(Math.random(), Math.random(), Math.random());
    const s = 0.8 + Math.random() * 1.8;
    r.scale.set(s, s * (0.7 + Math.random() * 0.6), s);
    g.add(r);
  }
  return g;
}

function makeBuoy() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.ConeGeometry(0.8, 2, 8),
    new THREE.MeshStandardMaterial({ color: 0xff7720, roughness: 0.4 }),
  );
  body.position.y = 1;
  g.add(body);
  const top = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0xffffff }),
  );
  top.position.y = 2.2;
  g.add(top);
  return g;
}

// Procedural palm tree — trunk + radial fronds. Looks like a silhouette from
// distance which matches the hero/preset videos.
function makePalmTree(scale = 1) {
  const g = new THREE.Group();
  // Trunk: tapered cylinder with slight curve
  const trunkH = 8 * scale;
  const trunkG = new THREE.CylinderGeometry(0.18, 0.32, trunkH, 8, 5);
  const pos = trunkG.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const bend = Math.sin((y / trunkH) * Math.PI) * 0.7 * scale;
    pos.setX(i, pos.getX(i) + bend * 0.3);
  }
  trunkG.computeVertexNormals();
  const trunk = new THREE.Mesh(
    trunkG,
    new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.85 }),
  );
  trunk.position.y = trunkH / 2;
  g.add(trunk);

  // Fronds: 7 flat leaf shapes radiating from top
  const frondMat = new THREE.MeshStandardMaterial({
    color: 0x2c5a25, side: THREE.DoubleSide, roughness: 0.65,
  });
  for (let i = 0; i < 7; i++) {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.bezierCurveTo(0.6, 0.2, 1.5, 0.4, 3.5, 0.1);
    shape.lineTo(3.5, -0.1);
    shape.bezierCurveTo(1.5, -0.4, 0.6, -0.2, 0, 0);
    const geom = new THREE.ShapeGeometry(shape);
    const frond = new THREE.Mesh(geom, frondMat);
    const ang = (i / 7) * Math.PI * 2;
    frond.rotation.set(
      -0.25 + Math.random() * 0.1,
      ang,
      -0.45 - Math.random() * 0.15,
    );
    frond.scale.setScalar(scale * (1.0 + Math.random() * 0.25));
    frond.position.set(Math.cos(ang) * 0.15 + 0.5 * scale, trunkH, Math.sin(ang) * 0.15);
    g.add(frond);
  }
  return g;
}

// Sandy beach island with rocks and palm trees
function makeIsland({ radius = 12, palms = 4, rocks = 6 } = {}) {
  const g = new THREE.Group();
  // Sand mound — flat ellipsoid
  const sand = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xd9b377, roughness: 1.0 }),
  );
  sand.scale.set(1, 0.15, 1);
  g.add(sand);

  for (let i = 0; i < palms; i++) {
    const t = makePalmTree(1 + Math.random() * 0.4);
    const ang = (i / palms) * Math.PI * 2 + Math.random() * 0.4;
    const r = radius * 0.35 * Math.random();
    t.position.set(Math.cos(ang) * r, 0.5, Math.sin(ang) * r);
    t.rotation.y = Math.random() * Math.PI * 2;
    g.add(t);
  }
  for (let i = 0; i < rocks; i++) {
    const r = makeRock(i * 13 + Math.random() * 50);
    const ang = (i / rocks) * Math.PI * 2 + Math.random();
    const dist = radius * (0.6 + Math.random() * 0.4);
    r.position.set(Math.cos(ang) * dist, -0.3 + Math.random() * 1, Math.sin(ang) * dist);
    r.scale.setScalar(0.6 + Math.random() * 1.2);
    g.add(r);
  }
  return g;
}

// ---------- main ----------

async function main() {
  const boot = document.getElementById("boot");

  if (!navigator.gpu) {
    boot.innerHTML = `
      <div style="max-width:520px; padding:20px; text-align:center; line-height:1.5;">
        <div style="font-size:18px;font-weight:600;margin-bottom:8px;">WebGPU not detected</div>
        <div style="opacity:0.8;font-size:13px;">This demo prefers WebGPU (Chrome / Edge 113+ with hardware support). It will still try a WebGL2 fallback below.</div>
      </div>`;
  }

  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  const urlParams = new URLSearchParams(location.search);
  const initialPresetName = urlParams.get("preset") || "sunset";
  const camOverride = urlParams.get("cam");

  const scene = new THREE.Scene();
  // Atmospheric fog applied to scene props (boats, rocks, palms). The water has
  // its own analytical fog blend in the colorNode. This makes distant islands
  // dissolve into the sky like in the reference videos.
  scene.fog = new THREE.FogExp2(0xb8c8d8, 0.0018);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 30000);
  // Reference-style low angle: close to surface, looking slightly down
  camera.position.set(28, 11, 45);
  if (camOverride) {
    const [cx, cy, cz] = camOverride.split(",").map(parseFloat);
    if (!isNaN(cx)) camera.position.set(cx, cy, cz);
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 2;
  controls.maxDistance = 600;
  // Underwater dive mode: lift restriction on polar angle and aim target below water.
  const diveMode = camOverride && parseFloat(camOverride.split(",")[1]) < 0;
  if (diveMode) {
    // Aim configurable via ?lookat=x,y,z, defaulting to the waterline so the
    // surface is visible above the sand/caustics below.
    const lookat = urlParams.get("lookat");
    if (lookat) {
      const [tx, ty, tz] = lookat.split(",").map(parseFloat);
      controls.target.set(tx, ty, tz);
    } else {
      controls.target.set(0, 0, 0);
    }
    controls.maxPolarAngle = Math.PI; // can look straight up
    controls.minPolarAngle = 0;
  } else {
    controls.target.set(0, 2.5, 0);
    controls.maxPolarAngle = Math.PI * 0.495;
  }

  const preset = getPresetParams(initialPresetName);

  const water = await WaterSystem.create(renderer, scene, camera, "high");
  water.loadPreset(preset);

  // Diagnostic URL params for verifying GUI plumbing.
  const contactOverride = urlParams.get("contact"); // e.g. 0, 1, 2
  if (contactOverride !== null) {
    const v = parseFloat(contactOverride);
    if (!isNaN(v)) water.foam.contact.coverage = v;
  }
  const wavesFoamOverride = urlParams.get("wavesFoam");
  if (wavesFoamOverride !== null) {
    const v = parseFloat(wavesFoamOverride);
    if (!isNaN(v)) water.foam.waves.coverage = v;
  }
  const clarityOverride = urlParams.get("clarity");
  if (clarityOverride !== null) {
    const v = parseFloat(clarityOverride);
    if (!isNaN(v)) water.color.clarity = v;
  }
  const splashOverride = urlParams.get("splash");
  if (splashOverride !== null) {
    const v = parseFloat(splashOverride);
    if (!isNaN(v)) water.splash.intensity = v;
  }
  const reflStrOverride = urlParams.get("refl");
  if (reflStrOverride !== null) {
    const v = parseFloat(reflStrOverride);
    if (!isNaN(v)) water.reflection.strength = v;
  }
  const surfaceFoamOverride = urlParams.get("surfaceFoam");
  if (surfaceFoamOverride !== null) {
    const v = parseFloat(surfaceFoamOverride);
    if (!isNaN(v)) water.foam.surface.coverage = v;
  }

  // Use the up-to-date three.js master SkyMesh (Hosek-Wilkie atmosphere +
  // volumetric clouds). This is the same sky used in the official
  // webgpu_ocean example and gives a noticeably richer look than our custom
  // RayleighSky. Falls back to RayleighSky via ?sky=rayleigh URL param.
  const useOfficialSky = urlParams.get("sky") !== "rayleigh";
  const sky = useOfficialSky
    ? new OfficialSky({
        elevation: preset.sky.sun.elevation,
        azimuth: preset.sky.sun.azimuth,
        turbidity: Math.max(2, preset.sky.atmosphere.turbidity * 2.5),
        rayleigh: preset.sky.atmosphere.rayleighCoefficient * 2,
        mieCoefficient: preset.sky.atmosphere.mieCoefficient,
        mieDirectionalG: preset.sky.atmosphere.mieDirectionalG,
        cloudCoverage: preset.sky.clouds.coverage,
        cloudDensity: preset.sky.clouds.intensity ?? 0.5,
        cloudElevation: preset.sky.clouds.height ?? 0.5,
        cloudScale: preset.sky.clouds.scale ?? 0.0002,
        cloudSpeed: preset.sky.clouds.speed ?? 0.0001,
        showSunDisc: true,
      })
    : new RayleighSky(preset.sky);
  scene.add(sky.getMesh());
  water.setSky(sky);

  // Lighting
  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambient);
  const sunLight = new THREE.DirectionalLight(0xffe7c2, 1.2);
  sunLight.position.copy(sky.sunUniforms.direction.value).multiplyScalar(150);
  scene.add(sunLight);
  // Soft fill from horizon
  const fill = new THREE.HemisphereLight(0xa8c8ee, 0x223040, 0.55);
  scene.add(fill);

  // ---- Scene props ----
  const props = new THREE.Group();
  scene.add(props);

  // Hero boat — moves in a circle so the wake foam is visible behind it.
  const boat = makeBoat(0x2cb6b0);
  boat.position.set(8, 0, 4);
  boat.userData.wakeStrength = 1.0; // emits wake foam when moving
  const ship = boat;
  props.add(boat);
  water.buoyancy.addObject(boat, { heightOffset: -0.6, rotationInfluence: 0.7, multiPoint: true, heightSmoothing: 0.18, rotationSmoothing: 0.18 });
  // Secondary boat farther away
  const boat2 = makeBoat(0xffb84a);
  boat2.position.set(-22, 0, -28);
  boat2.rotation.y = -0.8;
  props.add(boat2);
  water.buoyancy.addObject(boat2, { heightOffset: -0.6, rotationInfluence: 0.6, multiPoint: true });

  // Rocky outcrops at fixed positions
  const outcropPositions = [
    [-35, -1.5, -10], [-50, -1.0, 25], [40, -1.2, -25], [55, -2, 35], [-12, -2, 50], [25, -1.5, 60],
  ];
  for (const [x, y, z] of outcropPositions) {
    const o = makeRockyOutcrop();
    o.position.set(x, y, z);
    o.scale.setScalar(1 + Math.random() * 0.8);
    props.add(o);
  }

  // Underwater particles — hidden until camera dips below the water surface.
  // Tagged so the reflection pass excludes them (otherwise they ghost-reflect upward).
  const underwaterParticles = makeUnderwaterParticles({ count: 600, radius: 35 });
  underwaterParticles.userData.underwater = true;
  scene.add(underwaterParticles);

  // Above-surface spray particles — visible white mist where waves crash on
  // boats/rocks. Spawned proportional to per-object wake strength.
  const spray = new SprayParticles({ maxParticles: 600 });
  scene.add(spray.getObject());

  // Sprinkle seaweed across the ocean floor. Tagged underwater so it doesn't
  // appear mirrored on the water surface from above.
  for (let i = 0; i < 30; i++) {
    const ang = Math.random() * Math.PI * 2;
    const dist = 8 + Math.random() * 50;
    const sw = makeSeaweed({
      x: Math.cos(ang) * dist,
      z: Math.sin(ang) * dist,
      height: 2 + Math.random() * 3.5,
      count: 4 + Math.floor(Math.random() * 4),
    });
    sw.position.y = -18;
    sw.userData.underwater = true;
    sw.traverse((c) => { if (c.userData) c.userData.underwater = true; });
    props.add(sw);
  }

  // Two islands at distance for the hero-shot composition.
  const island1 = makeIsland({ radius: 18, palms: 5, rocks: 8 });
  island1.position.set(-70, 0, -50);
  props.add(island1);
  const island2 = makeIsland({ radius: 12, palms: 3, rocks: 6 });
  island2.position.set(85, 0, -75);
  props.add(island2);
  // A distant land mass silhouette
  const distantLand = new THREE.Mesh(
    new THREE.SphereGeometry(80, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x4a5a6a, roughness: 1.0 }),
  );
  distantLand.scale.set(2, 0.18, 1.4);
  distantLand.position.set(-150, -2, -200);
  props.add(distantLand);

  // Buoys
  for (let i = 0; i < 3; i++) {
    const b = makeBuoy();
    const a = (i / 3) * Math.PI * 2 + 0.4;
    b.position.set(Math.cos(a) * 18, 0, Math.sin(a) * 18);
    props.add(b);
    water.buoyancy.addObject(b, { heightOffset: -0.5, multiPoint: true, rotationInfluence: 0.45 });
  }

  // A handful of crates floating (kept away from camera to avoid contact-foam clutter)
  for (let i = 0; i < 4; i++) {
    const c = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 1.4, 1.8),
      new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.08 + Math.random() * 0.05, 0.35, 0.4 + Math.random() * 0.1), roughness: 0.85 }),
    );
    const ang = Math.random() * Math.PI * 2;
    const dist = 30 + Math.random() * 30; // farther out so contact foam stays subtle
    c.position.set(Math.cos(ang) * dist, 0, Math.sin(ang) * dist);
    c.rotation.y = Math.random() * Math.PI;
    props.add(c);
    water.buoyancy.addObject(c, { heightOffset: -0.2, rotationInfluence: 0.6 });
  }

  // ---- GUI ----
  const fpsEl = document.getElementById("fps");
  let frames = 0, fpsTimer = performance.now();

  const gui = new GUI({ title: "Water Pro" });
  gui.domElement.style.zIndex = 11;

  const presetState = { name: initialPresetName };
  gui.add(presetState, "name", listPresets()).name("preset").onChange((n) => {
    const p = getPresetParams(n);
    water.loadPreset(p);
    sky.setSunFromAngles(p.sky.sun.elevation, p.sky.sun.azimuth);
    sky.sunUniforms.intensity.value = p.sky.sun.intensity;
    sky.atmosphereUniforms.rayleighCoefficient.value = p.sky.atmosphere.rayleighCoefficient;
    sky.atmosphereUniforms.turbidity.value = p.sky.atmosphere.turbidity;
    sky.atmosphereUniforms.skyColor.value.set(p.sky.atmosphere.skyColor);
    sky.atmosphereUniforms.skyBrightness.value = p.sky.atmosphere.skyBrightness;
    sky.cloudUniforms.enabled.value = p.sky.clouds.enabled ? 1 : 0;
    sky.cloudUniforms.coverage.value = p.sky.clouds.coverage;
    sky.cloudUniforms.color.value.set(p.sky.clouds.color);
    sky.cloudUniforms.shadowColor.value.set(p.sky.clouds.shadowColor);
    sky.sunDiskUniforms.color.value.set(p.sky.sun.diskColor);
    sky.sunDiskUniforms.emissiveColor.value.set(p.sky.sun.diskEmissiveColor);
    sky.sunDiskUniforms.emissiveIntensity.value = p.sky.sun.diskEmissiveIntensity;
  });

  const wavesFolder = gui.addFolder("Waves");
  const wavesProxy = {
    get windSpeed()      { return water.waves.windSpeed.value; },     set windSpeed(v)      { water.waves.windSpeed.value = v; },
    get windDirection()  { return water.waves.windDirection.value; }, set windDirection(v)  { water.waves.windDirection.value = v; },
    get choppiness()     { return water.waves.choppiness.value; },    set choppiness(v)     { water.waves.choppiness.value = v; },
    get amplitude()      { return water.waves.amplitude.value; },     set amplitude(v)      { water.waves.amplitude.value = v; },
    get animationSpeed() { return water.waves.animationSpeed; },      set animationSpeed(v) { water.waves.animationSpeed = v; },
    get rippleAmp()      { return water.waves.rippleAmplitude.value; }, set rippleAmp(v)    { water.waves.rippleAmplitude.value = v; },
    get rippleFreq()     { return water.waves.rippleFrequency.value; }, set rippleFreq(v)   { water.waves.rippleFrequency.value = v; },
    get microAmp()       { return water.waves.microAmplitude.value; },  set microAmp(v)     { water.waves.microAmplitude.value = v; },
    get microFreq()      { return water.waves.microFrequency.value; },  set microFreq(v)    { water.waves.microFrequency.value = v; },
  };
  wavesFolder.add(wavesProxy, "windSpeed", 0, 80, 0.5);
  wavesFolder.add(wavesProxy, "windDirection", 0, Math.PI * 2, 0.01);
  wavesFolder.add(wavesProxy, "choppiness", 0, 2, 0.01);
  wavesFolder.add(wavesProxy, "amplitude", 0, 3, 0.01);
  wavesFolder.add(wavesProxy, "animationSpeed", 0, 3, 0.01);
  wavesFolder.add(wavesProxy, "rippleAmp", 0, 2, 0.01).name("ripple.amp");
  wavesFolder.add(wavesProxy, "rippleFreq", 0.01, 0.3, 0.005).name("ripple.freq");
  wavesFolder.add(wavesProxy, "microAmp", 0, 0.3, 0.005).name("micro.amp");
  wavesFolder.add(wavesProxy, "microFreq", 0.1, 2, 0.05).name("micro.freq");

  const gerstnerFolder = gui.addFolder("Gerstner");
  const gerstnerProxy = { ...water.gerstner };
  function applyGerstner() { water.gerstner.update(gerstnerProxy); }
  gerstnerFolder.add(gerstnerProxy, "wavelength", 20, 800, 1).onChange(applyGerstner);
  gerstnerFolder.add(gerstnerProxy, "amplitude", 0, 5, 0.05).onChange(applyGerstner);
  gerstnerFolder.add(gerstnerProxy, "wavelengthSpread", 1, 3, 0.05).onChange(applyGerstner);
  gerstnerFolder.add(gerstnerProxy, "directionalSpread", 0, 2, 0.05).onChange(applyGerstner);

  const foamFolder = gui.addFolder("Foam");
  foamFolder.add(water.foam.waves, "enabled").name("waves.enabled");
  foamFolder.add(water.foam.waves, "coverage", 0, 2, 0.01).name("waves.coverage");
  foamFolder.add(water.foam.waves, "opacity", 0, 1, 0.01).name("waves.opacity");
  foamFolder.add(water.foam.waves, "peakIntensity", 0, 2, 0.01).name("waves.peak");
  foamFolder.add(water.foam.waves, "size", 5, 200, 1).name("waves.size");
  foamFolder.add(water.foam.surface, "enabled").name("surface.enabled");
  foamFolder.add(water.foam.surface, "coverage", 0, 1, 0.01).name("surface.coverage");
  foamFolder.add(water.foam.shoreline, "enabled").name("shore.enabled");
  foamFolder.add(water.foam.shoreline, "coverage", 0, 1, 0.01).name("shore.coverage");
  foamFolder.add(water.foam.contact, "enabled").name("contact.enabled");
  foamFolder.add(water.foam.contact, "coverage", 0, 2, 0.01).name("contact.coverage");
  foamFolder.add(water.foam.contact, "opacity", 0, 1, 0.01).name("contact.opacity");
  foamFolder.add(water.foam.contact, "distance", 0.5, 15, 0.1).name("contact.distance");
  foamFolder.add(water.splash, "enabled").name("splash.enabled");
  foamFolder.add(water.splash, "intensity", 0, 3, 0.05).name("splash.intensity");

  const appearance = gui.addFolder("Appearance");
  appearance.addColor({ c: "#" + water.color.shallowWaterColor.getHexString() }, "c").name("shallow").onChange((v) => water.color.shallowWaterColor.set(v));
  appearance.addColor({ c: "#" + water.color.deepWaterColor.getHexString() }, "c").name("deep").onChange((v) => water.color.deepWaterColor.set(v));
  appearance.add(water.color, "depthFalloff", 1, 100, 0.5);
  appearance.add(water.color, "clarity", 0.0, 2.5, 0.05).name("clarity (see-through)");
  appearance.add(water.fresnel, "power", 1, 8, 0.1).name("fresnel.power");
  appearance.add(water.sparkle, "enabled").name("sparkle.enabled");
  appearance.add(water.sparkle, "intensity", 0, 3, 0.05).name("sparkle.intensity");
  appearance.add(water.fog, "enabled").name("fog.enabled");
  appearance.add(water.fog, "fadeStart", 50, 1500, 10).name("fog.fadeStart");
  appearance.add(water.fog, "fadePower", 0.3, 4, 0.05).name("fog.fadePower");

  // Reflection (planar mirror) — controls how strongly props ghost onto water.
  const reflectionFolder = gui.addFolder("Reflection");
  reflectionFolder.add(water.reflection, "strength", 0, 1, 0.01).name("strength");
  reflectionFolder.add(water.reflection, "fadeStart", 5, 500, 1).name("fadeStart (m)");
  reflectionFolder.add(water.reflection, "fadeEnd", 50, 2000, 5).name("fadeEnd (m)");
  reflectionFolder.add(water.reflection, "distortionStrength", 0, 3, 0.05).name("distortion");

  const skyFolder = gui.addFolder("Sky");
  const skyProxy = {
    sunElevation: preset.sky.sun.elevation,
    sunAzimuth: preset.sky.sun.azimuth,
    cloudCoverage: preset.sky.clouds.coverage,
    sunIntensity: preset.sky.sun.intensity,
  };
  skyFolder.add(skyProxy, "sunElevation", 0, 90, 0.5).onChange(() => sky.setSunFromAngles(skyProxy.sunElevation, skyProxy.sunAzimuth));
  skyFolder.add(skyProxy, "sunAzimuth", 0, 360, 1).onChange(() => sky.setSunFromAngles(skyProxy.sunElevation, skyProxy.sunAzimuth));
  skyFolder.add(skyProxy, "cloudCoverage", 0, 1, 0.01).onChange((v) => (sky.cloudUniforms.coverage.value = v));
  skyFolder.add(skyProxy, "sunIntensity", 0, 3, 0.05).onChange((v) => (sky.sunUniforms.intensity.value = v));

  const qualityFolder = gui.addFolder("Quality");
  const qState = { level: "high" };
  qualityFolder.add(qState, "level", ["low", "medium", "high", "ultra"]).onChange(async (v) => { await water.setQualityLevel(v); });
  qualityFolder.add(water, "wireframe");
  qualityFolder.add(renderer, "toneMappingExposure", 0.2, 2.5, 0.05).name("exposure");

  // ---------- Custom Presets (save / load / delete / import / export) ----------
  // Persists to browser localStorage so user-tuned looks survive refreshes.
  const store = new PresetStore();

  const customFolder = gui.addFolder("Custom Presets");
  const customState = {
    name: "",
    saved: store.list(),
    selected: "",
  };
  let savedDropdownController = null;

  // Refresh the saved-presets dropdown (must be recreated when list changes).
  function refreshSavedDropdown() {
    if (savedDropdownController) savedDropdownController.destroy();
    customState.saved = store.list();
    if (customState.saved.length === 0) customState.selected = "";
    else if (!customState.saved.includes(customState.selected)) customState.selected = customState.saved[0];
    savedDropdownController = customFolder
      .add(customState, "selected", customState.saved.length ? customState.saved : [""])
      .name("saved");
    // Keep the controller order stable: move it to position #2 (after name input).
    customFolder.children.splice(customFolder.children.indexOf(savedDropdownController), 1);
    customFolder.children.splice(1, 0, savedDropdownController);
    customFolder.$children.insertBefore(savedDropdownController.domElement, customFolder.$children.children[1]);
  }

  customFolder.add(customState, "name").name("name");
  refreshSavedDropdown();

  customFolder.add({ saveAs: () => {
    const n = (customState.name || "").trim();
    if (!n) { alert("Type a name first"); return; }
    store.save(n, snapshot(water, sky));
    customState.selected = n;
    customState.name = "";
    refreshSavedDropdown();
    customFolder.controllers.forEach((c) => c.updateDisplay());
    console.log(`Saved preset "${n}"`);
  }}, "saveAs").name("💾 Save Current");

  customFolder.add({ load: () => {
    const sel = customState.selected;
    if (!sel) { alert("No saved preset selected"); return; }
    const snap = store.get(sel);
    if (!snap) { alert("Preset not found"); return; }
    applySnapshot(water, sky, snap);
    gui.controllersRecursive().forEach((c) => c.updateDisplay && c.updateDisplay());
    console.log(`Loaded preset "${sel}"`);
  }}, "load").name("⬇️ Load Selected");

  customFolder.add({ del: () => {
    const sel = customState.selected;
    if (!sel) { alert("No saved preset selected"); return; }
    if (!confirm(`Delete preset "${sel}"?`)) return;
    store.remove(sel);
    refreshSavedDropdown();
    console.log(`Deleted preset "${sel}"`);
  }}, "del").name("🗑️ Delete Selected");

  customFolder.add({ exportJson: () => {
    const json = store.exportAll();
    // Trigger a download.
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `wave-three-js-presets-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }}, "exportJson").name("📤 Export JSON");

  customFolder.add({ importJson: () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        store.importAll(text);
        refreshSavedDropdown();
        alert(`Imported ${store.list().length} preset(s) total.`);
      } catch (err) {
        alert("Import failed: " + err.message);
      }
    };
    input.click();
  }}, "importJson").name("📥 Import JSON");

  customFolder.add({ snapshotToConsole: () => {
    console.log("Current snapshot:", snapshot(water, sky));
    console.log("(Copy from devtools to share / version control.)");
  }}, "snapshotToConsole").name("📋 Dump to Console");

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    water.resize(window.innerWidth, window.innerHeight);
  });

  // ---- Post-processing pipeline ----
  // Bloom — restricted to HDR-bright pixels so only the sun specular and the
  // strongest sun reflections glow. Foam and white props stay crisp.
  const postProcessing = new THREE.PostProcessing(renderer);
  const scenePass = pass(scene, camera);
  let outputNode = scenePass.getTextureNode("output");
  // (strength, radius, threshold) — note BloomNode API has threshold as 3rd arg
  const bloomPass = bloom(outputNode, 0.18, 0.6, 1.1);
  outputNode = outputNode.add(bloomPass);
  postProcessing.outputNode = outputNode;

  // Apply wetness to all scene props that touch the water. The wetness shader
  // samples the persistent foam RT + height-above-waterline so rocks/palms/boats
  // get darker + glossier near the waterline and where waves splash on them.
  applyWetness(props, water, { porosity: 0.7, fadeRange: 4.5, foamCoupling: 1.2 });

  try { await renderer.compileAsync(scene, camera); } catch (e) { console.warn("compileAsync failed:", e); }

  let firstFrameRendered = false;
  let lastT = performance.now();
  async function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;

    controls.update();
    sunLight.position.copy(sky.sunUniforms.direction.value).multiplyScalar(140);
    sunLight.intensity = sky.sunUniforms.intensity.value;
    // Sync atmospheric fog colour with the sky's current horizon tint so distant
    // props blend correctly across all presets. Switch to a dark green tone and
    // crank density when the camera dips below the water surface.
    const underwater = camera.position.y < 0;
    if (scene.fog) {
      if (underwater) {
        // Greenish blue underwater haze. Not too dense — we want to see kelp and
        // caustic-lit sand within ~30m.
        scene.fog.color.setHex(0x123847);
        scene.fog.density = 0.035;
      } else {
        scene.fog.color.copy(sky.getHorizonColor());
        scene.fog.density = 0.0018;
      }
    }
    renderer.toneMappingExposure = underwater ? 1.05 : 1.0;
    // Drift underwater particles with the camera and only show below water.
    underwaterParticles.visible = underwater;
    if (underwater) {
      underwaterParticles.position.copy(camera.position);
      underwaterParticles.position.y -= 5;
      // Slow rotation gives a sense of subtle current.
      underwaterParticles.rotation.y += dt * 0.04;
    }

    await water.update(dt);

    // Spawn spray particles from buoyancy objects that have wakeStrength.
    const emitters = [];
    for (const o of water.buoyancy._objects.values()) {
      const m = o.mesh;
      const ws = (m.userData && m.userData.wakeStrength) ?? 0;
      if (ws <= 0) continue;
      // Approximate "splash energy" from how much the buoyancy moved the boat this frame.
      emitters.push({ x: m.position.x, y: 0.4, z: m.position.z, strength: ws * 0.4 });
    }
    spray.update(dt, emitters);

    postProcessing.render();

    if (!firstFrameRendered) {
      firstFrameRendered = true;
      boot.classList.add("gone");
      setTimeout(() => boot.remove(), 800);
    }

    frames++;
    if (now - fpsTimer > 500) {
      fpsEl.textContent = `${Math.round((frames * 1000) / (now - fpsTimer))} fps`;
      frames = 0; fpsTimer = now;
    }
  }
  animate();
}

// Force a full page reload on any module change so the TSL graph rebuilds cleanly
// — without this, Vite tries to preserve module state and the running material
// can hold stale references (which is exactly the "controls don't work" symptom).
if (import.meta.hot) {
  import.meta.hot.accept(() => location.reload());
  import.meta.hot.on("vite:beforeUpdate", () => location.reload());
}

main().catch((err) => {
  console.error(err);
  const boot = document.getElementById("boot");
  boot.innerHTML = `
    <div style="max-width:620px; padding:20px; text-align:center; line-height:1.5; color:#fff;">
      <div style="font-size:18px;font-weight:600;margin-bottom:8px;">Failed to start</div>
      <pre style="font-size:11px;text-align:left;white-space:pre-wrap;background:rgba(0,0,0,0.5);padding:10px;border-radius:8px;">${String(err.stack || err)}</pre>
    </div>`;
});
