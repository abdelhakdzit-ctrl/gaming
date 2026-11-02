import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { DEG, V, clamp, sstep } from './math.js';
import { STATE, params } from './state.js';
import { camera, charRoot, controls, renderer, scene } from './scene.js';
import { STANCE, bones, orient, restWorldPos, restWorldQ, rotateWorld, rt, setWorldQuat, twoBoneIK, worldPos, worldQuat } from './skeleton.js';
import { RLT, ikEvalTimeline, rlCurU, rlKeys, rlRenderTicks, rlSetKey } from './reload-timeline.js';
import { _xq, mm } from './locomotion.js';
import { KA, RL, W, restLocalQ } from './weapons.js';
import { playerAim, playerCrouch } from './character.js';
import { motionPreview } from './motion-studio.js';
import { game, tps } from './game.js';

// ======================================================================
//  IK RIG  pelvis height + foot placement with ground clamp and reach limit
// ======================================================================
/* ANKLE_H, HIP_HALF, BALL_LEN, LEG_MAX in STATE */
export const GAIT_HIP = 8;   // half foot spacing while walking (A_AR_AimWalkPose_Fwd: feet ~18 cm apart)
export const HEEL_BACK = 4;   // heel contact behind the ankle (cm)
export const ikState = { foot: { l: V(), r: V() }, reachFix: 0 };
// Edit-IK offsets (character space) and the un-offset targets the handles are drawn from.
export const ikBase = { foot: { l: V(), r: V() }, knee: { l: V(), r: V() }, hand: { l: V(), r: V() }, elbow: { l: V(), r: V() }, pelvis: V(), gun: V() };
export const userIK = { foot: { l: V(), r: V() }, footQ: { l: new THREE.Quaternion(), r: new THREE.Quaternion() },
  knee: { l: V(), r: V() }, hand: { l: V(), r: V() }, handQ: { l: new THREE.Quaternion(), r: new THREE.Quaternion() }, elbow: { l: V(), r: V() },
  pelvis: V(), gun: V(), gunQ: new THREE.Quaternion() };
