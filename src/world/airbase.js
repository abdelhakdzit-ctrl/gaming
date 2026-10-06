import * as THREE from 'three';
import { BillboardBatch } from './billboards.js';
import { BASE_ALT } from './biomes.js';
import { noise2 } from '../util/noise.js';

// Algeria-inspired fictional airbase: white-washed arched hangars, tower, radar, bilingual signage.
const BLACK = new THREE.Color(0, 0, 0);
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

export function buildAirbase(spec) {
  const group = new THREE.Group(); group.name = 'airbase';
  const len = spec.runwayLength || 2500, W = 46;
  const root = new THREE.Group(); root.position.set(spec.pos[0], BASE_ALT, spec.pos[2]);
  root.rotation.y = -(spec.heading || 0) * Math.PI / 180;
  group.add(root);
  const animated = [];

  // runway with markings (texture v runs along length; north end is local -z)
  const rwTex = canvasTex(256, 2048, (g, w, h) => {
    g.fillStyle = '#25272a'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 9000; i++) { const v = 30 + Math.random() * 28; g.fillStyle = `rgb(${v},${v},${v + 2})`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
    g.fillStyle = '#d8d8d0';
    for (let y = 260; y < h - 260; y += 54) g.fillRect(w / 2 - 3, y, 6, 28);
    for (const e of [0, 1]) for (let k = 0; k < 8; k++) g.fillRect(24 + k * 26 + (k > 3 ? 14 : 0), e ? h - 70 : 20, 12, 40);
    g.fillRect(8, 0, 4, h); g.fillRect(w - 12, 0, 4, h);
    g.font = 'bold 54px sans-serif'; g.textAlign = 'center';
    g.save(); g.translate(w / 2, 150); g.rotate(Math.PI); g.fillText('18', 0, 0); g.restore();
    g.save(); g.translate(w / 2, h - 150); g.fillText('36', 0, 0); g.restore();
  });
  const runway = new THREE.Mesh(new THREE.PlaneGeometry(W, len), new THREE.MeshStandardMaterial({ map: rwTex, roughness: 0.85 }));
  runway.rotation.x = -Math.PI / 2; runway.position.y = 0.12; root.add(runway);
  const apronMat = new THREE.MeshStandardMaterial({ color: 0x3b3d3e, roughness: 0.9 });
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(210, 420), apronMat);
  apron.rotation.x = -Math.PI / 2; apron.position.set(190, 0.1, 100); root.add(apron);
  const taxi = new THREE.Mesh(new THREE.PlaneGeometry(22, len * 0.8), apronMat);
  taxi.rotation.x = -Math.PI / 2; taxi.position.set(95, 0.1, 0); root.add(taxi);

  // buildings
  const wall = new THREE.MeshStandardMaterial({ color: 0xcfc8b8, roughness: 0.9 });
  const roofM = new THREE.MeshStandardMaterial({ color: 0xa8a090, roughness: 0.8, metalness: 0.2 });
  const doorM = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.6, emissive: 0x1a2a3a, emissiveIntensity: 0.5 });
  const sign = canvasTex(1024, 256, (g, w, h) => {
    g.fillStyle = '#14301f'; g.fillRect(0, 0, w, h); g.strokeStyle = '#e8e2cf'; g.lineWidth = 6; g.strokeRect(8, 8, w - 16, h - 16);
    g.fillStyle = '#e8e2cf'; g.textAlign = 'center'; g.font = 'bold 72px sans-serif'; g.fillText('BA-07 RAS EL-HADJAR', w / 2, 110);
    g.font = '52px sans-serif'; g.fillText('BASE AÉRIENNE  •  القاعدة الجوية', w / 2, 190);
  });
  for (let i = 0; i < 3; i++) {
    const hz = -120 + i * 130, hg = new THREE.Group(); hg.position.set(290, 0, hz);
    const body = new THREE.Mesh(new THREE.BoxGeometry(70, 12, 62), wall); body.position.y = 6; hg.add(body);
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(35, 35, 62, 20, 1, false, 0, Math.PI), roofM);
    roof.rotation.z = Math.PI / 2; roof.rotation.y = 0; roof.rotation.x = Math.PI / 2; roof.position.y = 12; hg.add(roof);
    const door = new THREE.Mesh(new THREE.PlaneGeometry(40, 13), doorM); door.rotation.y = -Math.PI / 2; door.position.set(-35.2, 6.5, 0); hg.add(door);
    root.add(hg);
    if (i === 1) { const sg = new THREE.Mesh(new THREE.PlaneGeometry(26, 6.5), new THREE.MeshBasicMaterial({ map: sign })); sg.rotation.y = -Math.PI / 2; sg.position.set(-35.4, 17, 0); root.add(sg); sg.position.add(hg.position); }
  }
  // tower
  const tower = new THREE.Group(); tower.position.set(120, 0, 330);
  tower.add(new THREE.Mesh(new THREE.CylinderGeometry(3.2, 4.2, 34, 12), wall).translateY(17));
  const cab = new THREE.Mesh(new THREE.CylinderGeometry(7, 5.4, 6, 12), new THREE.MeshStandardMaterial({ color: 0x223a4a, emissive: 0x6fb0d8, emissiveIntensity: 0.9, roughness: 0.2 }));
  cab.position.y = 37; tower.add(cab); tower.add(new THREE.Mesh(new THREE.CylinderGeometry(7.6, 7.6, 0.8, 12), wall).translateY(40.4));
  root.add(tower);
  // radar dome + rotating antenna
  const radar = new THREE.Group(); radar.position.set(-150, 0, 300);
  radar.add(new THREE.Mesh(new THREE.BoxGeometry(14, 8, 14), wall).translateY(4));
  radar.add(new THREE.Mesh(new THREE.CylinderGeometry(1, 1.4, 12, 8), roofM).translateY(14));
  const ant = new THREE.Mesh(new THREE.BoxGeometry(22, 7, 1), new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.4, roughness: 0.5 }));
  ant.position.y = 22; const antG = new THREE.Group(); antG.position.y = 0; antG.add(ant); radar.add(antG); animated.push((t) => { antG.rotation.y = t * 1.1; });
  root.add(radar);
  // fuel tanks and small buildings
  const tankM = new THREE.MeshStandardMaterial({ color: 0xb9b6ad, roughness: 0.6, metalness: 0.3 });
  for (let i = 0; i < 4; i++) root.add(new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 11, 16), tankM).translateX(-120 + (i % 2) * 24).translateZ(520 + Math.floor(i / 2) * 24).translateY(5.5));
  for (let i = 0; i < 10; i++) root.add(new THREE.Mesh(new THREE.BoxGeometry(14, 6, 10), wall).translateX(-60 - (i % 5) * 22).translateZ(420 + Math.floor(i / 5) * 26).translateY(3));

  // lights (static additive billboards)
  const lights = new BillboardBatch(1100, { additive: true });
  lights.begin();
  const half = len / 2;
  const toWorld = (x, y, z) => { const v = new THREE.Vector3(x, y, z); root.localToWorld(v); return v; };
  for (let z = -half; z <= half; z += 60) for (const x of [-W / 2 - 1, W / 2 + 1]) { const p = toWorld(x, 1, z); lights.push(p.x, p.y, p.z, 2.6, 1, 0.95, 0.8, 0.9); }
  for (let x = -W / 2; x <= W / 2; x += 4) { const p1 = toWorld(x, 1, half + 4), p2 = toWorld(x, 1, -half - 4); lights.push(p1.x, p1.y, p1.z, 5, 1, 0.1, 0.05, 0.9); lights.push(p2.x, p2.y, p2.z, 5, 0.1, 1, 0.3, 0.9); }
  for (let k = 1; k <= 14; k++) { const p = toWorld(0, 1.5, -half - 40 - k * 40); lights.push(p.x, p.y, p.z, 8, 1, 1, 1, 0.9); }
  for (let i = 0; i < 24; i++) { const p = toWorld(210 + (i % 6) * 36 - 90, 7, -170 + Math.floor(i / 6) * 120); lights.push(p.x, p.y, p.z, 6, 1, 0.78, 0.45, 0.8); }
  for (let z = -half; z < half; z += 90) { const p = toWorld(95 + 14, 1, z); lights.push(p.x, p.y, p.z, 4, 0.2, 0.5, 1, 0.8); }
  const tp = toWorld(120, 41, 330); lights.push(tp.x, tp.y, tp.z, 16, 1, 0.2, 0.15, 1);
  lights.end(); group.add(lights.mesh);

  // gently varied ground patch around the base so the runway sits in the terrain
  const patch = new THREE.Mesh(new THREE.PlaneGeometry(900, len + 700), new THREE.MeshStandardMaterial({ color: 0x4b4838, roughness: 1 }));
  patch.rotation.x = -Math.PI / 2; patch.position.set(120, 0.02, 0); root.add(patch);

  return {
    group, lights,
    update(t, fogDensity) {
      for (const f of animated) f(t);
      lights.setFog(BLACK, fogDensity);
    }
  };
}

/** Distant city lights: clustered additive points. */
export function buildCityLights(zones, heightAt) {
  const pts = [];
  for (const z of zones) {
    if (z.type !== 'civilian') continue;
    const n = 1400;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, r = Math.pow(Math.random(), 0.7) * z.radius * 0.8;
      const x = z.pos[0] + Math.cos(a) * r, zz = z.pos[2] + Math.sin(a) * r;
      const h = heightAt(x, zz); if (h < 3) continue;
      pts.push(x, h + 4, zz);
    }
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffc77a, size: 26, sizeAttenuation: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, map: null });
  const mesh = new THREE.Points(geo, mat); mesh.frustumCulled = false;
  return mesh;
}
