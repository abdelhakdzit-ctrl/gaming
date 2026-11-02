import * as THREE from 'three';
import { DEG, Spring, V, angWrap, clamp, lerp, rayBox, sstep } from './math.js';
import { BLOCK, LEAN, STATE, rec } from './state.js';
import { camera, charRoot, controls, grid, ground, sun } from './scene.js';
import { bones, driveHand, handRel, restWorldQ, rotateWorld, rt, storeHandRel, worldPos, worldQuat } from './skeleton.js';
import { ejectShell } from './fx.js';
import { _tq, applyUserHands, ikBase, ikDbg, ikEdit, ikState, ikSyncContext, syncIKHandles, userIK } from './ik.js';
import { RLT, ikTimelineApply, updateRlTimeline } from './reload-timeline.js';
import { LADDER, charPos, keys, mm, retargetFrame, stepLocomotion, toWorld, toWorldDir, updateLadder } from './locomotion.js';
import { CLIP_GUIDE, KA, M4, RL, SG_PUMP, TRIGGER_PULL, W, chainOf, fingerFix, fromGun, gunState, karHandR, lerpM, poseHandFrom, reloadGunPose, reloadLeftHand, setGunMatrix, slideOffset, stepKar, stepReload, stepShotgunPump, stepSwap, updateKarParts, weaponTrigger } from './weapons.js';
import { game, tps } from './game.js';
import { ANIM_T0 } from './main.js';
import { damp, dampW } from './anim/curves.js';
import { ARENA } from './ai.js';
import { SEC, stepSecondary } from './anim/secondary.js';
import { applyXfade } from './anim/xfade.js';
import { TRAV, stepLandingDip, updateTraverse } from './anim/traverse.js';

// Player Crouch State
export const playerCrouch = { on: false, w: 0 };
export function toggleCrouch(force) {
  playerCrouch.on = force !== undefined ? force : !playerCrouch.on;
  const status = document.getElementById('status');
  if (status) status.textContent = playerCrouch.on ? 'Crouch stance active (C)' : 'Standing stance active (C)';
}

// Player Aim / Normal Stance State
// Default is ALWAYS Normal Idle / Carry (standing, walking, running with Shift).
// Aiming (ADS) activates ONLY while holding Right-Click (RMB) — or when explicitly toggled via Aiming button in Viewer/IK edit.
export const playerAim = { on: false, rmb: false, w: 0, fireHoldT: 0 };
export function isAiming() {
  if (typeof game !== 'undefined' && game?.active) return !!(tps?.zoom || STATE.testInput);
  return !!(playerAim.on || playerAim.rmb);
}
export function setAimMode(on) {
  playerAim.on = !!on;
  if (!on) { playerAim.rmb = false; playerAim.fireHoldT = 0; }
  document.getElementById('aimMode')?.classList.toggle('active', isAiming());
  document.getElementById('normalMode')?.classList.toggle('active', !isAiming());
  const status = document.getElementById('status');
  if (status && !LADDER.active) {
    status.textContent = playerAim.on ? 'Aiming ADS locked on (Key V) — Release or click Normal Idle to return to RMB-only aim' : 'Normal Idle stance — Hold Right-Click (RMB) to Aim';
  }
}
export function toggleAimMode() { setAimMode(!playerAim.on); }

// ======================================================================
//  BODY LAYER  spring-driven secondary motion: the torso bends toward the working hand, knees flex,
//  weight shifts, the head looks at the job; slow sway so the idle never freezes.
// ======================================================================
export const BF = { yaw: new Spring(1.6, 0.5), pitch: new Spring(1.8, 0.45), roll: new Spring(1.5, 0.5), drop: new Spring(1.8, 0.55),
  side: new Spring(1.4, 0.6), hy: new Spring(2.6, 0.62), hp: new Spring(2.6, 0.62), look: V(), lookW: 0 };