const KNEE_FWD = V(0, 0, 1);   // kneecap direction in the rest pose
export const _tq = new THREE.Quaternion(), _tq2 = new THREE.Quaternion();
// Two-bone leg IK that also sets the thigh/shin roll, so the kneecap faces the pole.
function legIK(s, target, pole) {
  const thigh = bones['thigh_' + s], calf = bones['calf_' + s], foot = bones['foot_' + s];
  const R = worldPos(thigh), a = worldPos(calf).distanceTo(R), c = worldPos(foot).distanceTo(worldPos(calf));
  const toT = target.clone().sub(R), d = Math.min(toT.length(), (a + c) * 0.999), dir = toT.normalize();
  const cosA = clamp((a * a + d * d - c * c) / (2 * a * d), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
  const perp = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
  const knee = R.clone().addScaledVector(dir, a * cosA).addScaledVector(perp, a * sinA);
  orient(thigh, calf, knee.clone().sub(R), KNEE_FWD, perp);
  orient(calf, foot, R.clone().addScaledVector(dir, d).sub(knee), KNEE_FWD, perp);
}
export function solveLegs(pose) {
  const tg = {}, wIdle = 1 - sstep(5, 60, mm.speed);
  for (const s of ['l', 'r']) {
    let p, q;
    if (pose) {
      const o = s === 'l' ? 5 : 10;
      p = V(pose[o], Math.max(STATE.ANKLE_H, pose[o + 1]), pose[o + 2]);
      q = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), pose[o + 4] * DEG)
        .multiply(_xq.setFromAxisAngle(V(1, 0, 0), pose[o + 3] * DEG)).multiply(restWorldQ['foot_' + s]);
    } else {
      p = rt.mFoot0[s].clone().add(STANCE.foot[s]); p.y = STATE.ANKLE_H;
      const f = bones['foot_' + s], b = bones['ball_' + s];
      const fwd = b ? worldPos(b).sub(worldPos(f)) : V(0, 0, 1);
      const rfwd = b ? restWorldPos['ball_' + s].clone().sub(restWorldPos['foot_' + s]) : V(0, 0, 1);
      const yaw = Math.atan2(fwd.x, fwd.z) - Math.atan2(rfwd.x, rfwd.z);
      q = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), yaw).multiply(restWorldQ['foot_' + s]);
    }
    ikBase.foot[s].copy(p);
    p.addScaledVector(userIK.foot[s], wIdle);
    p.y = Math.max(p.y, STATE.ANKLE_H);
    q.premultiply(_tq.identity().slerp(userIK.footQ[s], wIdle));
    tg[s] = { p, q };
  }
  // Pelvis IK: if a foot target nears full extension, lower the hips with a C1 soft-knee curve so there is zero corner snap.
  ikState.reachFix = 0;
  const soft = 2.5, lim0 = STATE.LEG_MAX - soft;
  for (let it = 0; it < 5; it++) {
    let need = 0;
    for (const s of ['l', 'r']) {
      const hip = worldPos(bones['thigh_' + s]), d = hip.distanceTo(tg[s].p);
      const ov = d - lim0;
      if (ov > 0) {
        const excess = ov < 2 * soft ? (ov * ov) / (4 * soft) : ov - soft;
        need = Math.max(need, excess / Math.max(0.35, (hip.y - tg[s].p.y) / d));
      }
    }
    if (need < 0.01) break;
    const pw = worldPos(bones.pelvis); pw.y -= need; ikState.reachFix += need;
    bones.pelvis.position.copy(bones.pelvis.parent.worldToLocal(pw));
    bones.pelvis.updateMatrixWorld(true);
  }
  for (const s of ['l', 'r']) {
    // Knee pole: over the toes (foot yaw), slightly outward, plus the user's knee handle.
    const fwd = V(0, 0, 1).applyQuaternion(_tq2.copy(tg[s].q).multiply(restWorldQ['foot_' + s].clone().invert()));
    fwd.y = 0; fwd.normalize(); fwd.x += (s === 'l' ? 1 : -1) * 0.12; fwd.normalize();
    const hip = worldPos(bones['thigh_' + s]);
    const poleP = hip.clone().add(tg[s].p).multiplyScalar(0.5).addScaledVector(fwd, 40);
    ikBase.knee[s].copy(poleP);
    poleP.add(userIK.knee[s]);
    legIK(s, tg[s].p, poleP.sub(hip));
    setWorldQuat(bones['foot_' + s], tg[s].q);
    const ball = bones['ball_' + s];
    if (ball) {
      ball.quaternion.copy(restLocalQ['ball_' + s]);
      const o = s === 'l' ? 5 : 10, pitch = pose ? pose[o + 3] : 0, yaw = pose ? pose[o + 4] : 0;
      if (pitch > 0 && tg[s].p.y <= STATE.ANKLE_H + STATE.BALL_LEN * Math.sin(pitch * DEG) + 1.5) {
        rotateWorld(ball, V(1, 0, 0).applyAxisAngle(V(0, 1, 0), yaw * DEG), -pitch * DEG);
      }
      ball.updateMatrixWorld(true);
    }
    ikState.foot[s].copy(tg[s].p);
  }
}

// IK / motion-matching debug: foot IK targets and the velocity the matcher is chasing (child of charRoot).
export const ikDbg = new THREE.Group();
ikDbg.feet = { l: new THREE.Mesh(new THREE.SphereGeometry(2.2, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff4455, depthTest: false })),
               r: new THREE.Mesh(new THREE.SphereGeometry(2.2, 12, 8), new THREE.MeshBasicMaterial({ color: 0x44aaff, depthTest: false })) };
ikDbg.vel = new THREE.ArrowHelper(V(0, 0, 1), V(0, 3, 0), 30, 0xffd23c);
ikDbg.add(ikDbg.feet.l, ikDbg.feet.r, ikDbg.vel);
ikDbg.feet.l.renderOrder = ikDbg.feet.r.renderOrder = 11;
ikDbg.visible = false;
charRoot.add(ikDbg);

