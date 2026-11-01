import { V, clamp, lerp } from './math.js';
import { IS_TOUCH, STATE, params } from './state.js';
import { camera, controls, renderer } from './scene.js';
import { bones, worldPos } from './skeleton.js';
import { updateFX } from './fx.js';
import { ikDbg, ikEdit, ikState, setIKMode, toggleIKEdit } from './ik.js';
import { RLT, rlClearKeys, rlDeleteKey, rlJump, rlSetKey, rlSetU, startRlTimeline, stopRlTimeline } from './reload-timeline.js';
import { charPos, keys, mm, toWorld, toggleLadder, turnOff } from './locomotion.js';
import { KA, RL, W, fire, fromGun, gunState, nextWeapon, pressFire, pullTrigger, releaseFire, startKarAction, startReload, switchWeapon } from './weapons.js';
import { aim, isAiming, lastPlaced, placeCharacter, playerAim, playerCrouch, setAimMode, toggleAimMode, toggleCrouch, updateCharacter } from './character.js';
import { motionPreview, previewMotionSelection, renderMotionFrame, stopMotionPreview } from './motion-studio.js';
import { updateAI } from './ai.js';
import { cycleAimStage, enterGame, game, pauseGame, queueWeapon, setAimStage, startRound, swapShoulder, targets, tps, updateGame, updateGameCamera, updateTargets } from './game.js';
import { capsuleMeshes } from './main.js';

// ======================================================================
//  MOBILE  fullscreen landscape play: left stick moves (push to the rim = run), drag anywhere on the
//  right to aim, FIRE (hold for full-auto; drag while holding to keep aiming), AIM zoom, R reload, ⇄ swap.
// ======================================================================
export const touch = { mv: { id: null, ox: 0, oy: 0, x: 0, y: 0, m: 0 }, look: new Map(), run: false };
if (IS_TOUCH) document.body.classList.add('touch');
export function goFullscreen() {
  const el = document.documentElement, rq = el.requestFullscreen || el.webkitRequestFullscreen;
  try { const r = rq?.call(el, { navigationUI: 'hide' }); r?.catch?.(() => {}); } catch (e) { /* not allowed */ }
  try { screen.orientation?.lock?.('landscape')?.catch?.(() => {}); } catch (e) { /* not supported */ }
}
export function leaveFullscreen() { if (document.fullscreenElement) document.exitFullscreen?.().catch?.(() => {}); }
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && game.active && IS_TOUCH) pauseGame(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && game.active) pauseGame(); });
(() => {
  const el = document.getElementById('touch'), joy = document.getElementById('joy'), knob = joy.firstElementChild;
  const playing = () => game.active && game.state === 'play';
  const R = 65;
  const btn = (id, down, up) => {
    const b = document.getElementById(id);
    b.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); b.classList.add('down'); if (playing()) down(e); });
    const end = e => { b.classList.remove('down'); up?.(e); };
    b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end);
  };
  // FIRE also starts an aim drag with the same finger.
  btn('tFire', e => { if (isAiming()) pressFire(); touch.look.set(e.pointerId, { x: e.clientX, y: e.clientY, fire: true }); },
    e => { releaseFire(); touch.look.delete(e.pointerId); });
  btn('tAim', () => cycleAimStage());
  btn('tReload', () => startReload());
  btn('tSwap', () => nextWeapon());
  btn('tRun', () => { touch.run = !touch.run; document.getElementById('tRun').classList.toggle('on', touch.run); });
  btn('tCrouch', () => { toggleCrouch(); document.getElementById('tCrouch').classList.toggle('on', playerCrouch.on); });
  btn('tLadder', () => { setAimStage(0); toggleLadder(); });
  btn('tPause', () => pauseGame());
  document.getElementById('tFull').addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); document.fullscreenElement ? leaveFullscreen() : goFullscreen(); });
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (!playing()) return;
    el.setPointerCapture?.(e.pointerId);
    if (e.clientX < innerWidth * 0.42 && touch.mv.id === null) {
      Object.assign(touch.mv, { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: 0, y: 0, m: 0 });
      joy.style.display = 'block'; joy.style.left = e.clientX + 'px'; joy.style.top = e.clientY + 'px';
      knob.style.transform = '';
    } else touch.look.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  addEventListener('pointermove', e => {
    if (e.pointerId === touch.mv.id) {
      let dx = e.clientX - touch.mv.ox, dy = e.clientY - touch.mv.oy;
      const d = Math.hypot(dx, dy); if (d > R) { dx *= R / d; dy *= R / d; }
      Object.assign(touch.mv, { x: dx / R, y: dy / R, m: Math.min(d, R * 1.2) / R });
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      return;
    }
    const l = touch.look.get(e.pointerId);
    if (!l || !playing()) return;
    const k = 0.0052 * lerp(1, 0.55, tps.z);
    tps.yaw -= (e.clientX - l.x) * k;
    tps.pitch = clamp(tps.pitch - (e.clientY - l.y) * k * 0.8, -0.75, 0.6);
    l.x = e.clientX; l.y = e.clientY;
  });
  const end = e => {
    if (e.pointerId === touch.mv.id) { touch.mv.id = null; touch.mv.m = 0; joy.style.display = 'none'; }
    const l = touch.look.get(e.pointerId); if (l?.fire) releaseFire();
    touch.look.delete(e.pointerId);
  };
  addEventListener('pointerup', end); addEventListener('pointercancel', end);
})();

