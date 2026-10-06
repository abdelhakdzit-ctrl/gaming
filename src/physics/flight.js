import * as THREE from 'three';
import { clamp, damp, smoothstep } from '../util/math.js';

// Hybrid SIMCADE flight model.
// The nose (quaternion) is steered by body rates; the velocity vector chases the nose at a rate that
// depends on airspeed and angle of attack (lift). Speed follows a thrust/drag/gravity energy equation,
// so climbing bleeds speed, diving gains it and hard turning costs energy (induced drag).
const G = 9.81;
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _e = new THREE.Euler(), _dq = new THREE.Quaternion(), _inv = new THREE.Quaternion();
const FWD = new THREE.Vector3(0, 0, -1), UP = new THREE.Vector3(0, 1, 0), RIGHT = new THREE.Vector3(1, 0, 0);

export class FlightModel {
  constructor(stats) {
    this.stats = stats;
    this.pos = new THREE.Vector3(); this.quat = new THREE.Quaternion(); this.vel = new THREE.Vector3();
    this.fwd = new THREE.Vector3(0, 0, -1); this.up = new THREE.Vector3(0, 1, 0); this.right = new THREE.Vector3(1, 0, 0);
    this.speed = 0; this.throttle = 0.6; this.ctrl = { pitch: 0, roll: 0, yaw: 0, brake: 0 };
    this.aoa = 0; this.g = 1; this.stalled = false; this.overspeed = false; this.stallFactor = 0;
    this.onGround = false; this.airborne = false; this.accel = new THREE.Vector3(); this.afterburner = false;
    this.heading = 0; this.pitchDeg = 0; this.bankDeg = 0; this.alt = 0; this.agl = 0; this.vspeed = 0; this.rates = { p: 0, r: 0, y: 0 };
    this.buffet = 0;
  }

  reset(pos, headingDeg, speed, onGround) {
    this.pos.copy(pos); this.speed = speed;
    this.quat.setFromEuler(_e.set(0, -headingDeg * Math.PI / 180, 0));
    this.vel.copy(FWD).applyQuaternion(this.quat).multiplyScalar(speed);
    this.onGround = !!onGround; this.airborne = !onGround; this.throttle = onGround ? 0 : 0.7; this.g = 1;
    this.syncAxes();
  }

  syncAxes() {
    this.fwd.copy(FWD).applyQuaternion(this.quat); this.up.copy(UP).applyQuaternion(this.quat); this.right.copy(RIGHT).applyQuaternion(this.quat);
    this.heading = (Math.atan2(this.fwd.x, -this.fwd.z) * 180 / Math.PI + 360) % 360;
    this.pitchDeg = Math.asin(clamp(this.fwd.y, -1, 1)) * 180 / Math.PI;
    this.bankDeg = Math.atan2(this.right.y, this.up.y) * 180 / Math.PI;
  }