// ======================================================================
//  EDIT IK  draggable handles for feet, knee poles, pelvis and weapon. Offsets are layered on top of
//  the animation + locomotion every frame and persist in localStorage.
// ======================================================================
export const IK_KEY = 'mannequin.ikpose.v2';   // { [context]: pose } — every motion / weapon stance keeps its own manual IK fix
export function ikToJson() {
  const r = a => a.toArray().map(x => +x.toFixed(4));
  return { foot: { l: r(userIK.foot.l), r: r(userIK.foot.r) }, footQ: { l: r(userIK.footQ.l), r: r(userIK.footQ.r) },
    knee: { l: r(userIK.knee.l), r: r(userIK.knee.r) }, hand: { l: r(userIK.hand.l), r: r(userIK.hand.r) },
    handQ: { l: r(userIK.handQ.l), r: r(userIK.handQ.r) }, elbow: { l: r(userIK.elbow.l), r: r(userIK.elbow.r) },
    pelvis: r(userIK.pelvis), gun: r(userIK.gun), gunQ: r(userIK.gunQ) };
}
export function ikZero() {
  for (const s of ['l', 'r']) {
    for (const k of ['foot', 'knee', 'hand', 'elbow']) userIK[k][s].set(0, 0, 0);
    userIK.footQ[s].identity(); userIK.handQ[s].identity();
  }
  userIK.pelvis.set(0, 0, 0); userIK.gun.set(0, 0, 0); userIK.gunQ.identity();
}
export function ikFromJson(j) {
  ikZero();
  const g = (o, k, s) => o?.[k]?.[s];
  for (const s of ['l', 'r']) {
    for (const k of ['foot', 'knee', 'hand', 'elbow']) { const a = g(j, k, s); if (a) userIK[k][s].fromArray(a); }
    for (const k of ['footQ', 'handQ']) { const a = g(j, k, s); if (a) userIK[k][s].fromArray(a); }
  }
  if (j.pelvis) userIK.pelvis.fromArray(j.pelvis);
  if (j.gun) userIK.gun.fromArray(j.gun);
  if (j.gunQ) userIK.gunQ.fromArray(j.gunQ);
}
/* ikProfiles in STATE */      // this browser's edits (localStorage)
/* ikDefaults in STATE */      // shipped defaults from ik-defaults.json (project file) — browser edits override them
export const ikCtx = { key: null };
try {
  if (params.has('ikreset')) localStorage.removeItem(IK_KEY);
  STATE.ikProfiles = JSON.parse(localStorage.getItem(IK_KEY) || '{}') || {};
} catch (e) { STATE.ikProfiles = {}; }
fetch('ik-defaults.json?' + Date.now()).then(r => r.ok ? r.json() : {}).then(j => { STATE.ikDefaults = j || {}; ikCtx.key = null; }).catch(() => {});
const ikAll = () => ({ ...STATE.ikDefaults, ...STATE.ikProfiles });
function ikContextKey() {
  if (motionPreview.active && motionPreview.profile) return 'motion:' + (document.getElementById('motionSelect')?.value || '');
  if (RLT.on || RL.on || (KA.on && KA.kind === 'reload')) return `${W.cur?.name || 'pistol'}:reload`;
  const aimed = playerAim.on || (game.active && tps.zoom);
  return `${W.cur?.name || 'pistol'}:${aimed ? 'aim' : 'normal'}${playerCrouch.on ? ':crouch' : ''}`;
}
export function ikLabel() {
  const el = document.getElementById('ikctx');
  if (!el) return;
  const p = STATE.ikProfiles[ikCtx.key] ?? STATE.ikDefaults[ikCtx.key];
  el.textContent = 'Editing: ' + ikCtx.key + (p?.keys ? ` (${p.keys.length} keys)` : STATE.ikProfiles[ikCtx.key] ? ' (saved)' : STATE.ikDefaults[ikCtx.key] ? ' (default)' : '');
}
// Called every frame: when the motion / weapon / stance changes, swap in that context's own IK edits.
export function ikSyncContext() {
  const k = ikContextKey();
  if (k === ikCtx.key) return;
  ikCtx.key = k;
  const j = STATE.ikProfiles[k] ?? STATE.ikDefaults[k];
  if (j && !j.keys) ikFromJson(j); else ikZero();
  if (k.endsWith(':reload')) ikEvalTimeline(rlCurU());
  ikLabel(); rlRenderTicks();
}
function saveIK() {
  if (!ikCtx.key) return;
  if (ikCtx.key.endsWith(':reload')) {
    if (RLT.on && !RLT.playing && (RLT.autoKey || rlKeys().some(k => Math.abs(k.t - RLT.u) <= 0.015))) rlSetKey();
    return;
  }
  STATE.ikProfiles[ikCtx.key] = ikToJson();
  try { localStorage.setItem(IK_KEY, JSON.stringify(STATE.ikProfiles)); } catch (e) { /* storage unavailable */ }
  ikLabel();
}

