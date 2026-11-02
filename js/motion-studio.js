import * as THREE from 'three';
import { V, angWrap } from './math.js';
import { STATE } from './state.js';
import { camera, charRoot, controls } from './scene.js';
import { READY_MOTIONS, bones, makeSourceInRestPose, restWorldPos, worldPos } from './skeleton.js';
import { applyPreviewLimbIK, ikBase, ikEdit, ikSyncContext, syncIKHandles, userIK } from './ik.js';
import { RLT, stopRlTimeline } from './reload-timeline.js';
import { LADDER, charPos, ladderAnchorForState, retargetFrame, slingWeaponOnBack, solveLadderIK } from './locomotion.js';
import { W, equip, gunState, setGunMatrix } from './weapons.js';
import { lastPlaced, tmpM, updateCharacter } from './character.js';
import { game } from './game.js';
import { fbx } from './main.js';

export const motionPreview = { active: false, playing: true, loop: true, speed: 1, time: 0, profile: null, cache: new Map(), token: 0, uiT: 0 };
function buildMotionProfile(anim, keepRoot = false) {
  anim.position.copy(STATE.mannequinRoot.position);
  anim.rotation.copy(STATE.mannequinRoot.rotation);
  anim.scale.copy(STATE.mannequinRoot.scale);
  anim.updateMatrixWorld(true);
  const source = makeSourceInRestPose(STATE.mannequinRoot, anim, {});
  const required = ['pelvis', 'spine_01', 'upperarm_l', 'upperarm_r', 'thigh_l', 'thigh_r', 'hand_l', 'hand_r'];
  const missing = required.filter(n => !source.abones[n]);
  if (missing.length) throw new Error('Incompatible skeleton. Missing: ' + missing.join(', '));
  if (source.list.length < 30) throw new Error('Only ' + source.list.length + ' matching bones were found; expected at least 30.');
  const sourcePelvisY = worldPos(source.abones.pelvis).y;
  source.ratio = Math.abs(sourcePelvisY) > 0.001 ? restWorldPos.pelvis.y / sourcePelvisY : 1;
  source.mPelvis0 = restWorldPos.pelvis.clone();
  source.aPelvis0 = worldPos(source.abones.pelvis);
  source.mFoot0 = { l: restWorldPos.foot_l.clone(), r: restWorldPos.foot_r.clone() };
  source.anim = anim;
  source.keepRoot = keepRoot;
  const original = anim.animations?.[0];
  if (!original || !original.tracks?.length) throw new Error('This FBX does not contain a playable animation clip.');
  const clip = original.clone();
  if (!keepRoot) clip.tracks = clip.tracks.filter(t => !t.name.startsWith('root.'));
  if (!clip.tracks.length) throw new Error('The animation contains no usable body tracks.');
  // Some Unreal pose exports are a single sampled frame (duration 0). Keep these usable as
  // a held pose instead of rejecting them as an invalid animation.
  const lastKey = Math.max(0, ...clip.tracks.map(t => t.times?.length ? t.times[t.times.length - 1] : 0));
  clip.duration = Math.max(original.duration || 0, lastKey, 1 / 30);
  source.clip = clip; source.dur = clip.duration;
  source.mixer = new THREE.AnimationMixer(anim);
  source.mixer.clipAction(clip).play();
  source.matchedBones = source.list.length;
  return source;
}
export async function getMotionProfile(id) {
  if (motionPreview.cache.has(id)) return motionPreview.cache.get(id);
  const item = READY_MOTIONS.find(x => x.id === id);
  if (!item) throw new Error('Unknown animation selection.');
  const basePath = item.dir || 'animation%20ready%20to%20use/';
  const anim = await fbx.loadAsync(basePath + encodeURIComponent(item.file));
  const profile = buildMotionProfile(anim, !!item.keepRoot);
  profile.label = item.label;
  profile.ladderState = item.ladderState || null;
  motionPreview.cache.set(id, profile);
  return profile;
}
export function renderMotionFrame() {
  if (!motionPreview.active || !motionPreview.profile) return;
  const p = motionPreview.profile, t = Math.min(motionPreview.time, p.dur);
  charRoot.position.set(0, 0, 0); charRoot.rotation.set(0, 0, 0); charRoot.updateMatrixWorld(true);
  ikSyncContext();
  retargetFrame(t, null, p, true);
  const cur = W.cur;
  if (p.ladderState) {
    const u = p.dur > 0 ? t / p.dur : 0;
    const { anchorPos, anchorYaw } = ladderAnchorForState(p.ladderState);
    solveLadderIK(p.ladderState, u, anchorPos, anchorYaw, false);
    slingWeaponOnBack(cur);
    const pelChar = worldPos(bones.pelvis);
    const wPos = LADDER.toWorld(anchorPos), wYaw = angWrap(LADDER.yaw + anchorYaw);
    charRoot.position.copy(wPos); charRoot.rotation.set(0, wYaw, 0); charRoot.updateMatrixWorld(true);
    const trackPos = wPos.clone().add(V(pelChar.x, pelChar.y - 97.4, pelChar.z).applyAxisAngle(V(0, 1, 0), wYaw));
    const d = trackPos.clone().sub(lastPlaced); lastPlaced.copy(trackPos);
    if (!game.active) { camera.position.add(d); controls.target.add(d); }
    return;
  }
  applyPreviewLimbIK();   // manual Edit-IK fixes for this motion (feet, knees, hands, elbows, pelvis)
  if (cur?.obj && cur.inHand) {
    if (cur.obj.parent !== charRoot) charRoot.add(cur.obj);
    Object.values(W.list).forEach(w => { w.obj.visible = (w === cur); });
    bones.hand_r.updateWorldMatrix(true, false);
    const attached = new THREE.Matrix4().multiplyMatrices(bones.hand_r.matrixWorld, cur.inHand);
    ikBase.gun.setFromMatrixPosition(attached);
    if (userIK.gun.lengthSq() > 0 || Math.abs(userIK.gunQ.w) < 0.999999) {
      const o = ikBase.gun, u = userIK.gun;
      attached.premultiply(tmpM.makeTranslation(-o.x, -o.y, -o.z)).premultiply(tmpM.makeRotationFromQuaternion(userIK.gunQ))
        .premultiply(tmpM.makeTranslation(o.x + u.x, o.y + u.y, o.z + u.z));
    }
    setGunMatrix(attached);
    cur.obj.matrixAutoUpdate = false;
    cur.obj.matrix.copy(gunState.mat);
    cur.obj.matrixWorldNeedsUpdate = true;
  }
  charRoot.position.copy(charPos); charRoot.rotation.set(0, STATE.charYaw, 0); charRoot.updateMatrixWorld(true);
  const d = charPos.clone().sub(lastPlaced); lastPlaced.copy(charPos);
  if (!game.active) { camera.position.add(d); controls.target.add(d); }
  if (ikEdit.on) syncIKHandles();
}
export function stopMotionPreview() {
  motionPreview.token++; motionPreview.active = false; motionPreview.playing = true; motionPreview.profile = null;
  document.getElementById('motionPanel').classList.add('hidden');
  document.getElementById('motionLibrary').classList.remove('active');
  if (STATE.ready) {
    charRoot.position.set(0, 0, 0); charRoot.rotation.set(0, 0, 0); charRoot.updateMatrixWorld(true);
    equip(W.cur);
    updateCharacter(0);
  }
}
export async function previewMotionSelection() {
  if (!STATE.ready) return;
  if (typeof RLT !== 'undefined' && RLT.on) stopRlTimeline();
  const id = document.getElementById('motionSelect').value;
  const token = ++motionPreview.token;
  const status = document.getElementById('motionStatus');
  const play = document.getElementById('motionPlay');
  status.textContent = 'Loading FBX and preparing mannequin retarget…';
  play.disabled = true;
  try {
    const profile = await getMotionProfile(id);
    if (token !== motionPreview.token) return;
    motionPreview.profile = profile; motionPreview.active = true; motionPreview.playing = true; motionPreview.time = 0;
    charRoot.position.set(0, 0, 0); charRoot.rotation.set(0, 0, 0); charRoot.updateMatrixWorld(true);
    Object.values(W.list).forEach(w => { w.obj.visible = false; });
    renderMotionFrame();
    play.textContent = 'Ⅱ Pause'; play.disabled = false;
    status.textContent = `Ready · ${profile.matchedBones} bones matched · ${profile.dur.toFixed(2)} s`;
    document.getElementById('motionTime').textContent = `0.00 / ${profile.dur.toFixed(2)} s`;
    document.getElementById('motionBar').style.width = '0%';
  } catch (err) {
    if (token !== motionPreview.token) return;
    motionPreview.active = false; motionPreview.profile = null;
    play.disabled = false; status.textContent = 'Could not load this animation: ' + (err?.message || err);
    if (STATE.ready && W.cur) { equip(W.cur); updateCharacter(0); }
    console.error('Animation preview failed:', err);
  }
}
export function updateMotionPreview(dt) {
  const p = motionPreview.profile;
  if (!motionPreview.active || !p) return;
  if (motionPreview.playing) {
    motionPreview.time += dt * motionPreview.speed;
    if (motionPreview.time >= p.dur) {
      if (motionPreview.loop) motionPreview.time %= p.dur;
      else { motionPreview.time = p.dur; motionPreview.playing = false; document.getElementById('motionPlay').textContent = '▶ Play'; }
    }
  }
  if (motionPreview.playing || ikEdit.on) renderMotionFrame();   // keep re-rendering while editing so handle drags show live
  motionPreview.uiT += dt;
  if (motionPreview.uiT >= 0.08) {
    motionPreview.uiT = 0;
    document.getElementById('motionBar').style.width = (100 * motionPreview.time / p.dur).toFixed(2) + '%';
    document.getElementById('motionTime').textContent = `${motionPreview.time.toFixed(2)} / ${p.dur.toFixed(2)} s`;
  }
}