function stepBodyFX(dt) {
  const kr = KA.on && KA.kind === 'reload', busy = RL.on ? RL.env : KA.on ? KA.env * (kr ? 1 : 0.4) : 0;
  const right = KA.on, hand = right ? bones.hand_r : bones.hand_l, sh = right ? bones.upperarm_r : bones.upperarm_l;
  // How far below the shoulder the working hand is (from the last frame): reaching low bends the body.
  const low = busy > 0 ? clamp((worldPos(sh).y - worldPos(hand).y - 22) / 40, 0, 1) * busy : 0;
  const side = right ? 1 : -1;
  BF.pitch.target = 7 * busy + 12 * low;
  BF.roll.target = side * 8 * low;
  BF.yaw.target = (right ? -5 : 7) * busy;
  BF.drop.target = 2.5 * busy + 5 * low;
  BF.side.target = -side * 3 * low;
  BF.yaw.target += 0.7 * Math.sin(STATE.simTime * 0.37); BF.roll.target += 0.5 * Math.sin(STATE.simTime * 0.23 + 1); BF.pitch.target += 0.4 * Math.sin(STATE.simTime * 0.31 + 2);
  BF.lookW = RL.on ? 0.85 * RL.env : kr ? 0.8 * KA.env : 0;
  if (BF.lookW > 0) BF.look.copy(fromGun(RL.on ? (W.cur.magWell || V()) : CLIP_GUIDE));
  for (const k of ['yaw', 'pitch', 'roll', 'drop', 'side']) BF[k].step(dt);
}
function applyBodyFX() {
  const Y = V(0, 1, 0);
  [['spine_01', 0.25], ['spine_02', 0.35], ['spine_03', 0.4]].forEach(([n, k]) => {
    rotateWorld(bones[n], Y, BF.yaw.x * k * DEG); rotateWorld(bones[n], X, BF.pitch.x * k * DEG); rotateWorld(bones[n], Z, BF.roll.x * k * DEG);
  });
}
function applyHeadLook(dt) {
  let ty = 0, tp = 0;
  if (BF.lookW > 0) {
    const f = V(0, 0, 1).applyQuaternion(worldQuat(bones.head).multiply(restWorldQ.head.clone().invert()));
    const d = BF.look.clone().sub(worldPos(bones.head)).normalize();
    ty = angWrap(Math.atan2(d.x, d.z) - Math.atan2(f.x, f.z)) * BF.lookW;
    tp = (Math.asin(clamp(f.y, -1, 1)) - Math.asin(clamp(d.y, -1, 1))) * BF.lookW;
  }
  BF.hy.target = clamp(ty, -0.9, 0.9); BF.hp.target = clamp(tp, -0.3, 0.9);
  BF.hy.step(dt); BF.hp.step(dt);
  const f = V(0, 0, 1).applyQuaternion(worldQuat(bones.head).multiply(restWorldQ.head.clone().invert())), ax = V(f.z, 0, -f.x).normalize();
  for (const [n, k] of [['neck_01', 0.4], ['head', 0.6]]) { rotateWorld(bones[n], V(0, 1, 0), BF.hy.x * k); rotateWorld(bones[n], ax, BF.hp.x * k); }
}

