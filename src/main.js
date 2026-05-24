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
import { FishSchool } from "./lib/FishSchool.js";
import { ImprovedNoise } from "three/addons/math/ImprovedNoise.js";
import { createRockMaterial, createSandMaterial, paintRockColors, paintSandColors } from "./lib/NaturalMaterials.js";

const _noise3 = new ImprovedNoise();
function noise3D(x, y, z) { return _noise3.noise(x, y, z); }

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

// Module-level rock material — shared by every rock/pebble in the scene so
// the GPU only compiles the procedural triplanar+moss+wet shader ONCE.
// Initialised lazily on first use because it depends on the WaterSystem.
let _rockMaterial = null;
function getRockMaterial() {
  if (!_rockMaterial) _rockMaterial = createRockMaterial();
  return _rockMaterial;
}
// WaterSystem reference exported by main() so the lazy material init can
// reach it. Set before any prop factories run.
let _waterRef = null;

function makeRock(seed = 1) {
  const baseRadius = 2 + (seed % 3) * 0.7;
  // Higher subdivision (level 2) gives ~320 triangles per rock — still cheap,
  // but lets the multi-octave noise produce believable ridges and recesses
  // instead of the old smooth-blob silhouette.
  const geom = new THREE.IcosahedronGeometry(baseRadius, 2);
  const pos = geom.attributes.position;
  // Per-rock random seeded stretching for shape variety.
  const stretchX = 0.85 + ((seed * 7) % 13) / 13 * 0.5;
  const stretchY = 0.7  + ((seed * 11) % 17) / 17 * 0.4;
  const stretchZ = 0.85 + ((seed * 5) % 19) / 19 * 0.5;
  const seedOfs = seed * 17.3;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // 4-octave Perlin displacement.
    let n = 0, amp = 0.32, freq = 0.55;
    for (let o = 0; o < 4; o++) {
      n += noise3D(x * freq + seedOfs, y * freq + seedOfs * 1.7, z * freq + seedOfs * 0.4) * amp;
      amp *= 0.52;
      freq *= 2.07;
    }
    // Add an anisotropic ridge: vertical bands that read as stratification.
    const ridge = Math.sin(y * 1.4 + seedOfs * 0.3) * 0.08;
    n += ridge * (1 - Math.abs(y / baseRadius));
    pos.setX(i, x * stretchX * (1 + n));
    pos.setY(i, y * stretchY * (1 + n * 0.9));
    pos.setZ(i, z * stretchZ * (1 + n));
  }
  geom.computeVertexNormals();
  // Bake per-vertex colours (3-octave noise palette + slope-based moss).
  paintRockColors(geom, { seed: seedOfs });
  const m = new THREE.Mesh(geom, getRockMaterial());
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

// Shared sand material — created lazily after WaterSystem exists.
let _sandMaterial = null;
function getSandMaterial() {
  if (!_sandMaterial) _sandMaterial = createSandMaterial();
  return _sandMaterial;
}