// Manual hand / elbow edits, layered on top of whatever posed the arms (gun grip, reload, animation clip).
const _uhQ = new THREE.Quaternion();
export function applyUserHands() {
  for (const s of ['l', 'r']) {
    const hand = bones['hand_' + s], lo = bones['lowerarm_' + s], up = bones['upperarm_' + s];
    const hp = worldPos(hand), lp = worldPos(lo);
    ikBase.hand[s].copy(hp); ikBase.elbow[s].copy(lp);
    const off = userIK.hand[s], eo = userIK.elbow[s], q = userIK.handQ[s];
    const moved = off.lengthSq() > 1e-6 || eo.lengthSq() > 1e-6, rot = Math.abs(q.w) < 0.999999;
    if (!moved && !rot) continue;
    const hq = worldQuat(hand);
    if (moved) twoBoneIK(up, lo, hand, hp.clone().add(off), lp.clone().add(eo).sub(worldPos(up)));
    setWorldQuat(hand, _uhQ.copy(q).multiply(hq));
  }
}
// Animation Studio previews: feet / knees / hands / elbows edits on top of the raw clip pose.
export function applyPreviewLimbIK() {
  for (const s of ['l', 'r']) {
    const thigh = bones['thigh_' + s], calf = bones['calf_' + s], foot = bones['foot_' + s];
    const fp = worldPos(foot), kp = worldPos(calf), hip = worldPos(thigh);
    ikBase.foot[s].copy(fp); ikBase.knee[s].copy(kp);
    const off = userIK.foot[s], ko = userIK.knee[s], q = userIK.footQ[s];
    const moved = off.lengthSq() > 1e-6 || ko.lengthSq() > 1e-6, rot = Math.abs(q.w) < 0.999999;
    if (!moved && !rot) continue;
    const fq = worldQuat(foot);
    if (moved) legIK(s, fp.clone().add(off), kp.clone().add(ko).sub(hip));
    setWorldQuat(foot, _uhQ.copy(q).multiply(fq));
  }
  applyUserHands();
}