const X = V(1, 0, 0), Z = V(0, 0, 1);
export const recM = new THREE.Matrix4(), tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion();
export const lastPlaced = V(0, 0, 0);
export function placeCharacter() {
  charRoot.position.copy(charPos); charRoot.rotation.set(0, STATE.charYaw, 0); charRoot.updateMatrixWorld(true);
  const trackPos = LADDER.active ? LADDER.worldTrackPos : charPos;
  const d = trackPos.clone().sub(lastPlaced); lastPlaced.copy(trackPos);
  if (!game.active) { camera.position.add(d); controls.target.add(d); }  // orbit camera follows
  ground.position.set(trackPos.x, 0, trackPos.z);
  grid.position.set(Math.round(trackPos.x / 20) * 20, 0.05, Math.round(trackPos.z / 20) * 20);
  sun.position.set(trackPos.x + 180, trackPos.y + 380, trackPos.z + 220); sun.target.position.set(trackPos.x, trackPos.y, trackPos.z);
  for (const s of ['l', 'r']) ikDbg.feet[s].position.copy(ikState.foot[s]);
  if (ikEdit.on) syncIKHandles();
  ikDbg.vel.visible = mm.speed > 1;
  if (mm.speed > 1) { ikDbg.vel.setDirection(V(mm.vel[0], 0, mm.vel[1]).normalize()); ikDbg.vel.setLength(Math.max(12, mm.speed * 0.25), 6, 4); }
}
// Compute the weapon matrix in character space when in Normal Idle / Running (non-aiming low-ready carry)
function normalCarryGunMatrix(cur, runW, baseMat) {
  const chest = worldPos(bones.spine_02);
  const ph = mm.phase * Math.PI * 2;
  const gSpd = Math.hypot(mm.gaitVel[0], mm.gaitVel[1]);
  const moveW = sstep(6, 105, gSpd);
  const bobX = (Math.cos(ph) * lerp(0.85, 3.2, runW)) * moveW;
  const bobY = (-Math.abs(Math.sin(ph)) * lerp(0.65, 2.5, runW) * moveW + 0.4 * Math.sin(STATE.simTime * 2.0) * (1 - moveW));
  const bobZ = (Math.sin(ph) * lerp(0.3, 1.2, runW)) * moveW;
  let pos, pitch, yaw, roll;
  if (cur.name === 'rpg7') {
    // RPG-7: over-the-shoulder carry — tube rests cleanly on top of the right shoulder, well clear of the head
    const baseOff = V(-11.5, 21.5, 17.5);
    const runOff  = V(-11.0, 22.5, 16.5);
    pos = chest.clone().add(baseOff.lerp(runOff, runW)).add(V(bobX * 0.6, bobY * 0.7, bobZ * 0.6));
    pitch = lerp(8, 3, runW) + Math.sin(ph * 2) * 2.0 * runW;
    yaw   = lerp(10, 14, runW) + Math.cos(ph) * 3.0 * runW;
    roll  = lerp(6, 10, runW);
  } else if (cur.long) {
    // Long guns (M4, Shotgun, Kar98k): across-chest low-ready carry — stock tucked under right shoulder, clear of face
    const baseOff = cur.name === 'kar' ? V(-5.0, 4.5, 19.5) : cur.name === 'shotgun' ? V(-5.0, 4.0, 17.5) : V(-4.5, 4.0, 18.5);
    const runOff  = cur.name === 'kar' ? V(-3.5, 6.0, 18.5) : cur.name === 'shotgun' ? V(-3.5, 5.5, 16.5) : V(-3.0, 5.5, 17.5);
    pos = chest.clone().add(baseOff.lerp(runOff, runW)).add(V(bobX, bobY, bobZ));
    pitch = lerp(20, 10, runW) + Math.sin(ph * 2) * 3.0 * runW;
    yaw   = lerp(42, 48, runW) + Math.cos(ph) * 5.0 * runW;
    roll  = lerp(12, 18, runW);
  } else {
    // Pistol: two-handed low-ready carry in front of lower chest, pumping naturally while sprinting
    const baseOff = V(-1.5, 2.0, 23.0);
    const runOff  = V(-2.0, 5.5, 19.5);
    pos = chest.clone().add(baseOff.lerp(runOff, runW)).add(V(bobX * 0.7, bobY * 0.8, bobZ * 0.7));
    pitch = lerp(30, -12, runW) + Math.sin(ph * 2) * 3.5 * runW;
    yaw   = lerp(6, 16, runW) + Math.cos(ph) * 4.5 * runW;
    roll  = lerp(4, 10, runW);
  }
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch * DEG, yaw * DEG, roll * DEG, 'YXZ'));
  const sc = baseMat ? V(1, 1, 1).setFromMatrixScale(baseMat) : V(1, 1, 1);
  return new THREE.Matrix4().compose(pos, q, sc);
}

// One-off: hand-to-gun matrices of a one-handed weapon in the original (un-untwisted) aim pose.
function captureAimHandRel(poseOut) {
  const keep = STATE.NORMAL_W; STATE.NORMAL_W = 0;
  retargetFrame((ANIM_T0 + STATE.simTime) % rt.dur, poseOut);
  bones.hand_r.updateWorldMatrix(true, false);
  setGunMatrix(new THREE.Matrix4().multiplyMatrices(bones.hand_r.matrixWorld, W.cur.inHand));
  storeHandRel('r'); storeHandRel('l');
  STATE.NORMAL_W = keep;
  return { l: handRel.l.clone(), r: handRel.r.clone() };
}
// ---- Lean / peek: Q = left, E = right (hold). Critically damped, limited by free space beside the player. ----
const LEAN_OFF = 22, LEAN_CLEAR = 22;
const LEAN_SPLIT = [['spine_01', 6], ['spine_02', 8], ['spine_03', 8.5], ['neck_01', 3], ['head', -9]];
const _leanS = { x: 0, v: 0 };
function stepLean(dt) {
  const playing = game.active && game.state === 'play' && !LADDER.active;
  const dir = playing ? (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0) || LEAN.touch : 0;
  LEAN.dir = dir;
  let free = 1;
  if (dir && ARENA.group.visible) {
    const yaw = STATE.charYaw, r = V(-Math.cos(yaw) * dir, 0, Math.sin(yaw) * dir), cd = 34 * playerCrouch.w;
    let t = LEAN_OFF + LEAN_CLEAR;
    for (const cv of ARENA.covers) for (const y of [158 - cd, 120 - cd]) { const h = rayBox(V(charPos.x, y, charPos.z), r, cv, t); if (h) t = Math.min(t, h.t); }
    free = clamp((t - LEAN_CLEAR) / LEAN_OFF, 0, 1);
  }
  LEAN.free = free;
  let w = damp(_leanS, dir * free, 11, dt);
  if (dir && Math.sign(w) === dir && Math.abs(w) > free) { w = dir * free; _leanS.x = w; _leanS.v = 0; }   // never lean into a wall
  LEAN.w = w; LEAN.off = w * LEAN_OFF;
}

