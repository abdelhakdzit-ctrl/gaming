import * as THREE from 'three';
import { DEG, Spring, V, clamp, lerp, rayBox, sstep } from './math.js';
import { IS_TOUCH, STATE, rec } from './state.js';
import { camera, controls, renderer, scene, setAtmosphere } from './scene.js';
import { audio, playHit, setMuffle, sfxBus, startAmbient, stepHeartbeat, stopAmbient } from './audio.js';
import { burst, impactFX, tracerFX } from './fx.js';
import { ikEdit, toggleIKEdit } from './ik.js';
import { RLT, stopRlTimeline } from './reload-timeline.js';
import { LADDER, charPos, mm, toWorld, toWorldDir } from './locomotion.js';
import { KA, RL, W, box, fromGun, gunState, pressFire, releaseFire } from './weapons.js';
import { aim, isAiming, lastPlaced, playerAim, playerCrouch, tmpM, tmpQ } from './character.js';
import { motionPreview, stopMotionPreview } from './motion-studio.js';
import { AI, ARENA, castWorld, onEnemyHit, startAI, stopAI, suppressNear } from './ai.js';
import { Damp, feel, shake, stepBloom, stepShake } from './gameplay/juice.js';
import { addDamageIndicator, clearIndicators, onKill, onPlayerDamaged, resetDirector, summaryHTML, updateDirector, updateIndicators } from './gameplay/director.js';
import { goFullscreen, leaveFullscreen, setView, touch } from './ui.js';

// ======================================================================
//  GAME DEMO  third-person aim trainer: steel plates + falling poppers, hitscan from the real barrel
// ======================================================================
export const game = { active: false, state: 'off', time: 60, score: 0, hits: 0, shots: 0, heads: 0 };
export const tps = { yaw: 0, pitch: -0.04, z: 0, zoom: false, aimStage: 0 };
const rmbState = { down: false, t0: 0, fromIdle: false, fired: false };
export function setAimStage(stage) {
  const maxStage = W.cur?.scope ? 2 : 1;
  const next = clamp(stage | 0, 0, maxStage);
  tps.aimStage = next;
  tps.zoom = next > 0;
  if (next === 0) {
    releaseFire();
    document.body.classList.remove('scoped');
    if (W.cur?.obj) W.cur.obj.visible = true;
  }
  const tAim = document.getElementById('tAim');
  if (tAim) {
    tAim.classList.toggle('on', next > 0);
    tAim.textContent = next === 2 ? 'SCOPE' : 'AIM';
  }
}
export function cycleAimStage() {
  const steps = W.cur?.scope ? 3 : 2;
  setAimStage((tps.aimStage + 1) % steps);
}
export const TGROUP = new THREE.Group(); TGROUP.visible = false; scene.add(TGROUP);
export const targets = [], hittables = [];
function plateTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#e9e4d8'; g.fillRect(0, 0, 256, 256);
  for (const [r, col] of [[118, '#d8452f'], [92, '#e9e4d8'], [66, '#d8452f'], [40, '#e9e4d8'], [18, '#151515']]) {
    g.fillStyle = col; g.beginPath(); g.arc(128, 128, r, 0, Math.PI * 2); g.fill();
  }
  return new THREE.CanvasTexture(c);
}
const steelMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.4, metalness: 0.8 });
const plateFace = new THREE.MeshStandardMaterial({ map: plateTexture(), roughness: 0.6, metalness: 0.2 });
const popperMat = new THREE.MeshStandardMaterial({ color: 0xd07a32, roughness: 0.55, metalness: 0.4 });
const standMat = new THREE.MeshStandardMaterial({ color: 0x3b3f45, roughness: 0.8 });
const holeGeo = new THREE.CircleGeometry(0.9, 10), holeMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
function holeMesh(parent) {   // up to 40 bullet holes per target in one draw call
  const m = new THREE.InstancedMesh(holeGeo, holeMat, 40); m.count = 0; m.frustumCulled = false; parent.add(m); return m;
}
function addPlate(x, z, h, r, move = 0) {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.lookAt(0, 0, 0); TGROUP.add(g);
  g.add(box(4, h + 6, 4, standMat, 0, (h + 6) / 2, -6));
  g.add(box(r * 2 + 12, 3, 3, standMat, 0, h + 4, -4));
  const hinge = new THREE.Group(); hinge.position.set(0, h + 2, 0); g.add(hinge);
  hinge.add(box(0.6, 8, 0.6, steelMat, 0, -4, 0));
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1.4, 40), [steelMat, plateFace, steelMat]);
  plate.rotation.x = Math.PI / 2; plate.position.y = -8 - r; plate.castShadow = true; hinge.add(plate);
  const t = { kind: 'plate', g, hinge, mesh: plate, r, x0: x, move, swing: new Spring(1.4, 0.12), holes: holeMesh(plate), holeN: 0 };
  plate.userData.target = t; hittables.push(plate); targets.push(t);
}
function popperShape() {
  const s = new THREE.Shape();
  s.moveTo(-23, 0); s.lineTo(23, 0); s.lineTo(23, 60); s.quadraticCurveTo(23, 70, 10, 72); s.lineTo(7, 72); s.lineTo(7, 76);
  s.absarc(0, 88, 12, -Math.PI * 0.3, Math.PI * 1.3, false); s.lineTo(-7, 76); s.lineTo(-7, 72); s.lineTo(-10, 72);
  s.quadraticCurveTo(-23, 70, -23, 60); s.lineTo(-23, 0);
  return s;
}
function addPopper(x, z, move = 0) {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.lookAt(0, 0, 0); TGROUP.add(g);
  g.add(box(40, 30, 14, standMat, 0, 15, -4));
  const pivot = new THREE.Group(); pivot.position.set(0, 30, 0); g.add(pivot);
  const geo = new THREE.ExtrudeGeometry(popperShape(), { depth: 1.2, bevelEnabled: false }); geo.translate(0, 0, -0.6);
  const mesh = new THREE.Mesh(geo, popperMat); mesh.castShadow = true; pivot.add(mesh);
  const t = { kind: 'popper', g, pivot, mesh, x0: x, move, down: false, timer: 0, fall: new Spring(2.2, 0.38), holes: holeMesh(mesh), holeN: 0 };
  mesh.userData.target = t; hittables.push(mesh); targets.push(t);
}
[[-150, 650, 120, 22], [130, 900, 130, 18], [-380, 1300, 140, 26], [320, 1700, 150, 30, 160], [0, 2300, 160, 34]].forEach(a => addPlate(...a));
[[260, 820], [-260, 1050, 170], [60, 1500], [-520, 1850], [480, 1250, 120]].forEach(a => addPopper(...a));

