import * as THREE from 'three';
import { clamp, damp, lerp, rand } from '../util/math.js';

export const CAMERA_IDS = ['chase', 'cockpit', 'close', 'missile', 'wing', 'tactical', 'cinematic', 'free'];
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _up = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0), _v0 = new THREE.Vector3(), _off = new THREE.Vector3();

/** Camera director: eight modes, smooth blends between them, shake and scripted overrides. */
export class CameraRig {
  constructor(camera) {
    this.camera = camera; this.mode = 'chase'; this.blend = 1; this.rq = new THREE.Quaternion(); this.trauma = 0;
    this.pos = new THREE.Vector3(); this.quat = new THREE.Quaternion(); this.fov = 62; this.override = null; this.free = { yaw: 0.6, pitch: 0.2, r: 45 };
    this.cine = { t: 99, kind: 0, pt: new THREE.Vector3(), ang: 0 }; this.kick = 0; this.settings = { shake: true, reducedMotion: false };
    this.init = false; this.time = 0; this.off = new THREE.Vector3(); this.lastMode = null;
  }
  setMode(id) { if (id !== this.mode) { this.mode = id; this.blend = 0; this.cine.t = 99; } }
  addTrauma(v) { this.trauma = Math.min(1, this.trauma + v); }
  impulse(v) { this.kick = Math.max(this.kick, v); }
  snap() { this.blend = 1; this.init = false; }