export const ikEdit = { on: false, sel: null };
const IK_HANDLES = {
  foot_l: { label: 'Left foot', color: 0xff5566, rot: true, base: () => ikBase.foot.l, off: userIK.foot.l, q: userIK.footQ.l },
  foot_r: { label: 'Right foot', color: 0x55aaff, rot: true, base: () => ikBase.foot.r, off: userIK.foot.r, q: userIK.footQ.r },
  knee_l: { label: 'Left knee', color: 0xff99aa, base: () => ikBase.knee.l, off: userIK.knee.l },
  knee_r: { label: 'Right knee', color: 0x99ccff, base: () => ikBase.knee.r, off: userIK.knee.r },
  pelvis: { label: 'Pelvis', color: 0xffd23c, base: () => ikBase.pelvis, off: userIK.pelvis },
  hand_l: { label: 'Left hand', color: 0xff8855, rot: true, base: () => ikBase.hand.l, off: userIK.hand.l, q: userIK.handQ.l },
  hand_r: { label: 'Right hand', color: 0x55ddff, rot: true, base: () => ikBase.hand.r, off: userIK.hand.r, q: userIK.handQ.r },
  elbow_l: { label: 'Left elbow', color: 0xffb98a, base: () => ikBase.elbow.l, off: userIK.elbow.l },
  elbow_r: { label: 'Right elbow', color: 0x9ae8ff, base: () => ikBase.elbow.r, off: userIK.elbow.r },
  gun: { label: 'Weapon + hands', color: 0x44ee88, rot: true, base: () => ikBase.gun, off: userIK.gun, q: userIK.gunQ },
};
const ikGroup = new THREE.Group(); ikGroup.visible = false; charRoot.add(ikGroup);
for (const [k, h] of Object.entries(IK_HANDLES)) {
  const geo = h.rot ? new THREE.OctahedronGeometry(3.4) : k === 'pelvis' ? new THREE.BoxGeometry(6, 6, 6) : new THREE.SphereGeometry(2.6, 14, 10);
  h.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: h.color, depthTest: false, transparent: true, opacity: 0.85 }));
  h.mesh.renderOrder = 12; h.mesh.userData.key = k; ikGroup.add(h.mesh);
  const b = document.createElement('button'); b.textContent = h.label; b.dataset.ik = k;
  b.onclick = () => selectIK(k); document.getElementById('ikkeys').appendChild(b);
}
const tc = new TransformControls(camera, renderer.domElement);
tc.setSize(0.8); tc.setSpace('world');
scene.add(tc.getHelper());
tc.addEventListener('dragging-changed', e => { controls.enabled = !e.value && !game.active; if (!e.value) saveIK(); });
tc.addEventListener('objectChange', () => {
  const h = IK_HANDLES[ikEdit.sel]; if (!h) return;
  h.off.copy(h.mesh.position).sub(h.base());
  if (h.q) h.q.copy(h.mesh.quaternion);
});
export function syncIKHandles() {
  for (const [k, h] of Object.entries(IK_HANDLES)) {
    if (tc.dragging && k === ikEdit.sel) continue;
    h.mesh.position.copy(h.base()).add(h.off);
    if (h.q) h.mesh.quaternion.copy(h.q);
    h.mesh.scale.setScalar(k === ikEdit.sel ? 1.35 : 1);
  }
}
export function setIKMode(m) {
  if (m === 'rotate' && !IK_HANDLES[ikEdit.sel]?.rot) m = 'translate';
  tc.setMode(m);
  document.getElementById('ikMove').classList.toggle('active', m === 'translate');
  document.getElementById('ikRot').classList.toggle('active', m === 'rotate');
}
export function selectIK(k) {
  ikEdit.sel = k; tc.attach(IK_HANDLES[k].mesh);
  setIKMode(tc.mode);
  document.getElementById('iksel').textContent = 'Selected: ' + IK_HANDLES[k].label;
  document.querySelectorAll('[data-ik]').forEach(b => b.classList.toggle('active', b.dataset.ik === k));
}
export function toggleIKEdit(on = !ikEdit.on) {
  ikEdit.on = on; ikGroup.visible = on;
  document.getElementById('ikpanel').classList.toggle('hidden', !on);
  document.getElementById('ikedit').classList.toggle('active', on);
  if (on) { ikSyncContext(); ikLabel(); syncIKHandles(); selectIK(ikEdit.sel || 'foot_l'); } else tc.detach();
}
function resetIK(k) {
  const h = IK_HANDLES[k]; h.off.set(0, 0, 0); if (h.q) h.q.identity(); saveIK();
}
const picker = new THREE.Raycaster(), ndc = new THREE.Vector2();
renderer.domElement.addEventListener('pointerdown', e => {
  if (!ikEdit.on || tc.dragging || e.button !== 0) return;
  ndc.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  picker.setFromCamera(ndc, camera);
  const hit = picker.intersectObjects(ikGroup.children, false)[0];
  if (hit) selectIK(hit.object.userData.key);
});
document.getElementById('ikMove').onclick = () => setIKMode('translate');
document.getElementById('ikRot').onclick = () => setIKMode('rotate');
document.getElementById('ikResetSel').onclick = () => ikEdit.sel && resetIK(ikEdit.sel);
document.getElementById('ikReset').onclick = () => Object.keys(IK_HANDLES).forEach(resetIK);
document.getElementById('ikCopy').onclick = async (e) => {
  const txt = JSON.stringify(ikAll(), null, 1);
  try { await navigator.clipboard.writeText(txt); e.target.textContent = 'Copied all!'; } catch (err) { prompt('All IK fixes JSON', txt); }
  setTimeout(() => (e.target.textContent = 'Copy pose JSON'), 1200);
};
document.getElementById('ikExport').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(ikAll(), null, 1)], { type: 'application/json' }));
  a.download = 'ik-defaults.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
document.getElementById('ikImport').onclick = () => document.getElementById('ikFile').click();
document.getElementById('ikFile').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    Object.assign(STATE.ikProfiles, j);
    localStorage.setItem(IK_KEY, JSON.stringify(STATE.ikProfiles));
    ikCtx.key = null;
  } catch (err) { alert('Invalid IK JSON file: ' + err.message); }
  e.target.value = '';
};
