import * as THREE from 'three';

export const V = (x, y, z) => new THREE.Vector3(x, y, z);
export const DEG = Math.PI / 180;
// ======================================================================
//  RECOIL — impulse springs + driven follower springs (secondary motion)
// ======================================================================
export class Spring {
  constructor(hz, zeta) { this.w = 2 * Math.PI * hz; this.z = zeta; this.x = 0; this.v = 0; this.target = 0; }
  step(dt) {
    const n = Math.max(1, Math.ceil(dt / 0.001)), h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (-this.w * this.w * (this.x - this.target) - 2 * this.z * this.w * this.v) * h;
      this.x += this.v * h;
    }
  }
  kick(peak) { // initial velocity that produces the requested first peak
    const s = Math.sqrt(1 - this.z * this.z);
    this.v += peak * this.w * Math.exp(this.z * Math.atan(s / this.z) / s);
  }
}
export const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const lerp = (a, b, t) => a + (b - a) * t;
export const ease = w => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, w)));
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const angWrap = a => Math.atan2(Math.sin(a), Math.cos(a));
export const rnd = (a, b) => a + Math.random() * (b - a);
export const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.41;
export const cvWorld = (cv, lx, lz) => V(cv.c.x + lx * cv.cos + lz * cv.sin, 0, cv.c.z - lx * cv.sin + lz * cv.cos);
export function rayBox(o, d, cv, tmax) {
  const c = cv.cos, s = cv.sin, ox = o.x - cv.c.x, oz = o.z - cv.c.z;
  const lo = [ox * c - oz * s, o.y, ox * s + oz * c], ld = [d.x * c - d.z * s, d.y, d.x * s + d.z * c];
  const mn = [-cv.hx, 0, -cv.hz], mx = [cv.hx, cv.h, cv.hz];
  let t0 = 0, t1 = tmax, ax = -1, sg = 0;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(ld[k]) < 1e-9) { if (lo[k] < mn[k] || lo[k] > mx[k]) return null; continue; }
    let ta = (mn[k] - lo[k]) / ld[k], tb = (mx[k] - lo[k]) / ld[k], sgn = -1;
    if (ta > tb) { const q = ta; ta = tb; tb = q; sgn = 1; }
    if (ta > t0) { t0 = ta; ax = k; sg = sgn; }
    if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }
  if (ax < 0) return { t: 0, n: d.clone().negate() };
  const ln = [0, 0, 0]; ln[ax] = sg;
  return { t: t0, n: V(ln[0] * c + ln[2] * s, ln[1], -ln[0] * s + ln[2] * c) };
}
export function insideBox2(x, z, cv, pad) {
  const ox = x - cv.c.x, oz = z - cv.c.z;
  return Math.abs(ox * cv.cos - oz * cv.sin) < cv.hx + pad && Math.abs(ox * cv.sin + oz * cv.cos) < cv.hz + pad;
}
export function segBox2(ax, az, bx, bz, cv, pad) {   // entry fraction of segment a->b into the padded footprint, or -1
  const c = cv.cos, s = cv.sin, ox = ax - cv.c.x, oz = az - cv.c.z, dx = bx - ax, dz = bz - az;
  const lo = [ox * c - oz * s, ox * s + oz * c], ld = [dx * c - dz * s, dx * s + dz * c], hh = [cv.hx + pad, cv.hz + pad];
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 2; k++) {
    if (Math.abs(ld[k]) < 1e-9) { if (Math.abs(lo[k]) > hh[k]) return -1; continue; }
    let ta = (-hh[k] - lo[k]) / ld[k], tb = (hh[k] - lo[k]) / ld[k];
    if (ta > tb) { const q = ta; ta = tb; tb = q; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 > t1) return -1;
  }
  return t0;
}
export const _ca = V(), _cb = V(), _cc = V(), _cd = V();
export function rayCapsule(o, d, a, b, r) {   // entry distance along the ray, or -1
  const u = _ca.subVectors(b, a), w = _cb.subVectors(o, a);
  const B = d.dot(u), C = u.dot(u), D = d.dot(w), E = u.dot(w), den = C - B * B;
  const sP = clamp(den > 1e-6 ? (E - B * D) / den : 0, 0, 1);
  const px = _cc.copy(a).addScaledVector(u, sP), t = _cd.subVectors(px, o).dot(d);
  if (t < 0) return -1;
  const d2 = _cd.copy(o).addScaledVector(d, t).distanceToSquared(px);
  return d2 > r * r ? -1 : t - Math.sqrt(r * r - d2);
}
