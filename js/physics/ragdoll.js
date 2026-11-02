import * as THREE from 'three';
import { insideBox2, rayBox } from '../math.js';

// ======================================================================
//  Lightweight position-based-dynamics ragdoll for the UE4 mannequin (cm, y up, world space).
//  16 particles on the main joints, distance constraints for bone lengths, two rigid torso blocks joined at
//  the spine particle with bend/twist range limits, hinge-only knees/elbows (direction + planarity), cone limits
//  for hips/shoulders/neck, capsule-capsule limb self-collision, ground + oriented cover boxes, Coulomb friction,
//  damping and sleeping. Bone rotations are rebuilt from particle frames, so the skinned mesh follows.
// ======================================================================
const PEL = 0, SPI = 1, NEK = 2, HED = 3, SHL = 4, SHR = 5, ELL = 6, ELR = 7, HNL = 8, HNR = 9, HPL = 10, HPR = 11, KNL = 12, KNR = 13, FTL = 14, FTR = 15, N = 16;
const SRC = ['pelvis', 'spine_02', 'neck_01', 'head', 'upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r', 'hand_l', 'hand_r', 'thigh_l', 'thigh_r', 'calf_l', 'calf_r', 'foot_l', 'foot_r'];
const RAD = [13, 15, 8, 11, 8, 8, 6, 6, 5, 5, 9, 9, 7, 7, 7, 7];
const MASS = [2.2, 2.2, 0.5, 1.3, 0.8, 0.8, 0.5, 0.5, 0.4, 0.4, 1.4, 1.4, 0.9, 0.9, 0.6, 0.6];
const EQ = [[PEL, SPI], [SPI, NEK], [NEK, HED], [NEK, SHL], [NEK, SHR], [SPI, SHL], [SPI, SHR], [SHL, SHR], [PEL, HPL], [PEL, HPR], [HPL, HPR], [SPI, HPL], [SPI, HPR],
  [SHL, ELL], [ELL, HNL], [SHR, ELR], [ELR, HNR], [HPL, KNL], [KNL, FTL], [HPR, KNR], [KNR, FTR]];
// [a, b, minFrac, maxFrac] of the rest distance
const RANGE = [[PEL, NEK, 0.8, 1.0], [HPL, SHL, 0, 1.12], [HPR, SHR, 0, 1.12], [SPI, HED, 0.72, 9]];
const HINGES = [[HPL, KNL, FTL, -1], [HPR, KNR, FTR, -1], [SHL, ELL, HNL, 1], [SHR, ELR, HNR, 1]];   // sign: which way the middle joint may point (-1 knee = forward)
const CAPS = [[ELL, HNL, 6, PEL, NEK, 15], [ELR, HNR, 6, PEL, NEK, 15], [HPL, KNL, 8, HPR, KNR, 8], [KNL, FTL, 7, KNR, FTR, 7], [HPL, KNL, 8, KNR, FTR, 7], [HPR, KNR, 8, KNL, FTL, 7],
  [ELL, HNL, 6, ELR, HNR, 6], [ELL, HNL, 6, HPL, KNL, 8], [ELL, HNL, 6, HPR, KNR, 8], [ELR, HNR, 6, HPL, KNL, 8], [ELR, HNR, 6, HPR, KNR, 8]];
// bone -> rotation frame slot(s) [slotA, slotB, t]; parents precede children
const BONES = [['pelvis', 0], ['spine_01', 0, 1, 0.3], ['spine_02', 0, 1, 0.65], ['spine_03', 1], ['clavicle_l', 1], ['upperarm_l', 7], ['lowerarm_l', 9], ['hand_l', 9],
  ['clavicle_r', 1], ['upperarm_r', 8], ['lowerarm_r', 10], ['hand_r', 10], ['neck_01', 1, 2, 0.5], ['head', 2],
  ['thigh_l', 3], ['calf_l', 5], ['foot_l', 5], ['thigh_r', 4], ['calf_r', 6], ['foot_r', 6]];

export const RAGDOLL = { gravity: -1000, step: 1 / 120, iters: 12, maxSteps: 3, blend: 0.1, muscle: 0.4, mu: 0.55, damp: 0.9985, sleepSpeed: 7, sleepTime: 0.7, maxSpeed: 2600 };

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3(), _f = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _t = new THREE.Vector3(), _s = new THREE.Vector3();
const _ray = new THREE.Vector3();
const COS_HIP = Math.cos(80 * Math.PI / 180);

