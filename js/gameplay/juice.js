// Shared "game feel" state: trauma shake, hit-stop, critically damped smoothing, weapon bloom.
import { clamp } from '../math.js';

export const feel = { trauma: 0, stopT: 0, stopScale: 1, fovKick: 0, bloom: 0, ads: 0, move: 0 };

// Critically damped scalar spring (SmoothDamp): no overshoot, frame-rate independent.
export class Damp {
  constructor(x = 0) { this.x = x; this.v = 0; }
  step(target, smoothTime, dt) {
    const w = 2 / Math.max(1e-4, smoothTime), a = w * dt, e = 1 / (1 + a + 0.48 * a * a + 0.235 * a * a * a);
    const d = this.x - target, tmp = (this.v + w * d) * dt;
    this.v = (this.v - w * tmp) * e;
    this.x = target + (d + tmp) * e;
    return this.x;
  }
  snap(x) { this.x = x; this.v = 0; }
}

// Smooth 1D value noise in [-1, 1].
const hash = n => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; };
export function noise1(t, seed = 0) {
  const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f);
  return hash(i + seed * 57.3) * (1 - u) + hash(i + 1 + seed * 57.3) * u;
}

export function addTrauma(a) { feel.trauma = Math.min(1, feel.trauma + a); }
export function hitStop(dur, scale = 0.1) { if (dur >= feel.stopT) { feel.stopT = dur; feel.stopScale = scale; } }
// Multiplier for the simulation step: <1 only during a brief hit-stop.
export function timeScaleFor(real) {
  if (feel.stopT <= 0) return 1;
  feel.stopT -= real;
  return feel.stopT > 0 ? feel.stopScale : 1;
}

export const shake = { yaw: 0, pitch: 0, roll: 0 };
export function stepShake(real, t) {
  feel.trauma = Math.max(0, feel.trauma - real * 1.35);
  const s = feel.trauma * feel.trauma, k = 0.022;
  shake.yaw = s * k * noise1(t * 22, 1);
  shake.pitch = s * k * noise1(t * 22, 2);
  shake.roll = s * k * 1.4 * noise1(t * 18, 3);
  return shake;
}

export function bloomKick(a) { feel.bloom = Math.min(1, feel.bloom + a); }
export function stepBloom(real, ads, moveSpeed) {
  feel.bloom = Math.max(0, feel.bloom - real * (0.9 + 0.5 * ads));   // recovers faster when braced
  feel.ads = ads; feel.move = clamp(moveSpeed / 400, 0, 1);
}
// Multiplier applied to a weapon's base spread: bloom and movement widen it, aiming tightens it.
export function spreadMul() {
  return (1 + feel.bloom * 1.6 + feel.move * 0.9) * (1 - 0.45 * feel.ads);
}
