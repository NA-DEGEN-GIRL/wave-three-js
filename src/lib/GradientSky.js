// Lightweight gradient sky for the WebGL fallback tier.
import * as THREE from "three/webgpu";
import { Fn, vec3, vec4, float, uniform, mix, normalize, dot, positionWorld, cameraPosition, clamp, smoothstep, pow, max } from "three/tsl";

export class GradientSky {
  constructor({ topColor = "#1a4080", bottomColor = "#a4c1e0", sunDir = new THREE.Vector3(0.4, 0.6, 0.2).normalize(), sunColor = "#fff2e6", sunSize = 0.04, showSunDisk = true } = {}) {
    this.sunUniforms = { direction: uniform(sunDir.clone().normalize()), intensity: uniform(1.0) };
    this._top = uniform(new THREE.Color(topColor));
    this._bot = uniform(new THREE.Color(bottomColor));
    this._sunCol = uniform(new THREE.Color(sunColor));
    this._sunSize = uniform(sunSize);
    this._sunDiskVisibility = uniform(showSunDisk ? 1 : 0);

    this.atmosphereUniforms = { skyColor: this._top, skyBrightness: uniform(1.0), turbidity: uniform(2), rayleighCoefficient: uniform(1), mieCoefficient: uniform(0.003), mieDirectionalG: uniform(0.75) };
    this.sunDiskUniforms = { color: this._sunCol, emissiveColor: uniform(new THREE.Color(sunColor)), emissiveIntensity: uniform(60), radius: this._sunSize, visible: this._sunDiskVisibility };
    this.cloudUniforms = { enabled: uniform(0), coverage: uniform(0) };

    this._buildMesh();
  }

  _skyColorFn() {
    const top = this._top;
    const bot = this._bot;
    const sCol = this._sunCol;
    const sSize = this._sunSize;
    const sunDiskVisibility = this._sunDiskVisibility;
    const sunDir = this.sunUniforms.direction;
    return Fn(([v]) => {
      const d = normalize(v);
      const t = clamp(d.y, 0, 1);
      let c = mix(bot, top, smoothstep(0.0, 0.5, t)).toVar();
      const cd = dot(d, sunDir);
      const disk = smoothstep(float(1.0).sub(sSize.mul(2.0)), float(1.0).sub(sSize), cd);
      c.addAssign(sCol.mul(disk).mul(sunDiskVisibility).mul(2.0));
      return c;
    });
  }

  _buildMesh() {
    const geom = new THREE.SphereGeometry(8000, 32, 16);
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const skyFn = this._skyColorFn();
    const viewDir = Fn(() => normalize(positionWorld.sub(cameraPosition)))();
    mat.colorNode = vec4(skyFn(viewDir), 1.0);
    this._mesh = new THREE.Mesh(geom, mat);
    this._mesh.frustumCulled = false;
    this._mesh.renderOrder = -1000;
    this._skyFn = skyFn;
    this._material = mat;
  }

  getMesh() { return this._mesh; }
  getHorizonColor() { return this._bot.value.clone(); }
  getSkyBrightness() { return this.atmosphereUniforms.skyBrightness.value; }
  createReflectionSampler() { return this._skyFn; }
  createFogSampler() { return this._skyFn; }
  dispose() { this._mesh.geometry.dispose(); this._material.dispose(); }
  setSunFromAngles(elevDeg, azimDeg) {
    const e = elevDeg * Math.PI / 180, a = azimDeg * Math.PI / 180;
    this.sunUniforms.direction.value.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)).normalize();
  }
}
