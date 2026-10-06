import * as THREE from 'three';
import { buildFighter } from '../aircraft/model.js';
import { BillboardBatch } from './billboards.js';
import { damp, lerp } from '../util/math.js';

function tex(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); } return t;
}

/** Functional 3D hangar used as the live background of every menu screen. */
export class Hangar {
  constructor() {
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x05080b); this.scene.fog = new THREE.FogExp2(0x070c10, 0.012);
    this.camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.3, 400);
    this.time = 0; this.focus = 'menu'; this.angle = 0.6; this.look = new THREE.Vector3(0, 3, 0); this.camPos = new THREE.Vector3(18, 5, 26); this.crew = []; this.exposure = 1.05;
    this.build();
  }
  build() {
    const S = this.scene, concrete = tex(512, 512, (g, w, h) => { g.fillStyle = '#2a2f33'; g.fillRect(0, 0, w, h); for (let i = 0; i < 6000; i++) { const v = 30 + Math.random() * 40; g.fillStyle = `rgb(${v},${v + 3},${v + 6})`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); } g.strokeStyle = '#d6b73a'; g.lineWidth = 6; g.strokeRect(10, 10, w - 20, h - 20); }, [10, 14]);
    const floorMat = new THREE.MeshStandardMaterial({ map: concrete, roughness: 0.32, metalness: 0.5, transparent: true, opacity: 0.9 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(90, 130), floorMat); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; S.add(floor);
    const wallTex = tex(256, 256, (g, w, h) => { g.fillStyle = '#6d7570'; g.fillRect(0, 0, w, h); for (let x = 0; x < w; x += 16) { g.fillStyle = x % 32 ? '#5b625e' : '#7b837e'; g.fillRect(x, 0, 14, h); } }, [8, 2]);
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.8, metalness: 0.3 });
    for (const [w, h, x, y, z, ry] of [[130, 22, -42, 11, 0, Math.PI / 2], [130, 22, 42, 11, 0, -Math.PI / 2], [84, 22, 0, 11, -62, 0]]) { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat); m.position.set(x, y, z); m.rotation.y = ry; S.add(m); }
    // roof ribs + ceiling
    const ribMat = new THREE.MeshStandardMaterial({ color: 0x20262b, metalness: 0.7, roughness: 0.5 });
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(84, 130), new THREE.MeshStandardMaterial({ color: 0x0c1014, roughness: 1 })); ceil.rotation.x = Math.PI / 2; ceil.position.y = 22; S.add(ceil);
    const ribs = new THREE.InstancedMesh(new THREE.BoxGeometry(84, 0.9, 0.9), ribMat, 13); const m4 = new THREE.Matrix4();
    for (let i = 0; i < 13; i++) { m4.setPosition(0, 21.4, -60 + i * 10); ribs.setMatrixAt(i, m4); } S.add(ribs);
    // open hangar door at the back: sky + distant airfield lights
    const door = new THREE.Mesh(new THREE.PlaneGeometry(40, 17), new THREE.MeshBasicMaterial({ map: tex(256, 128, (g, w, h) => { const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#0a1530'); gr.addColorStop(0.6, '#3a2b4a'); gr.addColorStop(0.85, '#d9743a'); gr.addColorStop(1, '#1a1410'); g.fillStyle = gr; g.fillRect(0, 0, w, h); for (let i = 0; i < 60; i++) { g.fillStyle = 'rgba(255,255,255,.8)'; g.fillRect(Math.random() * w, Math.random() * h * 0.5, 1, 1); } for (let i = 0; i < 24; i++) { g.fillStyle = i % 3 ? '#ffd27a' : '#6fe0ff'; g.fillRect(10 + i * 10, h * 0.93, 2, 2); } }) }));
    door.position.set(0, 9, -61.8); S.add(door);
    // lights
    S.add(new THREE.HemisphereLight(0x8aa0b8, 0x101418, 0.55));
    this.spots = [];
    for (const [x, z, c, i] of [[-14, 18, 0xdfeaff, 5200], [16, 10, 0xffe9c8, 4200], [0, -22, 0xaaccff, 3200]]) {
      const s = new THREE.SpotLight(c, i, 80, 0.62, 0.55, 1.6); s.position.set(x, 20, z); s.target.position.set(0, 1, 0); s.castShadow = true; s.shadow.mapSize.set(1024, 1024); s.shadow.bias = -0.0004; S.add(s, s.target); this.spots.push(s);
    }
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xf4fbff }); const lamps = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.6, 1.9, 0.5, 14), lampMat, 12);
    for (let i = 0; i < 12; i++) { m4.setPosition(i % 2 ? 12 : -12, 20.8, -46 + Math.floor(i / 2) * 18); lamps.setMatrixAt(i, m4); } S.add(lamps);
    this.beacon = new THREE.PointLight(0xff3a20, 90, 40, 1.6); this.beacon.position.set(-36, 8, -40); S.add(this.beacon);
    // light shafts
    const shaftMat = new THREE.MeshBasicMaterial({ color: 0xbcd8ff, transparent: true, opacity: 0.055, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    for (const [x, z] of [[-14, 18], [16, 10], [0, -22]]) { const c = new THREE.Mesh(new THREE.ConeGeometry(7.5, 20, 24, 1, true), shaftMat); c.position.set(x * 0.7, 10.5, z * 0.7); c.rotation.z = -x * 0.01; S.add(c); }
    // aircraft on chocks + planar fake reflection
    this.ac = buildFighter(); this.ac.group.position.y = 2.3; this.ac.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; } }); this.ac.setControls({ throttle: 0.08 }, 0); S.add(this.ac.group);
    this.refl = this.ac.group.clone(true); this.refl.scale.y = -1; this.refl.position.y = -2.3; this.refl.traverse((o) => { if (o.isMesh && o.material && !o.material.transparent) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.28; } }); S.add(this.refl);
    const chockMat = new THREE.MeshStandardMaterial({ color: 0xd6b73a, roughness: 0.7 });
    for (const sx of [-1, 1]) for (const z of [-3, 4]) { const c = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 1.2), chockMat); c.position.set(sx * 2.6, 0.2, z); S.add(c); }
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(9, 9.4, 0.12, 40), new THREE.MeshStandardMaterial({ color: 0x1b2024, roughness: 0.5, metalness: 0.6 })); ped.position.y = 0.06; S.add(ped);
    const ring = new THREE.Mesh(new THREE.RingGeometry(8.7, 9.0, 64), new THREE.MeshBasicMaterial({ color: 0x5dffa8, transparent: true, opacity: 0.5, side: THREE.DoubleSide })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.14; S.add(ring);
    // props: tool carts, crates, fuel bowser, tow tractor (moves), crew silhouettes (walk)
    const dark = new THREE.MeshStandardMaterial({ color: 0x15191d, roughness: 0.8 }), orange = new THREE.MeshStandardMaterial({ color: 0xc8631d, roughness: 0.6 }), grey = new THREE.MeshStandardMaterial({ color: 0x59626a, roughness: 0.6, metalness: 0.4 });
    for (const [x, z, w, d] of [[-24, 10, 3, 2], [26, -6, 4, 2.4], [-28, -20, 5, 3], [24, 26, 3, 3], [-20, 34, 2.5, 2.5]]) { const b = new THREE.Mesh(new THREE.BoxGeometry(w, 1.6, d), grey); b.position.set(x, 0.8, z); b.castShadow = true; S.add(b); const t = new THREE.Mesh(new THREE.BoxGeometry(w * 0.8, 0.3, d * 0.8), orange); t.position.set(x, 1.75, z); S.add(t); }
    this.tractor = new THREE.Group(); const tb = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.3, 4), orange); tb.position.y = 1.0; const cab = new THREE.Mesh(new THREE.BoxGeometry(2, 1.2, 1.8), dark); cab.position.set(0, 2.1, 0.6); this.tractor.add(tb, cab);
    for (const sx of [-1, 1]) for (const z of [-1.3, 1.4]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.4, 12), dark); w.rotation.z = Math.PI / 2; w.position.set(sx * 1.25, 0.55, z); this.tractor.add(w); }
    const bcn = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffa020 })); bcn.position.set(0, 2.9, 0.6); this.tractor.add(bcn); S.add(this.tractor);
    const crewMat = new THREE.MeshStandardMaterial({ color: 0x0a0c0e, roughness: 1 });
    for (let i = 0; i < 5; i++) {
      const gp = new THREE.Group(); const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 1.0, 4, 8), crewMat); body.position.y = 1.0; const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), crewMat); head.position.y = 1.9; const vest = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.25, 8), new THREE.MeshStandardMaterial({ color: 0xd7b400, emissive: 0x3a3000 })); vest.position.y = 1.2; gp.add(body, head, vest); S.add(gp);
      this.crew.push({ g: gp, r: 14 + i * 3, a: i * 1.3, s: 0.08 + (i % 3) * 0.03, work: i % 2 === 0, cx: i % 2 ? -4 : 3 });
    }
    // dust motes
    this.dust = new BillboardBatch(360, { additive: true, fog: false }); S.add(this.dust.mesh); this.motes = Array.from({ length: 360 }, () => ({ x: (Math.random() - 0.5) * 50, y: Math.random() * 18, z: (Math.random() - 0.5) * 60, v: 0.1 + Math.random() * 0.25, p: Math.random() * 6 }));
    this.setFocus('menu', true);
  }
  setPaint(p) { this.ac.setPaint(p); this.refl.traverse((o) => { if (o.isMesh && o.material?.color && o.material.transparent && o.material.opacity < 0.5) { /* paints applied through shared materials on first clone only */ } }); this.rebuildReflection(p); }
  rebuildReflection(p) { this.scene.remove(this.refl); this.refl = this.ac.group.clone(true); this.refl.scale.y = -1; this.refl.position.y = -2.3; this.refl.traverse((o) => { if (o.isMesh && o.material && !o.material.transparent) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.28; } }); this.scene.add(this.refl); }
  setFocus(mode, snap) { this.focus = mode; if (snap) { this.snapNext = true; } }
  update(dt) {
    this.time += dt; const t = this.time;
    const fx = { menu: { r: 34, h: 6.5, spd: 0.05, look: [4, 3, 0], fov: 42 }, aircraft: { r: 24, h: 4.8, spd: 0.09, look: [0, 2.6, 0], fov: 40 }, map: { r: 60, h: 14, spd: 0.02, look: [0, 4, 0], fov: 48 }, loadout: { r: 26, h: 5, spd: 0.07, look: [-3, 2.8, 0], fov: 40 }, dim: { r: 40, h: 9, spd: 0.03, look: [0, 3, 0], fov: 44 } }[this.focus] || { r: 34, h: 6.5, spd: 0.05, look: [0, 3, 0], fov: 42 };
    this.angle += dt * fx.spd; const a = this.angle + (this.focus === 'menu' ? 0.7 : 0.2);
    const want = new THREE.Vector3(Math.sin(a) * fx.r, fx.h, Math.cos(a) * fx.r);
    if (this.snapNext) { this.camPos.copy(want); this.snapNext = false; } else this.camPos.lerp(want, 1 - Math.exp(-2.2 * dt));
    this.look.lerp(new THREE.Vector3(...fx.look), 1 - Math.exp(-3 * dt));
    this.camera.position.copy(this.camPos); this.camera.lookAt(this.look); this.camera.fov = damp(this.camera.fov, fx.fov, 3, dt); this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
    // animation: beacon, lamp flicker, tractor shuttle, crew walking/working, dust
    this.beacon.position.set(Math.cos(t * 3) * 38, 9, -52 + Math.sin(t * 3) * 6); this.beacon.intensity = 60 + 50 * Math.max(0, Math.sin(t * 3));
    this.spots[1].intensity = 4200 * (0.96 + 0.04 * Math.sin(t * 40) * (Math.sin(t * 0.7) > 0.97 ? 3 : 0.2));
    const tp = (t * 0.045) % 2, tx = tp < 1 ? lerp(-30, 30, tp) : lerp(30, -30, tp - 1); this.tractor.position.set(tx, 0, -38); this.tractor.rotation.y = tp < 1 ? Math.PI / 2 : -Math.PI / 2;
    for (const c of this.crew) { c.a += dt * c.s; c.g.position.set(c.work ? c.cx + Math.sin(c.a * 3) * 0.4 : Math.cos(c.a) * c.r, 0.05 * Math.abs(Math.sin(t * 6 + c.a)), c.work ? 8 + c.r * 0.6 : Math.sin(c.a) * c.r * 1.1 - 4); c.g.rotation.y = c.work ? Math.sin(t + c.a) : -c.a + Math.PI / 2; c.g.children[0].rotation.z = c.work ? Math.sin(t * 2 + c.a) * 0.15 : 0; }
    this.ac.setControls({ throttle: 0.06, roll: Math.sin(t * 0.5) * 0.2, pitch: Math.sin(t * 0.7) * 0.15 }, t);
    this.dust.begin(); for (const m of this.motes) { m.y -= m.v * dt; m.x += Math.sin(t * 0.2 + m.p) * 0.1 * dt; if (m.y < 0) m.y = 18; this.dust.push(m.x, m.y, m.z, 0.13, 0.8, 0.9, 1, 0.26 + 0.2 * Math.sin(t + m.p)); } this.dust.end();
    return this.exposure;
  }
}
