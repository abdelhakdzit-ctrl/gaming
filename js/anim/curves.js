// Curve helpers for blending: critically-damped follower (C1 in & out) and smootherstep.
export const smoother = t => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * t * (t * (t * 6 - 15) + 10); };

// Critically damped approach of s.x to target (s = {x, v}); no overshoot, zero velocity pop on retarget.
export function damp(s, target, omega, dt) {
  const x = omega * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const d = s.x - target, tmp = (s.v + omega * d) * dt;
  s.v = (s.v - omega * tmp) * e;
  s.x = target + (d + tmp) * e;
  return s.x;
}
// Same, clamped to [0,1] so the result can drive blend weights safely.
export function dampW(s, target, omega, dt) {
  damp(s, target, omega, dt);
  if (s.x < 0) { s.x = 0; s.v = 0; } else if (s.x > 1) { s.x = 1; s.v = 0; }
  return s.x;
}
// Cheap smooth noise in [-1,1] from incommensurate sines (breathing / micro-sway).
export const noise1 = t => 0.5 * (Math.sin(t * 1.0) + 0.6 * Math.sin(t * 2.31 + 1.3) + 0.4 * Math.sin(t * 5.17 + 4.1)) / 1.0 * 0.7;