// Custom sand-mound geometry: concentric rings with noise-displaced heights.
// Center is tallest, edges drop to (just above) the waterline. Each vertex
// gets a per-position Perlin-noise bump to give the silhouette real character
// instead of a perfectly smooth dome.
function makeSandMound(radius, opts = {}) {
  const rings = opts.rings ?? 10;
  const segs  = opts.segments ?? 32;
  const centerH = opts.centerHeight ?? Math.max(0.8, radius * 0.18);
  const edgeH   = opts.edgeHeight   ?? -0.4;
  const bumpStrength = opts.bumpStrength ?? 0.45;
  const seed = opts.seed ?? Math.random() * 100;

  const positions = [0, centerH, 0];
  for (let r = 1; r <= rings; r++) {
    const tr = r / rings;
    const ringR = tr * radius;
    // Smooth easing from center to edge — slight inward shoulder before drop-off.
    const profile = Math.pow(1 - tr, 1.4);
    const baseH = edgeH + (centerH - edgeH) * profile;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const x = Math.cos(a) * ringR;
      const z = Math.sin(a) * ringR;
      // 3-octave Perlin bump, stronger near center, fading at the edge.
      let n = 0, amp = bumpStrength, freq = 0.35;
      for (let o = 0; o < 3; o++) {
        n += noise3D(x * freq + seed, 0, z * freq + seed * 0.7) * amp;
        amp *= 0.5;
        freq *= 2.1;
      }
      positions.push(x, baseH + n * (1 - tr * 0.6), z);
    }
  }
  // Indices: triangle fan from center, then quad strips between rings.
  const indices = [];
  for (let s = 0; s < segs; s++) {
    const sN = (s + 1) % segs;
    indices.push(0, 1 + sN, 1 + s);
  }
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < segs; s++) {
      const sN = (s + 1) % segs;
      const i0 = 1 + r * segs + s;
      const i1 = 1 + r * segs + sN;
      const i2 = 1 + (r + 1) * segs + s;
      const i3 = 1 + (r + 1) * segs + sN;
      indices.push(i0, i3, i2, i0, i1, i3);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

// Sandy beach island: noise-displaced sand mound + palms + scattered rocks of
// varied size around the periphery + a band of small pebbles at the waterline.
function makeIsland({ radius = 12, palms = 4, rocks = 6, seed = Math.random() * 100 } = {}) {
  const g = new THREE.Group();

  const sandGeom = makeSandMound(radius, { seed, centerHeight: 1.0 + Math.random() * 0.6 });
  paintSandColors(sandGeom);
  const sand = new THREE.Mesh(sandGeom, getSandMaterial());
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
    const r = makeRock(i * 13 + Math.floor(Math.random() * 50));
    const ang = (i / rocks) * Math.PI * 2 + Math.random();
    const dist = radius * (0.6 + Math.random() * 0.4);
    r.position.set(Math.cos(ang) * dist, -0.3 + Math.random() * 1, Math.sin(ang) * dist);
    r.scale.setScalar(0.6 + Math.random() * 1.2);
    g.add(r);
  }
  // Pebble band — many small rocks scattered around the waterline. Cheap
  // because they share the procedural rock material (1 compile, N instances
  // via different Mesh objects but same Material).
  for (let i = 0; i < 22; i++) {
    const ang = Math.random() * Math.PI * 2;
    const dist = radius * (0.88 + Math.random() * 0.28);
    const p = makeRock(i * 7 + Math.floor(Math.random() * 100));
    p.position.set(Math.cos(ang) * dist, -0.4 + Math.random() * 0.25, Math.sin(ang) * dist);
    p.scale.setScalar(0.12 + Math.random() * 0.22);
    g.add(p);
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
  // SkyMesh's atmosphere is calibrated for low exposure (the official example
  // uses 0.1). 0.5 keeps the sun + sky contrast believable without darkening
  // the rest of the scene too much.
  renderer.toneMappingExposure = 0.5;
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
  _waterRef = water;   // expose so getRockMaterial() can hook foamSim

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
  // SkyMesh wants tiny `cloudSpeed` values (default 0.0001 = subtle drift).
  // Our presets use 0.02-scale numbers tuned for the old RayleighSky cloud
  // system, which would fly across the sky 200x too fast. Scale down with a
  // damping factor so preset values still influence relative speed but stay
  // in SkyMesh's expected range.
  const presetToSkyMeshCloudSpeed = (s) => (s ?? 0.02) * 0.003; // 0.02 → 0.00006

  // SkyMesh has its own calibrated defaults (turbidity=10, rayleigh=2). Old
  // RayleighSky-tuned preset values would push it into unphysical territory
  // (black zenith, blown-out sun). We use SkyMesh defaults and only let the
  // preset influence sun position + cloud coverage.
  const sky = useOfficialSky
    ? new OfficialSky({
        elevation: preset.sky.sun.elevation,
        azimuth: preset.sky.sun.azimuth,
        turbidity: 10,
        rayleigh: 2,
        mieCoefficient: 0.005,
        mieDirectionalG: 0.8,
        cloudCoverage: preset.sky.clouds.enabled === false ? 0 : (preset.sky.clouds.coverage ?? 0.4),
        cloudDensity: 0.5,
        cloudElevation: 0.5,
        cloudScale: 0.0002,
        cloudSpeed: presetToSkyMeshCloudSpeed(preset.sky.clouds.speed),
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

  // Underwater fish — one InstancedMesh with N procedural fish forming a few
  // schools that wander around the camera. Tagged underwater so the planar
  // reflection pass skips them (otherwise ghost fish would float in the sky).
  const fish = new FishSchool({
    count: 150,
    nSchools: 6,
    bounds: { radius: 90, depthMin: -7, depthMax: -2 },
    swimSpeedRange: [0.4, 1.1],
    sizeRange: [0.45, 1.1],
  });
  scene.add(fish.getObject());

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

  // ---- Post-processing pipeline ----
  // Bloom — kept subtle so the SkyMesh sun disc + sun specular glow without
  // burning the whole frame to white. The official three.js webgpu_ocean
  // example uses strength 0.1, threshold 0, radius 0 — even subtler than this.
  // NOTE: this MUST be created before the GUI block below — the Display folder
  // wires getters/setters straight to bloomPass.* uniforms.
  const postProcessing = new THREE.PostProcessing(renderer);
  const scenePass = pass(scene, camera);
  let outputNode = scenePass.getTextureNode("output");
  const bloomPass = bloom(outputNode, 0.12, 0.5, 0.9);
  outputNode = outputNode.add(bloomPass);
  postProcessing.outputNode = outputNode;

  // User-controlled base exposure. The animate loop reads this and applies a
  // small underwater bump on top, instead of hard-overriding the slider value
  // every frame (which was the "exposure 조절해도 아무 변화없음" symptom).
  const exposureState = { base: renderer.toneMappingExposure };

  // ---- GUI ----
  const fpsEl = document.getElementById("fps");
  let frames = 0, fpsTimer = performance.now();

  const gui = new GUI({ title: "Water Pro" });
  gui.domElement.style.zIndex = 11;

  // Helper: attach a tooltip + small description to a lil-gui controller.
  // Hover the slider name to see what each one does.
  const desc = (ctrl, text) => {
    if (!ctrl) return ctrl;
    if (typeof ctrl.description === "function") ctrl.description(text);
    if (ctrl.domElement) ctrl.domElement.title = text;
    return ctrl;
  };

  // ---------- Display (exposure, bloom) — TOP folder, most-used knobs ----------
  const displayFolder = gui.addFolder("Display (exposure / bloom)");
  desc(
    displayFolder
      .add(exposureState, "base", 0.05, 2.5, 0.01)
      .name("exposure")
      .onChange((v) => (renderer.toneMappingExposure = v)),
    "Overall scene brightness. SkyMesh is calibrated for ~0.1. Try 0.3-0.6 for our scene. Lower = darker sky/sun, less blowout. The animate loop adds a small bump underwater on top of this.",
  );
  const bloomCtrl = {
    get strength()  { return bloomPass.strength.value; },
    set strength(v) { bloomPass.strength.value = v; },
    get threshold() { return bloomPass.threshold.value; },
    set threshold(v){ bloomPass.threshold.value = v; },
    get radius()    { return bloomPass.radius.value; },
    set radius(v)   { bloomPass.radius.value = v; },
  };
  desc(displayFolder.add(bloomCtrl, "strength",  0, 1.5, 0.01),  "Bloom intensity. 0 = no glow. Higher = sun/highlights bleed more.");
  desc(displayFolder.add(bloomCtrl, "threshold", 0, 2,   0.01),  "Brightness above which pixels glow. Lower = more things bloom (sky, foam). Higher = only sun.");
  desc(displayFolder.add(bloomCtrl, "radius",    0, 2,   0.01),  "How far bloom spreads from a bright pixel.");

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
  desc(wavesFolder.add(wavesProxy, "windSpeed",     0, 80, 0.5),      "Wind speed in m/s. Drives global wave amplitude. 5-10 calm, 15-25 moderate, 30+ stormy.");
  desc(wavesFolder.add(wavesProxy, "windDirection", 0, Math.PI * 2, 0.01), "Wind direction in radians. Rotates wave/foam streaks.");
  desc(wavesFolder.add(wavesProxy, "choppiness",    0, 2, 0.01),      "Horizontal wave displacement. 0=smooth sine, 1=natural, 1.5+=sharp choppy crests.");
  desc(wavesFolder.add(wavesProxy, "amplitude",     0, 3, 0.01),      "Global wave height multiplier on top of windSpeed scaling.");
  desc(wavesFolder.add(wavesProxy, "animationSpeed",0, 3, 0.01),      "Time scale. 0 freezes the surface, 1 = normal.");
  desc(wavesFolder.add(wavesProxy, "rippleAmp",     0, 2, 0.01).name("ripple.amp"),     "FBM mid-scale ripple amplitude (normal perturbation + slight vertical).");
  desc(wavesFolder.add(wavesProxy, "rippleFreq",    0.01, 0.3, 0.005).name("ripple.freq"), "FBM mid-scale ripple frequency. Lower = larger ripples.");
  desc(wavesFolder.add(wavesProxy, "microAmp",      0, 0.3, 0.005).name("micro.amp"),  "FBM fine ripple amplitude — mainly normal perturbation for sun glitter.");
  desc(wavesFolder.add(wavesProxy, "microFreq",     0.1, 2, 0.05).name("micro.freq"),  "FBM fine ripple frequency. Higher = denser glitter.");

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
  desc(appearance.addColor({ c: "#" + water.color.shallowWaterColor.getHexString() }, "c").name("shallow").onChange((v) => water.color.shallowWaterColor.set(v)),
    "Water colour in shallow / surface regions.");
  desc(appearance.addColor({ c: "#" + water.color.deepWaterColor.getHexString() }, "c").name("deep").onChange((v) => water.color.deepWaterColor.set(v)),
    "Water colour at depth — Beer-Lambert absorption fades toward this.");
  desc(appearance.add(water.color, "depthFalloff", 1, 100, 0.5),
    "How quickly water gets darker with depth (metres). Lower = murkier.");
  desc(appearance.add(water.color, "clarity", 0.0, 2.5, 0.05).name("clarity (see-through)"),
    "0=opaque (lake), 1=normal, 2=tropical lagoon. Boosts refraction visibility.");
  desc(appearance.add(water.fresnel, "power", 1, 8, 0.1).name("fresnel.power"),
    "Schlick exponent — how sharply reflection ramps up at grazing angles.");
  desc(appearance.add(water.sparkle, "enabled").name("sparkle.enabled"),    "Toggle high-freq sun sparkle on water surface.");
  desc(appearance.add(water.sparkle, "intensity", 0, 3, 0.05).name("sparkle.intensity"),  "Sparkle brightness.");
  desc(appearance.add(water.fog, "enabled").name("fog.enabled"),    "Atmospheric fade of distant water into sky horizon.");
  desc(appearance.add(water.fog, "fadeStart", 50, 1500, 10).name("fog.fadeStart"),  "Distance (m) where atmospheric fog begins.");
  desc(appearance.add(water.fog, "fadePower", 0.3, 4, 0.05).name("fog.fadePower"),  "Fog falloff curve. <1 = faster, >1 = slower.");

  const reflectionFolder = gui.addFolder("Reflection");
  reflectionFolder.domElement.title = "Planar mirror reflection — controls how strongly props ghost onto water.";
  desc(reflectionFolder.add(water.reflection, "strength", 0, 1, 0.01).name("strength"),  "0 = no reflection, 1 = full mirror. 0.5 is balanced.");
  desc(reflectionFolder.add(water.reflection, "fadeStart", 5, 500, 1).name("fadeStart (m)"),  "Distance where reflection starts fading. Closer water = clear mirror, distant = atmospheric haze.");
  desc(reflectionFolder.add(water.reflection, "fadeEnd",   50, 2000, 5).name("fadeEnd (m)"),  "Distance where reflection fully fades to sky horizon.");
  desc(reflectionFolder.add(water.reflection, "distortionStrength", 0, 3, 0.05).name("distortion"),  "How much waves wobble the reflection. 0 = perfect mirror, 1 = natural, 2+ = stormy.");

  const skyFolder = gui.addFolder("Sky");
  skyFolder.domElement.title = "Sun position, atmosphere, clouds. Sky type fixed at startup via ?sky=rayleigh URL param.";
  const skyProxy = {
    sunElevation: preset.sky.sun.elevation,
    sunAzimuth: preset.sky.sun.azimuth,
    cloudCoverage: preset.sky.clouds.coverage,
    sunIntensity: preset.sky.sun.intensity,
    turbidity: useOfficialSky ? sky._mesh.turbidity.value : preset.sky.atmosphere.turbidity,
    rayleigh: useOfficialSky ? sky._mesh.rayleigh.value : preset.sky.atmosphere.rayleighCoefficient,
    showSunDisc: useOfficialSky ? !!sky._mesh.showSunDisc.value : true,
    cloudDensity: useOfficialSky ? sky._mesh.cloudDensity.value : 0.5,
    cloudElevation: useOfficialSky ? sky._mesh.cloudElevation.value : 0.5,
    cloudSpeed: useOfficialSky ? sky._mesh.cloudSpeed.value : 0.0001,
  };
  desc(skyFolder.add(skyProxy, "sunElevation", 0, 90, 0.5),
    "Sun angle above horizon. 0 = horizon (sunset), 90 = directly overhead.")
    .onChange(() => sky.setSunFromAngles(skyProxy.sunElevation, skyProxy.sunAzimuth));
  desc(skyFolder.add(skyProxy, "sunAzimuth", 0, 360, 1),
    "Sun direction around the horizon in degrees. 0/360 = +Z, 90 = +X.")
    .onChange(() => sky.setSunFromAngles(skyProxy.sunElevation, skyProxy.sunAzimuth));
  desc(skyFolder.add(skyProxy, "cloudCoverage", 0, 1, 0.01),
    "Fraction of sky covered by clouds. 0 = clear, 1 = overcast.")
    .onChange((v) => (sky.cloudUniforms.coverage.value = v));
  if (useOfficialSky) {
    desc(skyFolder.add(skyProxy, "showSunDisc"),
      "Toggle the sun disc rendering. Off = atmospheric glow only (no white spot).")
      .onChange((v) => (sky._mesh.showSunDisc.value = v ? 1 : 0));
    desc(skyFolder.add(skyProxy, "turbidity", 1, 20, 0.1),
      "Atmospheric haze. Low = clear, high = dusty/foggy sky.")
      .onChange((v) => (sky._mesh.turbidity.value = v));
    desc(skyFolder.add(skyProxy, "rayleigh", 0, 4, 0.05),
      "Blue scattering strength. Higher = bluer sky.")
      .onChange((v) => (sky._mesh.rayleigh.value = v));
    desc(skyFolder.add(skyProxy, "cloudDensity", 0, 1, 0.01),
      "How opaque the clouds are inside their coverage area.")
      .onChange((v) => (sky._mesh.cloudDensity.value = v));
    desc(skyFolder.add(skyProxy, "cloudElevation", 0, 0.7, 0.01),
      "Cloud layer apparent distance. Despite the name, the SkyMesh shader makes clouds appear LOWER/CLOSER as this rises (it scales 1/(y*elevation) in cloudUV). 0=clouds high & small, 0.5=natural, 0.7+=clouds wrap around and clip the sun horizon. Range capped at 0.7 to avoid the sun-cut-in-half artifact.")
      .onChange((v) => (sky._mesh.cloudElevation.value = v));
    desc(skyFolder.add(skyProxy, "cloudSpeed", 0, 0.001, 0.00001),
      "Cloud drift speed. Very small numbers — 0.0001 is normal wind.")
      .onChange((v) => (sky._mesh.cloudSpeed.value = v));
  } else {
    desc(skyFolder.add(skyProxy, "sunIntensity", 0, 3, 0.05),
      "Sun brightness multiplier (RayleighSky only — SkyMesh has its own calibration).")
      .onChange((v) => (sky.sunUniforms.intensity.value = v));
  }

  // ---------- Interactive Water (object-driven displacement) ----------
  // The InteractiveWater layer lets boats / splash events push displacement
  // into the water. Toggle off to compare against the analytical Gerstner-only
  // surface. Range / damping knobs are per-step (60Hz).
  if (water.interactive) {
    const iwFolder = gui.addFolder("Interactive Water");
    const iwState = {
      enabled: water.interactive.enabled,
      waveSpeed: water.interactive.waveSpeed,
      damping: water.interactive.damping,
    };
    desc(iwFolder.add(iwState, "enabled"),
      "Master toggle. OFF = boats / splash do not displace water (Gerstner-only).")
      .onChange((v) => water.interactive.setEnabled(v));
    desc(iwFolder.add(iwState, "waveSpeed", 0.5, 8, 0.1),
      "Ripple propagation speed (m/s). 3 m/s = natural short-ocean ripples. >8 risks CFL instability.")
      .onChange((v) => water.interactive.setWaveSpeed(v));
    desc(iwFolder.add(iwState, "damping", 0, 0.02, 0.0005),
      "Energy bleed per step. Higher = ripples die quicker. 0.003 = natural.")
      .onChange((v) => water.interactive.setDamping(v));
    iwFolder.add({ pulse: () => {
      // Fire 6 impulses around the origin so you can see the effect immediately.
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        water.interactive.splatImpulse(Math.cos(a) * 5, Math.sin(a) * 5, 0.35, 0.6);
      }
    }}, "pulse").name("💥 Test pulse ring");
  }

  // ---------- Fish (underwater life) ----------
  const fishFolder = gui.addFolder("Fish");
  const fishState = {
    enabled: true,
    count: 150,
    swimSpeedScale: 1.0,
  };
  desc(fishFolder.add(fishState, "enabled"),
    "Show / hide all fish. Cheap — just toggles a draw call.")
    .onChange((v) => fish.setEnabled(v));
  desc(fishFolder.add(fishState, "count", 0, 300, 1),
    "Number of active fish. 50 = sparse, 150 = busy, 300 = full schools everywhere. No realloc cost.")
    .onChange((v) => fish.setCount(v));
  desc(fishFolder.add(fishState, "swimSpeedScale", 0, 3, 0.05),
    "Multiplier on swim speed. 0 = frozen tableau, 1 = natural, 3 = panicked.")
    .onChange((v) => fish.setSwimSpeedScale(v));

  const qualityFolder = gui.addFolder("Quality");
  const qState = { level: "high" };
  qualityFolder.add(qState, "level", ["low", "medium", "high", "ultra"]).onChange(async (v) => { await water.setQualityLevel(v); });
  qualityFolder.add(water, "wireframe");
  // (exposure lives in the top Display folder now.)

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
    // Apply a small underwater brighten on top of the user's chosen base
    // exposure so the slider in the Display folder isn't overwritten every frame.
    renderer.toneMappingExposure = exposureState.base * (underwater ? 1.05 : 1.0);
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
    // Same loop also fires periodic interactive-water IMPULSES when boats are
    // moving fast enough — gives a one-shot concentric ripple at every "impact".
    const emitters = [];
    for (const o of water.buoyancy._objects.values()) {
      const m = o.mesh;
      const ws = (m.userData && m.userData.wakeStrength) ?? 0;
      if (ws <= 0) continue;
      emitters.push({ x: m.position.x, y: 0.4, z: m.position.z, strength: ws * 0.4 });

      // Periodic impulse — every ~0.25s when the boat is moving > 1 m/s, splat
      // a small positive Gaussian to seed transient ripples around the hull.
      if (!m.userData._lastSplashImpulse) m.userData._lastSplashImpulse = 0;
      m.userData._lastSplashImpulse += dt;
      const last = m.userData._lastPosForSplat;
      if (last && water.interactive?.enabled && m.userData._lastSplashImpulse > 0.25) {
        const vx = m.position.x - last.x, vz = m.position.z - last.z;
        const speed = Math.sqrt(vx * vx + vz * vz) / Math.max(0.001, dt);
        if (speed > 1.0) {
          // amp scales with KE, capped. sigma scales with hull beam.
          // Smaller impulses — previous 0.08..0.30 m looked like dots from
          // distance. 0.04..0.14 still seeds visible transient ripples up close
          // without polluting the wide-view appearance.
          const amp = 0.04 + Math.min(0.10, speed * 0.015) * ws;
          water.interactive.splatImpulse(m.position.x, m.position.z, amp, 0.7);
          m.userData._lastSplashImpulse = 0;
        }
      }
    }
    spray.update(dt, emitters);
    fish.update(dt, { x: camera.position.x, z: camera.position.z }, now / 1000);

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