  /**
   * input: {pitch, roll, yaw, throttleDelta, throttleSet, brake} (-1..1)
   * o: {mode, autoLevel, groundY, diff:{stallForgiveness, energyBleed, assistBonus}, autoTakeoff}
   */
  update(dt, input, o) {
    const s = this.stats, diff = o.diff || {}, mode = o.mode || 'NORMAL';
    // throttle
    if (input.throttleSet !== undefined) this.throttle = damp(this.throttle, input.throttleSet, 4, dt);
    else this.throttle = clamp(this.throttle + (input.throttleDelta || 0) * dt * 0.55, 0, 1);
    this.afterburner = this.throttle > 0.92;

    const speed = this.speed;
    const auth = clamp(speed / s.cornerSpeed, 0.18, 1) * (speed > s.maxSpeed * 1.03 ? 0.55 : 1);
    this.overspeed = speed > s.maxSpeed * 1.03;
    const assistBase = mode === 'ASSISTED' ? 1 : mode === 'NORMAL' ? 0.55 : 0;
    const assist = clamp(assistBase + (diff.assistBonus || 0), 0, 1);

    // stall + AoA state (from previous frame velocity)
    _inv.copy(this.quat).invert(); _v.copy(this.vel).applyQuaternion(_inv);
    this.aoa = speed > 8 ? Math.atan2(-_v.y, -_v.z) : 0;
    const stallSpeed = s.stallSpeed * (1 + (1 - (diff.stallForgiveness ?? 0.8)) * 0.15);
    this.stallFactor = this.onGround ? 0 : smoothstep(stallSpeed * 1.12, stallSpeed * 0.82, speed);
    const aoaLim = s.aoaMax * (mode === 'EXPERT' ? 1.1 : 1);
    this.stalled = this.stallFactor > 0.45 || Math.abs(this.aoa) > aoaLim * 1.25;
    this.buffet = Math.max(smoothstep(aoaLim * 0.8, aoaLim * 1.2, Math.abs(this.aoa)), this.stallFactor);

    // ----- commands
    let cp = input.pitch || 0, cr = input.roll || 0, cy = input.yaw || 0;
    if (o.locked) { cp = cr = cy = 0; }
    if (assist > 0 && !o.locked) {
      // pitch stabiliser: bring AoA back to trim when stick is neutral
      if (Math.abs(cp) < 0.05) cp += clamp(-(this.aoa - 0.05) * 2.4, -0.6, 0.6) * assist;
      // level wings when roll stick neutral; the direction is latched near inverted so it can't flip at the +/-180 wrap
      if (o.autoLevel !== false && Math.abs(cr) < 0.05) {
        const bank = Math.atan2(this.right.y, this.up.y);
        if (Math.abs(bank) > 2.7) { if (!this.alDir) this.alDir = bank >= 0 ? 1 : -1; } else if (Math.abs(bank) < 2.2) this.alDir = 0;
        const cmd = this.alDir ? this.alDir : Math.sign(bank);
        const mag = this.alDir ? 0.9 : clamp(Math.abs(bank) * (0.6 + assist * 1.2), 0, 1);
        cr += cmd * mag * assist;
      }
      // gentle return to the horizon when the stick is neutral and the nose is steep
      if (Math.abs(input.pitch || 0) < 0.05 && Math.abs(this.pitchDeg) > 12 && assist > 0.45) cp += clamp(-this.pitchDeg / 60, -0.5, 0.5) * (assist - 0.3) * (this.up.y > 0 ? 1 : 0);
      // hold the turn when banked and pulling nothing
      if (Math.abs(cp) < 0.05 && Math.abs(cr) > 0.05 && assist > 0.7) cp += Math.abs(this.right.y) * 0.3;
    }
    // AoA limiter (protects against departure; strength depends on mode/difficulty)
    const lim = clamp(assist * 1.15, 0, 1);
    if (cp > 0) cp *= 1 - lim * smoothstep(aoaLim * 0.7, aoaLim, this.aoa);
    else if (cp < 0) cp *= 1 - lim * smoothstep(aoaLim * 0.5, aoaLim * 0.8, -this.aoa);
    const k = 11;
    this.ctrl.pitch = damp(this.ctrl.pitch, clamp(cp, -1, 1), k, dt);
    this.ctrl.roll = damp(this.ctrl.roll, clamp(cr, -1, 1), k, dt);
    this.ctrl.yaw = damp(this.ctrl.yaw, clamp(cy, -1, 1), k, dt);
    this.ctrl.brake = damp(this.ctrl.brake, input.brake ? 1 : 0, 5, dt);

    // ----- body rates
    let pr = this.ctrl.pitch * s.pitchRate * auth * (this.ctrl.pitch < 0 ? 0.75 : 1) * (1 - this.stallFactor * 0.8);
    pr -= this.stallFactor * 0.85 * (mode === 'EXPERT' ? 1.2 : 0.8);               // nose drops in stall
    if (this.onGround) pr = speed < 70 ? 0 : pr * smoothstep(70, 90, speed);
    let rr = this.ctrl.roll * s.rollRate * (0.35 + 0.65 * auth) * (1 - this.stallFactor * 0.4);
    let yr = this.ctrl.yaw * s.yawRate * auth;
    if (this.onGround) { rr = 0; yr = this.ctrl.yaw * 0.25 * clamp(speed / 40, 0, 1); }
    this.rates.p = damp(this.rates.p, pr, 14, dt); this.rates.r = damp(this.rates.r, rr, 14, dt); this.rates.y = damp(this.rates.y, yr, 14, dt);
    _dq.setFromEuler(_e.set(this.rates.p * dt, -this.rates.y * dt, -this.rates.r * dt, 'YXZ'));
    this.quat.multiply(_dq).normalize();
    if (this.onGround) {
      _e.setFromQuaternion(this.quat, 'YXZ'); _e.z = 0; _e.x = Math.max(_e.x, 0); this.quat.setFromEuler(_e);
    }
    this.syncAxes();

    // ----- energy
    const dirY = speed > 1 ? this.vel.y / speed : 0;
    const thrust = s.thrust * (1 + 0.25 * smoothstep(0.85, 1, this.throttle));
    const vr = speed / s.maxSpeed;
    let acc = thrust * this.throttle * Math.max(0, 1 - vr * vr) - G * dirY - 0.9 * vr * vr * s.thrust * (1 - this.throttle * 0.5);
    acc -= this.ctrl.brake * (6 + speed * 0.045);
    acc -= (diff.energyBleed ?? 1) * 0.9 * Math.pow(Math.max(0, this.g - 1), 1.35);
    if (this.overspeed) acc -= (speed - s.maxSpeed * 1.03) * 0.8;
    this.speed = Math.max(this.onGround ? 0 : 22, speed + acc * dt);

    // ----- velocity follows the nose (lift)
    _w.copy(this.vel); if (_w.lengthSq() < 1) _w.copy(this.fwd);
    _w.normalize(); const prevDir = _v.copy(_w);
    const lift = 1.15 * s.liftAgility * Math.pow(clamp(this.speed / s.cornerSpeed, 0.15, 1.25), 1.2) * (1 - this.stallFactor * 0.7);
    _w.lerp(this.fwd, 1 - Math.exp(-lift * dt)).normalize();
    this.vel.copy(_w).multiplyScalar(this.speed);
    if (!this.onGround) this.vel.y -= G * this.stallFactor * dt * 1.6;
    const sp = this.vel.length(); if (sp > 1) this.speed = sp;
    // load factor: proper acceleration along body-up
    this.accel.copy(_w).sub(prevDir).multiplyScalar(this.speed / Math.max(dt, 1e-4));
    const gNew = clamp(this.accel.dot(this.up) / G + this.up.y, -5, 12);
    this.g = damp(this.g, gNew, 10, dt);

    // ----- integrate
    this.pos.addScaledVector(this.vel, dt);
    const gy = o.groundY ?? -1e9;
    this.alt = this.pos.y; this.agl = this.pos.y - gy;
    if (this.onGround || (o.autoTakeoff && this.agl < 2.4)) {
      if (this.agl <= 2.4 && this.speed < s.stallSpeed * 1.25 + 8 && this.vel.y <= 6) {
        this.onGround = true; this.pos.y = gy + 2.2; this.vel.y = Math.max(0, this.vel.y);
        this.agl = 2.2;
      } else this.onGround = false;
    }
    if (!this.onGround && this.agl > 8) this.airborne = true;
    this.vspeed = this.vel.y;
    this.syncAxes();
  }
}
