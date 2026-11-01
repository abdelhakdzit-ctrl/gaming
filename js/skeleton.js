import * as THREE from 'three';
import { DEG, V } from './math.js';
import { STATE } from './state.js';
import { charRoot } from './scene.js';
import { gunState, restLocalPos, restLocalQ, restLocalScale } from './weapons.js';

// ---------- bone helpers (all targets are in world space) ----------
export const bones = {};
export const restWorldQ = {}, restWorldPos = {};
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

export function worldPos(b) { b.updateWorldMatrix(true, false); return b.getWorldPosition(new THREE.Vector3()); }
export function worldQuat(b) { b.updateWorldMatrix(true, false); return b.getWorldQuaternion(new THREE.Quaternion()); }
export function setWorldQuat(b, q) {
  const parentQ = worldQuat(b.parent);
  b.quaternion.copy(parentQ.invert().multiply(q));
  b.updateMatrixWorld(true);
}
export function rotateWorld(b, axis, angle) {
  setWorldQuat(b, _q.setFromAxisAngle(axis.clone().normalize(), angle).multiply(worldQuat(b)));
}
// Orient a bone from rest so (child - bone) points along dir and refRest maps toward refTarget.
export function orient(b, child, dir, refRest, refTarget) {
  setWorldQuat(b, restWorldQ[b.name].clone());
  const cur = worldPos(child).sub(worldPos(b)).normalize();
  const m1 = basis(cur, refRest), m2 = basis(dir.clone().normalize(), refTarget);
  const rot = new THREE.Quaternion().setFromRotationMatrix(m2.multiply(m1.transpose()));
  setWorldQuat(b, rot.multiply(worldQuat(b)));
}
function basis(a, ref) {
  const x = a.clone().normalize();
  const z = new THREE.Vector3().crossVectors(x, ref).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Matrix4().makeBasis(x, y, z);
}
function aimAt(b, child, target) {
  const cur = worldPos(child).sub(worldPos(b)).normalize();
  const want = target.clone().sub(worldPos(b)).normalize();
  setWorldQuat(b, _q2.setFromUnitVectors(cur, want).multiply(worldQuat(b)));
}
export function twoBoneIK(root, mid, end, target, pole) {
  const a = worldPos(mid).distanceTo(worldPos(root));
  const c = worldPos(end).distanceTo(worldPos(mid));
  const R = worldPos(root);
  const toT = target.clone().sub(R);
  const d = Math.min(toT.length(), (a + c) * 0.999);
  const dir = toT.normalize();
  const cosA = (a * a + d * d - c * c) / (2 * a * d);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const perp = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
  const elbow = R.clone().add(dir.clone().multiplyScalar(a * cosA)).add(perp.multiplyScalar(a * sinA));
  aimAt(root, mid, elbow);
  aimAt(mid, end, R.clone().add(dir.multiplyScalar(d)));
}

// ======================================================================
//  HAND PLACEMENT relative to the pistol (gun-space targets)
// ======================================================================
// Right-hand grip in gun space: wrist→middle-knuckle direction, index→pinky axis,
// and where the middle knuckle sits on the grip.
const tilt = 20 * DEG;
export const GRIP_R = { fwd: V(-0.1, -Math.sin(tilt), Math.cos(tilt)), across: V(0, Math.cos(tilt), Math.sin(tilt)), socket: V(-2.8, -4.7, 3.0) };
export const handRel = {};
export function handFrame(s) {
  const fwd = worldPos(bones['middle_01_' + s]).sub(worldPos(bones['hand_' + s])).normalize();
  const acr = worldPos(bones['index_01_' + s]).sub(worldPos(bones['pinky_01_' + s])).normalize();
  const palm = s === 'r' ? new THREE.Vector3().crossVectors(acr, fwd) : new THREE.Vector3().crossVectors(fwd, acr);
  palm.normalize();
  return { fwd, acr, palm, curl: new THREE.Vector3().crossVectors(fwd, palm).normalize() };
}
function driveHandTo(s, rel) { handRel[s] = rel; driveHand(s); }
export function storeHandRel(s) {
  bones['hand_' + s].updateWorldMatrix(true, false);
  handRel[s] = gunState.inv.clone().multiply(bones['hand_' + s].matrixWorld);
}
export const _hp = new THREE.Vector3(), _hq = new THREE.Quaternion(), _hs = new THREE.Vector3();
// w < 1 blends the IK target back toward the animated hand (used while swapping weapons).
export function driveHand(s, w = 1) {
  new THREE.Matrix4().multiplyMatrices(gunState.mat, handRel[s]).decompose(_hp, _hq, _hs);
  const up = bones['upperarm_' + s], lo = bones['lowerarm_' + s], hand = bones['hand_' + s];
  if (w < 1) { _hp.lerpVectors(worldPos(hand), _hp, w); _hq.copy(worldQuat(hand).slerp(_hq, w)); }
  const pole = worldPos(lo).sub(worldPos(up));
  if (typeof STATE.NORMAL_W !== 'undefined' && STATE.NORMAL_W > 0.001) {
    const side = s === 'r' ? -1 : 1;
    pole.lerp(V(side * 10, -22, -10), 0.65 * STATE.NORMAL_W);
  }
  twoBoneIK(up, lo, hand, _hp, pole);
  setWorldQuat(hand, _hq);
}