function resetTargets() {
  for (const t of targets) {
    if (t.kind === 'plate') { t.swing.x = t.swing.v = 0; } else { t.down = false; t.fall.target = 0; t.fall.x = t.fall.v = 0; }
    t.holeN = 0; t.holes.count = 0;
  }
}
export function updateTargets(dt) {
  if (!TGROUP.visible) return;
  for (const t of targets) {
    if (t.move) { t.g.position.x = t.x0 + t.move * Math.sin(STATE.simTime * 0.9 + t.x0); }
    if (t.kind === 'plate') { t.swing.step(dt); t.hinge.rotation.x = t.swing.x; }
    else {
      if (t.down && (t.timer -= dt) <= 0) { t.down = false; t.fall.target = 0; }
      t.fall.step(dt); t.pivot.rotation.x = Math.max(-1.55, t.fall.x);
    }
  }
}
export const ray = new THREE.Raycaster();
// Player hitscan from the real muzzle: targets, cover, enemies, ground (castWorld is in the COMBAT section).
export function shootRay(o, d, customDmg = null) {
  game.shots++;
  const h = castWorld(o, d, 9000);
  if (h.kind === 'target') onTargetHit(h.hit, d);
  else if (h.kind === 'enemy') onEnemyHit(h.e, h.part, h.point, d, customDmg);
  else if (h.kind === 'cover') impactFX(h.point, h.n, h.cover.kind === 'crate' ? 'wood' : 'concrete');
  else if (h.kind === 'ground') impactFX(h.point, h.n, 'ground');
  else h.point.copy(o).addScaledVector(d, 6000);
  tracerFX(o.clone().addScaledVector(d, 30), h.point, true);
  if (AI.on) suppressNear(o, d, h.t);
}
function onTargetHit(hit, d) {
  const t = hit.object.userData.target, n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : d.clone().negate();
  burst(hit.point, n, 0xffffff);
  const ln = hit.face ? hit.face.normal : V(0, 0, 1), H = t.holes;
  H.setMatrixAt(t.holeN % 40, tmpM.compose(hit.object.worldToLocal(hit.point.clone()).addScaledVector(ln, 0.05), tmpQ.setFromUnitVectors(V(0, 0, 1), ln), V(1, 1, 1)));
  t.holeN++; H.count = Math.min(40, t.holeN); H.instanceMatrix.needsUpdate = true;
  if (game.state !== 'play') return;
  let pts = 0, head = false;
  if (t.kind === 'plate') {
    t.swing.kick(0.3 + 0.1 * Math.random());
    const dist = hit.distance;
    pts = 100 + Math.round(dist / 20);
    playDing(dist / 34300, 900 + 1800 * (20 / t.r));
  } else if (!t.down) {
    head = t.mesh.worldToLocal(hit.point.clone()).y > 75;
    t.down = true; t.timer = 2.6; t.fall.target = -1.5; t.fall.kick(-0.6);
    pts = head ? 150 : 100; if (head) game.heads++;
    playDing(hit.distance / 34300, 520);
  }
  if (!pts) return;
  game.hits++; game.score += pts;
  hitMarker(head);
  popup((head ? 'HEAD +' : '+') + pts, hit.point);
}
export function hitMarker(head, kill = false) {
  const m = document.getElementById('hm'); m.className = ''; void m.offsetWidth;   // restart the pop animation on every hit
  m.className = 'on' + (head ? ' head' : '') + (kill ? ' kill' : '');
  if (game.mode === 'ai' && !head && !kill) playHit('hit');
  clearTimeout(hitMarker.t); hitMarker.t = setTimeout(() => (m.className = head ? 'head' : ''), kill ? 220 : 110);
}
export function popup(text, p) {
  const isKill = game.mode === 'ai' && /^(HEADSHOT|KILL|BLAST KILL)/.test(text);
  if (isKill) {
    const head = text[0] === 'H', mult = onKill(p, head, game);
    hitMarker(head, true);
    if (mult > 1) text += `  x${mult}`;
  }
  const s = p.clone().project(camera); if (s.z > 1) return;
  const el = document.createElement('div'); el.className = 'pop' + (isKill ? (text[0] === 'H' ? ' head' : ' kill') : ''); el.textContent = text;
  el.style.left = ((s.x + 1) / 2 * innerWidth) + 'px'; el.style.top = ((1 - s.y) / 2 * innerHeight) + 'px';
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.transform = 'translateY(-40px)'; el.style.opacity = '0'; });
  setTimeout(() => el.remove(), 900);
}
export function playDing(delay, f) {
  if (!STATE.soundOn) return;
  const ac = audio(); if (!ac) return;
  const t = ac.currentTime + delay;
  for (const [mul, gain, dec] of [[1, 0.25, 0.9], [2.76, 0.12, 0.5], [5.4, 0.05, 0.25]]) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = f * mul; g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0005, t + dec);
    o.connect(g).connect(sfxBus); o.start(t); o.stop(t + dec + 0.05);
  }
}

