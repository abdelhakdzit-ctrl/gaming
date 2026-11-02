import * as THREE from 'three';
import { clamp, ease } from './math.js';
import { STATE } from './state.js';
import { IK_KEY, ikCtx, ikEdit, ikFromJson, ikLabel, ikSyncContext, ikToJson, ikZero, selectIK, syncIKHandles, toggleIKEdit } from './ik.js';
import { LADDER } from './locomotion.js';
import { KA, KA_DEF, RL, W, releaseFire } from './weapons.js';
import { motionPreview, stopMotionPreview } from './motion-studio.js';
import { game } from './game.js';

// ======================================================================
//  RELOAD SMART TIMELINE (lite)  scrub any weapon's reload, jump to smart phases, drag IK handles
//  (auto-keyed or via ◆ Set key). Keys interpolate smoothly and drive every real reload of that weapon.
// ======================================================================
export const RLT = { on: false, u: 0, playing: false, empty: false, autoKey: true, openedIK: false };
const IK_ZERO_JSON = {
  foot: { l: [0, 0, 0], r: [0, 0, 0] }, footQ: { l: [0, 0, 0, 1], r: [0, 0, 0, 1] },
  knee: { l: [0, 0, 0], r: [0, 0, 0] }, hand: { l: [0, 0, 0], r: [0, 0, 0] },
  handQ: { l: [0, 0, 0, 1], r: [0, 0, 0, 1] }, elbow: { l: [0, 0, 0], r: [0, 0, 0] },
  pelvis: [0, 0, 0], gun: [0, 0, 0], gunQ: [0, 0, 0, 1],
};
export function rlCurU() { return RLT.on ? RLT.u : (KA.on && KA.kind === 'reload') ? KA.t : RL.on ? RL.t : 0; }
function rlDuration() {
  const c = W.cur;
  if (c.kar) return KA_DEF.reload.dur;
  if (c.clips) return (RLT.empty ? c.clips.empty : c.clips.tac).dur;
  if (c.rl) return RLT.empty ? c.rlDur.empty : c.rlDur.tac;
  return c.rlDur || 2.5;
}
function ikBlendJson(a, b, w) {
  const Z3 = [0, 0, 0], ZQ = [0, 0, 0, 1];
  const L = (x, y) => x.map((v, i) => v + (y[i] - v) * w);
  const Q = (x, y) => new THREE.Quaternion().fromArray(x).slerp(new THREE.Quaternion().fromArray(y), w).toArray();
  const out = { foot: {}, footQ: {}, knee: {}, hand: {}, handQ: {}, elbow: {} };
  for (const s of ['l', 'r']) {
    for (const k of ['foot', 'knee', 'hand', 'elbow']) out[k][s] = L(a[k]?.[s] || Z3, b[k]?.[s] || Z3);
    for (const k of ['footQ', 'handQ']) out[k][s] = Q(a[k]?.[s] || ZQ, b[k]?.[s] || ZQ);
  }
  out.pelvis = L(a.pelvis || Z3, b.pelvis || Z3); out.gun = L(a.gun || Z3, b.gun || Z3); out.gunQ = Q(a.gunQ || ZQ, b.gunQ || ZQ);
  return out;
}
export function rlKeys() { return (STATE.ikProfiles[ikCtx.key] ?? STATE.ikDefaults[ikCtx.key])?.keys || []; }
export function ikEvalTimeline(u) {
  const ks = rlKeys();
  if (!ks.length) { ikZero(); return; }
  if (u <= ks[0].t) {
    if (ks[0].t <= 0.015) ikFromJson(ks[0].pose);
    else ikFromJson(ikBlendJson(IK_ZERO_JSON, ks[0].pose, ease(u / ks[0].t)));
    return;
  }
  const last = ks[ks.length - 1];
  if (u >= last.t) {
    if (last.t >= 0.985) ikFromJson(last.pose);
    else ikFromJson(ikBlendJson(last.pose, IK_ZERO_JSON, ease((u - last.t) / Math.max(1e-4, 1 - last.t))));
    return;
  }
  let i = 0; while (u > ks[i + 1].t) i++;
  const w = ease((u - ks[i].t) / Math.max(1e-4, ks[i + 1].t - ks[i].t));
  ikFromJson(ikBlendJson(ks[i].pose, ks[i + 1].pose, w));
}
function rlPersist() { try { localStorage.setItem(IK_KEY, JSON.stringify(STATE.ikProfiles)); } catch (e) { /* storage unavailable */ } }
export function rlSetKey() {
  if (!RLT.on || !ikCtx.key?.endsWith(':reload')) return;
  const ks = rlKeys().map(k => ({ t: k.t, pose: k.pose })).filter(k => Math.abs(k.t - RLT.u) > 0.012);
  ks.push({ t: +RLT.u.toFixed(3), pose: ikToJson() });
  ks.sort((a, b) => a.t - b.t);
  STATE.ikProfiles[ikCtx.key] = { keys: ks }; rlPersist(); ikLabel(); rlRenderTicks();
}
export function rlDeleteKey() {
  if (!RLT.on || !ikCtx.key?.endsWith(':reload')) return;
  const ks = rlKeys().filter(k => Math.abs(k.t - RLT.u) > 0.03);
  if (ks.length) STATE.ikProfiles[ikCtx.key] = { keys: ks }; else delete STATE.ikProfiles[ikCtx.key];
  rlPersist(); ikEvalTimeline(RLT.u); ikLabel(); rlRenderTicks();
}
export function rlClearKeys() {
  if (!RLT.on || !ikCtx.key?.endsWith(':reload')) return;
  delete STATE.ikProfiles[ikCtx.key];
  rlPersist(); ikZero(); ikLabel(); rlRenderTicks();
}
export function rlJump(dir) {
  const ks = rlKeys(); if (!ks.length) return;
  const nxt = dir > 0 ? ks.find(k => k.t > RLT.u + 0.004) : [...ks].reverse().find(k => k.t < RLT.u - 0.004);
  if (nxt) rlSetU(nxt.t);
}
export function rlSetU(u) {
  RLT.u = clamp(u, 0, 0.999);
  RLT.playing = false;
  const btn = document.getElementById('rlPlay'); if (btn) btn.textContent = '▶ Play';
  ikEvalTimeline(RLT.u);
  if (ikEdit.on) syncIKHandles();
}
function rlPhasesFor(c) {
  if (!c) return [];
  if (c.name === 'shotgun') return [['Start', 0], ['Pouch', 0.20], ['Shell In', 0.42], ['Grip Pump', 0.60], ['Pump Back', 0.78], ['Pump Fwd', 0.96]];
  if (c.name === 'kar') return [['Start', 0], ['Bolt Open', 0.19], ['Pouch', 0.36], ['Clip In', 0.54], ['Strip Rounds', 0.66], ['Bolt Close', 0.80], ['End', 0.97]];
  if (c.name === 'rpg7') return [['Start', 0], ['Pouch', 0.25], ['Muzzle', 0.50], ['Seat Rocket', 0.68], ['End', 0.96]];
  if (c.clips) {
    const K = RLT.empty ? c.clips.empty : c.clips.tac;
    const out = [['Start', 0], ['Release', +K.release.toFixed(2)], ['Pouch', +K.low.toFixed(2)], ['Seat', +K.seat.toFixed(2)]];
    if (K.boltRel > 0) out.push(['Bolt', +K.boltRel.toFixed(2)]);
    out.push(['End', 0.96]);
    return out;
  }
  if (c.rl) {
    return RLT.empty
      ? [['Start', 0], ['Release', 0.07], ['Pouch', 0.40], ['Well', 0.60], ['Seat', 0.66], ['Rack', 0.84], ['End', 0.96]]
      : [['Start', 0], ['Release', 0.08], ['Pouch', 0.46], ['Well', 0.70], ['Seat', 0.78], ['End', 0.96]];
  }
  return [['Start', 0], ['Mid', 0.5], ['End', 0.96]];
}
function rlRenderChips() {
  const box = document.getElementById('rlChips'); if (!box) return;
  box.innerHTML = '';
  const lbl = document.createElement('span');
  lbl.textContent = 'Phases:'; lbl.style.cssText = 'color:#84909f;font-size:11px;margin-right:2px';
  box.appendChild(lbl);
  for (const [name, t] of rlPhasesFor(W.cur)) {
    const b = document.createElement('button');
    b.textContent = `${name} ${Math.round(t * 100)}%`;
    b.onclick = () => rlSetU(t);
    box.appendChild(b);
  }
}
export function rlRenderTicks() {
  const box = document.getElementById('rlTicks'); if (!box) return;
  box.innerHTML = '';
  for (const k of rlKeys()) {
    const d = document.createElement('i'); d.style.left = (k.t * 100) + '%'; d.dataset.t = k.t;
    d.title = `Key @ ${(k.t * rlDuration()).toFixed(2)} s (${Math.round(k.t * 100)}%) — click to jump`;
    d.classList.toggle('near', Math.abs(k.t - RLT.u) <= 0.015);
    d.onclick = () => rlSetU(k.t); box.appendChild(d);
  }
}
export function updateRlTimeline(dt) {
  if (!RLT.on) return;
  if (RLT.playing) { RLT.u += dt / rlDuration(); if (RLT.u >= 0.999) RLT.u = 0; }
  RLT.u = clamp(RLT.u, 0, 0.999);
  const sl = document.getElementById('rlSlider'); if (sl) sl.value = RLT.u;
  const info = document.getElementById('rlInfo');
  if (info) info.textContent = `${(RLT.u * rlDuration()).toFixed(2)} / ${rlDuration().toFixed(2)} s (${Math.round(RLT.u * 100)}%) · ${rlKeys().length} keys`;
  const box = document.getElementById('rlTicks');
  if (box) for (const d of box.children) d.classList.toggle('near', Math.abs((+d.dataset.t || 0) - RLT.u) <= 0.015);
}
// Real (or playing) reloads follow the keys; while scrubbing by hand the working pose stays what you are dragging.
export function ikTimelineApply() {
  if (ikCtx.key?.endsWith(':reload') && (!RLT.on || RLT.playing)) ikEvalTimeline(rlCurU());
}
export function startRlTimeline() {
  if (!STATE.ready || RLT.on || game.active || LADDER.active) return;
  if (motionPreview.active) stopMotionPreview();
  const c = W.cur;
  const u0 = (KA.on && KA.kind === 'reload') ? KA.t : RL.on ? RL.t : 0;
  KA.on = false; RL.on = false;
  RLT.on = true; RLT.u = clamp(u0, 0, 0.999); RLT.playing = false;
  const playBtn = document.getElementById('rlPlay'); if (playBtn) playBtn.textContent = '▶ Play';
  releaseFire(); STATE.trigStart = -1;
  if (c.kar) Object.assign(KA, { on: true, kind: 'reload', t: RLT.u, ev: {}, pending: -1, dur: KA_DEF.reload.dur });
  else {
    RL.pending = -1; RL.empty = RLT.empty; RL.on = true; RL.t = RLT.u; RL.ev = {}; RL.rack = 0; RL.frame = null;
    RL.external = null; RL.loading = false; RL.externalEvents = null;
    RL.key = c.clips ? (RL.empty ? c.clips.empty : c.clips.tac) : (c.rl ? (RL.empty ? c.rl.empty : c.rl.tac) : null);
    RL.dur = rlDuration();
    if (c.mag) c.mag.visible = true;
    if (c.warhead) c.warhead.visible = true;
  }
  document.getElementById('rlTimeline').classList.remove('hidden');
  document.getElementById('rlTimelineBtn').classList.add('active');
  document.getElementById('rlTitle').textContent = 'Reload Smart Timeline — ' + c.label;
  document.getElementById('rlEmpty').style.display = (c.clips || c.rl) ? '' : 'none';
  document.getElementById('rlEmpty').textContent = RLT.empty ? 'Empty reload' : 'Tactical reload';
  rlRenderChips();
  if (!ikEdit.on) { RLT.openedIK = true; toggleIKEdit(true); }
  if (!ikEdit.sel || ikEdit.sel === 'foot_l') selectIK(c.kar ? 'hand_r' : 'hand_l');
  ikCtx.key = null; ikSyncContext();
}
export function stopRlTimeline(switching = false) {
  if (!RLT.on) return;
  RLT.on = false; RLT.playing = false;
  const c = W.cur;
  if (KA.on && KA.kind === 'reload') { KA.on = false; KA.lift = KA.pull = 0; KA.clipState = 'none'; if (STATE.kar?.clip) STATE.kar.clip.visible = false; }
  if (RL.on) {
    RL.on = false; RL.env = 0; RL.frame = null; RL.mag = null; RL.gripPump = false;
    if (c.mag) c.mag.visible = true;
    c.locked = false;
    if (c.pump) c.pump.position.z = 0;
    if (c.sgBolt) c.sgBolt.position.z = 1.5;
    if (c.warhead) c.warhead.visible = true;
  }
  if (!switching) {
    document.getElementById('rlTimeline').classList.add('hidden');
    document.getElementById('rlTimelineBtn').classList.remove('active');
    if (RLT.openedIK && ikEdit.on) toggleIKEdit(false);
    RLT.openedIK = false;
  }
  ikCtx.key = null;
}