// ---------- views ----------
export const views = {
  photo: [V(-250, 150, -290), V(0, 92, 20)],
  front: [V(0, 120, 360), V(0, 92, 0)],
  back:  [V(0, 120, -360), V(0, 92, 0)],
  left:  [V(360, 120, 10), V(0, 92, 10)],
  right: [V(-360, 120, 10), V(0, 92, 10)],
  top:   [V(0.01, 420, 10), V(0, 60, 10)],
};
export function setView(name) {
  if (name === 'gripL' || name === 'gripR' || name === 'shoulder') {
    setAimMode(true);
    playerAim.w = 1;
    if (STATE.ready) { updateCharacter(0); placeCharacter(); }
  }
  let pair = views[name] || views.photo;
  if (STATE.ready && W.cur) {
    if (name === 'shoulder') {
      pair = W.cur.long ? [V(-52, 164, -112), V(-18, 150, 145)] : [V(-44, 160, -96), V(-12, 148, 120)];
    } else if (name === 'gripL') {
      const g = fromGun(W.cur.long ? V(0, 0, 18) : V(0, -3, 3));
      pair = [g.clone().add(V(48, 16, 22)), g];
    } else if (name === 'gripR') {
      const g = fromGun(W.cur.long ? V(0, -3, -6) : V(0, -3, 3));
      pair = [g.clone().add(V(-48, 14, 18)), g];
    }
  }
  const [pos, tgt] = pair;
  camera.position.copy(pos).applyAxisAngle(V(0, 1, 0), STATE.charYaw).add(charPos);
  controls.target.copy(tgt).applyAxisAngle(V(0, 1, 0), STATE.charYaw).add(charPos);
  controls.update();
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === name));
}
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => setView(b.dataset.view));
const toggle = (id, fn) => document.getElementById(id).onclick = (e) => e.currentTarget.classList.toggle('active', fn());
toggle('spin', () => (controls.autoRotate = !controls.autoRotate));
toggle('auto', () => (STATE.autoFire = !STATE.autoFire));
toggle('slow', () => ((STATE.timeScale = STATE.timeScale < 1 ? 1 : 0.12), STATE.timeScale < 1));
toggle('sound', () => (STATE.soundOn = !STATE.soundOn));
toggle('demo', () => { STATE.demoOn = !STATE.demoOn; mm.demoT = 0; return STATE.demoOn; });
toggle('ikdbg', () => (ikDbg.visible = !ikDbg.visible));
toggle('colliders', () => { const on = !capsuleMeshes[0]?.visible; capsuleMeshes.forEach(m => (m.visible = on)); return on; });
document.getElementById('fire').onclick = () => { if (W.cur.auto) { pressFire(); setTimeout(releaseFire, 70); } else pullTrigger(); };
document.getElementById('weap').onclick = () => nextWeapon();
document.getElementById('normalMode').onclick = () => setAimMode(false);
document.getElementById('aimMode').onclick = () => setAimMode(true);
document.getElementById('ikedit').onclick = () => toggleIKEdit();
document.getElementById('motionLibrary').onclick = () => {
  const panel = document.getElementById('motionPanel');
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening);
  document.getElementById('motionLibrary').classList.toggle('active', opening);
  if (opening && !motionPreview.active) previewMotionSelection();
  else if (!opening) stopMotionPreview();
};
document.getElementById('motionClose').onclick = stopMotionPreview;
document.getElementById('motionSelect').onchange = previewMotionSelection;
document.getElementById('motionPlay').onclick = () => {
  if (!motionPreview.profile) return;
  motionPreview.playing = !motionPreview.playing;
  document.getElementById('motionPlay').textContent = motionPreview.playing ? 'Ⅱ Pause' : '▶ Play';
  if (motionPreview.playing && motionPreview.time >= motionPreview.profile.dur) { motionPreview.time = 0; renderMotionFrame(); }
};
document.getElementById('motionRestart').onclick = () => {
  if (!motionPreview.profile) return;
  motionPreview.time = 0; motionPreview.playing = true; renderMotionFrame();
  document.getElementById('motionPlay').textContent = 'Ⅱ Pause';
  document.getElementById('motionBar').style.width = '0%';
};
document.getElementById('motionSpeed').onchange = e => { motionPreview.speed = Math.max(0.1, Number(e.target.value) || 1); };
document.getElementById('motionLoop').onchange = e => { motionPreview.loop = e.target.checked; };
document.getElementById('reload').onclick = () => { if (RLT.on) stopRlTimeline(); startReload(); };
document.getElementById('rlTimelineBtn').onclick = () => (RLT.on ? stopRlTimeline() : startRlTimeline());
document.getElementById('ikRlOpen').onclick = () => (RLT.on ? stopRlTimeline() : startRlTimeline());
document.getElementById('rlClose').onclick = () => stopRlTimeline();
document.getElementById('rlSlider').oninput = e => rlSetU(parseFloat(e.target.value) || 0);
document.getElementById('rlPlay').onclick = () => {
  if (!RLT.on) return;
  RLT.playing = !RLT.playing;
  document.getElementById('rlPlay').textContent = RLT.playing ? 'Ⅱ Pause' : '▶ Play';
};
document.getElementById('rlSetKey').onclick = () => rlSetKey();
document.getElementById('rlDelKey').onclick = () => rlDeleteKey();
document.getElementById('rlClearKeys').onclick = () => rlClearKeys();
document.getElementById('rlPrev').onclick = () => rlJump(-1);
document.getElementById('rlNext').onclick = () => rlJump(1);
document.getElementById('rlAutoKey').onchange = e => { RLT.autoKey = e.target.checked; };
document.getElementById('rlEmpty').onclick = () => {
  if (!RLT.on) return;
  RLT.empty = !RLT.empty;
  const keepU = RLT.u;
  stopRlTimeline(true);
  startRlTimeline();
  rlSetU(keepU);
};
document.getElementById('ladderBtn').onclick = () => toggleLadder();
document.getElementById('game').onclick = enterGame;
document.getElementById('toggleRef').onclick = () => document.getElementById('ref').classList.toggle('hidden');
addEventListener('keydown', e => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) {
      if (RLT.on) document.getElementById('rlPlay').click();
      else if (!game.active || isAiming()) pressFire();
    }
  }
  if (e.code.startsWith('Arrow')) e.preventDefault();
  const pick = { Digit1: 'pistol', Digit2: 'rifle', Digit3: 'shotgun', Digit4: 'kar', Digit5: 'rpg7' }[e.code];
  if (pick) { if (game.active && (RL.on || KA.on)) queueWeapon(pick); else switchWeapon(pick); }   // mid-reload: switch as soon as it finishes
  if (e.code === 'KeyQ' && game.active && !e.repeat) swapShoulder();
  if (e.code === 'KeyC') toggleCrouch();
  if (e.code === 'KeyV' && !game.active) toggleAimMode();
  if (e.code === 'KeyF') { setAimStage(0); toggleLadder(); }
  if (RLT.on && e.code === 'KeyK') rlSetKey();
  if (ikEdit.on && e.code === 'KeyT') setIKMode('translate');
  if (ikEdit.on && e.code === 'KeyR') setIKMode('rotate');
  else if (e.code === 'KeyR') startReload();
  if (e.code === 'Escape' && game.active) pauseGame();
  keys.add(e.code);
});
addEventListener('keyup', e => { keys.delete(e.code); if (e.code === 'Space') releaseFire(); });
addEventListener('blur', () => { keys.clear(); setAimStage(0); playerAim.rmb = false; releaseFire(); });
if (params.has('noref')) document.getElementById('ref').classList.add('hidden');
if (params.has('slow')) { STATE.timeScale = 0.12; document.getElementById('slow').classList.add('active'); }
// Test hook: ?t=seconds-after-shot freezes the frame at that moment of a shot.
export const freezeAt = params.has('t') ? parseFloat(params.get('t')) : null;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
/* previousFrameTime in STATE */
/* frozenDone, initDone, simFrozen, statusT in STATE */
const step60 = 1 / 60;
function inputFromParams() {
  const mv = (params.get('move') || '0,0').split(',').map(Number);
  return { x: mv[0] || 0, z: mv[1] || 0, run: params.has('run') ? 1 : 0, turn: parseFloat(params.get('turn') || '0') };
}
// ?sim=seconds&move=x,z[&run][&turn=rad/s] : run the locomotion for N seconds, then freeze for a screenshot.
function aimAtTarget(i) {
  const t = targets[i]; t.g.updateMatrixWorld(true);
  const c = t.mesh.getWorldPosition(V(0, 0, 0)).add(V(0, t.kind === 'popper' ? 40 : 0, 0));
  for (let k = 0; k < 4; k++) {
    updateGameCamera(0);
    const d = c.clone().sub(camera.position);
    tps.yaw = Math.atan2(d.x, d.z); tps.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  }
  updateGameCamera(0); aim.smooth.copy(aim.point);
}
export function runSim() {
  STATE.testInput = inputFromParams(); STATE.soundOn = false;
  if (params.has('game')) { enterGame(); startRound(params.get('mode') || 'trainer'); }
  const T = parseFloat(params.get('sim')), shots = parseInt(params.get('shoot') || '0');
  let fired = 0, nextT = 1.0;
  for (let t = 0; t < T; t += step60) {
    if (params.has('aimt')) aimAtTarget(+params.get('aimt'));
    if (params.has('swap') && Math.abs(t - 0.5) < step60 / 2) switchWeapon(params.get('swap'));
    if (params.has('kact') && Math.abs(t - 0.3) < step60 / 2) startKarAction(params.get('kact'));
    if (params.has('rl') && Math.abs(t - 0.3) < step60 / 2) { if (params.get('rl') === 'empty') { W.cur.ammo = 0; W.cur.locked = true; } startReload(); }
    if (fired < shots && t >= nextT) { pressFire(); fired++; nextT = t + 0.45; }
    if (W.cur.auto && t >= nextT - 0.45 + 0.1) releaseFire();
    STATE.simTime += step60; updateCharacter(step60); updateFX(step60); updateTargets(step60); updateAI(step60);
    if (game.active) { updateGameCamera(step60); updateGame(step60); }
  }
  if (params.has('freezeFlash')) { fire(); updateCharacter(0.012); }
  if (params.has('camw')) {   // debug camera in the current weapon's space
    const c = params.get('camw').split(',').map(Number), t = (params.get('camt') || '0,-3,5').split(',').map(Number);
    camera.position.copy(toWorld(fromGun(V(...c)))); controls.target.copy(toWorld(fromGun(V(...t)))); controls.update();
  }
  STATE.simFrozen = true;
  if (params.has('debug')) document.title = 'SIM ' + JSON.stringify({ gq: [V(0, 0, 1).applyQuaternion(gunState.q).toArray().map(x => +x.toFixed(2)), V(0, 1, 0).applyQuaternion(gunState.q).toArray().map(x => +x.toFixed(2))], rl: [RL.on, +RL.t.toFixed(2), RL.env.toFixed(2), RL.err, RL.seg, W.cur.ammo], weapon: W.cur.name, blend: W.blend, score: game.score, hits: game.hits, shots: game.shots, clip: mm.clips[mm.clip].name, v: mm.vel });
}
// ?test : scripted locomotion scenarios with foot-contact / popping metrics written into the page title.
export function runTest() {
  STATE.soundOn = false;
  const seq = {
    walk: t => ({ x: 0, z: 1 }), run: t => ({ x: 0, z: 1, run: 1 }), strafe: t => ({ x: 1, z: 0 }), back: t => ({ x: 0, z: -1 }),
    circle: t => ({ x: 0, z: 1, run: 1, turn: 0.7 }),
    stopgo: t => t < 1 ? {} : t < 4 ? { z: 1 } : t < 6 ? {} : t < 9 ? { z: 1, run: 1 } : t < 11 ? {} : { z: 1 },
  };
  const out = {};
  for (const [name, f] of Object.entries(seq)) {
    turnOff.forEach(t => t.fill(0)); Object.assign(mm, { clip: 0, phase: 0, vel: [0, 0], speed: 0, transitions: 0, searchT: 0 }); STATE.charYaw = 0; charPos.set(0, 0, 0); lastPlaced.set(0, 0, 0);
    mm.out.set(STATE.IDLE); mm.prev.set(STATE.IDLE); mm.outVel.fill(0); mm.inertX.fill(0); mm.inertV.fill(0);
    const T = name === 'stopgo' ? 13 : 6, prev = {}, slide = [], jump = [], minY = [], pel = [];
    let reach = 0, worst = {};
    for (let t = 0; t < T; t += step60) {
      STATE.testInput = { x: 0, z: 0, run: 0, turn: 0, ...f(t) };
      STATE.simTime += step60; updateCharacter(step60);
      reach = Math.max(reach, ikState.reachFix);
      pel.push(worldPos(bones.pelvis).y);
      for (const s of ['l', 'r']) {
        const w = worldPos(bones['foot_' + s]);
        if (prev[s]) {
          const dxz = Math.hypot(w.x - prev[s].x, w.z - prev[s].z) / step60;
          jump.push(Math.abs(w.y - prev[s].y) / step60 + dxz * 0);
          if (t > 1.5 && w.y < STATE.ANKLE_H + 0.8 && prev[s].y < STATE.ANKLE_H + 0.8) { slide.push(dxz); if (dxz > (worst.v || 0)) worst = { v: +dxz.toFixed(0), t: +t.toFixed(2), s, clip: mm.clips[mm.clip].name, sp: +mm.speed.toFixed(0) }; }
        }
        minY.push(w.y); prev[s] = w;
      }
    }
    slide.sort((a, b) => a - b);
    out[name] = { v: +mm.speed.toFixed(0), n: slide.length, slideMed: +(slide[slide.length >> 1] || 0).toFixed(1), slideP95: +(slide[Math.floor(slide.length * 0.95)] || 0).toFixed(1),
      slideMax: +(slide[slide.length - 1] || 0).toFixed(1), footVyMax: +Math.max(...jump).toFixed(0), minFootY: +Math.min(...minY).toFixed(2),
      pelvis: [+Math.min(...pel).toFixed(1), +Math.max(...pel).toFixed(1)], reachFixMax: +reach.toFixed(2), trans: mm.transitions, worst };
  }
  out.ankleH = +STATE.ANKLE_H.toFixed(2); out.legMax = +STATE.LEG_MAX.toFixed(1); out.hip = +STATE.HIP_HALF.toFixed(1); out.db = mm.db.n;
  document.title = 'TEST ' + JSON.stringify(out);
}
