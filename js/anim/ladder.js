import * as THREE from 'three';
import { DEG, V, clamp, sstep } from '../math.js';
import { damp, smoother } from './curves.js';
import { bones, handFrame, restWorldPos, rotateWorld, setWorldQuat, twoBoneIK, worldPos, worldQuat } from '../skeleton.js';
import { W, chainOf, gunState, lerpM, restLocalQ, setGunMatrix } from '../weapons.js';

// ======================================================================
//  LADDER RIG  hand-over-hand / foot-over-foot rung climbing on top of the authored climb clips.
//  Every limb follows the body height Pe through a repeating rung schedule (one rung per cycle, limbs staggered
//  by a quarter cycle: L hand -> R foot -> R hand -> L foot). A planted limb sits exactly on its rung; a travelling
//  limb follows a smoothed arc that pulls back off the ladder and forward again onto the next rung.
// ======================================================================
const Y = V(0, 1, 0);
const RUNG_R = 1.45, HAND_X = 15, FOOT_X = 11, WIN = 0.22, HMIN = 34;
const TILT = 18 * DEG;
const FWD_H = V(0, Math.cos(TILT), Math.sin(TILT));    // wrist -> knuckles, fingers up and toward the rung
const PALM_H = V(0, -Math.sin(TILT), Math.cos(TILT));  // palm faces the rung
const FOOT_FWD = V(0, -0.55, 0.835);                   // ankle -> ball: ball of the foot on the rung, heel dropped
const PALM_OFF = 3.1;                                  // palm-centre distance from the rung axis
const ARM_POLE = V(1, -0.75, -0.3), LEG_POLE = V(1, -0.05, 0.12);
const CURL = {
  index: [58, 72, 42], middle: [64, 78, 46], ring: [68, 80, 48], pinky: [72, 82, 50],
};
const LIMBS = [
  { n: 'hl', kind: 'hand', s: 'l', ph: 0 }, { n: 'rf', kind: 'foot', s: 'r', ph: 1 },
  { n: 'rh', kind: 'hand', s: 'r', ph: 2 }, { n: 'lf', kind: 'foot', s: 'l', ph: 3 },
];
const sideSign = s => (s === 'l' ? 1 : -1);   // character left is +X on the ladder

export const RIG = {
  e: { x: 0, v: 0 }, wi: { x: 0, v: 0 }, grip: { l: { x: 1, v: 0 }, r: { x: 1, v: 0 } },
  t: 0, zoff: null, init: false, mount: null, exit: null, sling: 0,
  info: {},
};
export function ladderRigReset() {
  RIG.e.x = RIG.e.v = 0; RIG.wi.x = RIG.wi.v = 0; RIG.grip.l.x = RIG.grip.r.x = 1; RIG.t = 0;
}

function setup(L) {
  if (RIG.init) return;
  const R = L.rungStep, Y0 = L.rung0 - HMIN, ballH = restWorldPos.ball_l?.y ?? 3;
  RIG.footDy = RUNG_R + ballH - 0.3;
  for (const lm of LIMBS) {
    lm.y0 = Y0 + lm.ph * 0.25 * R;
    const rel = L.rung0 - lm.y0 + (lm.kind === 'foot' ? RIG.footDy : 0);
    const lo = lm.kind === 'foot' ? -90 : 24;
    lm.k = Math.ceil((lo - rel) / R);
  }
  RIG.init = true;
}

export function climbWeight(state, u) {
  switch (state) {
    case 'up_start': return sstep(0.12, 0.38, u);
    case 'up_loop': case 'down_loop': return 1;
    case 'up_end': return 1 - sstep(0.08, 0.32, u);
    case 'down_start': return sstep(0.7, 0.95, u);
    case 'down_end': return 1 - sstep(0.04, 0.22, u);
    default: return 0;
  }
}

function limbState(L, lm, Pe) {
  const R = L.rungStep, x = (Pe - lm.y0) / R, n = Math.floor(x), f = x - n, t = clamp(f / WIN, 0, 1);
  const idx = clamp(n + smoother(t) + lm.k, 0, L.rungs.length - 1);
  return { ry: L.rung0 + idx * R, t, arc: Math.sin(Math.PI * t), hold: f >= WIN };
}

const basis = (f, p) => {
  const e1 = f.clone().normalize(), e2 = p.clone().addScaledVector(e1, -p.dot(e1)).normalize();
  return new THREE.Matrix4().makeBasis(e1, e2, new THREE.Vector3().crossVectors(e1, e2));
};
const _rq = new THREE.Quaternion();