  update(dt, c) {
    // c: {p (entity), f (flight), missile, contacts, look:{dx,dy}, buffet}
    const { p, f } = c; this.time += dt; this.blend = Math.min(1, this.blend + dt / 0.9);
    const lam = lerp(3.2, 60, this.blend * this.blend);
    this.rq.slerp(p.quat, 1 - Math.exp(-5.5 * dt));
    let tp = _a, look = _b, up = _up.copy(UP), fovT = 62, lamP = Math.min(lam, 14), lamR = lam;
    const P = p.pos, mode = this.override ? 'override' : this.mode;
    switch (mode) {
      case 'chase': { const d = 24 + f.speed * 0.025 + this.kick * 6; tp.set(0, 5.2 - clamp(f.g, -2, 6) * 0.1, d).applyQuaternion(this.rq).add(P); look.set(0, 1.4, -90).applyQuaternion(this.rq).add(P); up.lerp(_q.copy(this.rq) && new THREE.Vector3(0, 1, 0).applyQuaternion(this.rq), 0.3); fovT = 62 + clamp(f.speed - 200, 0, 250) * 0.045 + (f.afterburner ? 3 : 0); break; }
      case 'close': { tp.set(0, 3.2, 14 + this.kick * 3).applyQuaternion(this.rq).add(P); look.set(0, 1.2, -70).applyQuaternion(this.rq).add(P); up.lerp(new THREE.Vector3(0, 1, 0).applyQuaternion(this.rq), 0.45); fovT = 66; break; }
      case 'cockpit': { tp.set(0, 1.12 - clamp(f.g - 1, -2, 6) * 0.012, -3.1).applyQuaternion(p.quat).add(P); look.set(0, 1.12, -60).applyQuaternion(p.quat).add(P).addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(p.quat), (c.look?.x || 0) * 25); up.set(0, 1, 0).applyQuaternion(p.quat); fovT = 78 + clamp(f.speed - 200, 0, 250) * 0.02; lamP = 80; lamR = 40; break; }
      case 'wing': { tp.set(15, 1.6, 3).applyQuaternion(p.quat).add(P); look.set(0, 0.4, -3).applyQuaternion(p.quat).add(P); up.set(0, 1, 0).applyQuaternion(p.quat); fovT = 58; lamP = 40; lamR = 20; break; }
      case 'missile': {
        const m = c.missile;
        if (m && m.alive) { _q.copy(m.mesh.quaternion); tp.set(1.6, 2.4, 14).applyQuaternion(_q).add(m.pos); look.copy(m.pos).addScaledVector(m.dir, 120); up.set(0, 1, 0); fovT = 58; lamP = 25; lamR = 14; this.lastMissilePos = m.pos.clone(); }
        else if (this.lastMissilePos && this.blend < 1.5 && this.mode === 'missile' && (this.holdUntil || 0) > this.time) { tp.copy(this.lastMissilePos).add(new THREE.Vector3(30, 18, 40)); look.copy(this.lastMissilePos); lamP = 4; lamR = 6; }
        else { tp.set(0, 5.2, 24).applyQuaternion(this.rq).add(P); look.set(0, 1.4, -90).applyQuaternion(this.rq).add(P); }
        if (m && m.alive) this.holdUntil = this.time + 1.8;
        break; }
      case 'tactical': {
        const far = Math.max(2500, ...(c.contacts || []).filter((k) => k.visible).map((k) => Math.min(k.range, 22000) * 1.25));
        tp.set(P.x, P.y + clamp(far, 2500, 24000), P.z + 0.01 * far); look.copy(P);
        up.set(0, 0, -1).set(Math.sin(f.heading * Math.PI / 180), 0, -Math.cos(f.heading * Math.PI / 180)); fovT = 55; lamP = 4; lamR = 4; break; }
      case 'free': {
        const fr = this.free; fr.yaw -= (c.look?.dx || 0) * 0.004; fr.pitch = clamp(fr.pitch + (c.look?.dy || 0) * 0.003, -1.2, 1.4); fr.yaw += dt * 0.06;
        tp.set(Math.sin(fr.yaw) * Math.cos(fr.pitch), Math.sin(fr.pitch), Math.cos(fr.yaw) * Math.cos(fr.pitch)).multiplyScalar(fr.r).add(P); look.copy(P); fovT = 55; lamP = 7; lamR = 9; break; }
      case 'cinematic': {
        const ci = this.cine; ci.t += dt;
        if (ci.t > 6.5 || ci.t < 0 ) { ci.t = 0; ci.kind = (ci.kind + 1) % 4; ci.ang = rand(0, 6.28); ci.pt.copy(P).addScaledVector(p.vel, 3.2).add(new THREE.Vector3(Math.cos(ci.ang) * 180, rand(-10, 40), Math.sin(ci.ang) * 180)); }
        switch (ci.kind) {
          case 0: tp.copy(ci.pt); look.copy(P); fovT = 36; lamP = 30; lamR = 12; break;
          case 1: tp.set(rand(-0.1, 0.1) + 6, -0.5, 16).applyQuaternion(p.quat).add(P); look.set(0, 0, -30).applyQuaternion(p.quat).add(P); up.set(0, 1, 0).applyQuaternion(p.quat); fovT = 70; lamP = 12; lamR = 8; break;
          case 2: { const a = ci.ang + ci.t * 0.35; tp.set(Math.cos(a) * 70, 14, Math.sin(a) * 70).add(P); look.copy(P); fovT = 48; lamP = 6; lamR = 8; break; }
          default: tp.set(-4, 2, -10).applyQuaternion(p.quat).add(P); look.set(0, 0, 40).applyQuaternion(p.quat).add(P); up.set(0, 1, 0).applyQuaternion(p.quat); fovT = 78; lamP = 14; lamR = 10; break;
        }
        break; }
      case 'override': { const o = this.override; tp.copy(o.pos); look.copy(o.look); fovT = o.fov || 50; lamP = o.snap ? 90 : 8; lamR = o.snap ? 90 : 8; if (o.up) up.copy(o.up); break; }
    }
    // pose
    // smooth the offset from a moving reference so speed and frame-time jitter cannot make the view stutter
    const ref = mode === 'override' ? _v0.set(0, 0, 0) : mode === 'missile' ? look : P;
    _off.copy(tp).sub(ref);
    if (!this.init || this.lastMode !== mode) { this.off.copy(_off); this.init = true; this.lastMode = mode; }
    else { this.off.x = damp(this.off.x, _off.x, lamP, dt); this.off.y = damp(this.off.y, _off.y, lamP, dt); this.off.z = damp(this.off.z, _off.z, lamP, dt); }
    this.pos.copy(ref).add(this.off);
    _m.lookAt(this.pos, look, up); _q.setFromRotationMatrix(_m);
    if (this.quat.lengthSq() < 0.5 || this.blend === 0 && !this._q0) { this.quat.copy(_q); this._q0 = true; }
    this.quat.slerp(_q, 1 - Math.exp(-lamR * dt));
    this.fov = damp(this.fov, fovT + this.kick * 4, 4, dt);
    this.kick = Math.max(0, this.kick - dt * 3);
    // shake
    this.trauma = Math.max(0, this.trauma - dt * 1.5);
    const amb = Math.max(0, (c.buffet || 0)) * 0.1 + (f.speed > f.stats.maxSpeed * 1.02 ? 0.04 : 0);
    const sh = this.settings.shake && !this.settings.reducedMotion ? Math.min(1, this.trauma * this.trauma + amb) : 0;
    this.camera.position.copy(this.pos);
    this.camera.quaternion.copy(this.quat);
    if (sh > 0) {
      const t = this.time * 38;
      this.camera.position.x += Math.sin(t * 1.7) * sh * 0.5; this.camera.position.y += Math.sin(t * 2.3 + 1) * sh * 0.5;
      this.camera.rotateZ(Math.sin(t * 1.3) * sh * 0.012); this.camera.rotateX(Math.sin(t * 1.9) * sh * 0.01);
    }
    if (Math.abs(this.camera.fov - this.fov) > 0.01) { this.camera.fov = this.fov; this.camera.updateProjectionMatrix(); }
  }
}
