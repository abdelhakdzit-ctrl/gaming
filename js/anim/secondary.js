// Procedural "mocap feel" layer for the player: acceleration lean, banking, head/torso lag,
// breathing, idle weight shift, clavicle follow-through and weapon sway, all spring driven.
import { DEG, Spring, clamp, lerp, sstep } from '../math.js';
import { noise1 } from './curves.js';

const mk = (hz, z) => new Spring(hz, z);
const S = {
  leanF: mk(2.4, 0.45), roll: mk(2.2, 0.5), yawLag: mk(3.0, 0.6), headYaw: mk(4.5, 0.5), headPitch: mk(3.8, 0.4),
  shrug: mk(4.0, 0.3), clavL: mk(4.5, 0.35), clavR: mk(4.5, 0.35), swayX: mk(3.0, 0.4), swayY: mk(3.0, 0.4),
  shiftX: mk(0.9, 1.0), shiftR: mk(0.9, 1.0), stopKick: mk(3.0, 0.3),
};
let pv = [0, 0], pyaw = 0, ax = 0, az = 0, yr = 0, shiftT = 2, wasMoving = false, tt = 0;

// Output, read by character.js. Angles in degrees, offsets in cm.
export const SEC = { dx: 0, dy: 0, roll: 0, lean: 0, yaw: 0, spineYaw: 0, headYaw: 0, headPitch: 0, breath: 0,
  clavL: 0, clavR: 0, swayYaw: 0, swayRoll: 0, swayX: 0, swayY: 0 };

// c: { vel:[x,z] local cm/s, speed, yaw (charYaw rad), phase 0..1, aimW, crouchW, nw, rate }
export function stepSecondary(dt, c) {
  if (!(dt > 1e-5)) return SEC;
  dt = Math.min(dt, 0.05); tt += dt;
  const k = 1 - Math.exp(-16 * dt);
  ax += ((c.vel[0] - pv[0]) / dt - ax) * k; az += ((c.vel[1] - pv[1]) / dt - az) * k;
  pv[0] = c.vel[0]; pv[1] = c.vel[1];
  let dyaw = c.yaw - pyaw; dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw)); pyaw = c.yaw;
  yr += (dyaw / dt - yr) * (1 - Math.exp(-14 * dt));

  const moving = c.speed > 20, wMove = sstep(10, 140, c.speed), wRun = sstep(170, 340, c.speed);
  const calm = 1 - 0.55 * c.aimW;                // ADS keeps the weapon steadier
  const turnF = sstep(0, 60, c.speed) * 0.7 + 0.3;

  // Lean into acceleration, rock back on braking (spring overshoot = settle).
  S.leanF.target = clamp(az * 0.0065, -7, 7) * calm;
  // Bank into lateral accel and turns (+X is left, roll about +Z leans right, hence the minus).
  S.roll.target = (-clamp(ax * 0.0045, -5, 5) - clamp(yr * 1.3, -6, 6) * sstep(20, 200, c.speed)) * calm;
  S.yawLag.target = -clamp(yr * 2.2, -9, 9) * turnF;          // pelvis lags the turn, torso/head lead it
  S.headYaw.target = clamp(yr * 3.2, -12, 12) * turnF;
  S.headPitch.target = -S.leanF.x * 0.55 + clamp(az * 0.002, -2, 2);   // head stays level against the lean

  // Stop kick: abrupt deceleration drives a small shoulder/weapon rebound.
  const braking = Math.max(0, -Math.sign(c.vel[1] || 1) * az * (Math.abs(c.vel[1]) > 5 ? 1 : 0));
  if (wasMoving && !moving) S.stopKick.v += 22;
  wasMoving = moving;
  S.stopKick.target = 0;
  S.shrug.target = clamp(braking * 0.003, 0, 2) + Math.cos(c.phase * 12.566) * 0.9 * wMove * (0.6 + 0.8 * wRun);
  const bob = Math.cos(c.phase * 12.566) * wMove;
  S.clavL.target = Math.sin(c.phase * 6.283) * 1.8 * wMove;   // arm-swing counter motion, lagged = follow-through
  S.clavR.target = -S.clavL.target;
  S.swayX.target = clamp(-ax * 0.0009 - yr * 0.35, -1.6, 1.6) * c.nw;
  S.swayY.target = clamp(-az * 0.0006, -1.2, 1.2) * c.nw + bob * 0.25 * wRun;

  // Idle weight shift: slowly drifts between targets, only when standing still.
  const idle = (1 - wMove) * c.nw * (1 - 0.7 * c.crouchW);
  shiftT -= dt;
  if (shiftT <= 0) { shiftT = 3 + Math.random() * 3.5; S.shiftX.target = (Math.random() - 0.5) * 2.6; S.shiftR.target = -S.shiftX.target * 0.8; }
  for (const s of Object.values(S)) s.step(dt);

  const br = Math.sin(tt * 1.7) * 0.6 + noise1(tt * 0.9) * 0.4;   // breathing + irregular noise
  SEC.breath = br * lerp(1, 1.6, wMove) * (1 - 0.5 * c.aimW);
  SEC.dx = S.shiftX.x * idle;
  SEC.dy = -Math.abs(S.leanF.x) * 0.12;
  SEC.roll = S.roll.x + S.shiftR.x * idle;
  SEC.lean = S.leanF.x;
  SEC.yaw = S.yawLag.x * (1 - 0.6 * c.aimW);
  SEC.spineYaw = -SEC.yaw * 0.5;
  SEC.headYaw = S.headYaw.x * (1 - c.aimW);
  SEC.headPitch = S.headPitch.x * (1 - c.aimW) + SEC.breath * 0.25;
  SEC.clavL = S.clavL.x + S.shrug.x + S.stopKick.x * 0.5;
  SEC.clavR = S.clavR.x + S.shrug.x + S.stopKick.x * 0.5;
  SEC.swayYaw = S.swayX.x; SEC.swayRoll = -S.swayX.x * 0.8 + S.stopKick.x * 0.1; SEC.swayX = S.swayX.x * 0.5; SEC.swayY = S.swayY.x + S.stopKick.x * 0.04;
  return SEC;
}