export const report = {};
export const trigFinger = { rest: null, pulled: null };

// ======================================================================
//  RETARGET  UE5 Manny animation -> UE4 mannequin
//  Per bone: M(t) = A(t) * inv(A0) * C * M0, where C aligns the two rest poses'
//  bone directions, so differing rest poses / bone axes don't skew the motion.
// ======================================================================
export const NAME_MAP = { spine_02: 'spine_03', spine_03: 'spine_05' };
export const REF_CHILD = { pelvis: 'spine_01', spine_03: 'neck_01', hand_l: 'middle_01_l', hand_r: 'middle_01_r',
  upperarm_l: 'lowerarm_l', upperarm_r: 'lowerarm_r', thigh_l: 'calf_l', thigh_r: 'calf_r', foot_l: 'ball_l', foot_r: 'ball_r' };
// Stance layer on top of the clip: drop the hips and widen the stagger (cm, world).
// Hips sit 3 cm lower than the ADS clip; idle feet come from the A_AR_Aim_Fwd reference pose (see captureIdle).
export const STANCE = { drop: 7, foot: { l: V(), r: V() } };
export const rt = { list: [], ratio: 1, anim: null, mixer: null, dur: 1, abones: {} };
// Build a retarget source: per mannequin bone, the offset that maps the clip's world rotation onto it.
export function makeSource(man, anim, nameMap) {
  const ab = {}; anim.traverse(n => { if (n.isBone) ab[n.name] = n; });
  anim.updateMatrixWorld(true); man.updateMatrixWorld(true);
  const animName = n => nameMap[n] || n;
  const C = {}, list = [], byName = {};
  man.traverse(b => {
    // Twist bones follow their parent: UE4/UE5 place and drive them differently, and
    // copying UE5's twist rolls the mannequin's shoulder pads.
    if (!b.isBone || b.name === 'root' || b.name.startsWith('ik_') || b.name.includes('twist') || !ab[animName(b.name)]) return;
    const pref = REF_CHILD[b.name];
    const child = (pref && bones[pref]) || b.children.find(c => c.isBone && ab[animName(c.name)]);
    // Inherit the parent's alignment so roll stays consistent down the chain,
    // then add the minimal rotation that matches this bone's direction.
    let c = (C[b.parent.name] || new THREE.Quaternion()).clone();
    if (child && ab[animName(child.name)]) {
      const dm = worldPos(child).sub(worldPos(b)).normalize().applyQuaternion(c);
      const da = worldPos(ab[animName(child.name)]).sub(worldPos(ab[animName(b.name)])).normalize();
      c.premultiply(new THREE.Quaternion().setFromUnitVectors(dm, da));
    }
    C[b.name] = c;
    const A0 = worldQuat(ab[animName(b.name)]);
    const lower = ['pelvis', 'thigh', 'calf', 'foot', 'ball'].some(p => b.name.startsWith(p));
    const e = { m: b, a: ab[animName(b.name)], off: A0.invert().multiply(c).multiply(restWorldQ[b.name].clone()),
      upper: !lower && b.name !== 'head' && b.name !== 'neck_01', torso: !lower };
    list.push(e); byName[b.name] = e;
  });
  return { list, byName, abones: ab };
}
// Retarget offsets must be derived from the original mannequin rest pose, not from a
// weapon grip, a previous preview frame, or a gameplay pose. Snapshot/restore lets the
// user switch clips while the mannequin is already moving without corrupting the map.
export function makeSourceInRestPose(man, anim, nameMap = {}) {
  const rootState = { p: charRoot.position.clone(), q: charRoot.quaternion.clone(), s: charRoot.scale.clone() };
  const saved = Object.values(bones).map(b => ({ b, p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() }));
  try {
    charRoot.position.set(0, 0, 0); charRoot.quaternion.identity(); charRoot.scale.set(1, 1, 1);
    for (const item of saved) {
      const n = item.b.name;
      if (restLocalPos[n]) item.b.position.copy(restLocalPos[n]);
      if (restLocalQ[n]) item.b.quaternion.copy(restLocalQ[n]);
      if (restLocalScale[n]) item.b.scale.copy(restLocalScale[n]);
    }
    charRoot.updateMatrixWorld(true); man.updateMatrixWorld(true); anim.updateMatrixWorld(true);
    return makeSource(man, anim, nameMap);
  } finally {
    for (const item of saved) { item.b.position.copy(item.p); item.b.quaternion.copy(item.q); item.b.scale.copy(item.s); }
    charRoot.position.copy(rootState.p); charRoot.quaternion.copy(rootState.q); charRoot.scale.copy(rootState.s);
    charRoot.updateMatrixWorld(true);
  }
}
export function setupRetarget(man, anim) {
  Object.assign(rt, makeSource(man, anim, NAME_MAP));
  const ab = rt.abones;
  rt.ratio = worldPos(bones.pelvis).y / worldPos(ab.pelvis).y;
  rt.mPelvis0 = worldPos(bones.pelvis); rt.aPelvis0 = worldPos(ab.pelvis);
  rt.mFoot0 = { l: worldPos(bones.foot_l), r: worldPos(bones.foot_r) };
  rt.aFoot0 = { l: worldPos(ab.foot_l), r: worldPos(ab.foot_r) };
  STATE.ANKLE_H = rt.mFoot0.l.y; STATE.HIP_HALF = Math.abs(rt.mFoot0.l.x);
  if (bones.ball_l) STATE.BALL_LEN = Math.max(6, Math.abs(worldPos(bones.ball_l).z - worldPos(bones.foot_l).z));
  STATE.LEG_MAX = 0.985 * (worldPos(bones.thigh_l).distanceTo(worldPos(bones.calf_l)) + worldPos(bones.calf_l).distanceTo(worldPos(bones.foot_l)));
  rt.anim = anim; rt.dur = anim.animations[0].duration;
  rt.mixer = new THREE.AnimationMixer(anim);
  const clip = anim.animations[0].clone();
  clip.tracks = clip.tracks.filter(t => !t.name.startsWith('root.'));   // no root motion
  rt.mixer.clipAction(clip).play();
}