function curlFingers(s, gw) {
  if (gw < 0.001) return;
  const axis = handFrame(s).curl;
  for (const f of ['index', 'middle', 'ring', 'pinky', 'thumb']) {
    const ch = chainOf(f, s), clip = ch.map(b => b.quaternion.clone());
    ch.forEach((b, i) => b.quaternion.copy(restLocalQ[b.name]));
    ch[0].updateMatrixWorld(true);
    if (f === 'thumb') {
      const acr = handFrame(s).acr.clone().multiplyScalar(s === 'l' ? 1 : -1);
      [18, 28, 20].forEach((a, i) => rotateWorld(ch[i], acr, a * DEG));
    } else CURL[f].forEach((a, i) => rotateWorld(ch[i], axis, a * DEG));
    ch.forEach((b, i) => { const cq = b.quaternion.clone(); b.quaternion.slerpQuaternions(clip[i], cq, gw); });
    ch[0].updateMatrixWorld(true);
  }
}

// Weighted rung IK for the four limbs. All limb targets are given in ladder space and converted into character space.
export function solveRig(ctx) {
  const { L, anchorPos, anchorYaw, wClimb, paused, dt } = ctx;
  setup(L);
  const c2l = p => p.clone().applyAxisAngle(Y, anchorYaw).add(anchorPos);
  const l2c = p => p.clone().sub(anchorPos).applyAxisAngle(Y, -anchorYaw);
  const l2cd = d => d.clone().applyAxisAngle(Y, -anchorYaw);
  RIG.t += dt;
  const R = L.rungStep, Pp = c2l(worldPos(bones.pelvis)).y;

  // Idle: let every limb finish its step so all four are planted, then keep the settled phase.
  const phi = (((Pp - (L.rung0 - HMIN)) / R) % 1 + 1) % 1, c0 = (WIN + 0.25) / 2;
  const m = Math.round((phi - c0) / 0.25), eT = (c0 + 0.25 * m - phi) * R;
  damp(RIG.e, paused ? eT : 0, 7, dt);
  damp(RIG.wi, paused ? 1 : 0, 5, dt); RIG.wi.x = clamp(RIG.wi.x, 0, 1);
  const Pe = Pp + RIG.e.x;

  const info = {};
  for (const lm of LIMBS) {
    const st = limbState(L, lm, Pe), sg = sideSign(lm.s), w = wClimb;
    info[lm.n] = st;
    if (w < 0.001) continue;
    if (lm.kind === 'hand') {
      const up = bones['upperarm_' + lm.s], lo = bones['lowerarm_' + lm.s], hand = bones['hand_' + lm.s], mid = bones['middle_01_' + lm.s];
      const len = worldPos(mid).distanceTo(worldPos(hand)), hq = worldQuat(hand), hp = worldPos(hand);
      const rungC = V(sg * (HAND_X + 2.2 * st.arc), st.ry, L.rungZ - 9 * st.arc);
      const palmC = rungC.clone().addScaledVector(PALM_H, -(RUNG_R + PALM_OFF));
      const wrist = palmC.addScaledVector(FWD_H, -0.5 * len);
      wrist.x = clamp(wrist.x, sg > 0 ? 6 : -(L.railX - 2.1 - 4.8), sg > 0 ? L.railX - 2.1 - 4.8 : -6);
      const tgt = hp.clone().lerp(l2c(wrist), w);
      twoBoneIK(up, lo, hand, tgt, l2cd(ARM_POLE.clone().multiply(V(sg, 1, 1))));
      setWorldQuat(hand, hq);
      const fr = handFrame(lm.s), Mc = basis(fr.fwd, fr.palm), Md = basis(l2cd(FWD_H), l2cd(PALM_H));
      _rq.setFromRotationMatrix(Md.multiply(Mc.transpose()));
      setWorldQuat(hand, new THREE.Quaternion().slerpQuaternions(hq, _rq.multiply(hq), w));
      const g = RIG.grip[lm.s]; damp(g, st.hold ? 1 : 0.55, 18, dt); g.x = clamp(g.x, 0, 1);
      curlFingers(lm.s, g.x * w);
    } else {
      const thigh = bones['thigh_' + lm.s], calf = bones['calf_' + lm.s], foot = bones['foot_' + lm.s], ball = bones['ball_' + lm.s];
      const fq = worldQuat(foot), fp = worldPos(foot), len = worldPos(ball).distanceTo(fp);
      const bt = V(sg * FOOT_X, st.ry + RIG.footDy, L.rungZ - 0.6 - 7 * st.arc);
      const fwd = FOOT_FWD.clone(); fwd.x = sg * -0.12; fwd.normalize();
      const ankle = bt.clone().addScaledVector(fwd, -len);
      const tgt = fp.clone().lerp(l2c(ankle), w);
      twoBoneIK(thigh, calf, foot, tgt, l2cd(LEG_POLE.clone().multiply(V(sg, 1, 1))));
      const cur = worldPos(ball).sub(worldPos(foot)).normalize();
      const want = l2cd(fwd);
      _rq.setFromUnitVectors(cur, want).multiply(fq);
      setWorldQuat(foot, new THREE.Quaternion().slerpQuaternions(fq, _rq, w));
    }
  }
  RIG.info = info;
}