const fmtTime = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// Third-person camera over the shoulder: critically damped follow/offsets, collision against cover, FOV curves, shake.
const cam = { px: new Damp(), py: new Damp(), pz: new Damp(), side: new Damp(1), sideOff: new Damp(48), up: new Damp(160), dist: new Damp(170), fov: new Damp(50), z: new Damp(0), shoulder: 1, init: false, t: 0 };
export function resetCamera() { cam.init = false; cam.dist.snap(170); }
export function swapShoulder() { cam.shoulder = -cam.shoulder; }
const _head = V(), _lat = V();
export function updateGameCamera(real) {
  real = Math.min(real, 0.05); cam.t += real;
  tps.z = clamp(cam.z.step(tps.zoom ? 1 : 0, 0.11, real), 0, 1);
  const e = tps.z * tps.z * (3 - 2 * tps.z);   // smoothstep curve over the damped zoom
  const p = tps.pitch + rec.cam.x * DEG;
  const fwd = V(Math.sin(tps.yaw) * Math.cos(p), Math.sin(p), Math.cos(tps.yaw) * Math.cos(p));
  const right = V(-Math.cos(tps.yaw), 0, Math.sin(tps.yaw));
  const crouchDrop = (playerCrouch?.w || 0) * 34;
  const basePos = LADDER.active ? LADDER.worldTrackPos : charPos;
  const longW = W.blend || (W.cur?.long ? 1 : 0);
  if (!cam.init || Math.hypot(basePos.x - cam.px.x, basePos.z - cam.pz.x) > 250) { cam.px.snap(basePos.x); cam.py.snap(basePos.y); cam.pz.snap(basePos.z); cam.side.snap(cam.shoulder); cam.init = true; }
  const fx = cam.px.step(basePos.x, 0.06, real), fy = cam.py.step(basePos.y, 0.1, real), fz = cam.pz.step(basePos.z, 0.06, real);
  const sideOff = cam.sideOff.step(lerp(lerp(48, 56, longW), lerp(38, 46, longW), e), 0.14, real) * cam.side.step(cam.shoulder, 0.16, real);
  const upOff = cam.up.step(lerp(160, 157, e) + 4 * longW + Math.max(0, p) * 16 - crouchDrop, 0.12, real);
  _head.set(fx, fy + upOff, fz);
  _lat.copy(right).multiplyScalar(sideOff);
  let lat = _lat.length(), latDir = V(Math.sign(sideOff) * right.x, 0, Math.sign(sideOff) * right.z);
  const arena = ARENA.group.visible;
  if (arena) for (const cv of ARENA.covers) { const h = rayBox(_head, latDir, cv, lat); if (h) lat = Math.max(0, h.t - 10); }   // shoulder never inside cover
  const pivot = _head.clone().addScaledVector(latDir, lat);
  const wantDist = lerp(IS_TOUCH ? 210 : lerp(165, 180, longW), lerp(92, 108, longW), e);
  let limit = wantDist;
  if (arena) {
    const back = fwd.clone().negate();
    for (const cv of ARENA.covers) { const h = rayBox(pivot, back, cv, wantDist); if (h) limit = Math.min(limit, Math.max(25, h.t - 12)); }
  }
  if (fwd.y > 0.02) limit = Math.min(limit, Math.max(25, (pivot.y - 14) / fwd.y));   // camera stays above the ground
  // pull in instantly when blocked, ease back out when clear
  if (limit < cam.dist.x) cam.dist.snap(limit);
  const dist = cam.dist.step(limit, 0.22, real);
  camera.position.copy(pivot).addScaledVector(fwd, -dist);
  camera.lookAt(camera.position.clone().add(fwd));
  // Scoped weapons (Kar98k / RPG-7): 1st right-click (aimStage === 1) aims over the shoulder without scope;
  // 2nd right-click (aimStage === 2) looks through the 6x optic.
  const scoped = tps.aimStage === 2 && tps.z > 0.6 && W.cur.scope && !KA.on && !RL.on && W.swapT < 0;
  document.body.classList.toggle('scoped', !!scoped);
  W.cur.obj.visible = !scoped;
  if (scoped) {
    const eye = toWorld(fromGun(W.cur.scope.clone().add(V(0, 0, 2)))), d = toWorldDir(V(0, 0, 1).applyQuaternion(gunState.q));
    camera.position.copy(eye); camera.lookAt(eye.clone().add(d));
  }
  // FOV: aim zoom curve, sprint widening, kill punch
  const sprintK = sstep(230, 400, mm.speed) * (1 - e);
  feel.fovKick = Math.max(0, feel.fovKick - real * 5);
  const tFov = scoped ? 7 : lerp(50, 34, e) + 7 * sprintK - 2.2 * feel.fovKick;
  const fov = cam.fov.step(tFov, scoped ? 0.04 : 0.09, real);
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  // shake + idle breathing / sprint sway (rotations only, so the aim ray below stays clean)
  stepShake(real, cam.t);
  const k = scoped ? 0.12 : 1, breath = Math.sin(cam.t * 1.25) * 0.0011 * (0.4 + e) * (scoped ? 6 : 1);
  camera.rotateY((shake.yaw + Math.sin(cam.t * 0.8) * 0.0007 * (0.4 + e)) * k);
  camera.rotateX((shake.pitch + breath) * k);
  camera.rotateZ((shake.roll + Math.sin(cam.t * 8.5) * 0.0016 * sprintK) * k);
  const h = castWorld(camera.position, fwd, 9000, scoped ? 20 : dist + 30);   // skip anything between the camera and the player
  aim.point.copy(h.kind !== 'none' ? h.point : camera.position.clone().addScaledVector(fwd, 5000));
  if (aim.point.distanceTo(charPos) < 150) aim.point.copy(camera.position).addScaledVector(fwd, 600);
  aim.smooth.lerp(aim.point, 1 - Math.exp(-25 * real));
}
const fb = { hp: 100, hitT: 0, low: 0, queued: null };   // feedback bookkeeping between frames
export function queueWeapon(name) { fb.queued = W.cur.name === name ? null : name; }
export function updateGame(real) {
  const ai = game.mode === 'ai';
  if (game.state === 'play') { if (ai) game.time += real; else { game.time -= real; if (game.time <= 0) { game.time = 0; endRound(); } } }
  document.getElementById('hTime').textContent = ai ? fmtTime(game.time) : Math.ceil(game.time);
  if (ai) {
    document.getElementById('hpBar').style.transform = `scaleX(${Math.max(0, AI.hp) / 100})`;
    document.getElementById('hWave').textContent = AI.wave;
    document.getElementById('hLeft').textContent = AI.breakT > 0 ? '' : `${Math.max(0, AI.toKill - AI.killed)} left`;
    const hpNow = AI.hp;
    if (hpNow < fb.hp - 0.01) onPlayerDamaged(fb.hp - hpNow);
    fb.hp = hpNow;
    if (AI.hitT !== fb.hitT) { fb.hitT = AI.hitT; if (AI.hitFrom) addDamageIndicator(AI.hitFrom); }
    document.getElementById('dmg').style.opacity = Math.min(1, AI.flash * 0.9).toFixed(3);
    document.getElementById('di0')?.remove();
    updateIndicators(real, tps.yaw);
    const alive = game.state === 'play';
    const low = alive ? clamp((45 - hpNow) / 30, 0, 1) : 0;
    fb.low += (low - fb.low) * (1 - Math.exp(-4 * real));
    const lh = document.getElementById('lowhp');
    lh.style.opacity = fb.low > 0.01 ? (fb.low * (0.55 + 0.3 * Math.sin(STATE.simTime * (5 + 4 * fb.low)))).toFixed(3) : '0';
    renderer.domElement.style.filter = fb.low > 0.03 ? `saturate(${(1 - 0.55 * fb.low).toFixed(2)})` : '';
    setMuffle(alive ? Math.max(fb.low * 0.85, Math.min(0.5, AI.flash * 0.5)) : 0);
    stepHeartbeat(real, fb.low);
    updateDirector(real, game);
    document.getElementById('hLeft').textContent = AI.breakT > 0 ? '' : `${Math.max(0, AI.toKill - AI.killed)} left`;
  }
  if (fb.queued && !RL.on && !KA.on && W.swapT < 0 && game.state === 'play') { const n = fb.queued; fb.queued = null; switchWeapon(n); }
  stepBloom(real, tps.z, mm.speed);
  document.getElementById('hScore').textContent = game.score;
  document.getElementById('hAcc').textContent = game.shots ? Math.round(100 * game.hits / game.shots) + '%' : '-';
  document.getElementById('hWeap').textContent = W.cur.hud;
  document.getElementById('aCur').textContent = RL.on ? '…' : W.cur.ammo;
  document.getElementById('aCap').textContent = W.cur.cap;
  document.getElementById('ammo').classList.toggle('low', W.cur.ammo <= Math.ceil(W.cur.cap * 0.2));
  const spread = 6 + Math.abs(rec.flip.x) * 2.4 + rec.back.x * 2 + mm.speed * 0.03 + (W.swapT >= 0 ? 14 : 0) - tps.z * 3 + feel.bloom * 9;
  const xh = document.getElementById('xh');
  xh.style.setProperty('--s', Math.max(3, spread) + 'px');
  xh.style.opacity = isAiming() ? '1' : '0.28';
}
function showOverlay(title, text, go, alt = null) {
  document.getElementById('ov').classList.remove('hidden');
  document.getElementById('ovTitle').textContent = title;
  document.getElementById('ovText').textContent = text;
  document.getElementById('ovGo').textContent = go;
  const b = document.getElementById('ovAI'); b.style.display = alt ? '' : 'none';
  if (alt) { b.textContent = alt[0]; b.dataset.mode = alt[1]; }
}
function lockPointer() { try { const r = renderer.domElement.requestPointerLock?.(); r?.catch?.(() => {}); } catch (e) { /* no pointer lock: mouse deltas still work */ } }
export function startRound(mode = game.mode || 'trainer') {
  game.mode = mode;
  setAimStage(0); playerAim.rmb = false; playerAim.on = false;
  Object.assign(game, { state: 'play', time: mode === 'ai' ? 0 : 60, score: 0, hits: 0, shots: 0, heads: 0 });
  document.body.classList.toggle('ai', mode === 'ai');
  TGROUP.visible = mode !== 'ai';
  charPos.set(0, 0, 0); STATE.charYaw = 0; lastPlaced.set(0, 0, 0); tps.yaw = 0; tps.pitch = -0.04;
  mm.vel[0] = mm.vel[1] = 0; mm.gaitVel[0] = mm.gaitVel[1] = 0; mm.speed = 0;
  for (const w of Object.values(W.list)) { w.ammo = w.cap + (w.name === 'pistol' ? 1 : 0); w.locked = false; }
  if (mode === 'ai') startAI(); else stopAI();
  resetTargets(); document.getElementById('ov').classList.add('hidden');
}
export function endRound() {
  game.state = 'over'; setAimStage(0); playerAim.rmb = false; document.exitPointerLock?.();
  const acc = game.shots ? Math.round(100 * game.hits / game.shots) : 0;
  if (game.mode === 'ai') showOverlay('You died', `Survived ${fmtTime(game.time)} · reached wave ${AI.wave}\nKills ${AI.kills} (${AI.heads} headshots) · Score ${game.score} · Accuracy ${acc}%`, 'Play again', ['Aim trainer', 'trainer']);
  else showOverlay('Time!', `Score ${game.score}\nHits ${game.hits} / ${game.shots} shots (${acc}%)  ·  Headshots ${game.heads}`, 'Play again', ['VS AI', 'ai']);
}
export function enterGame() {
  if (!STATE.ready) return;
  if (RLT.on) stopRlTimeline();
  if (motionPreview.active) stopMotionPreview();
  if (ikEdit.on) toggleIKEdit(false);
  setAimStage(0); playerAim.rmb = false; playerAim.on = false;
  game.active = true; game.state = 'ready';
  document.body.classList.add('gaming'); document.getElementById('hud').classList.remove('hidden');
  TGROUP.visible = true; controls.enabled = false; controls.autoRotate = false; STATE.demoOn = false;
  charPos.set(0, 0, 0); STATE.charYaw = 0; lastPlaced.set(0, 0, 0); tps.yaw = 0; tps.pitch = -0.04;
  scene.fog.near = 2500; scene.fog.far = 9000;
  showOverlay('Choose a mode', 'Aim trainer: 60 s on steel plates and poppers.\nVS AI: tactical squad patrols, searches your last position, hesitates, plans flanks & ambushes. Use cover and survive!\n' +
    (IS_TOUCH ? 'Left thumb: move (push further to run) · Right thumb: look\nAIM to raise weapon (2nd tap for Scope) · FIRE to shoot · R reload · ⇄ weapon'
              : 'Tip: Right-Click (RMB) to Aim — on Sniper, 1st Right-Click aims without scope, 2nd Right-Click opens Scope. Left-Click (LMB) to Fire.'), 'Aim trainer', ['VS AI', 'ai']);
}
function exitGame() {
  game.active = false; game.state = 'off'; setAimStage(0); playerAim.rmb = false; document.exitPointerLock?.(); leaveFullscreen();
  touch.mv.id = null; touch.look.clear();
  document.body.classList.remove('gaming'); document.getElementById('hud').classList.add('hidden');
  TGROUP.visible = false; controls.enabled = true; stopAI();
  document.body.classList.remove('scoped', 'ai'); W.cur.obj.visible = true;
  document.getElementById('aimMode')?.classList.toggle('active', isAiming());
  document.getElementById('normalMode')?.classList.toggle('active', !isAiming());
  scene.fog.near = 600; scene.fog.far = 1400; camera.fov = 40; camera.updateProjectionMatrix();
  setView('photo');
}
document.getElementById('ovGo').onclick = () => {
  if (IS_TOUCH) goFullscreen(); else lockPointer();
  if (game.state === 'paused') { game.state = 'play'; document.getElementById('ov').classList.add('hidden'); } else startRound(game.state === 'ready' ? 'trainer' : game.mode);
};
document.getElementById('ovAI').onclick = e => { if (IS_TOUCH) goFullscreen(); else lockPointer(); startRound(e.currentTarget.dataset.mode || 'ai'); };
document.getElementById('ovExit').onclick = exitGame;
export function pauseGame() {
  if (game.state !== 'play') return;
  game.state = 'paused'; setAimStage(0); playerAim.rmb = false;
  touch.mv.id = null; touch.look.clear(); document.getElementById('joy').style.display = 'none';
  showOverlay('Paused', IS_TOUCH ? 'Tap Resume to continue.' : 'Click Resume to continue.', 'Resume');
}
document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement && game.active && !IS_TOUCH) pauseGame(); });
addEventListener('mousemove', e => {
  if (!game.active || game.state !== 'play') return;
  const k = 0.0022 * lerp(1, 0.6, tps.z) * (document.body.classList.contains('scoped') ? 0.25 : 1);
  tps.yaw -= e.movementX * k;
  tps.pitch = clamp(tps.pitch - e.movementY * k, -0.75, 0.6);
});
addEventListener('mousedown', e => {
  if (game.active) {
    if (game.state !== 'play') return;
    if (e.button === 2) {
      rmbState.down = true;
      rmbState.t0 = performance.now();
      rmbState.fired = false;
      if (W.cur?.scope) {
        rmbState.fromIdle = false;
        cycleAimStage();   // 0 (Idle) -> 1 (Aim without scope) -> 2 (Aim with scope) -> 0 (Idle)
      } else {
        rmbState.fromIdle = tps.aimStage === 0;
        setAimStage(tps.aimStage === 0 ? 1 : 0);
      }
    }
    if (e.button === 0) {
      if (rmbState.down) rmbState.fired = true;
      if (isAiming()) pressFire();
    }
    return;
  }
  if (e.button === 2 && e.target === renderer.domElement) {
    rmbState.down = true;
    rmbState.t0 = performance.now();
    rmbState.fromIdle = !isAiming();
    if (playerAim.on && !playerAim.rmb) {
      playerAim.on = false;
      playerAim.rmb = false;
    } else {
      playerAim.rmb = !playerAim.rmb;
    }
    document.getElementById('aimMode')?.classList.toggle('active', isAiming());
    document.getElementById('normalMode')?.classList.toggle('active', !isAiming());
  }
});
addEventListener('mouseup', e => {
  if (e.button === 0) releaseFire();
  if (e.button === 2) {
    const heldMs = performance.now() - rmbState.t0;
    if (game.active) {
      if (!W.cur?.scope && rmbState.down && rmbState.fromIdle && (heldMs >= 240 || rmbState.fired)) {
        setAimStage(0);
      }
    } else if (rmbState.down && rmbState.fromIdle && heldMs >= 240) {
      playerAim.rmb = false;
      document.getElementById('aimMode')?.classList.toggle('active', isAiming());
      document.getElementById('normalMode')?.classList.toggle('active', !isAiming());
    }
    rmbState.down = false;
    rmbState.fromIdle = false;
    rmbState.fired = false;
  }
});
addEventListener('contextmenu', e => { if (game.active || e.target === renderer.domElement) e.preventDefault(); });
