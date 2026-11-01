import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { DEG, V, lerp } from './math.js';
import { RECOIL_PIVOT, STATE, params } from './state.js';
import { camera, charRoot, controls, perfGovernor, renderer, scene } from './scene.js';
import './audio.js';
import { NAME_MAP, REF_CHILD, bones, makeSource, orient, report, restWorldPos, restWorldQ, rt, setupRetarget, trigFinger, worldPos, worldQuat } from './skeleton.js';
import { caseGeo, flash, prepMuzzleFX, rifleCaseGeo, updateFX } from './fx.js';
import { CLIP_GUIDE, EJECT_PORT, FINGERS, KAR_COLS, KAR_EYE, KAR_GRIP_FRAME, KAR_L_SHIFT, KAR_MUZZLE, KAR_TRIG, LREF_HAND, LREF_SOCK, M4, M4_COLS, M4_GRIP_FRAME, MUZZLE, PMAG_AXIS, RIFLE_EJECT, RIFLE_EYE, RIFLE_MUZZLE, RIFLE_TRIG, RL, RPG_EYE, RPG_MUZZLE, RPG_TRIG, SHOTGUN_EYE, SHOTGUN_MUZZLE, SHOTGUN_TRIG, SLIDE_TRAVEL, TRIGGER_PIVOT, TRIGGER_PULL, W, buildCapsules, ccdReach, chainOf, chainPoints, equip, eyePos, fingerClearance, fire, fitGrip, fitGunToHand, fitLong, frameM, fromGun, gripReport, gunState, initHandRetarget, karCaseGeo, loadM4, makeKar, makePistol, makeRPG7, makeShotgun, placeShape, poseHandFrom, pullTrigger, restLocalPos, restLocalQ, restLocalScale, shotgunCaseGeo, solveFingerFix, tipLocal, toGun } from './weapons.js';
import { buildDB, captureIdle, loadLadderAnims, mm, retargetFrame } from './locomotion.js';
import './ik.js';
import './reload-timeline.js';
import { playerCrouch, tmpM, updateCharacter } from './character.js';
import { motionPreview, previewMotionSelection, updateMotionPreview } from './motion-studio.js';
import { enterGame, game, updateGame, updateGameCamera, updateTargets } from './game.js';
import { AI, ARENA, buildArena, buildEnemyGun, buildEnemyPool, captureEnemyPoses, updateAI } from './ai.js';
import { freezeAt, runSim, runTest, setView, views } from './ui.js';
import { timeScaleFor } from './gameplay/juice.js';

// ======================================================================
//  LOAD + BIND
// ======================================================================
/* ready in STATE */
/* mannequinRoot in STATE */
export const restAcross = {};
/* pistol, kar, gunBase, gunInHand in STATE */
export const ANIM_T0 = 0.5;
export const capsuleMeshes = [];

