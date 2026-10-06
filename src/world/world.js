import * as THREE from 'three';
import { getBiome, BASE_ALT } from './biomes.js';
import { buildTerrainMesh } from './terrain.js';
import { Sky } from './sky.js';
import { buildAirbase, buildCityLights } from './airbase.js';
import { noise2 } from '../util/noise.js';

function seaNormalMap() {
  const N = 256, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d'), img = g.createImageData(N, N);
  const waves = []; for (let i = 0; i < 9; i++) waves.push({ fx: Math.floor(Math.random() * 7) + 1, fy: Math.floor(Math.random() * 7) + 1, p: Math.random() * 6.28, a: 1 / (1 + i * 0.6) });
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let dx = 0, dy = 0;
    for (const w of waves) { const ph = 6.2832 * (w.fx * x / N + w.fy * y / N) + w.p, c = Math.cos(ph) * w.a; dx += c * w.fx; dy += c * w.fy; }
    const nx = -dx * 0.05, ny = -dy * 0.05, nz = 1, l = Math.hypot(nx, ny, nz), i = (y * N + x) * 4;
    img.data[i] = (nx / l * 0.5 + 0.5) * 255; img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255; img.data[i + 2] = (nz / l * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(400, 400); t.anisotropy = 8;
  return t;
}

/** Owns everything static in the 3D scene: sky, terrain, sea, base, vegetation. */
export class World {
  constructor(scene) {
    this.scene = scene; this.sky = new Sky(scene); this.root = new THREE.Group(); scene.add(this.root);
    this.biome = getBiome('coast'); this.time = 0; this.sea = null; this.base = null; this.exposure = 1;
  }

  build(mission, centre = [0, 0, 0]) {
    this.clear();
    const env = mission.env || {};
    this.biome = getBiome(env.biome);
    this.sky.set({ time: env.time, weather: env.weather, fogTint: this.biome.fogTint });
    const cx = centre[0], cz = centre[2];
    const inner = buildTerrainMesh(this.biome, cx, cz, 20000, 280, { skirt: 140 });
    const outer = buildTerrainMesh(this.biome, cx, cz, 110000, 200, { yOffset: -28 });
    this.root.add(outer, inner); this.terrain = [inner, outer];
    if (this.biome.sea) {
      const tex = seaNormalMap(); this.seaTex = tex;
      this.sea = new THREE.Mesh(new THREE.PlaneGeometry(120000, 120000), new THREE.MeshStandardMaterial({ color: this.sky.seaColor, roughness: 0.16, metalness: 0.25, normalMap: tex, normalScale: new THREE.Vector2(0.9, 0.9) }));
      this.sea.rotation.x = -Math.PI / 2; this.root.add(this.sea);
    }
    if (mission.base) { this.base = buildAirbase(mission.base); this.root.add(this.base.group); }
    if (mission.zones) {
      const city = buildCityLights(mission.zones, (x, z) => this.biome.height(x, z));
      city.material.opacity = 0.15 + 0.8 * this.sky.lightsAmount; this.root.add(city); this.city = city;
    }
    this.buildVegetation(cx, cz);
    this.hasSea = !!this.biome.sea;
  }

  buildVegetation(cx, cz) {
    const v = this.biome.vegetation; if (!v) return;
    const pts = [];
    if (v.oasis) for (const [ox, oz] of v.oasis) for (let i = 0; i < 40; i++) pts.push([ox + (Math.random() - 0.5) * 500, oz + (Math.random() - 0.5) * 500]);
    const n = Math.floor(v.density * 5000);
    for (let i = 0; i < n; i++) {
      const x = cx + (Math.random() - 0.5) * 12000, z = cz + (Math.random() - 0.5) * 12000;
      if (noise2(x / 900, z / 900, 22) < 0.5) continue;
      pts.push([x, z]);
    }
    const geo = v.kind === 'palm' ? new THREE.ConeGeometry(7, 22, 5) : v.kind === 'cypress' ? new THREE.ConeGeometry(4, 18, 6) : new THREE.IcosahedronGeometry(3, 0);
    geo.translate(0, v.kind === 'shrub' ? 1.5 : 9, 0);
    const mat = new THREE.MeshStandardMaterial({ color: v.kind === 'palm' ? 0x3e6b2e : v.kind === 'cypress' ? 0x24381f : 0x5a5232, roughness: 1, flatShading: true });
    const mesh = new THREE.InstancedMesh(geo, mat, pts.length); let k = 0; const m = new THREE.Matrix4();
    for (const [x, z] of pts) {
      const h = this.biome.height(x, z);
      if (h < v.minH || h > v.maxH || (v.minD && z - this.coastLine(x) < v.minD) || Math.hypot(x, z - 1500) < 1900) continue;
      m.makeScale(0.8 + Math.random() * 0.8, 0.8 + Math.random() * 1.1, 0.8 + Math.random() * 0.8).setPosition(x, h, z);
      mesh.setMatrixAt(k++, m);
    }
    mesh.count = k; mesh.instanceMatrix.needsUpdate = true; mesh.frustumCulled = false;
    this.root.add(mesh); this.veg = mesh;
  }
  coastLine(x) { return -1600 + 900 * Math.sin(x * 0.00045 + 1) + 400 * Math.sin(x * 0.0017 + 2); }

  heightAt(x, z) { return this.biome.height(x, z); }
  /** Collision height: terrain or sea surface. */
  groundY(x, z) { const h = this.biome.height(x, z); return this.hasSea ? Math.max(h, 0) : h; }

  update(dt, camera, particles) {
    this.time += dt;
    this.exposure = this.sky.update(dt, camera.position);
    const sd = this.sky.scene.fog.density;
    if (this.sea) {
      const tile = 300;
      this.sea.position.set(camera.position.x, 0, camera.position.z);
      this.seaTex.offset.set(camera.position.x / tile + this.time * 0.004, -camera.position.z / tile + this.time * 0.003);
      this.sea.material.color.copy(this.sky.seaColor);
    }
    if (this.base) this.base.update(this.time, sd);
    particles?.setFog(this.sky.fogColor, sd);
    return this.exposure;
  }

  clear() {
    for (const c of [...this.root.children]) {
      this.root.remove(c);
      c.traverse?.((o) => { o.geometry?.dispose?.(); if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.map?.dispose?.(); m.dispose?.(); }); } });
    }
    this.sea = null; this.base = null; this.city = null; this.veg = null;
  }
}
