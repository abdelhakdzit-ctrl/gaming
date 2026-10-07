import * as THREE from 'three';
import { BillboardBatch } from '../world/billboards.js';

// Pooled particle system: fixed arrays, two batches (additive fire/glow, normal smoke).
const N = 3500;
export class Particles {
  constructor(scene) {
    this.add = new BillboardBatch(2200, { additive: true });
    this.smoke = new BillboardBatch(2600, { additive: false });
    scene.add(this.add.mesh, this.smoke.mesh);
    this.p = new Float32Array(N * 3); this.v = new Float32Array(N * 3);
    this.life = new Float32Array(N); this.max = new Float32Array(N);
    this.s0 = new Float32Array(N); this.s1 = new Float32Array(N);
    this.c0 = new Float32Array(N * 4); this.c1 = new Float32Array(N * 4);
    this.drag = new Float32Array(N); this.grav = new Float32Array(N); this.additive = new Uint8Array(N);
    this.rot = new Float32Array(N);
    this.cursor = 0;
  }
  emit(o) {
    // o: pos, vel, life, size0, size1, c0:[r,g,b,a], c1, drag, grav, additive
    let i = this.cursor; this.cursor = (this.cursor + 1) % N;
    const p = o.pos, v = o.vel || ZERO;
    this.p[i * 3] = p.x; this.p[i * 3 + 1] = p.y; this.p[i * 3 + 2] = p.z;
    this.v[i * 3] = v.x; this.v[i * 3 + 1] = v.y; this.v[i * 3 + 2] = v.z;
    this.life[i] = this.max[i] = o.life; this.s0[i] = o.size0; this.s1[i] = o.size1 ?? o.size0;
    const c0 = o.c0, c1 = o.c1 || [c0[0], c0[1], c0[2], 0];
    for (let k = 0; k < 4; k++) { this.c0[i * 4 + k] = c0[k]; this.c1[i * 4 + k] = c1[k]; }
    this.drag[i] = o.drag ?? 0; this.grav[i] = o.grav ?? 0; this.additive[i] = o.additive ? 1 : 0;
    this.rot[i] = Math.random() * 6.28;
  }
  update(dt) {
    this.add.begin(); this.smoke.begin();
    for (let i = 0; i < N; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;
      const k = i * 3, d = Math.exp(-this.drag[i] * dt);
      this.v[k] *= d; this.v[k + 1] = this.v[k + 1] * d - this.grav[i] * dt; this.v[k + 2] *= d;
      this.p[k] += this.v[k] * dt; this.p[k + 1] += this.v[k + 1] * dt; this.p[k + 2] += this.v[k + 2] * dt;
      const t = 1 - this.life[i] / this.max[i], c = i * 4;
      const size = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      const a = this.c0[c + 3] + (this.c1[c + 3] - this.c0[c + 3]) * t;
      const r = this.c0[c] + (this.c1[c] - this.c0[c]) * t, g = this.c0[c + 1] + (this.c1[c + 1] - this.c0[c + 1]) * t, b = this.c0[c + 2] + (this.c1[c + 2] - this.c0[c + 2]) * t;
      (this.additive[i] ? this.add : this.smoke).push(this.p[k], this.p[k + 1], this.p[k + 2], size, r, g, b, a, this.rot[i] + t);
    }
    this.add.end(); this.smoke.end();
  }
  setFog(color, density) { this.add.setFog(new THREE.Color(0, 0, 0), density * 0.6); this.smoke.setFog(color, density); }

  // ---- effect recipes ----
  explosion(pos, scale = 1) {
    for (let i = 0; i < 26 * scale; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.4, Math.random() - 0.5).normalize().multiplyScalar((20 + Math.random() * 70) * scale);
      this.emit({ pos, vel: v, life: 0.5 + Math.random() * 0.7, size0: 14 * scale, size1: 40 * scale, c0: [1, 0.75, 0.3, 1], c1: [0.9, 0.2, 0.05, 0], drag: 2.2, additive: true });
    }
    for (let i = 0; i < 18 * scale; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).normalize().multiplyScalar((10 + Math.random() * 35) * scale);
      this.emit({ pos, vel: v, life: 2.5 + Math.random() * 2, size0: 18 * scale, size1: 70 * scale, c0: [0.18, 0.17, 0.16, 0.8], c1: [0.1, 0.1, 0.1, 0], drag: 0.9, grav: -4, additive: false });
    }
    this.emit({ pos, life: 0.35, size0: 60 * scale, size1: 160 * scale, c0: [1, 0.9, 0.7, 1], c1: [1, 0.6, 0.2, 0], additive: true });
  }
  smokePuff(pos, vel, size = 5, life = 3, alpha = 0.5) {
    this.emit({ pos, vel, life, size0: size, size1: size * 3.2, c0: [0.75, 0.75, 0.75, alpha], c1: [0.55, 0.55, 0.55, 0], drag: 0.8, additive: false });
  }
  fire(pos, vel, size = 4, life = 0.4) {
    this.emit({ pos, vel, life, size0: size, size1: size * 0.3, c0: [1, 0.7, 0.25, 0.9], c1: [1, 0.25, 0.05, 0], drag: 1, additive: true });
  }
  spark(pos, vel, life = 0.4) {
    this.emit({ pos, vel, life, size0: 1.4, size1: 0.2, c0: [1, 0.9, 0.6, 1], c1: [1, 0.4, 0.1, 0], drag: 0.4, grav: 9, additive: true });
  }
  flareGlow(pos, size, intensity) {
    this.emit({ pos, life: 0.06, size0: size, size1: size, c0: [1, 0.85, 0.55, intensity], c1: [1, 0.7, 0.3, intensity], additive: true });
  }
}
const ZERO = { x: 0, y: 0, z: 0 };