// Additional Unreal-exported clips use the UE5 Manny bone names directly (unlike the
// legacy ADS reference clip, which needs NAME_MAP). Build an independent retarget profile
// for each take so previewing one never mutates the live gameplay animation mixer.
export const READY_MOTIONS = [
  { id: 'handgun-empty', label: 'Handgun — Empty reload', file: 'A_TP_CH_Handgun_Reload_Empty.FBX' },
  { id: 'rifle-reload', label: 'Rifle — Reload', file: 'A_TP_CH_RL_01_Reload.FBX' },
  { id: 'smg-reload', label: 'SMG — Reload', file: 'A_TP_CH_SMG_02_Reload.FBX' },
  { id: 'smg-empty', label: 'SMG — Empty reload', file: 'A_TP_CH_SMG_02_Reload_Empty.FBX' },
  { id: 'shotgun-bolt', label: 'Shotgun — Bolt reload', file: 'A_TP_CH_Shotgun_01_Reload_Bolt.FBX' },
  { id: 'sniper-bolt', label: 'Sniper — Bolt reload', file: 'A_TP_CH_Sniper_01_Reload_Bolt.FBX' },
  { id: 'sniper-insert', label: 'Sniper — Insert reload', file: 'A_TP_CH_Sniper_01_Reload_Insert.FBX' },
  { id: 'sniper-crouch', label: 'Sniper — Crouch aim pose', file: 'A_TP_CH_Sniper_02_Crouch_Aim_Pose.FBX' },
  { id: 'ladder-up-start', label: 'Ladder — Climb Up Start', file: 'A_Ladder_Up_Start.FBX', dir: 'anim/ladder/', keepRoot: true, ladderState: 'up_start' },
  { id: 'ladder-up-loop', label: 'Ladder — Climb Up Loop', file: 'A_Ladder_Up_Loop.FBX', dir: 'anim/ladder/', keepRoot: true, ladderState: 'up_loop' },
  { id: 'ladder-up-end', label: 'Ladder — Climb Up End (Top)', file: 'A_Ladder_Up_End.FBX', dir: 'anim/ladder/', keepRoot: true, ladderState: 'up_end' },
  { id: 'ladder-down-start', label: 'Ladder — Slide Down Start (Top)', file: 'A_Ladder_Dawn_Start.FBX', dir: 'anim/ladder/', keepRoot: true, ladderState: 'down_start' },
  { id: 'ladder-down-loop', label: 'Ladder — Slide Down Loop', file: 'A_Ladder_Dawn_Loop.FBX', dir: 'anim/ladder/', keepRoot: true, ladderState: 'down_loop' },
  { id: 'ladder-down-end', label: 'Ladder — Slide Down End (Bottom)', file: 'A_Ladder_Dawn_End.FBX', dir: 'anim/ladder/', keepRoot: true, ladderState: 'down_end' },
];