// orthonormal frame from an 'up' axis and a lateral hint (Gram-Schmidt); identical convention for rest and live poses
function frameQ(up, side, out) {
  const Y = _a.copy(up).normalize(), Z = _b.crossVectors(side, Y);
  if (Z.lengthSq() < 1e-8) Z.set(Math.abs(Y.x) < 0.9 ? 1 : 0, Math.abs(Y.x) < 0.9 ? 0 : 1, 0).cross(Y);
  Z.normalize(); const X = _c.crossVectors(Y, Z);
  return out.setFromRotationMatrix(_m.makeBasis(X, Y, Z));
}
function worldQ(o, out) { o.matrixWorld.decompose(_t, out, _s); return out; }

export class Ragdoll {
  constructor(B, covers = () => []) {
    this.B = B; this.covers = covers; this.on = false; this.sleeping = false;
    this.P = Array.from({ length: N }, (_, i) => ({ p: new THREE.Vector3(), q: new THREE.Vector3(), v: new THREE.Vector3(), r: RAD[i], w: 1 / MASS[i], pb: 0, contact: 0, off: new THREE.Vector3() }));
    this.prevJ = Array.from({ length: N }, () => new THREE.Vector3()); this.curJ = Array.from({ length: N }, () => new THREE.Vector3()); this.jdt = 1 / 60; this.tracked = 0;
    this.hv = HINGES.map(() => new THREE.Vector3(1, 0, 0));
    this.frames = Array.from({ length: 11 }, () => new THREE.Quaternion()); this.refInv = Array.from({ length: 11 }, () => new THREE.Quaternion());
    this.rel = BONES.map(() => [new THREE.Quaternion(), new THREE.Quaternion()]);
    this.frozen = BONES.map(() => new THREE.Quaternion()); this.frozenPelvis = new THREE.Vector3();
    this.eq = []; this.rng = []; this.hl = []; this.near = []; this.acc = 0; this.t = 0; this.restT = 0; this.fwdSign = 1; this.maxLenErr = 0;
  }
  // sample joint world positions every animated frame (gives the pose velocity at the moment of death)
  track(dt) {
    const P = this.prevJ; this.prevJ = this.curJ; this.curJ = P;
    for (let i = 0; i < N; i++) { const e = this.B[SRC[i]].matrixWorld.elements; this.curJ[i].set(e[12], e[13], e[14]); }
    this.jdt = Math.max(dt, 1e-3); this.tracked = Math.min(2, this.tracked + 1);
  }
  start({ vel = null, scale = 0.85 } = {}) {
    const B = this.B, P = this.P;
    for (let i = 0; i < N; i++) {
      const e = B[SRC[i]].matrixWorld.elements, p = P[i];
      p.p.set(e[12], e[13], e[14]); p.q.copy(p.p); p.v.set(0, 0, 0); p.contact = 0; p.pb = 0;
      if (this.tracked >= 2) p.v.copy(this.curJ[i]).sub(this.prevJ[i]).multiplyScalar(scale / this.jdt);
      if (vel) p.v.add(vel);
      if (p.v.length() > 700) p.v.setLength(700);
    }
    for (let i = 0; i < N; i++) P[i].off.copy(P[i].p).sub(P[PEL].p);
    BONES.forEach(([n], i) => { this.frozen[i].copy(B[n].quaternion); });
    this.frozenPelvis.copy(B.pelvis.position);
    // facing sign: the side x up convention must agree with the actual foot direction (ball bone)
    this.fwdSign = 1;
    if (B.ball_l) { const e = B.ball_l.matrixWorld.elements; _d.set(e[12], e[13], e[14]).sub(P[FTL].p); _d.y = 0; this.fwdSign = _d.dot(this._fwd(_e)) < 0 ? -1 : 1; }
    this.eq = EQ.map(([a, b]) => [a, b, P[a].p.distanceTo(P[b].p)]);
    this.rng = RANGE.map(([a, b, lo, hi]) => { const d = P[a].p.distanceTo(P[b].p); return [a, b, d * lo, d * hi]; });
    this.hl = HINGES.map(([a, b, c], i) => {
      const l1 = P[a].p.distanceTo(P[b].p), l2 = P[b].p.distanceTo(P[c].p), flex = (i < 2 ? 140 : 145) * Math.PI / 180, inner = Math.PI - flex;
      this.rng.push([a, c, Math.sqrt(l1 * l1 + l2 * l2 - 2 * l1 * l2 * Math.cos(inner)), (l1 + l2) * 1.001]);
      return [l1, l2];
    });
    // hinge axes from the death pose (bent joints) or the body-frame default (straight joints)
    HINGES.forEach(([a, b, c, sg], i) => {
      const u = _a.copy(P[b].p).sub(P[a].p), w = _b.copy(P[c].p).sub(P[b].p), h = this.hv[i];
      h.crossVectors(u, w);
      if (h.length() < 0.2 * u.length() * w.length()) this._defaultHinge(i, h);
      h.normalize();
    });
    this._computeFrames(this.frames);
    for (let i = 0; i < 11; i++) this.refInv[i].copy(this.frames[i]).invert();
    BONES.forEach(([n, a, b], i) => {
      worldQ(B[n], _q);
      this.rel[i][0].copy(this.refInv[a]).multiply(_q);
      if (b !== undefined) this.rel[i][1].copy(this.refInv[b]).multiply(_q);
    });
    this.on = true; this.sleeping = false; this.t = 0; this.acc = 0; this.restT = 0;
  }
  _fwd(out) {
    const P = this.P, side = _a.copy(P[HPL].p).sub(P[HPR].p), up = _b.copy(P[SPI].p).sub(P[PEL].p);
    return out.crossVectors(side, up).normalize().multiplyScalar(this.fwdSign || 1);
  }
  _defaultHinge(i, h) {
    const P = this.P, [a, b, , sg] = HINGES[i], u = _d.copy(P[b].p).sub(P[a].p).normalize(), f = this._fwd(_e);
    h.crossVectors(u, f.multiplyScalar(sg));
    if (h.lengthSq() < 0.04) h.crossVectors(u, _f.copy(P[HPL].p).sub(P[HPR].p));
    return h;
  }
  _computeFrames(F) {
    const P = this.P, hv = this.hv, p = i => P[i].p;
    const sideL = _d.copy(p(HPL)).sub(p(HPR)), sideU = _e.copy(p(SHL)).sub(p(SHR));
    frameQ(_f.copy(p(SPI)).sub(p(PEL)), sideL, F[0]);
    frameQ(_f.copy(p(NEK)).sub(p(SPI)), sideU, F[1]);
    frameQ(_f.copy(p(HED)).sub(p(NEK)), sideU, F[2]);
    frameQ(_f.copy(p(KNL)).sub(p(HPL)), hv[0], F[3]); frameQ(_f.copy(p(KNR)).sub(p(HPR)), hv[1], F[4]);
    frameQ(_f.copy(p(FTL)).sub(p(KNL)), hv[0], F[5]); frameQ(_f.copy(p(FTR)).sub(p(KNR)), hv[1], F[6]);
    frameQ(_f.copy(p(ELL)).sub(p(SHL)), hv[2], F[7]); frameQ(_f.copy(p(ELR)).sub(p(SHR)), hv[3], F[8]);
    frameQ(_f.copy(p(HNL)).sub(p(ELL)), hv[2], F[9]); frameQ(_f.copy(p(HNR)).sub(p(ELR)), hv[3], F[10]);
  }
  // impulses (cm/s) -------------------------------------------------
  impulse(point, dir, strength, headSnap = 0) {
    for (let i = 0; i < N; i++) {
      const d = this.P[i].p.distanceTo(point), w = 1 / (1 + (d / 20) * (d / 20));
      this.P[i].v.addScaledVector(dir, strength * w / (0.6 + 0.4 * MASS[i]));
    }
    if (headSnap) { this.P[HED].v.addScaledVector(dir, headSnap).y += headSnap * 0.25; this.P[NEK].v.addScaledVector(dir, headSnap * 0.4); }
    this.sleeping = false; this.restT = 0;
  }
  blast(point, power) {
    for (let i = 0; i < N; i++) {
      const p = this.P[i], d = _a.copy(p.p).sub(point); const dist = d.length(); d.y += 45; d.normalize();
      p.v.addScaledVector(d, (700 + 1100 * power) / (1 + dist / 220));
    }
    this.sleeping = false; this.restT = 0;
  }
  // simulation ------------------------------------------------------
  step(dt) {
    if (!this.on || this.sleeping) return;
    this.acc = Math.min(this.acc + dt, RAGDOLL.step * RAGDOLL.maxSteps);
    while (this.acc >= RAGDOLL.step) { this.acc -= RAGDOLL.step; this._sub(RAGDOLL.step); this.t += RAGDOLL.step; }
  }
  _sub(h) {
    const P = this.P, R = RAGDOLL, covers = this.covers();
    const pel = P[PEL].p, near = this.near; near.length = 0;
    for (const cv of covers) if (Math.abs(cv.c.x - pel.x) < cv.hx + cv.hz + 220 && Math.abs(cv.c.z - pel.z) < cv.hx + cv.hz + 220) near.push(cv);
    const mk = this.t < R.muscle ? 0.1 * Math.pow(1 - this.t / R.muscle, 2) : 0;
    for (let i = 0; i < N; i++) {
      const o = P[i]; o.contact = 0; o.pb = 0;
      o.v.y += R.gravity * h; o.v.multiplyScalar(R.damp);
      if (o.v.length() > R.maxSpeed) o.v.setLength(R.maxSpeed);
      if (o.p.y + o.v.y * h < o.r && o.v.y < -220) o.pb = -o.v.y;
      o.q.copy(o.p); o.p.addScaledVector(o.v, h);
      if (near.length && o.v.lengthSq() * h * h > 25) this._sweep(o, near);
    }
    for (let it = 0; it < R.iters; it++) {
      if (mk > 0) for (let i = 1; i < N; i++) { const o = P[i]; o.p.x += (pel.x + o.off.x - o.p.x) * mk; o.p.y += (pel.y + o.off.y - o.p.y) * mk; o.p.z += (pel.z + o.off.z - o.p.z) * mk; }
      if (it === 0) this._updateHinges(h);
      this._solveDist();
      for (const [a, b, lo, hi] of this.rng) this._range(a, b, lo, hi);
      this._hinges(); this._cones();
      for (const c of CAPS) this._capsule(c);
      for (let i = 0; i < N; i++) this._env(P[i], near);
    }
    this._solveDist(); this._solveDist();
    for (let i = 0; i < N; i++) { const o = P[i]; if (o.p.y < o.r) { o.p.y = o.r; o.contact = 1; } }
    // velocities, Coulomb friction on contacts, small bounce, sleep test
    let maxV = 0;
    for (let i = 0; i < N; i++) {
      const o = P[i]; o.v.copy(o.p).sub(o.q).multiplyScalar(1 / h);
      if (o.contact) {
        const s = Math.hypot(o.v.x, o.v.z), ns = Math.max(0, s - R.mu * -R.gravity * h * (o.contact > 1 ? 1.5 : 1));
        if (s > 1e-4) { o.v.x *= ns / s; o.v.z *= ns / s; }
        if (o.pb > 0) o.v.y = Math.max(o.v.y, o.pb * 0.12);
      }
      maxV = Math.max(maxV, o.v.length());
    }
    if (this.t > 0.5 && maxV < R.sleepSpeed) { if ((this.restT += h) > R.sleepTime) { this.sleeping = true; for (const o of P) o.v.set(0, 0, 0); } } else this.restT = 0;
  }
  _sweep(o, near) {   // fast particles: rayBox along the step so thin walls cannot be tunnelled
    const len = _ray.copy(o.p).sub(o.q).length(); if (len < 1e-3) return;
    _ray.multiplyScalar(1 / len);
    for (const cv of near) {
      const hit = rayBox(o.q, _ray, cv, len + o.r);
      if (hit && hit.t > 1e-3) {
        o.p.copy(o.q).addScaledVector(_ray, Math.max(0, hit.t - 0.5)).addScaledVector(hit.n, o.r + 0.5);
        const vn = o.v.dot(hit.n); if (vn < 0) o.v.addScaledVector(hit.n, -vn * 1.2); o.contact = 1; break;
      }
    }
  }
  _solveDist() {
    const P = this.P;
    for (const [a, b, rest] of this.eq) {
      const A = P[a], Bp = P[b], d = _a.copy(Bp.p).sub(A.p), l = d.length(); if (l < 1e-5) continue;
      const k = (l - rest) / l / (A.w + Bp.w);
      A.p.addScaledVector(d, k * A.w); Bp.p.addScaledVector(d, -k * Bp.w);
    }
  }
  _range(a, b, lo, hi) {
    const A = this.P[a], Bp = this.P[b], d = _a.copy(Bp.p).sub(A.p), l = d.length(); if (l < 1e-5) return;
    const t = l < lo ? lo : l > hi ? hi : l; if (t === l) return;
    const k = (l - t) / l / (A.w + Bp.w);
    A.p.addScaledVector(d, k * A.w); Bp.p.addScaledVector(d, -k * Bp.w);
  }
  _updateHinges(h) {
    const P = this.P;
    HINGES.forEach(([a, b, , sg], i) => {
      const hv = this.hv[i], u = (this._u ||= new THREE.Vector3()).copy(P[b].p).sub(P[a].p).normalize();
      this._defaultHinge(i, _b); _b.addScaledVector(u, -_b.dot(u));
      if (_b.lengthSq() > 1e-6) hv.lerp(_b.normalize(), Math.min(1, (i < 2 ? 5 : 1.2) * h));
      hv.addScaledVector(u, -hv.dot(u)); if (hv.lengthSq() < 1e-8) hv.crossVectors(u, _e.set(0, 1, 0)); hv.normalize();
    });
  }
  _hinges() {
    const P = this.P;
    HINGES.forEach(([a, b, c], i) => {
      const hv = this.hv[i], A = P[a].p, Bp = P[b].p, C = P[c].p;
      const w = _a.copy(C).sub(Bp), cd = w.dot(hv);
      C.addScaledVector(hv, -cd * 0.6); Bp.addScaledVector(hv, cd * 0.2);
      const u = _b.copy(Bp).sub(A); w.copy(C).sub(Bp);
      if (_c.crossVectors(u, w).dot(hv) < 0) {   // hyperextended: snap the middle joint back onto the straight line
        const [l1, l2] = this.hl[i];
        _d.copy(C).sub(A).multiplyScalar(l1 / (l1 + l2)).add(A);
        Bp.lerp(_d, 0.85);
      }
    });
  }
  _cone(parent, child, axis, cosMax, k = 0.9) {
    const P = this.P, v = _a.copy(P[child].p).sub(P[parent].p), l = v.length(); if (l < 1e-5) return;
    v.multiplyScalar(1 / l); const c = v.dot(axis); if (c >= cosMax) return;
    const perp = _b.copy(v).addScaledVector(axis, -c); const pl = perp.length();
    if (pl < 1e-5) perp.set(axis.y, -axis.x, 0); perp.normalize();
    const s = Math.sqrt(1 - cosMax * cosMax);
    _c.copy(axis).multiplyScalar(cosMax).addScaledVector(perp, s).multiplyScalar(l).add(P[parent].p);
    P[child].p.lerp(_c, k);
  }
  _cones() {
    const P = this.P, p = i => P[i].p;
    const upL = _d.copy(p(SPI)).sub(p(PEL)).normalize(), sideL = _e.copy(p(HPL)).sub(p(HPR)), fwdL = _f.crossVectors(sideL, upL).normalize().multiplyScalar(this.fwdSign);
    sideL.normalize();
    const hip = this._ax1 ||= new THREE.Vector3(), sh = this._ax2 ||= new THREE.Vector3();
    hip.copy(upL).multiplyScalar(-0.643).addScaledVector(fwdL, 0.766);   // 50 deg flexed rest axis
    this._cone(HPL, KNL, hip, COS_HIP); this._cone(HPR, KNR, hip, COS_HIP);
    const upU = _d.copy(p(NEK)).sub(p(SPI)).normalize(), sideU = _e.copy(p(SHL)).sub(p(SHR)).normalize();
    const fwdU = _f.crossVectors(sideU, upU).normalize().multiplyScalar(this.fwdSign);
    this._cone(NEK, HED, upU, Math.cos(0.96), 0.9);
    const cosS = Math.cos(2.4);
    sh.copy(sideU).multiplyScalar(0.5).addScaledVector(upU, -0.85).addScaledVector(fwdU, 0.15).normalize();
    this._cone(SHL, ELL, sh, cosS);
    sh.copy(sideU).multiplyScalar(-0.5).addScaledVector(upU, -0.85).addScaledVector(fwdU, 0.15).normalize();
    this._cone(SHR, ELR, sh, cosS);
  }
  _capsule([a0, a1, ra, b0, b1, rb]) {
    const P = this.P, p1 = P[a0].p, q1 = P[a1].p, p2 = P[b0].p, q2 = P[b1].p;
    const d1 = _a.copy(q1).sub(p1), d2 = _b.copy(q2).sub(p2), r = _c.copy(p1).sub(p2);
    const aa = d1.dot(d1), ee = d2.dot(d2), ff = d2.dot(r), cc = d1.dot(r), bb = d1.dot(d2), den = aa * ee - bb * bb;
    let s = den > 1e-6 ? Math.min(1, Math.max(0, (bb * ff - cc * ee) / den)) : 0, t = (bb * s + ff) / ee;
    if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -cc / aa)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (bb - cc) / aa)); }
    const c1 = _d.copy(p1).addScaledVector(d1, s), c2 = _e.copy(p2).addScaledVector(d2, t), n = _f.copy(c1).sub(c2), dist = n.length(), min = ra + rb;
    if (dist >= min) return;
    if (dist < 1e-4) n.set(0, 1, 0); else n.multiplyScalar(1 / dist);
    const pen = (min - dist) * 0.5;
    P[a0].p.addScaledVector(n, pen * (1 - s)); P[a1].p.addScaledVector(n, pen * s);
    P[b0].p.addScaledVector(n, -pen * (1 - t)); P[b1].p.addScaledVector(n, -pen * t);
  }
  _env(o, near) {
    const p = o.p, r = o.r;
    if (p.y < r) { p.y = r; o.contact = 1; }
    for (const cv of near) {
      if (p.y >= cv.h + r || !insideBox2(p.x, p.z, cv, r)) continue;
      const ox = p.x - cv.c.x, oz = p.z - cv.c.z, lx = ox * cv.cos - oz * cv.sin, lz = ox * cv.sin + oz * cv.cos;
      const ex = cv.hx + r - Math.abs(lx), ez = cv.hz + r - Math.abs(lz), ey = cv.h + r - p.y;
      o.contact = 2;
      if (ey <= ex && ey <= ez) { p.y = cv.h + r; continue; }
      let dx = 0, dz = 0;
      if (ex < ez) dx = Math.sign(lx || 1) * ex; else dz = Math.sign(lz || 1) * ez;
      p.x += dx * cv.cos - dz * cv.sin; p.z += dx * cv.sin + dz * cv.cos;
    }
  }
  // write the particle pose back onto the skeleton -----------------
  apply() {
    if (!this.on) return;
    const B = this.B, F = this.frames, blend = Math.min(1, this.t / RAGDOLL.blend), P = this.P;
    this._computeFrames(F);
    for (let i = 0; i < BONES.length; i++) {
      const [n, a, b, t] = BONES[i], bone = B[n];
      _q.copy(F[a]).multiply(this.rel[i][0]);
      if (b !== undefined) _q.slerp(_q2.copy(F[b]).multiply(this.rel[i][1]), t);
      worldQ(bone.parent, _pq);
      _q.premultiply(_pq.invert());
      bone.quaternion.copy(this.frozen[i]).slerp(_q, blend);
      if (i === 0) {
        const lp = bone.parent.worldToLocal(_t.copy(P[PEL].p));
        bone.position.copy(this.frozenPelvis).lerp(lp, blend);
      }
      bone.updateMatrixWorld(false);
    }
  }
  // verification helpers -------------------------------------------
  diagnostics() {
    const P = this.P; let lenErr = 0, minGap = 1e9, hyper = 0, minBoneY = 1e9;
    for (const [a, b, rest] of this.eq) lenErr = Math.max(lenErr, Math.abs(P[a].p.distanceTo(P[b].p) / rest - 1));
    for (let i = 0; i < N; i++) minGap = Math.min(minGap, P[i].p.y - P[i].r);
    HINGES.forEach(([a, b, c], i) => { const u = _a.copy(P[b].p).sub(P[a].p), w = _b.copy(P[c].p).sub(P[b].p); const s = _c.crossVectors(u, w).dot(this.hv[i]) / (u.length() * w.length()); if (s < -0.03) hyper++; });
    for (const n of SRC) minBoneY = Math.min(minBoneY, this.B[n].matrixWorld.elements[13]);
    const flex = HINGES.map(([a, b, c]) => { const u = _a.copy(P[b].p).sub(P[a].p).normalize(), w = _b.copy(P[c].p).sub(P[b].p).normalize(); return Math.round(Math.acos(Math.min(1, Math.max(-1, u.dot(w)))) * 180 / Math.PI); });
    return { lenErr, minGap, hyper, minBoneY, flex, sleeping: this.sleeping, t: this.t };
  }
}
