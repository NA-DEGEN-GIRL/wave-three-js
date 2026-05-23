// Sandy ocean floor with animated caustics and seaweed.
//
// Caustics are computed in the floor material using two voronoi noise samples
// at different scales — interference between them gives the characteristic
// flickering bright network seen in shallow tropical water.

import * as THREE from "three/webgpu";
import {
  Fn, vec2, vec3, vec4, float, uniform, mix, sin, cos, fract, floor as flr,
  dot, smoothstep, uv, length, min, max, pow, abs, clamp, time, normalize,
  cameraPosition, positionWorld, texture,
} from "three/tsl";

const hash22 = Fn(([p]) => {
  const x = fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
  const y = fract(sin(dot(p, vec2(269.5, 183.3))).mul(43758.5453));
  return vec2(x, y);
});

// Voronoi distance to nearest hashed point in the 3x3 neighbourhood.
const voronoi2 = Fn(([p]) => {
  const ip = flr(p).toVar();
  const fp = p.sub(ip).toVar();
  const md = float(8.0).toVar();
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const offset = vec2(dx, dy);
      const cell = ip.add(offset);
      const h = hash22(cell);
      const pt = offset.add(h);
      const d = length(pt.sub(fp));
      md.assign(min(md, d));
    }
  }
  return md;
});

export class OceanFloor {
  constructor({ size = 1000, depth = 18, meshResolution = 96, sunDirection = null, foamSim = null } = {}) {
    this.size = size;
    this.depth = depth;
    this.meshResolution = meshResolution;
    this.sunDirection = sunDirection ?? uniform(new THREE.Vector3(0.4, 0.6, 0.5).normalize());
    this.foamSim = foamSim; // optional: dim caustics under foamy areas (multiple-scattering)
    this._build();
  }

  _build() {
    // Subtly displaced floor: bumpy plane.
    const geom = new THREE.PlaneGeometry(this.size, this.size, this.meshResolution, this.meshResolution);
    geom.rotateX(-Math.PI / 2);
    const pos = geom.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const dunes = Math.sin(x * 0.04) * 0.4 + Math.cos(z * 0.05) * 0.3 + Math.sin((x + z) * 0.02) * 0.6;
      pos.setY(i, dunes);
    }
    geom.computeVertexNormals();

    const mat = new THREE.MeshBasicNodeMaterial({ fog: true });
    const sandTop = uniform(new THREE.Color("#d2b07a"));
    const sandLow = uniform(new THREE.Color("#7a5e3b"));
    const causticsColor = uniform(new THREE.Color("#fff2c0"));
    const causticsStrength = uniform(2.8);

    // If a foam simulation is wired up, sample its RT so caustics can be dimmed
    // where foam is splashing (foam scatters light diffusely, washing out the
    // sharp caustic pattern beneath it).
    const hasFoam = !!this.foamSim;
    const foamTex = hasFoam ? this.foamSim.currentTexture : null;
    const foamCenter = hasFoam ? this.foamSim.centerXZUniform : null;
    const foamHalf = hasFoam ? this.foamSim.halfSizeUniform : null;

    mat.colorNode = Fn(() => {
      const wp = positionWorld;
      // Sand colour: blend by procedural noise plus ripple bumps.
      const uvSand = vec2(wp.x.mul(0.05), wp.z.mul(0.05));
      const baseNoise = sin(uvSand.x.mul(3.0).add(sin(uvSand.y.mul(2.0)))).mul(0.5).add(0.5);
      const ripples = sin(uvSand.x.mul(7.0).add(uvSand.y.mul(9.0))).mul(0.1).add(0.9);
      const sandCol = mix(sandLow, sandTop, baseNoise).mul(ripples).toVar();

      // Caustics: two voronoi samples animated and offset by sun direction.
      const sd = normalize(this.sunDirection);
      const causticUV = vec2(wp.x.mul(0.07), wp.z.mul(0.07))
        .add(vec2(sd.x, sd.z).mul(0.3));
      const t = time.mul(0.18);
      const c1 = voronoi2(causticUV.add(vec2(t, t.mul(0.7))));
      const c2 = voronoi2(causticUV.mul(1.7).add(vec2(t.mul(-0.5), t.mul(0.3))));
      const causticEdge = pow(float(1.0).sub(min(c1, c2).mul(2.0)), float(6.0));
      const sunUp = clamp(sd.y.mul(1.5), 0.0, 1.0);
      let caustic = clamp(causticEdge, 0.0, 1.0).mul(causticsStrength).mul(sunUp);

      // Caustics × (1 - foam): foam scatters incoming light so caustic focal
      // lines underneath are washed out. Per Tessendorf & GPU Gems Ch.2.
      if (hasFoam) {
        const foamUV = vec2(
          wp.x.sub(foamCenter.x).div(foamHalf).mul(0.5).add(0.5),
          wp.z.sub(foamCenter.y).div(foamHalf).mul(0.5).add(0.5),
        );
        const foamHere = texture(foamTex, foamUV).r;
        // Dim caustics by foam (up to 70%) and add a small constant diffuse term
        // back to fake the multiple-scattering brightness under foam.
        const dimCoeff = float(1.0).sub(foamHere.mul(0.7));
        caustic = caustic.mul(dimCoeff).add(foamHere.mul(0.08));
      }

      const litCol = sandCol.mul(0.85).add(causticsColor.mul(caustic));
      return vec4(litCol, 1.0);
    })();

    this._mesh = new THREE.Mesh(geom, mat);
    this._mesh.position.y = -this.depth;
    this._mesh.frustumCulled = false;
    this._mat = mat;
  }

  getMesh() { return this._mesh; }
  dispose() {
    this._mesh.geometry.dispose();
    this._mat.dispose();
  }
}

// Underwater particles (sediment, plankton) — points distributed in a sphere
// around the camera. Slowly drift. Visible only when the camera is below water.
export function makeUnderwaterParticles({ count = 800, radius = 30 } = {}) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Distribute in a spherical shell with random angles
    const u = Math.random();
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * Math.cbrt(u);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) - 8;
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xeaf5f5,
    size: 0.5,
    transparent: true,
    opacity: 0.85,
    sizeAttenuation: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.visible = false; // toggled by main loop when underwater
  return points;
}

// Procedural seaweed/kelp prop. A few flat strands with seaweed material.
export function makeSeaweed({ x = 0, z = 0, height = 4, count = 5 } = {}) {
  const grp = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const shape = new THREE.Shape();
    shape.moveTo(-0.3, 0);
    shape.bezierCurveTo(-1.0, height * 0.4, 0.6, height * 0.6, -0.3, height);
    shape.lineTo(0.3, height);
    shape.bezierCurveTo(-0.4, height * 0.6, 1.0, height * 0.4, 0.3, 0);
    shape.lineTo(-0.3, 0);
    const geom = new THREE.ShapeGeometry(shape);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2a4f24, side: THREE.DoubleSide, roughness: 0.6,
    });
    const m = new THREE.Mesh(geom, mat);
    m.rotation.y = Math.random() * Math.PI;
    m.position.set(x + (Math.random() - 0.5) * 1.5, 0, z + (Math.random() - 0.5) * 1.5);
    grp.add(m);
  }
  return grp;
}