export const fbx = new FBXLoader();
Promise.all([fbx.loadAsync('model/Mannequin.FBX'), fbx.loadAsync('anim/MF_Pistol_Idle_ADS.FBX'), fbx.loadAsync('anim/A_AR_Aim_Fwd.FBX'), loadM4()]).then(([obj, anim, aimPose]) => {
  obj.updateMatrixWorld(true);
  obj.traverse(n => {
    if (n.isBone) bones[n.name] = n;
    if (n.isMesh) {
      n.castShadow = true; n.receiveShadow = true;
      n.material = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, roughness: 0.45, metalness: 0.05 });
    }
  });
  for (const k in bones) { restWorldQ[k] = worldQuat(bones[k]); restWorldPos[k] = worldPos(bones[k]); restLocalQ[k] = bones[k].quaternion.clone(); restLocalPos[k] = bones[k].position.clone(); restLocalScale[k] = bones[k].scale.clone(); }
  for (const s of ['r', 'l']) {
    restAcross[s] = worldPos(bones['index_01_' + s]).sub(worldPos(bones['pinky_01_' + s])).normalize();
    for (const f of ['thumb', ...FINGERS]) {
      const [, b2, b3] = chainOf(f, s), p2 = worldPos(b2), p3 = worldPos(b3);
      tipLocal[`${f}_${s}`] = b3.worldToLocal(p3.clone().add(p3.clone().sub(p2).multiplyScalar(0.5)));
    }
  }

  const box3 = new THREE.Box3().setFromObject(obj);
  obj.position.y -= box3.min.y; anim.position.y = obj.position.y;
  STATE.mannequinRoot = obj;
  charRoot.add(obj);
  AI.template = SkeletonUtils.clone(obj);   // enemy body (before debug capsules are attached to the fingers)
  obj.updateMatrixWorld(true);
  for (const k in bones) { restWorldQ[k] = worldQuat(bones[k]); restWorldPos[k] = worldPos(bones[k]); }
  setupRetarget(obj, anim);
  const rifleSrc = makeSource(obj, aimPose, {});       // A_AR_Aim_Fwd uses UE4 spine names
  captureIdle(aimPose);
  for (const e of rifleSrc.list) if (rt.byName[e.m.name]) rt.byName[e.m.name].rq = worldQuat(e.a).multiply(e.off);
  buildDB();

  const P = makePistol(); STATE.pistol = P;
  P.gun.add(flash); flash.position.copy(MUZZLE);
  charRoot.add(P.gun);
  STATE.gunInHand = fitGunToHand();
  solveFingerFix();
  // Trigger finger: rest = animated pose, pulled = pad on the fully-pressed trigger.
  const piv = V(0, TRIGGER_PIVOT[1], TRIGGER_PIVOT[0]);
  const pulledG = V(-0.1, -2.05, 6.95).sub(piv).applyAxisAngle(V(1, 0, 0), TRIGGER_PULL).add(piv);
  const idx = chainOf('index', 'r'), idx0 = idx.map(b => b.quaternion.clone());
  ccdReach('index', 'r', fromGun(V(-0.1, -2.05, 6.95)));
  trigFinger.rest = idx.map(b => b.quaternion.clone());
  ccdReach('index', 'r', fromGun(pulledG));
  trigFinger.pulled = idx.map(b => b.quaternion.clone());
  idx.forEach((b, i) => b.quaternion.copy(idx0[i]));
  Object.assign(report, gripReport());
  if (params.has('debug')) {
    const errs = {};
    for (const e of rt.list) {
      const ch = REF_CHILD[e.m.name] ? bones[REF_CHILD[e.m.name]] : e.m.children.find(c => c.isBone && rt.abones[NAME_MAP[c.name] || c.name]);
      if (!ch) continue;
      const dm = worldPos(ch).sub(worldPos(e.m)).normalize(), da = worldPos(rt.abones[NAME_MAP[ch.name] || ch.name]).sub(worldPos(e.a)).normalize();
      const d = dm.angleTo(da) / DEG; if (d > 3) errs[e.m.name] = +d.toFixed(1);
    }
    report.dirErr = errs;
  }
  report.barrel = V(0, 0, 1).applyQuaternion(gunState.q).toArray().map(x => +x.toFixed(2));
  buildCapsules();
  const origin = fromGun(V(0, 0, 0));

  if (params.has('debug')) document.title = 'GRIP ' + JSON.stringify(report);
  for (const s of ['l', 'r']) if (params.has('hide' + s)) bones['hand_' + s].scale.setScalar(0.001);
  if (params.has('cam')) { const c = params.get('cam').split(',').map(Number); views.dbg = [fromGun(V(c[0], c[1], c[2])), fromGun(V(0, -3, 3))]; }
  views.gripL = [origin.clone().add(V(48, 18, 22)), origin.clone().add(V(0, -3, 3))];
  views.gripR = [origin.clone().add(V(-46, 14, 18)), origin.clone().add(V(0, -3, 3))];
  views.under = [origin.clone().add(V(10, -40, 32)), origin.clone().add(V(0, -3, 3))];
  views.shoulder = [V(-55, 185, -95), origin.clone().add(V(0, 0, 60))];
  // ---- long guns: fitted once into the A_AR_Aim_Fwd pose; hands come from the FPS animation pack ----
  initHandRetarget();
  const K = makeKar(); STATE.kar = K;
  const SG = makeShotgun();
  const RPG = makeRPG7();
  charRoot.add(M4.holder, K.gun, SG.gun, RPG.gun);
  const longFit = (eye, gun) => {
    W.blend = 1; retargetFrame(ANIM_T0, null);
    const inHand = fitLong(eye); gun.matrix.copy(gunState.mat); gun.updateMatrixWorld(true);
    return inHand;
  };
  const hk = s => lerp(1, worldPos(bones['middle_01_' + s]).distanceTo(worldPos(bones['hand_' + s])) / M4.rest[s][9].distanceTo(M4.rest[s][0]), 0.8);
  report.handK = ['r', 'l'].map(s => +hk(s).toFixed(2));
  const trigFor = (piv, pad, g) => {
    poseHandFrom('r', g.J, gunState.mat, 1, g.fq);
    const ch = chainOf('index', 'r');
    ccdReach('index', 'r', fromGun(pad));
    const r = { rest: ch.map(b => b.quaternion.clone()) };
    ccdReach('index', 'r', fromGun(pad.clone().sub(piv).applyAxisAngle(V(1, 0, 0), TRIGGER_PULL).add(piv)));
    r.pulled = ch.map(b => b.quaternion.clone());
    return r;
  };
  const m4In = longFit(RIFLE_EYE, M4.holder);
  const m4G = { r: fitGrip('r', M4.rest.r, M4_COLS.r, hk('r')), l: fitGrip('l', M4.rest.l, M4_COLS.l, hk('l')) };
  for (const c of [M4.tac, M4.empty]) for (const f of c.frames) f.l = f.l.map(m4G.l.scale);   // reload keeps the same hand size
  const m4Trig = trigFor(RIFLE_TRIG.piv, RIFLE_TRIG.pad, m4G.r);
  report.rifleFingers = Object.fromEntries(['middle', 'ring', 'pinky'].flatMap(f => ['r', 'l'].map(sd => {
    poseHandFrom(sd, m4G[sd].J, gunState.mat, 1, m4G[sd].fq);
    return [f + '_' + sd, +fingerClearance(f, sd, 0, M4_COLS[sd].map(o => ({ type: 'cap', a: fromGun(o.a), b: fromGun(o.b), r: o.r }))).d.toFixed(2)];
  })));
  report.rifleEye = toGun(eyePos()).toArray().map(x => +x.toFixed(1));
  // Left-hand reference matrix (gun space) the pistol reload keys are built from.
  orient(bones.hand_l, bones.middle_01_l, LREF_HAND[0].clone().applyQuaternion(gunState.q), restAcross.l, LREF_HAND[1].clone().applyQuaternion(gunState.q));
  bones.hand_l.updateWorldMatrix(true, false);
  const lref = bones.hand_l.matrixWorld.clone(), dl = fromGun(LREF_SOCK).sub(worldPos(bones.middle_01_l));
  lref.elements[12] += dl.x; lref.elements[13] += dl.y; lref.elements[14] += dl.z;
  const rifleLeft = gunState.inv.clone().multiply(lref);
  const karIn = longFit(KAR_EYE, K.gun);
  const karG = { r: fitGrip('r', placeShape(M4.rest.r, M4_GRIP_FRAME, KAR_GRIP_FRAME), KAR_COLS.r, hk('r')),
                 l: fitGrip('l', M4.rest.l.map(p => p.clone().add(KAR_L_SHIFT)), KAR_COLS.l, hk('l')) };
  const karTrig = trigFor(KAR_TRIG.piv, KAR_TRIG.pad, karG.r);
  if (params.has('debug')) report.karFingers = Object.fromEntries(['index', 'middle', 'ring', 'pinky', 'thumb'].map(f => {
    poseHandFrom('l', karG.l.J, gunState.mat, 1, karG.l.fq);
    const tip = toGun(chainPoints(f, 'l')[3]);
    return [f, [+fingerClearance(f, 'l', 0, KAR_COLS.l.map(o => ({ type: 'cap', a: fromGun(o.a), b: fromGun(o.b), r: o.r }))).d.toFixed(2), ...tip.toArray().map(x => +x.toFixed(1))]];
  }));

  // Fit Shotgun (left hand cupped directly on the moveable pump slider at y = -1.1, z = 18..36)
  const SG_COLS = {
    r: [{ a: V(0, -2.0, -7.5), b: V(0, -9.5, -10.5), r: 1.7 }, { a: V(0, 0, -11), b: V(0, 0, 11), r: 2.0 }],
    l: [{ a: V(0, -1.1, 18), b: V(0, -1.1, 36), r: 2.22 }, { a: V(0, 1.3, 18), b: V(0, 1.3, 36), r: 1.25 }]
  };
  const sgIn = longFit(SHOTGUN_EYE, SG.gun);
  const sgG = {
    r: fitGrip('r', placeShape(M4.rest.r, M4_GRIP_FRAME, frameM(V(0, -0.65, -0.75), V(0, -0.75, 0.65), V(0, -5.5, -9.0))), SG_COLS.r, hk('r')),
    l: fitGrip('l', M4.rest.l.map(p => p.clone().add(V(-0.34, -0.9, 3.5))), SG_COLS.l, hk('l'))
  };
  const sgTrig = trigFor(SHOTGUN_TRIG.piv, SHOTGUN_TRIG.pad, sgG.r);

  // Fit RPG-7
  const RPG_COLS = {
    r: [{ a: V(0, -2.5, -6.0), b: V(0, -10.5, -6.0), r: 1.55 }, { a: V(0, 0, -20), b: V(0, 0, 10), r: 2.7 }],
    l: [{ a: V(0, -2.0, 16.0), b: V(0, -10.0, 16.0), r: 1.55 }, { a: V(0, 0, 5), b: V(0, 0, 28), r: 2.15 }]
  };
  const M4_GRIP_FRAME_L = frameM(V(0, -0.94, -0.34), V(0, -0.34, 0.94), V(-0.34, -9.5, -8.5));
  const rpgIn = longFit(RPG_EYE, RPG.gun);
  const rpgG = {
    r: fitGrip('r', placeShape(M4.rest.r, M4_GRIP_FRAME, frameM(V(0, -0.98, -0.20), V(0, -0.20, 0.98), V(0, -6.5, -6.0))), RPG_COLS.r, hk('r')),
    l: fitGrip('l', placeShape(M4.rest.r.map(p => V(-p.x, p.y, p.z)), M4_GRIP_FRAME_L, frameM(V(0, -0.98, -0.20), V(0, -0.20, 0.98), V(0, -6.2, 16.0))), RPG_COLS.l, hk('l'))
  };
  const rpgTrig = trigFor(RPG_TRIG.piv, RPG_TRIG.pad, rpgG.r);

  W.blend = 0;
  W.list.pistol = { name: 'pistol', obj: P.gun, inHand: STATE.gunInHand, muzzle: MUZZLE, eject: EJECT_PORT.clone().add(V(0, 0, -SLIDE_TRAVEL * 0.5)),
    ejectV: V(-330, 260, -35), shellGeo: caseGeo, trig: trigFinger, trigPivot: P.trigPivot, slide: P.slide, leftRel: null, auto: false,
    pivot: RECOIL_PIVOT, kick: { flip: 7.5, back: 1.7, up: 0.9, yaw: 1.6, roll: [-0.8, -1.2], cam: 0.6 }, flashS: 1, pitch: 1, spread: 0.002,
    label: 'Pistol', hud: 'Pistol', sfx: 'pistol_shot', dmg: 34, lockTravel: SLIDE_TRAVEL, cycleK: 1, magWell: V(-0.5, -6, -1), rlDur: { empty: 2.9, tac: 2.3 } };
  W.list.rifle = { name: 'rifle', label: 'M4', hud: 'M4 (auto)', long: true, obj: M4.holder, inHand: m4In, J: { r: m4G.r.J, l: m4G.l.J }, fq: { r: m4G.r.fq, l: m4G.l.fq }, trig: m4Trig,
    muzzle: RIFLE_MUZZLE, eject: RIFLE_EJECT, ejectV: V(-420, 140, 60), shellGeo: rifleCaseGeo, slide: null, auto: true, rpm: 750,
    pivot: V(0, -2, -36), kick: { flip: 2.2, back: 2.6, up: 0.4, yaw: 1.0, roll: [-0.3, 0.6], cam: 0.35 }, flashS: 1.5, pitch: 1.2, spread: 0.003, bodyK: 0.45, dmg: 26,
    sfx: 'rifle_shot', cap: 30, ammo: 30, lockTravel: 6.15, cycleK: 1.45, magObj: M4.magJ, magAxis: V(0, 0.995, 0.1), magWell: V(0.3, -6, 7),
    clips: { empty: M4.empty, tac: M4.tac }, setBolt: M4.setBolt, trigFn: M4.setTrig };
  W.list.shotgun = { name: 'shotgun', label: 'Shotgun', hud: 'Shotgun (12G)', long: true, obj: SG.gun, inHand: sgIn,
    J: { r: sgG.r.J, l: sgG.l.J }, fq: { r: sgG.r.fq, l: sgG.l.fq }, trig: sgTrig, pump: SG.pump, sgBolt: SG.bolt,
    muzzle: SHOTGUN_MUZZLE, eject: V(-1.8, 1.2, 2), ejectV: V(-280, 220, -40), shellGeo: shotgunCaseGeo, slide: null, auto: false,
    pellets: 8, dmg: 24, spread: 0.045, pivot: V(0, -5, -38), kick: { flip: 9.0, back: 4.8, up: 1.8, yaw: 2.2, roll: [-1.0, 1.8], cam: 1.6 },
    bodyK: 1.15, shK: 1.45,
    flashS: 2.2, pitch: 0.65, cap: 8, ammo: 8, rlAnim: 'shotgun-bolt', rlDur: 2.6,
    gripPivot: V(0, -5.5, -9.0), rlPose: { cant: 22, pitch: 12, yaw: -14, off: V(-2, -6, -8) } };
  W.list.kar = { name: 'kar', label: 'Kar98k', hud: 'Kar98k (bolt)', long: true, kar: true, obj: K.gun, inHand: karIn, J: { r: karG.r.J, l: karG.l.J }, fq: { r: karG.r.fq, l: karG.l.fq }, trig: karTrig,
    muzzle: KAR_MUZZLE, eject: V(-1.4, 1.4, -5), ejectV: V(-240, 320, -70), shellGeo: karCaseGeo, slide: null, auto: false,
    trigPivot: K.trigPivot, pivot: V(0, -7, -43), kick: { flip: 6.5, back: 3.2, up: 1.2, yaw: 1.4, roll: [-0.6, 1.2], cam: 1.7 }, bodyK: 1.15, shK: 1.40, dmg: 120,
    flashS: 1.8, pitch: 0.75, spread: 0.0006, sfx: 'kar_shot', cap: 5, ammo: 5, scope: KAR_EYE, magWell: CLIP_GUIDE };
  W.list.rpg7 = { name: 'rpg7', label: 'RPG-7', hud: 'RPG-7 (rocket)', long: true, obj: RPG.gun, inHand: rpgIn,
    J: { r: rpgG.r.J, l: rpgG.l.J }, fq: { r: rpgG.r.fq, l: rpgG.l.fq }, trig: rpgTrig, warhead: RPG.warhead,
    muzzle: RPG_MUZZLE, eject: null, slide: null, auto: false, isRocket: true, dmg: 250, spread: 0.001,
    pivot: V(0, -6, -20), kick: { flip: 12.0, back: 6.0, up: 2.5, yaw: 1.8, roll: [-1.2, 2.0], cam: 2.4 }, bodyK: 1.25, shK: 1.50,
    flashS: 3.5, pitch: 0.45, cap: 1, ammo: 1, scope: RPG_EYE, rlAnim: 'rifle-reload', rlDur: 3.2,
    gripPivot: V(0, -6.5, -6.0), rlPose: { cant: 14, pitch: -10, yaw: -12, off: V(-2, -5, -8) } };
  // Reload data. wellRel = left hand cupping the seated magazine's baseplate (palm up, gun space);
  // magInHand keeps the new magazine fixed in that grip, so it seats exactly when the hand reaches 'well'.
  const kn = LREF_SOCK;   // rifleLeft puts the left middle knuckle exactly here
  const rotAt = (pivot, q) => new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  const rotKn = (rel, q) => rel.clone().premultiply(rotAt(kn, q));
  const moveKn = (rel, target) => rel.clone().premultiply(tmpM.makeTranslation(target.x - kn.x, target.y - kn.y, target.z - kn.z));
  const qx180 = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), Math.PI), qz90 = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), Math.PI / 2);
  const finish = w => {
    if (w.wellRel) w.magInHand = w.wellRel.clone().invert();
    if (!w.magObj) return;
    w.mag = w.magObj; w.obj.updateMatrixWorld(true);
    w.magCenter = w.mag.worldToLocal(new THREE.Box3().setFromObject(w.magObj).getCenter(V()));
  };
  W.list.pistol.cap = 15; W.list.pistol.ammo = 16;
  Object.assign(W.list.pistol, { magObj: P.mag, magAxis: PMAG_AXIS, magDepth: 10, gripPivot: V(0, -6, -1),
    wellRel: moveKn(rifleLeft, V(-0.6, -13.4, -2.4)),
    rackRel: moveKn(rotKn(rifleLeft, qx180), V(-0.5, 5.0, 0.3)),
    // Reference video: gun pulled in to the chest and canted, head down, mag dropped at the side,
    // new mag from the left hip, insert, overhand rack, back out to aim (~4.5 s there; tightened here).
    rlPose: { cant: 34, pitch: 16, yaw: -16, off: V(-3, -10, -17) },
    rl: { empty: { release: 0.07, grab: 0.40, seat: 0.66, slam: 0.86, rackAt: 0.77,
                   path: [[0, 'grip'], [0.06, 'grip', V(6, -6, 0)], [0.36, 'pouch'], [0.44, 'pouch', V(-4, 6, 6)], [0.60, 'wellOut'], [0.66, 'well'], [0.70, 'well', V(0, 6, -2)], [0.77, 'rack'], [0.84, 'rackBack'], [0.86, 'rackBack', V(0, 4, -4)], [0.94, 'grip'], [1, 'grip']] },
          tac: { release: 0.08, grab: 0.46, seat: 0.78,
                   path: [[0, 'grip'], [0.07, 'grip', V(6, -6, 0)], [0.42, 'pouch'], [0.50, 'pouch', V(-4, 6, 6)], [0.70, 'wellOut'], [0.78, 'well'], [0.82, 'well', V(2, 2, 2)], [0.96, 'grip'], [1, 'grip']] } } });
  for (const w of Object.values(W.list)) finish(w);
  M4.holder.visible = K.gun.visible = SG.gun.visible = RPG.gun.visible = false; equip(W.list.pistol);
  const pw = W.list[params.get('weapon')]; if (pw) { equip(pw); W.blend = pw.long ? 1 : 0; }
  if (params.has('debug')) document.title = 'GRIP ' + JSON.stringify(report);
  captureEnemyPoses(); AI.gunGeo = buildEnemyGun(); buildArena(); buildEnemyPool();
  if (params.has('debug')) Object.assign(report, { crouchH: +AI.crouchH.toFixed(1), aim0: [+AI.yaw0.toFixed(3), +AI.pitch0.toFixed(3)], idleFeetZ: [+STATE.IDLE[7].toFixed(1), +STATE.IDLE[12].toFixed(1)], coverPts: ARENA.pts.length });
  // Compile arena / enemy / FX shaders now instead of hitching on the first spawn or shot.
  ARENA.group.visible = true; AI.enemies[0].root.visible = AI.enemies[0].gun.visible = true;
  renderer.compile(scene, camera);
  ARENA.group.visible = false; AI.enemies[0].root.visible = AI.enemies[0].gun.visible = false;
  document.getElementById('status').textContent = 'WASD move · Shift run · V aim/normal · Space fire · C crouch · F ladder · R reload · 1-5 weapons';
  setView(params.has('cam') ? 'dbg' : (params.get('view') || 'photo'));
  STATE.ready = true;
  window.READY = true;
  loadLadderAnims();
  if (!document.getElementById('motionPanel').classList.contains('hidden')) previewMotionSelection();
}).catch((e) => { document.getElementById('status').textContent = 'Failed to load: ' + e; console.error(e); });

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const raw = Math.max(0, (now - STATE.previousFrameTime) / 1000); STATE.previousFrameTime = now;
  const real = Math.min(raw, 0.1);   // 0.1: slow phones keep real-time speed instead of slow motion
  perfGovernor(raw);
  if (STATE.ready && !STATE.initDone) { STATE.initDone = true; if (params.has('test')) runTest(); else if (params.has('sim')) runSim(); else if (params.has('play')) enterGame(); }
  if (STATE.ready && !STATE.simFrozen && !params.has('test')) {
    if (motionPreview.active) {
      updateMotionPreview(real);
    } else if (freezeAt !== null) {
      if (!STATE.frozenDone) { // deterministic: fire, then advance exactly freezeAt seconds
        STATE.frozenDone = true; STATE.soundOn = false; fire();
        for (let t = 0; t < freezeAt - 1e-9; t += 1 / 240) { STATE.simTime += 1 / 240; updateCharacter(1 / 240); updateFX(1 / 240); }
        updateCharacter(0);
      }
    } else {
      const dt = real * STATE.timeScale * timeScaleFor(real);
      STATE.simTime += dt;
      if (STATE.autoFire && STATE.simTime >= STATE.nextAuto) { pullTrigger(); STATE.nextAuto = STATE.simTime + 0.42; }
      if (!(game.active && game.state !== 'play')) { updateCharacter(dt); updateFX(dt); updateTargets(dt); updateAI(dt); }
      if (game.active) updateGame(real);
      STATE.statusT -= real;
      if (STATE.statusT <= 0) {
        STATE.statusT = 0.15;
        document.getElementById('status').textContent = `${W.cur.name} ${W.cur.ammo}/${W.cur.cap}${RL.external ? ' (FBX reload)' : RL.on ? ' (reloading)' : ''}${playerCrouch.on ? ' [CROUCH]' : ''} · ${mm.clips[mm.clip].name} · ${mm.speed.toFixed(0)} cm/s · MM cost ${mm.cost.toFixed(2)} → ${mm.best.toFixed(2)} · ${mm.transitions} transitions · WASD / Shift / Space / C crouch / R / 1-5 weapons`;
      }
    }
  }
  if (game.active) updateGameCamera(real); else controls.update();
  prepMuzzleFX();
  renderer.render(scene, camera);
});
if (params.has('harness')) window.APP_EVAL = c => eval(c);   // test hook: evaluate inside the module scope