// Small living motion while holding still: breathing, weight shift, glance around. Applied before IK so the grips stay put.
export function idleMicro(anchorPos) {
  const wi = RIG.wi.x; if (wi < 0.002) return;
  const t = RIG.t;
  anchorPos.x += wi * 1.3 * Math.sin(t * 0.55);
  anchorPos.y += wi * 0.25 * Math.sin(t * 1.5);
  const br = Math.sin(t * 1.6) * 0.8 * DEG * wi;
  rotateWorld(bones.spine_03, V(1, 0, 0), br);
  rotateWorld(bones.spine_02, V(0, 0, 1), wi * 1.6 * DEG * Math.sin(t * 0.55 + 1));
  const look = Math.sin(t * 0.45) * 0.6 + Math.sin(t * 0.17 + 2) * 0.4;
  rotateWorld(bones.head, Y, wi * 16 * DEG * look);
  rotateWorld(bones.head, V(1, 0, 0), wi * 5 * DEG * Math.sin(t * 0.31 + 0.5));
}

// ---------- pose snapshots / blends ----------
export function snapshotPose() {
  const q = {};
  for (const k in bones) q[k] = bones[k].quaternion.clone();
  bones.pelvis.updateWorldMatrix(true, false);
  return { q, pelW: worldPos(bones.pelvis), pelQ: worldQuat(bones.pelvis) };
}
// w = weight of the snapshot (1 = old pose, 0 = current pose). Pelvis is blended in world space so a root teleport can't pop.
export function blendToSnapshot(snap, w, charPos, yaw) {
  if (w < 0.001) return;
  for (const k in snap.q) if (k !== 'pelvis') bones[k].quaternion.slerp(snap.q[k], w);
  const toChar = p => p.clone().sub(charPos).applyAxisAngle(Y, -yaw);
  const pel = bones.pelvis;
  pel.position.lerp(pel.parent.worldToLocal(toChar(snap.pelW)), w);
  const yq = new THREE.Quaternion().setFromAxisAngle(Y, yaw).invert();
  pel.quaternion.copy(worldQuat(pel.parent).invert().multiply(worldQuat(pel)));
  const target = worldQuat(pel.parent).invert().multiply(yq.multiply(snap.pelQ));
  pel.quaternion.slerp(target, w);
  pel.updateMatrixWorld(true);
}

// ---------- weapon sling ----------
const _slingOff = new THREE.Matrix4().makeTranslation(-15, 5, -9)
  .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.28, Math.PI * 0.5, 1.05, 'XYZ')));
export function backMatrix() {
  bones.spine_02.updateWorldMatrix(true, false);
  return new THREE.Matrix4().multiplyMatrices(bones.spine_02.matrixWorld, _slingOff);
}
export function handMatrix(cur) {
  bones.hand_r.updateWorldMatrix(true, false);
  return new THREE.Matrix4().multiplyMatrices(bones.hand_r.matrixWorld, cur.inHand);
}
// Draw arc: the gun travels between hand and back along a lifted curve instead of teleporting. s: 0 = hand, 1 = back.
export function slingBlend(hand, back, s) {
  const m = lerpM(hand, back, s), lift = Math.sin(Math.PI * s) * 14;
  m.elements[13] += lift;
  return m;
}
export function applyGun(cur, m) {
  setGunMatrix(m);
  cur.obj.matrixAutoUpdate = false;
  cur.obj.matrix.copy(gunState.mat);
  cur.obj.matrixWorldNeedsUpdate = true;
}

// ---------- ladder camera clipping (deck / columns) ----------
const _o = V(), _d = V();
function rayAABB(o, d, mn, mx, tmax) {
  let t0 = 0, t1 = tmax;
  for (const k of ['x', 'y', 'z']) {
    if (Math.abs(d[k]) < 1e-9) { if (o[k] < mn[k] || o[k] > mx[k]) return -1; continue; }
    let a = (mn[k] - o[k]) / d[k], b = (mx[k] - o[k]) / d[k];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return -1;
  }
  return t0;
}
// Pull the camera towards the head until it is clear of the deck and its support columns.
export function ladderCamClip(L, head, cam) {
  _o.copy(L.toLocal(head)); _d.copy(L.toLocal(cam)).sub(_o);
  const len = _d.length(); if (len < 1e-3) return cam;
  _d.divideScalar(len);
  const top = L.topY, boxes = [[V(-105, top - 8, 34), V(105, top, 200)]];
  for (const sx of [-1, 1]) for (const sz of [40, 192]) boxes.push([V(sx * 96 - 4, 0, sz - 4), V(sx * 96 + 4, top, sz + 4)]);
  let best = len;
  for (const [a, b] of boxes) {
    const mn = a.clone().addScalar(-14), mx = b.clone().addScalar(14);
    const t = rayAABB(_o, _d, mn, mx, len); if (t >= 0) best = Math.min(best, t);
  }
  if (best >= len) return cam;
  return head.clone().lerp(cam, Math.max(30, best) / len);
}