// ---- Weapon vs wall: pull the gun toward the chest and raise the muzzle (damped) so it never pokes through cover. ----
const _wbS = { x: 0, v: 0 }, _wbM1 = new THREE.Matrix4(), _wbM2 = new THREE.Matrix4(), _wbQ = new THREE.Quaternion(), _wbQ2 = new THREE.Quaternion();
function applyWeaponBlock(dt, cur) {
  const G = STATE.gunBase, S = worldPos(bones.upperarm_r), M = V(cur.muzzle.x, cur.muzzle.y, cur.muzzle.z).applyMatrix4(G);
  const fwd = V(0, 0, 1).transformDirection(G), reach = M.distanceTo(S), gunLen = cur.long ? 95 : 38;
  let pen = 0;
  if (game.active && ARENA.group.visible && !LADDER.active) {
    const dA = M.clone().sub(S).normalize(), oA = toWorld(S), dAw = toWorldDir(dA), oB = toWorld(M.clone().addScaledVector(fwd, -gunLen)), dBw = toWorldDir(fwd.clone());
    for (const cv of ARENA.covers) {
      const a = rayBox(oA, dAw, cv, reach + 5), b = rayBox(oB, dBw, cv, gunLen + 5);
      if (a) pen = Math.max(pen, reach + 5 - a.t);
      if (b) pen = Math.max(pen, gunLen + 5 - b.t);
    }
  }
  const ps = Math.max(0, damp(_wbS, pen, pen > _wbS.x ? 22 : 8, dt));   // quick in (never clip), slow out
  BLOCK.pen = ps; BLOCK.w = sstep(2, 20, ps);
  if (ps < 0.15) return;
  // Blocked pose: short pull toward the chest, then a capped rotation about the grip split into a raise and an inward
  // (across-chest) turn. A single large pitch stood long guns vertical and dragged the support arm/clavicle overhead.
  const piv = worldPos(bones.hand_r), lever = Math.max(M.distanceTo(piv), 15);
  const pull = Math.min(ps * 0.45, cur.long ? 12 : 14), rem = ps - pull;
  const theta = Math.min(Math.acos(clamp(1 - rem / lever, -1, 1)), (cur.long ? 48 : 42) * DEG);
  const pitch = Math.min(theta * 0.78, (cur.long ? 34 : 36) * DEG), yaw = Math.sqrt(Math.max(0, theta * theta - pitch * pitch));
  const fh = V(fwd.x, 0, fwd.z).normalize(), ax = V().crossVectors(fh, V(0, 1, 0)).normalize();
  _wbQ.setFromAxisAngle(V(0, 1, 0), yaw).multiply(_wbQ2.setFromAxisAngle(ax, pitch));
  G.premultiply(_wbM1.makeTranslation(-piv.x, -piv.y, -piv.z)).premultiply(_wbM2.makeRotationFromQuaternion(_wbQ))
    .premultiply(_wbM1.makeTranslation(piv.x - fh.x * pull, piv.y + pull * 0.25, piv.z - fh.z * pull));
}
const _crS = { x: 0, v: 0 }, _aimS = { x: 0, v: 0 };   // critically-damped blend states (no start/stop pop)
export function updateCharacter(dt) {
  updateRlTimeline(dt);
  playerCrouch.w = dampW(_crS, playerCrouch.on ? 1 : 0, 10, dt);
  const wantAim = isAiming() || RL.on || KA.on || RLT.on || SG_PUMP.on;
  playerAim.w = dampW(_aimS, wantAim ? 1 : 0, 14, dt);
  for (const k of ['flip', 'back', 'up', 'yaw', 'roll', 'cam', 'hx', 'hy', 'hz']) rec[k].step(dt);
  const shK = W.cur.shK ?? 0.4;
  rec.hips.target = 0.8 * rec.back.x + 0.05 * rec.flip.x;
  rec.hips.step(dt);
  rec.spine.target = 0.12 * rec.flip.x + (W.cur.bodyK ?? 0.35) * rec.back.x;
  rec.shrug.target = 0.9 * rec.up.x + 0.35 * shK * rec.back.x;
  rec.shoulder.target = 0.65 * shK * rec.back.x + 0.08 * shK * rec.flip.x;
  rec.armBack.target = 0.55 * shK * rec.back.x;
  rec.elbow.target = 0.45 * shK * rec.back.x;
  rec.head.target = -0.5 * rec.spine.x;
  rec.spine.step(dt); rec.shrug.step(dt); rec.shoulder.step(dt); rec.armBack.step(dt); rec.elbow.step(dt); rec.head.step(dt);

  // Solve in character space (charRoot at identity), place in the world at the end.
  charRoot.position.set(0, 0, 0); charRoot.rotation.set(0, 0, 0); charRoot.updateMatrixWorld(true);
  if (LADDER.active && updateLadder(dt)) return;
  if (TRAV.active && updateTraverse(dt, keys.has('ShiftLeft') || keys.has('ShiftRight'))) return;
  if (W.cur?.obj && W.cur.obj.parent !== charRoot) charRoot.add(W.cur.obj);
  stepSwap(dt); stepReload(dt); stepKar(dt); stepShotgunPump(dt); stepBodyFX(dt);
  ikSyncContext(); ikTimelineApply();

  stepLocomotion(dt);
  const poseOut = mm.out.slice();
  const nw = 1 - playerAim.w; // 1 = Normal Idle (can run), 0 = Aiming ADS (no run)
  stepSecondary(dt, { vel: mm.vel, speed: mm.speed, yaw: STATE.charYaw, phase: mm.phase, aimW: playerAim.w, crouchW: playerCrouch.w, nw });
  stepLean(dt);
  poseOut[0] += SEC.dx - LEAN.w * 6; poseOut[1] += SEC.dy - stepLandingDip(dt); poseOut[3] += SEC.roll + LEAN.w * 4; poseOut[4] += SEC.lean; poseOut[15] += SEC.yaw;
  const wIdle = 1 - sstep(5, 60, mm.speed);
  STATE.NORMAL_W = nw;
  if (nw > 0.001) {
    // Relaxed stance: feet planted flat on the ground, shoulder-width, toes slightly out; pelvis height is
    // resolved by the leg IK (reach fix), so only add breathing sway instead of raising the hips.
    const kFoot = nw * wIdle;
    if (kFoot > 0.001) {
      const fx = STATE.HIP_HALF * 0.95;
      poseOut[5]  = lerp(poseOut[5],  fx, kFoot);
      poseOut[6]  = lerp(poseOut[6],  STATE.ANKLE_H, kFoot);
      poseOut[7]  = lerp(poseOut[7],  0, kFoot);
      poseOut[8]  = lerp(poseOut[8],  0, kFoot);
      poseOut[9]  = lerp(poseOut[9],  8, kFoot);
      poseOut[10] = lerp(poseOut[10], -fx, kFoot);
      poseOut[11] = lerp(poseOut[11], STATE.ANKLE_H, kFoot);
      poseOut[12] = lerp(poseOut[12], 0, kFoot);
      poseOut[13] = lerp(poseOut[13], 0, kFoot);
      poseOut[14] = lerp(poseOut[14], -8, kFoot);
      poseOut[1] += 0.35 * Math.sin(STATE.simTime * 2.0) * kFoot + 6.0 * kFoot;   // legs nearly straight; IK reach-fix caps it
    }
  }
  if (playerCrouch.w > 0.001) {
    const cw = playerCrouch.w;
    poseOut[1] -= 36 * cw;
    poseOut[4] += 12 * cw;
  }
  if (!W.cur.J && nw > 0.001 && !W.cur.hrCache) W.cur.hrCache = captureAimHandRel(poseOut);
  retargetFrame((ANIM_T0 + STATE.simTime) % rt.dur, poseOut);
  const wP = 1 - W.blend;
  for (const [b, d] of fingerFix) b.quaternion.premultiply(wP >= 1 ? d : _tq.identity().slerp(d, wP));
  const gSpd = Math.hypot(mm.gaitVel[0], mm.gaitVel[1]);
  const aimMoveW = sstep(10, 120, gSpd) * playerAim.w;
  if (aimMoveW > 0.001) {
    // Subtle cushioned upper-body cadence while moving in ADS (applied before applyAim so muzzle stays locked on target)
    const phA = mm.phase * Math.PI * 2;
    rotateWorld(bones.spine_02, Z, -Math.sin(phA) * 0.55 * aimMoveW * DEG);
    rotateWorld(bones.spine_02, X, Math.cos(phA * 2) * 0.45 * aimMoveW * DEG);
  }
  if (W.blend > 0) rotateWorld(bones.spine_03, X, -0.5 * Math.sin(STATE.simTime * 1.7) * W.blend * DEG);   // rifle pose is one frame: breathe
  if (W.blend > 0 && playerAim.w > 0.01) rotateWorld(bones.head, X, -4.5 * W.blend * playerAim.w * DEG);   // level chin along rifle sightline
  if (W.dip > 0) { rotateWorld(bones.spine_02, X, 10 * W.dip * DEG); rotateWorld(bones.spine_03, X, 16 * W.dip * DEG); }
  {
    // Secondary motion: breathing, torso counter-rotation, level head, clavicle follow-through (before aim so the muzzle stays on target)
    const aw = 1 - 0.5 * playerAim.w;
    rotateWorld(bones.spine_01, V(0, 1, 0), SEC.spineYaw * 0.3 * DEG);
    rotateWorld(bones.spine_02, V(0, 1, 0), SEC.spineYaw * 0.4 * DEG);
    rotateWorld(bones.spine_03, V(0, 1, 0), SEC.spineYaw * 0.3 * DEG);
    rotateWorld(bones.spine_03, X, SEC.breath * 0.35 * aw * DEG);
    rotateWorld(bones.neck_01, V(0, 1, 0), SEC.headYaw * 0.4 * DEG);
    rotateWorld(bones.head, V(0, 1, 0), SEC.headYaw * 0.6 * DEG);
    rotateWorld(bones.head, X, SEC.headPitch * DEG);
    rotateWorld(bones.clavicle_l, Z, SEC.clavL * DEG);
    rotateWorld(bones.clavicle_r, Z, -SEC.clavR * DEG);
  }
  if (Math.abs(LEAN.w) > 1e-3) for (const [n, k] of LEAN_SPLIT) rotateWorld(bones[n], Z, LEAN.w * k * DEG);
  applyBodyFX();
  if (playerAim.w > 0.01) applyAim();

  const cur = W.cur;
  bones.hand_r.updateWorldMatrix(true, false);
  STATE.gunBase.multiplyMatrices(bones.hand_r.matrixWorld, cur.inHand);
  const walkW = sstep(6, 85, gSpd), runFactor = sstep(155, 330, gSpd) * nw;
  if (nw > 0.001) {
    // Smooth walk & run upper-body rhythm: breathing at rest, natural counter-rotation, shoulder roll & harmonic nod in motion.
    const ph = mm.phase * Math.PI * 2;
    const pitchCad = 1.0 * Math.sin(STATE.simTime * 2.0) * (1 - walkW) + lerp(1.6, 7.2, runFactor) * walkW + Math.cos(ph * 2) * lerp(0.55, 1.7, runFactor) * walkW;
    rotateWorld(bones.spine_02, X, pitchCad * nw * DEG);
    if (walkW > 0.001) {
      const yaw2 = Math.cos(ph) * lerp(2.1, 5.2, runFactor) * walkW * nw * DEG;
      const yaw3 = Math.cos(ph) * lerp(2.5, 6.2, runFactor) * walkW * nw * DEG;
      const roll2 = -Math.sin(ph) * lerp(1.0, 2.3, runFactor) * walkW * nw * DEG;
      rotateWorld(bones.spine_02, V(0, 1, 0), yaw2);
      rotateWorld(bones.spine_03, V(0, 1, 0), yaw3);
      rotateWorld(bones.spine_02, Z, roll2);
    }
  }
  setGunMatrix(STATE.gunBase);
  if (!cur.J) {
    // Pistol: the support hand's grip on the gun is captured once from the untouched aim pose, so the
    // relaxed-stance torso untwist can't pull the left hand off the weapon.
    storeHandRel('r'); storeHandRel('l');
    if (nw > 0.001 && cur.hrCache) {
      handRel.r = nw >= 0.999 ? cur.hrCache.r.clone() : lerpM(handRel.r, cur.hrCache.r, nw);
      handRel.l = nw >= 0.999 ? cur.hrCache.l.clone() : lerpM(handRel.l, cur.hrCache.l, nw);
    }
  }
  if (nw > 0.001) {
    // Across-chest / low-ready carry: lowers the weapon to chest height so the buttstock stays tucked under the right shoulder.
    STATE.gunBase.copy(lerpM(STATE.gunBase, normalCarryGunMatrix(cur, runFactor, STATE.gunBase), nw));
    setGunMatrix(STATE.gunBase);
  }
  // Edit-IK weapon offset: move/rotate the gun about its origin; both hands follow via handRel.
  ikBase.gun.setFromMatrixPosition(STATE.gunBase);
  if (userIK.gun.lengthSq() > 0 || Math.abs(userIK.gunQ.w) < 0.999999) {
    const o = ikBase.gun, u = userIK.gun;
    STATE.gunBase.premultiply(tmpM.makeTranslation(-o.x, -o.y, -o.z)).premultiply(tmpM.makeRotationFromQuaternion(userIK.gunQ))
      .premultiply(tmpM.makeTranslation(o.x + u.x, o.y + u.y, o.z + u.z));
  }

  applyWeaponBlock(dt, cur);
  reloadGunPose(STATE.gunBase);
  const Y = V(0, 1, 0), shBack = rec.shoulder.x;
  // Upper torso pitches back and twists around Y as the stock drives the right shoulder backward
  rotateWorld(bones.spine_01, X, -0.22 * shBack * DEG);
  rotateWorld(bones.spine_02, X, -(0.45 * rec.spine.x + 0.55 * shBack) * DEG);
  rotateWorld(bones.spine_03, X, -(0.55 * rec.spine.x + 0.75 * shBack) * DEG);
  rotateWorld(bones.spine_02, Y, -0.45 * shBack * DEG);
  rotateWorld(bones.spine_03, Y, -0.65 * shBack * DEG);
  // Both shoulders (clavicle_r / clavicle_l) kick backward (-Z via Y rotation) and shrug upward (Z rotation)
  rotateWorld(bones.clavicle_r, Y, -2.4 * shBack * DEG);
  rotateWorld(bones.clavicle_l, Y,  1.6 * shBack * DEG);
  rotateWorld(bones.clavicle_r, Z, -(rec.shrug.x * 1.2 + 0.95 * shBack) * DEG);
  rotateWorld(bones.clavicle_l, Z,  (rec.shrug.x * 1.2 + 0.70 * shBack) * DEG);
  rotateWorld(bones.head, X, rec.head.x * DEG);
  // Small random head vibration while the rifle runs full-auto (kicked per shot + a little tremor while held).
  if (W.cur.auto && STATE.triggerHeld && cur.ammo > 0) for (const k of ['hx', 'hy', 'hz']) rec[k].v += (Math.random() - 0.5) * 140 * dt;
  rotateWorld(bones.head, X, rec.hx.x * DEG); rotateWorld(bones.head, Y, rec.hy.x * DEG); rotateWorld(bones.head, Z, rec.hz.x * DEG);
  applyHeadLook(dt);

  const armBack = rec.armBack.x;
  const e = new THREE.Euler(-(rec.flip.x + 0.35 * shBack) * DEG, (rec.yaw.x - 0.30 * shBack + SEC.swayYaw) * DEG, (rec.roll.x + SEC.swayRoll) * DEG, 'YXZ'), pv = cur.pivot;
  recM.makeTranslation(-0.18 * armBack + SEC.swayX, rec.up.x + 0.15 * shBack + SEC.swayY, -(rec.back.x + 0.85 * armBack))
    .multiply(tmpM.makeTranslation(pv.x, pv.y, pv.z))
    .multiply(tmpM.makeRotationFromEuler(e))
    .multiply(tmpM.makeTranslation(-pv.x, -pv.y, -pv.z));
  setGunMatrix(STATE.gunBase.clone().multiply(recM));
  cur.obj.matrix.copy(gunState.mat);
  cur.obj.matrixWorldNeedsUpdate = true;

  if (cur.J) {   // long guns: both hands retargeted from the FPS pack (grip, M4 reload, Kar bolt work, Shotgun pump slider)
    const G = gunState.mat;
    poseHandFrom('r', KA.on ? karHandR() : cur.J.r, G, KA.on ? 1 : W.leftW, cur.fq.r, 1);
    if (KA.on) {   // working the bolt / clip: index leaves the trigger and closes like the middle finger
      const mid = chainOf('middle', 'r'), idx = chainOf('index', 'r');
      idx.forEach((b, i) => b.quaternion.slerp(mid[i].quaternion, KA.env));
    }
    const pumpZ = cur.pump ? cur.pump.position.z : 0;
    const jl = RL.frame ? RL.frame.l : (Math.abs(pumpZ) > 1e-4 ? cur.J.l.map(p => V(p.x, p.y, p.z + pumpZ)) : cur.J.l);
    const fqWL = RL.frame ? (RL.gripPump ? 1 : 1 - RL.env) : 1;
    poseHandFrom('l', jl, G, RL.on ? 1 : W.leftW, cur.fq.l, fqWL);
  } else {
    driveHand('r');
    if (RL.on && !RL.loading) reloadLeftHand();
    else driveHand('l', W.leftW);
  }

  applyUserHands();   // manual hand / elbow Edit-IK for this weapon stance

  const tv = RL.on || KA.on ? 0 : weaponTrigger(dt);
  if (cur.trigPivot) cur.trigPivot.rotation.x = tv * TRIGGER_PULL;
  cur.trigFn?.(tv);
  if (!KA.on) chainOf('index', 'r').forEach((b, i) => b.quaternion.copy(cur.trig.rest[i]).slerp(cur.trig.pulled[i], tv));

  placeCharacter();
  applyXfade(dt, cur.obj);   // blends out ladder dismount / mount pops

  const st = STATE.simTime - STATE.fireTime;
  if (cur.kar) updateKarParts();
  else {
    const so = Math.max(slideOffset(st) * cur.cycleK, cur.locked ? cur.lockTravel : 0, RL.on ? RL.rack : 0);
    if (cur.slide) cur.slide.position.z = -so;
    cur.setBolt?.(so, RL.frame);
    if (cur.clips) { cur.mag.matrix.copy(RL.frame ? RL.frame.mag : M4.restM.mag); cur.mag.matrixWorldNeedsUpdate = true; }
  }
  if (!STATE.ejected && st >= 0.01) { STATE.ejected = true; ejectShell(); }
}
// ======================================================================
//  AIMING  the spine (3 bones, distributed) turns and pitches so the barrel points at the aim point
// ======================================================================
export const aim = { point: V(0, 140, 3000), smooth: V(0, 140, 3000) };
export const AIM_SPLIT = [['spine_01', 0.2], ['spine_02', 0.35], ['spine_03', 0.45]];
function applyAim() {
  if (!game.active) return;
  const P = aim.smooth.clone().sub(charPos).applyAxisAngle(V(0, 1, 0), -STATE.charYaw);   // character space
  // When the gun is raised off a wall the spine stops chasing the target; the total correction is bounded so it can never wrench.
  const wA = 1 - 0.85 * BLOCK.w;
  let yawT = 0, pitchT = 0;
  for (let it = 0; it < 2; it++) {
    bones.hand_r.updateWorldMatrix(true, false);
    const M = new THREE.Matrix4().multiplyMatrices(bones.hand_r.matrixWorld, W.cur.inHand);
    const muzzle = W.cur.muzzle.clone().applyMatrix4(M), B = V(0, 0, 1).transformDirection(M);
    const D = P.clone().sub(muzzle).normalize();
    const yawE = clamp(angWrap(Math.atan2(D.x, D.z) - Math.atan2(B.x, B.z)) * wA, -0.7 - yawT, 0.7 - yawT);
    const pitchE = clamp((Math.asin(clamp(D.y, -1, 1)) - Math.asin(clamp(B.y, -1, 1))) * wA, -0.8 - pitchT, 0.8 - pitchT);
    yawT += yawE; pitchT += pitchE;
    const ax = new THREE.Vector3().crossVectors(V(D.x, 0, D.z).normalize(), V(0, 1, 0));
    for (const [n, k] of AIM_SPLIT) { rotateWorld(bones[n], V(0, 1, 0), yawE * k); rotateWorld(bones[n], ax, pitchE * k); }
  }
}
