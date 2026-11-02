import * as THREE from 'three';
import { DEG, V, angWrap, clamp, ease, lerp, sstep } from './math.js';
import { damp, smoother } from './anim/curves.js';
import { LEAN, STATE, rec } from './state.js';
import { charRoot, scene } from './scene.js';
import { STANCE, bones, restWorldPos, restWorldQ, rt, setWorldQuat, twoBoneIK, worldPos, worldQuat } from './skeleton.js';
import { GAIT_HIP, HEEL_BACK, ikBase, ikState, solveLegs, userIK } from './ik.js';
import { RLT, stopRlTimeline } from './reload-timeline.js';
import { KA, RL, W, box, gunState, playClick, setGunMatrix } from './weapons.js';
import { BF, isAiming, placeCharacter, playerAim, playerCrouch } from './character.js';
import { getMotionProfile, motionPreview, stopMotionPreview } from './motion-studio.js';
import { AI, ARENA, pushOutOfCover } from './ai.js';
import { game, tps } from './game.js';
import { touch } from './ui.js';
import { ANIM_T0 } from './main.js';
import { RIG, applyGun, backMatrix, blendToSnapshot, climbWeight, handMatrix, idleMicro, ladderRigReset, slingBlend, snapshotPose, solveRig } from './anim/ladder.js';

// ======================================================================
//  LADDER CLIMBING & 4-LIMB RUNG/RAIL IK SYSTEM
//  Uses the 6 authored UE4 Mannequin ladder animations with root motion:
//  Up_Start (0.733s, +86.49cm) -> Up_Loop (0.733s, +150.71cm/cycle) -> Up_End (2.6s, +215.86cm onto platform)
//  Dawn_Start (2.067s, top mount & -284.15cm drop) -> Dawn_Loop (rail slide) -> Dawn_End (bottom dismount)
// ======================================================================
export const LADDER = {
  active: false,
  ready: false,
  loading: false,
  state: 'up_start', // 'up_start' | 'up_loop' | 'up_end' | 'down_start' | 'down_loop' | 'down_end'
  t: 0,
  climbY: 86.49,
  slideY: 168.91,
  auto: true,
  autoDir: 1,
  onPlatform: false,
  pos: V(-95, 0, 40),
  yaw: 0,
  startH: 86.49,
  loopH: 150.71,
  endH: 215.86,
  loops: 1,
  get topY() { return this.startH + this.loops * this.loopH + this.endH; }, // 453.06 cm
  rungZ: 28.0,
  railX: 33.0,
  rung0: 23.4,
  rungStep: 150.71 / 4, // 37.6775 cm
  rungs: [],
  clips: {},
  group: new THREE.Group(),
  worldTrackPos: V(),
  grip: null,
  gripW: { l: 0, r: 0 },
  zS: { x: 0, v: 0 },
  from: null,
  enterT: 1,
  lastRungSfx: -1,
  toWorld(localP) {
    return localP.clone().applyAxisAngle(V(0, 1, 0), this.yaw).add(this.pos);
  },
  toLocal(worldP) {
    return worldP.clone().sub(this.pos).applyAxisAngle(V(0, 1, 0), -this.yaw);
  },
  nearestRung(y) {
    const k = clamp(Math.round((y - this.rung0) / this.rungStep), 0, this.rungs.length - 1);
    return this.rungs[k] ?? (this.rung0 + k * this.rungStep);
  },
  isOnPlatform(wx, wz) {
    const lp = this.toLocal(V(wx, 0, wz));
    return lp.x >= -105 && lp.x <= 105 && lp.z >= 30 && lp.z <= 200;
  }
};

function buildLadderMesh() {
  const g = LADDER.group;
  g.position.copy(LADDER.pos);
  g.rotation.set(0, LADDER.yaw, 0);
  const railMat = new THREE.MeshStandardMaterial({ color: 0x3b424c, roughness: 0.38, metalness: 0.85 });
  const rungMat = new THREE.MeshStandardMaterial({ color: 0x727a86, roughness: 0.32, metalness: 0.9 });
  const hazardMat = new THREE.MeshStandardMaterial({ color: 0xd99b26, roughness: 0.45, metalness: 0.3 });
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x282d34, roughness: 0.65, metalness: 0.6 });
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.55, metalness: 0.75 });

  const topY = LADDER.topY;
  const railH = topY + 95;
  // Left & Right vertical side rails (X = ±33 cm, Z = 28 cm)
  for (const sx of [-1, 1]) {
    const rx = sx * LADDER.railX;
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.1, railH, 16), railMat);
    rail.position.set(rx, railH / 2, LADDER.rungZ);
    rail.castShadow = true; rail.receiveShadow = true;
    g.add(rail);

    // Top gooseneck handrail extension curving onto platform (Z = 28 -> 54 cm)
    const topBar = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 26, 14), hazardMat);
    topBar.rotation.x = Math.PI / 2;
    topBar.position.set(rx, railH, LADDER.rungZ + 13);
    topBar.castShadow = true; g.add(topBar);

    const backPost = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 95, 14), hazardMat);
    backPost.position.set(rx, topY + 47.5, LADDER.rungZ + 26);
    backPost.castShadow = true; g.add(backPost);

    // Base foot plate on the ground
    const basePlate = box(10, 2, 14, hazardMat, rx, 1, LADDER.rungZ);
    g.add(basePlate);
  }

  // Horizontal cylindrical rungs
  LADDER.rungs.length = 0;
  for (let y = LADDER.rung0; y <= topY + 5; y += LADDER.rungStep) {
    LADDER.rungs.push(y);
    const rung = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.45, LADDER.railX * 2, 16), rungMat);
    rung.rotation.z = Math.PI / 2;
    rung.position.set(0, y, LADDER.rungZ);
    rung.castShadow = true; rung.receiveShadow = true;
    g.add(rung);
    // Industrial yellow safety collars on each rung end
    for (const sx of [-1, 1]) {
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(1.85, 1.85, 3.2, 14), hazardMat);
      collar.rotation.z = Math.PI / 2;
      collar.position.set(sx * (LADDER.railX - 2.0), y, LADDER.rungZ);
      g.add(collar);
    }
  }

  // Elevated Watchtower Platform Deck at Y = topY (453.06 cm)
  const deckW = 210, deckD = 166, deckT = 8, deckZ = 34 + deckD / 2;
  const deck = box(deckW, deckT, deckD, deckMat, 0, topY - deckT / 2, deckZ);
  deck.receiveShadow = true;
  g.add(deck);
  // Safety yellow nose strip at the ladder opening
  g.add(box(86, 2.2, 6, hazardMat, 0, topY - 0.8, 36));

  // 4 Support Columns & Bracing
  for (const sx of [-1, 1]) {
    for (const sz of [40, 192]) {
      const col = box(8, topY, 8, pillarMat, sx * 96, topY / 2, sz);
      col.receiveShadow = true; g.add(col);
    }
    // Side Mounting Brackets from ladder rails to front columns
    for (const by of [110, 230, 350, topY - 6]) {
      g.add(box(3.5, 4.0, 14, pillarMat, sx * LADDER.railX, by, LADDER.rungZ + 6));
    }
  }

  // Platform Perimeter Guardrails (leaving X in [-38, +38] open at Z = 36 for ladder entry)
  const railY1 = topY + 50, railY2 = topY + 95;
  for (const ry of [railY1, railY2]) {
    // Back rail
    g.add(box(deckW, 3.2, 3.2, hazardMat, 0, ry, 196));
    // Left & Right rails
    for (const sx of [-1, 1]) {
      g.add(box(3.2, 3.2, deckD, hazardMat, sx * 101, ry, deckZ));
      // Front rail segments flanking the ladder gate
      g.add(box(64, 3.2, 3.2, hazardMat, sx * 69, ry, 36));
    }
  }
  for (const sx of [-1, 1]) {
    g.add(box(3.5, 95, 3.5, pillarMat, sx * 101, topY + 47.5, 36));
    g.add(box(3.5, 95, 3.5, pillarMat, sx * 101, topY + 47.5, 196));
  }

  scene.add(g);
}
buildLadderMesh();

export async function loadLadderAnims() {
  if (LADDER.ready) return;
  if (LADDER.loading) { while (LADDER.loading) await new Promise(r => setTimeout(r, 50)); return; }   // F pressed while the clips are still loading
  LADDER.loading = true;
  const map = [
    ['upStart', 'ladder-up-start'],
    ['upLoop', 'ladder-up-loop'],
    ['upEnd', 'ladder-up-end'],
    ['downStart', 'ladder-down-start'],
    ['downLoop', 'ladder-down-loop'],
    ['downEnd', 'ladder-down-end'],
  ];
  for (const [key, id] of map) {
    LADDER.clips[key] = await getMotionProfile(id);
  }
  LADDER.ready = true;
  LADDER.loading = false;
}

export function ladderAnchorForState(state) {
  switch (state) {
    case 'up_start': return { anchorPos: V(0, 0, 0), anchorYaw: 0 };
    case 'up_loop': return { anchorPos: V(0, LADDER.startH, 0), anchorYaw: 0 };
    case 'up_end': return { anchorPos: V(0, LADDER.startH + LADDER.loops * LADDER.loopH, 0), anchorYaw: 0 };
    case 'down_start': return { anchorPos: V(0, LADDER.topY, 62.78), anchorYaw: Math.PI };
    case 'down_loop': return { anchorPos: V(0, 140, 0), anchorYaw: 0 };
    case 'down_end': return { anchorPos: V(0, 0, 0), anchorYaw: 0 };
    default: return { anchorPos: V(0, 0, 0), anchorYaw: 0 };
  }
}

const _slingOff = new THREE.Matrix4().makeTranslation(-15, 5, -9)
  .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.28, Math.PI * 0.5, 1.05, 'XYZ')));
export function slingWeaponOnBack(cur) {
  if (!cur?.obj) return;
  Object.values(W.list).forEach(w => { w.obj.visible = (w === cur); });
  bones.spine_02.updateWorldMatrix(true, false);
  const m = new THREE.Matrix4().multiplyMatrices(bones.spine_02.matrixWorld, _slingOff);
  setGunMatrix(m);
  cur.obj.matrixAutoUpdate = false;
  cur.obj.matrix.copy(gunState.mat);
  cur.obj.matrixWorldNeedsUpdate = true;
}

// ---- Rung climbing (see anim/ladder.js for the limb schedule) ----
const LADDER_RATE = 74;   // cm/s climbing speed (about 2 rungs per second)
let ladDt = 1 / 60;
const ZS_TARGET = 6;      // spine_03 depth in front of the rung plane: chest, belly and thighs clear the rungs

// Body shift that puts the climb clip's chest at ZS_TARGET (sampled once over the loop clip).
function ensureRigZ() {
  if (RIG.zoff !== null || !LADDER.ready) return;
  const src = LADDER.clips.upLoop, N = 24;
  let sum = 0;
  for (let i = 0; i < N; i++) { retargetFrame(i / N * src.dur, null, src, true); sum += worldPos(bones.spine_03).z; }
  RIG.zoff = ZS_TARGET - sum / N;
}

export function solveLadderIK(state, u, anchorPos, anchorYaw, paused = false, fade = 1) {
  const charToLad = p => p.clone().applyAxisAngle(V(0, 1, 0), anchorYaw).add(anchorPos);
  const ladToChar = p => p.clone().sub(anchorPos).applyAxisAngle(V(0, 1, 0), -anchorYaw);
  const wClimb = climbWeight(state, u) * fade;
  RIG.wClimb = wClimb;
  if (wClimb > 0.001) solveRig({ L: LADDER, anchorPos, anchorYaw, wClimb, paused, dt: ladDt });
  // Top platform foot grounding at the end of Up_End
  if (state === 'up_end' && u > 0.62) {
    const wPlat = sstep(0.62, 0.82, u);
    for (const s of ['l', 'r']) {
      const thigh = bones['thigh_' + s], calf = bones['calf_' + s], foot = bones['foot_' + s];
      const fp = worldPos(foot), fq = worldQuat(foot), fLad = charToLad(fp);
      if (fLad.y < LADDER.topY + STATE.ANKLE_H) {
        fLad.y = lerp(fLad.y, LADDER.topY + STATE.ANKLE_H, wPlat);
        twoBoneIK(thigh, calf, foot, ladToChar(fLad), worldPos(calf).sub(worldPos(thigh)));
        setWorldQuat(foot, fq);
      }
    }
  }
  if (state.startsWith('up') || state === 'down_start' || state === 'down_loop' || state === 'down_end') {
    for (const s of ['l', 'r']) ikState.foot[s].copy(worldPos(bones['foot_' + s]));
  }
}

async function startLadder(dir = 'auto', autoClimb = true) {
  if (typeof RLT !== 'undefined' && RLT.on) stopRlTimeline();
  if (motionPreview.active) stopMotionPreview();
  if (!LADDER.ready) await loadLadderAnims();
  if (!LADDER.ready) return;
  RL.on = false; RL.frame = null; KA.on = false;
  playerCrouch.on = false; playerCrouch.w = 0;
  const goDown = dir === 'down' || (dir === 'auto' && (LADDER.onPlatform || charPos.y > LADDER.topY * 0.5));
  LADDER.active = true;
  LADDER.auto = autoClimb;
  LADDER.autoDir = goDown ? -1 : 1;
  LADDER.t = 0;
  LADDER.lastRungSfx = -1;
  LADDER.from = { pos: charPos.clone(), yaw: STATE.charYaw }; LADDER.enterT = 0;   // walk-in blend instead of a teleport
  LADDER.zS.x = LADDER.zS.v = 0;
  LADDER.drop = null;
  ladderRigReset();
  RIG.exit = null; RIG.xf = null; RIG.mountT = 0; RIG.pendingMount = true;
  if (goDown) {
    LADDER.state = 'down_start';
    LADDER.slideY = LADDER.topY - 284.15;
  } else {
    LADDER.state = 'up_start';
    LADDER.climbY = LADDER.startH;
  }
  const btn = document.getElementById('ladderBtn');
  if (btn) btn.classList.add('active');
}

// F on the ladder: climbing up -> climbing down (dismount at the bottom) -> hold still -> climbing up again.
export function toggleLadder() {
  if (LADDER.active) {
    if (LADDER.state === 'up_loop') {
      if (LADDER.auto && LADDER.autoDir > 0) LADDER.autoDir = -1;
      else if (LADDER.auto) LADDER.auto = false;
      else { LADDER.auto = true; LADDER.autoDir = 1; }
    } else LADDER.auto = !LADDER.auto;
    return;
  }
  startLadder('auto', true);
}

// Leave the ladder: the pose, the weapon and the root are blended into the normal pipeline by ladderExitPost().
function exitLadder(pos, yaw, onPlatform) {
  RIG.exit = { snap: snapshotPose(charPos, STATE.charYaw), t: 0 };
  charPos.copy(pos);
  STATE.charYaw = yaw;
  LADDER.active = false;
  LADDER.onPlatform = onPlatform;
  mm.vel[0] = mm.vel[1] = mm.speed = 0;
  if (STATE.IDLE) { mm.out.set(STATE.IDLE); mm.prev.set(STATE.IDLE); }
  document.getElementById('ladderBtn')?.classList.remove('active');
}
// Let go mid-climb: limbs release, the body falls away from the rungs and lands at the foot of the ladder.
export function dropFromLadder() {
  const L = LADDER;
  if (!L.active || L.state !== 'up_loop') return;
  const relY = clamp(L.climbY - L.startH, 0, L.loops * L.loopH - 0.001), cyc = Math.floor(relY / L.loopH);
  L.drop = { t: 0, vy: 0, z0: L.zS.x, y: L.startH + cyc * L.loopH, u: (relY - cyc * L.loopH) / L.loopH };
  L.state = 'drop';
}

export function updateLadder(dt) {
  if (!LADDER.active || !LADDER.ready) return false;
  ladDt = dt;
  ensureRigZ();
  const C = LADDER.clips;
  const vz = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  if (vz !== 0) LADDER.auto = false;
  RIG.mountT += dt;

  const st = LADDER.state;   // state this frame's pose belongs to (the branches below may advance it)
  let ikSt = st, fade = 1, src = C.upStart, clipTime = 0, u = 0, anchorPos = V(0, 0, 0), anchorYaw = 0, paused = false, done = null;

  if (st === 'up_start') {
    src = C.upStart;
    LADDER.t += dt;
    clipTime = Math.min(LADDER.t, src.dur);
    u = clipTime / src.dur;
    if (LADDER.t >= src.dur) {
      LADDER.state = 'up_loop';
      LADDER.climbY = LADDER.startH;
      LADDER.t = 0;
      playClick(420, 0.04, 0.25);
    }
  } else if (st === 'up_loop') {
    src = C.upLoop;
    const dir = LADDER.auto ? LADDER.autoDir : vz;
    paused = Math.abs(dir) < 0.01;
    const fast = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1.35 : 1.0;
    LADDER.climbY += dir * LADDER_RATE * fast * dt;
    const maxClimbY = LADDER.startH + LADDER.loops * LADDER.loopH;
    const rungIdx = Math.floor((LADDER.climbY - LADDER.startH) / LADDER.rungStep);
    if (rungIdx !== LADDER.lastRungSfx && !paused) {
      LADDER.lastRungSfx = rungIdx;
      playClick(440 + (rungIdx & 1) * 60, 0.04, 0.22);
    }
    if (LADDER.climbY >= maxClimbY && dir > 0) {
      LADDER.climbY = maxClimbY;
      LADDER.state = 'up_end';
      LADDER.t = 0;
    } else if (LADDER.climbY <= LADDER.startH && dir < 0) {
      LADDER.climbY = LADDER.startH;
      LADDER.state = 'dismount';
      LADDER.t = C.upStart.dur;
    }
    const relY = clamp(LADDER.climbY - LADDER.startH, 0, LADDER.loops * LADDER.loopH - 0.001);
    const cyc = Math.floor(relY / LADDER.loopH);
    u = (relY - cyc * LADDER.loopH) / LADDER.loopH;
    clipTime = u * src.dur;
    anchorPos.set(0, LADDER.startH + cyc * LADDER.loopH, 0);
  } else if (st === 'up_end') {
    src = C.upEnd;
    LADDER.t += dt;
    clipTime = Math.min(LADDER.t, src.dur);
    u = clipTime / src.dur;
    anchorPos.set(0, LADDER.startH + LADDER.loops * LADDER.loopH, 0);
    if (LADDER.t >= src.dur) done = { pos: LADDER.toWorld(V(-10.82, LADDER.topY, 70.18)), yaw: LADDER.yaw, platform: true };
  } else if (st === 'down_start') {
    src = C.downStart;
    LADDER.t += dt;
    clipTime = Math.min(LADDER.t, src.dur);
    u = clipTime / src.dur;
    anchorPos.set(0, LADDER.topY, 62.78); anchorYaw = Math.PI;
    if (LADDER.t >= src.dur) {
      LADDER.state = 'up_loop';
      LADDER.climbY = LADDER.topY - 284.15;
      LADDER.auto = true; LADDER.autoDir = -1;
      LADDER.t = 0;
      RIG.xf = { snap: snapshotPose(charPos, STATE.charYaw), t: 0, dur: 0.45 };
    }
  } else if (st === 'dismount') {
    // bottom dismount: the mount clip played backwards, the climber steps off the first rung and away
    src = C.upStart;
    LADDER.t -= dt;
    clipTime = Math.max(LADDER.t, 0);
    u = clipTime / src.dur;
    ikSt = 'up_start';
    if (LADDER.t <= 0) done = { pos: LADDER.toWorld(V(5.87, 0, -37.45)), yaw: LADDER.yaw, platform: false };
  } else if (st === 'drop') {
    const d = LADDER.drop;
    src = C.upLoop; u = d.u; clipTime = u * src.dur; paused = true; d.t += dt; d.vy -= 980 * dt; d.y += d.vy * dt;
    ikSt = 'up_loop';
    fade = 1 - sstep(0, 0.2, d.t);
    anchorPos.set(0, d.y, lerp(d.z0, -42, sstep(0, 0.4, d.t)));
  }

  // Move the body in until the chest sits at the right distance in front of the rungs; eased so state changes never pop
  const zo = RIG.zoff ?? 0;
  if (st !== 'drop') {
    const zT = (st === 'up_start' || st === 'dismount') ? zo * sstep(0, 0.45, u) : st === 'up_loop' ? zo
      : st === 'up_end' ? zo * (1 - sstep(0.15, 0.7, u)) : st === 'down_start' ? zo * sstep(0.6, 1, u) : 0;
    damp(LADDER.zS, zT, 16, dt);
    anchorPos.z = LADDER.zS.x;
  } else LADDER.zS.x = anchorPos.z;
  if (st === 'down_start' && LADDER.state === 'up_loop') LADDER.zS.x = zo;

  // Retarget the ladder frame in character space (charRoot at identity)
  retargetFrame(clipTime, null, src, true);
  idleMicro(anchorPos);

  // Root placement (walk-in blend instead of a teleport)
  const aw = LADDER.toWorld(anchorPos), ay = angWrap(LADDER.yaw + anchorYaw), f0 = LADDER.from;
  LADDER.enterT += dt;
  const bIn = f0 ? sstep(0, 0.45, LADDER.enterT) : 1;
  const rootPos = f0 ? f0.pos.clone().lerp(aw, bIn) : aw;
  const rootYaw = f0 ? angWrap(f0.yaw + angWrap(ay - f0.yaw) * bIn) : ay;
  if (RIG.pendingMount) { RIG.pendingMount = false; RIG.xf = { snap: snapshotPose(f0.pos, f0.yaw), t: 0, dur: 0.45 }; }
  if (RIG.xf) {
    RIG.xf.t += dt;
    const w = 1 - smoother(RIG.xf.t / RIG.xf.dur);
    blendToSnapshot(RIG.xf.snap, w, rootPos, rootYaw);
    if (w <= 0) RIG.xf = null;
  }
  charPos.copy(rootPos); STATE.charYaw = rootYaw;
  if (bIn >= 1) LADDER.from = null;

  solveLadderIK(ikSt, u, anchorPos, anchorYaw, paused, fade);

  // Weapon: hand -> back while mounting
  const cur = W.cur;
  if (cur?.obj) {
    Object.values(W.list).forEach(w => { w.obj.visible = (w === cur); });
    const s = smoother((RIG.mountT - 0.06) / 0.55);
    applyGun(cur, slingBlend(handMatrix(cur), backMatrix(), s));
  }

  if (st === 'drop') {
    const d = LADDER.drop;
    d.fy ??= Math.min(worldPos(bones.foot_l).y, worldPos(bones.foot_r).y);
    if (d.t > 0.1 && anchorPos.y + d.fy <= STATE.ANKLE_H) done = { pos: LADDER.toWorld(V(0, 0, anchorPos.z)), yaw: LADDER.yaw, platform: false };
  }
  if (done) { exitLadder(done.pos, done.yaw, done.platform); return false; }

  // Live world tracking position for the camera
  const pelChar = worldPos(bones.pelvis);
  LADDER.worldTrackPos.copy(charPos).add(
    V(pelChar.x, pelChar.y - 97.4, pelChar.z).applyAxisAngle(V(0, 1, 0), STATE.charYaw)
  );
  placeCharacter();
  return true;
}
/* NORMAL_W in STATE */   // 1 = normal relaxed stance (can run), 0 = aiming stance
const NORMAL_UNTWIST = { pelvis: 0.6, spine_01: 0.8, spine_02: 0.85, spine_03: 0.9, clavicle_l: 0.7, clavicle_r: 0.7, neck_01: 0.85, head: 0.9 };
export const _aq = new THREE.Quaternion(), _leanQ = new THREE.Quaternion(), _rollQ = new THREE.Quaternion(), _fq = new THREE.Quaternion(), _xq = new THREE.Quaternion();
// pose = locomotion pose vector (see gaitPose) or null for the bare animation.
export function retargetFrame(t, pose, source = rt, previewMode = false) {
  source.mixer.setTime(t);
  source.anim.updateMatrixWorld(true);
  const ab = source.abones;
  const walkW = (!previewMode && pose) ? sstep(8, 72, mm.speed) : 0;
  const pel = source.mPelvis0.clone().addScaledVector(worldPos(ab.pelvis).sub(source.aPelvis0), source.ratio);
  if (walkW > 0.001) {
    // Center the static ADS clip's asymmetric hip XZ offset during locomotion so left & right strafes have identical leg reach
    pel.x = lerp(pel.x, 0, walkW);
    pel.z = lerp(pel.z, 0, walkW * 0.85);
  }
  if (!previewMode) pel.y -= STANCE.drop;
  if (pose) pel.x += pose[0], pel.y += pose[1], pel.z += pose[2];
  ikBase.pelvis.copy(pel);
  if (previewMode && !source.ladderState) pel.add(userIK.pelvis);   // Edit IK pelvis offset also applies to animation previews
  if (!previewMode) {
    pel.add(userIK.pelvis);
    pel.y -= 1.4 * rec.hips.x + BF.drop.x; pel.z -= 0.6 * rec.hips.x; pel.x += BF.side.x;
  }
  bones.pelvis.position.copy(bones.pelvis.parent.worldToLocal(pel));
  _leanQ.setFromAxisAngle(V(1, 0, 0), (pose ? pose[4] : 0) * DEG);
  for (const e of source.list) {
    _aq.copy(worldQuat(e.a)).multiply(e.off);
    if (!previewMode && W.blend > 0 && e.torso && e.rq) _aq.slerp(e.rq, W.blend); // rifle upper-body pose
    // Normal (non-aiming) stance: square the hips / torso / head to the facing direction instead of the bladed ADS twist.
    // Done here (before solveLegs) so the leg IK stays consistent with the pelvis.
    if (!previewMode && STATE.NORMAL_W > 0.001 && NORMAL_UNTWIST[e.m.name] !== undefined && restWorldQ[e.m.name]) _aq.slerp(restWorldQ[e.m.name], STATE.NORMAL_W * NORMAL_UNTWIST[e.m.name]);
    if (pose && e.upper) _aq.premultiply(_leanQ);
    if (e.m === bones.pelvis) {
      if (walkW > 0.001 && restWorldQ.pelvis) _aq.slerp(restWorldQ.pelvis, walkW * 0.88);
      if (pose) _aq.premultiply(_rollQ.setFromAxisAngle(V(0, 0, 1), pose[3] * DEG));
      const f = V(0, 0, 1).applyQuaternion(_xq.copy(_aq).multiply(restWorldQ.pelvis.clone().invert()));
      _aq.premultiply(_rollQ.setFromAxisAngle(V(0, 1, 0), -Math.atan2(f.x, f.z) * walkW + (pose ? pose[15] : 0) * DEG));
    }
    setWorldQuat(e.m, _aq);
  }
  // Preview clips already contain their own authored feet, knees and crouch; do not pin them
  // to the gameplay idle stance. Normal gameplay continues to use the procedural foot IK.
  if (!previewMode) solveLegs(pose);
}

// ======================================================================
//  GAIT  procedural walk / run cycle.  Pose vector (character space, +Z fwd, +X left):
//  [pelvis dx, dy, dz, roll°, lean°,  footL x,y,z,pitch°,yaw°,  footR x,y,z,pitch°,yaw°]
//  Feet are absolute targets; pelvis values are offsets from the animated ADS pelvis.
// ======================================================================
const NP = 16;   // + [15] pelvis yaw°
/* IDLE in STATE */

export function gaitParams(v, lat = 0) {
  const rf = sstep(155, 295, v);                                          // 0 = walk, 1 = run (smooth blend)
  // Smooth continuous cadence across all speeds & directions (~1.6-2.0 steps/s walk -> ~2.85 steps/s run).
  // Lateral / diagonal travel shortens stride slightly with balanced rhythm instead of choppy frantic steps.
  const baseFreq = lerp(0.70 + 0.30 * sstep(0, 155, v), 1.02 + 0.44 * sstep(145, 400, v), rf);
  const latScale = 1 + lat * lerp(0.18, 0.28, sstep(80, 260, v));
  const freq = baseFreq * latScale;
  const duty = lerp(0.63, 0.33, rf);                                      // stance fraction (run has aerial phase)
  return { rf, freq, duty, S: v * duty / freq };                          // S = ground travel during stance
}
// Ankle height and fore/aft shift when the foot rolls about the heel (pitch < 0) or the ball (pitch > 0):
// the contact point stays put instead of the foot pivoting around the ankle.
export function footRoll(pitch) {
  const a = Math.abs(pitch) * DEG, c = Math.cos(a), sn = Math.sin(a);
  return pitch >= 0 ? [STATE.BALL_LEN * sn + STATE.ANKLE_H * c, STATE.BALL_LEN * (1 - c) + STATE.ANKLE_H * sn]
                    : [HEEL_BACK * sn + STATE.ANKLE_H * c, HEEL_BACK * (c - 1) - STATE.ANKLE_H * sn];
}
export function gaitPose(vx, vz, phase) {
  const v = Math.hypot(vx, vz);
  if (v < 0.5) return STATE.IDLE.slice();
  const dx = vx / v, dz = vz / v, ax = Math.abs(dx), az = Math.abs(dz);
  const { rf, duty, S } = gaitParams(v, ax);
  const p = new Array(NP).fill(0), vf = sstep(0, 85, v);
  const ph0 = rf * duty * 0.5;                                            // run: hips lowest at mid-stance
  // Smooth 3D pelvis rhythm: mirror-symmetric lateral weight transfer, harmonic vertical bounce, banking roll & directional lean
  p[0] = (lerp(1.65, 0.90, rf) * Math.sin(2 * Math.PI * phase) * (1 - 0.55 * ax) + dx * lerp(1.1, 2.0, rf) * ax) * vf;
  p[1] = (STANCE.drop - lerp(7.8, 9.4, rf)) * vf - lerp(1.65, 4.2, rf) * vf * Math.cos(4 * Math.PI * (phase - ph0));
  p[2] = lerp(0.45, 1.1, rf) * Math.sin(4 * Math.PI * (phase - ph0)) * vf * dz;
  p[3] = (2.2 * (1 - 0.35 * rf) * Math.sin(2 * Math.PI * phase) * (1 - 0.55 * ax) - dx * lerp(1.6, 3.6, rf)) * vf;
  p[4] = dz * lerp(1.8 * sstep(0, 130, v), 8.5, rf) * vf;
  p[15] = -lerp(5.8, 4.4, rf) * vf * Math.cos(2 * Math.PI * phase) * (0.30 + 0.70 * az);
  // Heel strike -> foot flat -> heel-off -> toe-off; lateral steps use a centered, non-crossing shuffle stride within natural leg reach.
  const heelA = lerp(-15, -6, rf), toeA = lerp(30, 37, rf);
  const H = (lerp(7.5, 28, rf) * Math.min(1, 0.38 + v / 155) + 4.5 * ax) * vf;
  const latS = Math.min(S * lerp(0.68, 0.54, rf), lerp(42, 54, rf));
  // Side-steps widen the base symmetrically so left & right boots never collide or cross, while staying inside LEG_MAX.
  const halfW = GAIT_HIP + ax * Math.max(4.5, 0.44 * latS + 5.5 - GAIT_HIP);
  const flatAt = lerp(0.20, 0.13, rf), heelOff = lerp(0.54, 0.40, rf);
  // Subtle toe alignment into diagonal travel (mirror-symmetric across +X / -X with zero snap)
  const dirToe = clamp(Math.atan2(dx, az + 0.4) / DEG * 0.38, -16, 16) * lerp(-0.45, 1, sstep(-0.35, 0.05, dz)) * vf;
  for (const [o, s] of [[5, 'l'], [10, 'r']]) {
    const ph = (((phase + (s === 'l' ? 0 : 0.5)) % 1) + 1) % 1;
    let normProg, lift = 0, rawPitch;
    if (ph < duty) {
      const u = ph / duty;
      normProg = lerp(0.5, -0.5, u);
      rawPitch = u < flatAt ? lerp(heelA, 0, ease(u / flatAt)) : u < heelOff ? 0 : toeA * ease((u - heelOff) / (1 - heelOff));
    } else {
      const w = (ph - duty) / (1 - duty);
      const prog = lerp(ease(w), Math.pow(ease(w), 1.48), rf);
      normProg = lerp(-0.5, 0.5, prog - 0.55 * (1 - duty) / (2 * Math.PI * duty) * Math.sin(2 * Math.PI * w));
      lift = H * Math.sin(Math.PI * Math.pow(w, lerp(0.82, 0.58, rf)));
      rawPitch = lerp(toeA, heelA, ease(w)) + rf * 32 * Math.sin(Math.PI * Math.min(1, w * 1.55));
    }
    const alongZ = (normProg - 0.06) * S;
    const alongX = normProg * latS;
    // Smooth omnidirectional foot pitch: full fore/aft roll, plus subtle cushioned ball-flex on pure lateral steps
    const pitch = (rawPitch * dz + Math.max(0, rawPitch) * 0.22 * ax * (1 - az)) * vf;
    const [ay, shift] = footRoll(pitch), side = s === 'l' ? 1 : -1;
    p[o] = side * halfW + dx * alongX;
    p[o + 1] = ay + lift;
    p[o + 2] = dz * alongZ + shift * (0.20 + 0.80 * az);
    p[o + 3] = pitch;
    p[o + 4] = side * 4.5 + dirToe;
  }
  return p;
}
export function captureIdle(aimPose) {
  // Reference stance: feet of the A_AR_Aim_Fwd pose, scaled to this mannequin and planted flat on the ground.
  const pm = new THREE.AnimationMixer(aimPose); pm.clipAction(aimPose.animations[0]).play(); pm.setTime(0); aimPose.updateMatrixWorld(true);
  const pb = {}; aimPose.traverse(n => { if (n.isBone) pb[n.name] = n; });
  for (const s of ['l', 'r']) {
    STANCE.foot[s].copy(worldPos(pb['foot_' + s]).sub(rt.aFoot0[s]).multiplyScalar(rt.ratio));
    STANCE.foot[s].y = 0;
  }
  retargetFrame(ANIM_T0, null);
  const p = new Array(NP).fill(0);
  for (const [o, s] of [[5, 'l'], [10, 'r']]) {
    const f = bones['foot_' + s], w = worldPos(f);
    const afwd = pb['ball_' + s] ? worldPos(pb['ball_' + s]).sub(worldPos(pb['foot_' + s])) : V(0, 0, 1);
    const rfwd = bones['ball_' + s] ? restWorldPos['ball_' + s].clone().sub(restWorldPos['foot_' + s]) : V(0, 0, 1);
    const yaw = (Math.atan2(afwd.x, afwd.z) - Math.atan2(rfwd.x, rfwd.z)) / DEG;
    p[o] = w.x; p[o + 1] = STATE.ANKLE_H; p[o + 2] = w.z; p[o + 3] = 0; p[o + 4] = yaw;
  }
  STATE.IDLE = p;
}

// ======================================================================
//  MOTION MATCHING
//  Database = gait clips (idle, 8 directions x walk speeds, forward-ish run speeds) sampled
//  at 24 phases. Every 70 ms the current state (feet position/velocity, body velocity and a
//  predicted trajectory toward the input) is matched against all frames; a better frame
//  starts a transition that is absorbed by inertialization (critically-damped offset decay),
//  so cuts are invisible. Playback is time-warped to the real speed to avoid foot sliding.
// ======================================================================
const TURN_START = 60 * DEG, TURN_END = 6 * DEG, STEP_T = 0.3, STEP_LIFT = 9;
const WALK_SPEED = 140, RUN_SPEED = 400, MM_SWITCH_MARGIN = 0.22, INERT_W = 11.5;
const FW = [0.5, 0.5, 0.5, 0.5, 0.4, 0.4, 0.4, 0.4, 3, 3, 1.5, 1.5, 1.5, 1.5, 1, 1];
export const mm = { clips: [], db: null, clip: 0, phase: 0, rate: 1, vel: [0, 0], gaitVel: [0, 0], lastDir: [0, 1], speed: 0,
  out: null, prev: null, outVel: new Float32Array(NP),
  inertX: new Float32Array(NP), inertV: new Float32Array(NP), searchT: 0, cost: 0, best: 0, transitions: 0, demoT: 0 };
export const charPos = V(0, 0, 0), charVelW = V(0, 0, 0);
export const turnOff = [[0, 0], [0, 0]];   // keeps planted feet fixed in the world while the body turns
/* charYaw in STATE */
export const toWorld = p => p.clone().applyAxisAngle(V(0, 1, 0), STATE.charYaw).add(charPos);
export const toWorldDir = d => d.clone().applyAxisAngle(V(0, 1, 0), STATE.charYaw);

function featureVec(pose, vel, cx, cz, a, b, fv) {
  return Float32Array.of(pose[5] / 40, pose[7] / 40, pose[10] / 40, pose[12] / 40,
    vel[5] / 250, vel[7] / 250, vel[10] / 250, vel[12] / 250, cx / 150, cz / 150,
    a[0] / 60, a[1] / 60, b[0] / 60, b[1] / 60, fv[0] / 150, fv[1] / 150);
}
function clipSpeedRate(clip, speed) { return clip.v > 1 ? clamp(speed / clip.v, 0.15, 1.6) : 1; }
function evalContinuousGait(vx, vz, phase) {
  const sp = Math.hypot(vx, vz);
  if (sp > 2) { mm.lastDir[0] = vx / sp; mm.lastDir[1] = vz / sp; }
  const moveW = sstep(1.5, 38, sp);
  if (moveW <= 1e-4) return STATE.IDLE.slice();
  const effSp = Math.max(42, sp);
  const gp = gaitPose(mm.lastDir[0] * effSp, mm.lastDir[1] * effSp, phase);
  if (moveW >= 0.999) return gp;
  const out = new Array(NP);
  for (let i = 0; i < NP; i++) out[i] = lerp(STATE.IDLE[i], gp[i], moveW);
  return out;
}
export function buildDB() {
  const clips = [{ vx: 0, vz: 0, v: 0, name: 'idle' }];
  const add = (deg, v) => clips.push({ vx: Math.sin(deg * DEG) * v, vz: Math.cos(deg * DEG) * v, v, name: `${v < 220 ? 'walk' : 'run'} ${deg}° ${v}` });
  // Full 360° omnidirectional walk & run coverage so diagonal / lateral / backpedal transitions never hit blind spots
  for (let d = 0; d < 360; d += 45) for (const v of [70, 110, 145, 185, 260, 340, 410]) add(d, v);
  for (const c of clips) if (c.v > 1) c.freq = gaitParams(c.v, Math.abs(c.vx) / c.v).freq;
  const N = 24, feats = [], cl = [], ph = [];
  clips.forEach((c, ci) => {
    const frames = c.v > 1 ? N : 1;
    for (let k = 0; k < frames; k++) {
      const phase = k / N, pose = gaitPose(c.vx, c.vz, phase), dph = 1 / N / 2;
      const nxt = gaitPose(c.vx, c.vz, phase + dph), T = c.v > 1 ? dph / c.freq : 1;
      const vel = pose.map((x, i) => c.v > 1 ? (nxt[i] - x) / T : 0);
      feats.push(featureVec(pose, vel, c.vx, c.vz, [c.vx * 0.25, c.vz * 0.25], [c.vx * 0.55, c.vz * 0.55], [c.vx, c.vz]));
      cl.push(ci); ph.push(phase);
    }
  });
  mm.clips = clips;
  mm.db = { n: cl.length, feat: feats, clip: cl, phase: ph };
  mm.out = Float32Array.from(STATE.IDLE); mm.prev = Float32Array.from(STATE.IDLE);
}
function mmSearch(des) {
  const tau = 0.3, cx = mm.vel[0], cz = mm.vel[1];
  const tp = t => { const k = tau * (1 - Math.exp(-t / tau)); return [des[0] * t + (cx - des[0]) * k, des[1] * t + (cz - des[1]) * k]; };
  const e = Math.exp(-0.5 / tau);
  const q = featureVec(mm.out, mm.outVel, cx, cz, tp(0.25), tp(0.55), [des[0] + (cx - des[0]) * e, des[1] + (cz - des[1]) * e]);
  const db = mm.db; let best = -1, bestC = Infinity, cur = Infinity;
  for (let i = 0; i < db.n; i++) {
    const f = db.feat[i]; let c = 0;
    for (let d = 0; d < 16; d++) { const x = f[d] - q[d]; c += FW[d] * x * x; }
    if (db.clip[i] === mm.clip) {
      let dp = Math.abs(db.phase[i] - mm.phase); dp = Math.min(dp, 1 - dp);
      if (mm.clip === 0 || dp <= 0.08) cur = Math.min(cur, c);
    }
    if (c < bestC) { bestC = c; best = i; }
  }
  mm.cost = cur; mm.best = bestC;
  if (best < 0) return;
  const nc = db.clip[best];
  // Continuous gait handles smooth direction & speed sweeps natively; only re-phase via inertialization
  // when starting from idle or executing a sharp direction reversal so there are zero micro-cuts.
  const desSp = Math.hypot(des[0], des[1]), curSp = Math.hypot(cx, cz);
  const dot = (desSp > 25 && curSp > 25) ? (des[0] * cx + des[1] * cz) / (desSp * curSp) : 1;
  const fromIdle = mm.clip === 0 && nc !== 0 && desSp > 20;
  const sharpReverse = dot < -0.25 && bestC + MM_SWITCH_MARGIN < cur;
  if (fromIdle || sharpReverse) mmTransition(best, des, fromIdle);
  else mm.clip = nc;
}
function mmTransition(i, des, fromIdle = false) {
  const db = mm.db, nc = db.clip[i];
  let np = db.phase[i];
  const desSp = Math.hypot(des[0], des[1]);
  if (desSp > 2) {
    mm.lastDir[0] = des[0] / desSp;
    mm.lastDir[1] = des[1] / desSp;
    if (fromIdle && Math.abs(des[0]) > Math.abs(des[1]) * 0.5) {
      // Mirror-symmetric lateral step-off: lift the lead leg first (Left leg for A/+X, Right leg for D/-X)
      const duty0 = gaitParams(Math.max(42, desSp), Math.abs(des[0]) / desSp).duty;
      np = des[0] >= 0 ? duty0 : (duty0 + 0.5) % 1;
    }
  }
  const gx = mm.gaitVel[0], gz = mm.gaitVel[1], gSp = Math.hypot(gx, gz);
  const effSp = Math.max(42, gSp);
  const freq = gSp > 1.5 ? gaitParams(effSp, Math.abs(gx) / gSp).freq * clamp(gSp / effSp, 0.32, 1.15) : 0;
  // Evaluate at mm.gaitVel (identical to stepLocomotion) so base + inertX === mm.out with zero discontinuity
  const base = evalContinuousGait(gx, gz, np);
  const adv = freq * 0.01;
  const base2 = adv > 1e-6 ? evalContinuousGait(gx, gz, (np + adv) % 1) : base;
  for (let j = 0; j < NP; j++) {
    mm.inertX[j] = mm.out[j] - base[j];
    mm.inertV[j] = mm.outVel[j] - (adv > 1e-6 ? (base2[j] - base[j]) / 0.01 : 0);
  }
  mm.clip = nc; mm.phase = np; mm.transitions++;
}

// ---------- input ----------
export const keys = new Set();
/* demoOn, testInput in STATE */
const DEMO = [[1.5, {}], [3.5, { z: 1 }], [4.5, { z: 1, run: 1, turn: 0.45 }], [1.0, {}], [3.0, { x: 1 }], [2.5, { z: -1 }], [3.0, { z: 1, turn: -0.5 }], [1.5, {}]];
function demoInput(t) {
  const total = DEMO.reduce((a, d) => a + d[0], 0); t %= total;
  for (const [d, v] of DEMO) { if (t < d) return { x: 0, z: 0, run: 0, turn: 0, ...v }; t -= d; }
  return { x: 0, z: 0, run: 0, turn: 0 };
}
function readInput(dt) {
  if (STATE.testInput) return STATE.testInput;
  if (STATE.demoOn) { mm.demoT += dt; return demoInput(mm.demoT); }
  const k = (...c) => c.some(x => keys.has(x)) ? 1 : 0;
  if (touch.mv.id !== null && touch.mv.m > 0.12) return stickInput(touch.mv.x, touch.mv.y, touch.mv.m, touch.run);
  return { x: k('KeyA') - k('KeyD'), z: k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown'),
    run: k('ShiftLeft', 'ShiftRight'), turn: game.active ? 0 : 1.5 * (k('KeyQ', 'ArrowLeft') - k('KeyE', 'ArrowRight')) };
}

// Touch stick -> analog movement. Speed rises continuously with deflection and the outer ring blends into a
// run, so a wobbling thumb near the rim no longer flips between walk (140) and run (400) every few frames.
function stickInput(x, y, m, runToggle) {
  return { x: -x, z: -y, mag: runToggle ? Math.min(1, m) : Math.min(1, m / 0.7), run: runToggle ? 1 : sstep(0.72, 0.97, m), turn: 0 };
}
export function stepLocomotion(dt) {
  let inp = readInput(dt);
  // Analog stick: low-pass direction / deflection (~0.1 s) so thumb wobble doesn't modulate the speed and gait.
  if (inp.mag !== undefined) {
    const k = 1 - Math.exp(-10 * dt), si = mm.stick ||= { x: inp.x, z: inp.z, mag: inp.mag, run: inp.run };
    si.x += (inp.x - si.x) * k; si.z += (inp.z - si.z) * k; si.mag += (inp.mag - si.mag) * k; si.run += (inp.run - si.run) * k;
    inp = { ...inp, x: si.x, z: si.z, mag: si.mag, run: si.run };
  } else mm.stick = null;

  // Align character yaw first: in game mode, compensate for A_AR_Aim_Fwd's natural bladed rifle angle (AI.yaw0) at rest,
  // and smoothly square the lower body to tps.yaw while moving so left (A) and right (D) strafes are 100% symmetric.
  const m = Math.hypot(inp.x, inp.z);
  const moveFade = 1 - Math.max(sstep(15, 85, mm.speed), m > 0.01 ? 0.92 : 0);
  const targetAimYawOff = (AI.yaw0 || 0) * W.blend * playerAim.w * moveFade;
  mm.aimYawOff = lerp(mm.aimYawOff || 0, targetAimYawOff, 1 - Math.exp(-9 * dt));
  let dTurn;
  if (game.active) {
    const err = angWrap(tps.yaw - mm.aimYawOff - STATE.charYaw), ts = mm.ts ||= { on: false, t: 0, sw: -1, u: 0, from: 0, yaw: [0, 0] };
    const standing = m < 0.01 && mm.speed < 12 && !LADDER.active;
    if (standing && !ts.on && Math.abs(err) > TURN_START) ts.on = true;
    if (!standing || Math.abs(err) < TURN_END) ts.on = false;
    if (ts.on) {
      // Eased stepped turn: ramp in, speed proportional to remaining angle, capped.
      ts.t = Math.min(1, ts.t + dt / 0.18);
      const ramp = ts.t * ts.t * (3 - 2 * ts.t), rate = clamp(Math.abs(err) * 6, 0.9, 4.2) * ramp;
      dTurn = Math.sign(err) * Math.min(Math.abs(err), rate * dt);
    } else {
      ts.t = 0;
      dTurn = err * (1 - Math.exp(-(standing ? 7 : 12) * dt));
    }
  } else dTurn = inp.turn * dt;
  STATE.charYaw += dTurn;

  let des = [0, 0];
  if (m > 0.01) {
    const ix = inp.x / m, iz = inp.z / m;
    // Prevent running while actively aiming (ADS) or crouching; hip-ready in Aim game still allows starting a Shift sprint.
    const aimingNow = game.active ? isAiming() : (isAiming() || playerAim.w > 0.35);
    const runW = aimingNow || playerCrouch.on ? 0 : (+inp.run || 0);
    const aimSlow = lerp(1.0, 0.86, playerAim.w);
    const walkSp = WALK_SPEED * (1 - 0.16 * Math.abs(ix)) * aimSlow;
    const runSp = lerp(215, RUN_SPEED, sstep(-0.15, 0.72, iz));
    let sp = lerp(walkSp, runSp, runW);
    sp = lerp(sp, Math.min(sp, lerp(118, 175, runW)), sstep(-0.2, -0.55, iz));   // smooth backpedal speed cap
    sp *= (inp.mag ?? 1) * (1 - 0.4 * Math.abs(LEAN.w));
    // Rotate camera-relative input into character-local space so W/A/S/D always moves straight along tps.yaw
    const lookOff = game.active ? angWrap(tps.yaw - STATE.charYaw) : 0;
    const cl = Math.cos(lookOff), sl = Math.sin(lookOff);
    const dx = ix * cl + iz * sl, dz = -ix * sl + iz * cl;
    des = [dx * sp, dz * sp];
  }

  // Smooth exponential + rate-bounded velocity filter: zero corner jerk when starting, stopping, or curving across 360°
  const desSpd = Math.hypot(des[0], des[1]);
  // Start-up anticipation: the first ~0.15 s of a push-off ramps in with a smootherstep so the body commits before the feet go.
  mm.moveT = desSpd > 5 ? Math.min(1, (mm.moveT || 0) + dt / 0.18) : 0;
  const ramp = mm.speed < 60 ? lerp(0.5, 1, mm.moveT * mm.moveT * (3 - 2 * mm.moveT)) : 1;
  const resp = (desSpd > mm.speed ? 8.5 * ramp : (desSpd < 5 ? 10.5 : 9.5));
  const kv = 1 - Math.exp(-resp * dt);
  const maxStep = (desSpd > mm.speed ? 820 : 1080) * dt;
  const ex = (des[0] - mm.vel[0]) * kv, ez = (des[1] - mm.vel[1]) * kv, el = Math.hypot(ex, ez);
  const sc = el > maxStep ? maxStep / el : 1;
  mm.vel[0] += ex * sc; mm.vel[1] += ez * sc;
  if (desSpd < 0.5 && Math.hypot(mm.vel[0], mm.vel[1]) < 0.5) { mm.vel[0] = 0; mm.vel[1] = 0; }
  mm.speed = Math.hypot(mm.vel[0], mm.vel[1]);

  const kg = 1 - Math.exp(-14 * dt);
  mm.gaitVel[0] += (mm.vel[0] - mm.gaitVel[0]) * kg;
  mm.gaitVel[1] += (mm.vel[1] - mm.gaitVel[1]) * kg;

  const c = Math.cos(STATE.charYaw), sn = Math.sin(STATE.charYaw);
  charVelW.set(mm.vel[0] * c + mm.vel[1] * sn, 0, -mm.vel[0] * sn + mm.vel[1] * c);
  charPos.addScaledVector(charVelW, dt);
  if (LADDER.onPlatform) {
    charPos.y = LADDER.topY;
    const lp = LADDER.toLocal(charPos);
    // Walking into the ladder opening at the top platform triggers descending
    if (Math.abs(lp.x) < 38 && lp.z < 52 && charVelW.z < -25 && LADDER.ready) {
      startLadder('down', false);
      return;
    }
    lp.x = clamp(lp.x, -92, 92);
    lp.z = clamp(lp.z, 36, 188);
    charPos.copy(LADDER.toWorld(lp));
  } else {
    charPos.y = 0;
    const lp = LADDER.toLocal(charPos);
    // Walking into the ladder base on the ground triggers ascending
    if (Math.abs(lp.x) < 36 && lp.z > -22 && lp.z < 28 && charVelW.z > 25 && LADDER.ready) {
      startLadder('up', false);
      return;
    }
  }
  if (ARENA.group.visible) pushOutOfCover(charPos, 32);

  mm.searchT -= dt;
  if (mm.searchT <= 0) { mm.searchT = 0.06; mmSearch(des); }

  const gSpd = Math.hypot(mm.gaitVel[0], mm.gaitVel[1]);
  if (gSpd > 1.5) {
    const effSp = Math.max(42, gSpd);
    const gp = gaitParams(effSp, Math.abs(mm.gaitVel[0]) / gSpd);
    mm.rate = clamp(gSpd / effSp, 0.32, 1.15);
    mm.phase = (mm.phase + gp.freq * mm.rate * dt) % 1;
  } else {
    mm.rate = 0;
    if (desSpd < 0.5) mm.clip = 0;
  }

  const e = Math.exp(-INERT_W * dt);
  for (let i = 0; i < NP; i++) {
    const x = mm.inertX[i], v = mm.inertV[i], j1 = v + INERT_W * x;
    mm.inertX[i] = (x + j1 * dt) * e; mm.inertV[i] = (v - j1 * INERT_W * dt) * e;
  }
  const base = evalContinuousGait(mm.gaitVel[0], mm.gaitVel[1], mm.phase);
  for (let i = 0; i < NP; i++) mm.out[i] = base[i] + mm.inertX[i];
  const ts = mm.ts ||= { on: false, t: 0, sw: -1, u: 0, from: 0, yaw: [0, 0] };
  // Turn-in-place shuffle: when a planted foot has been dragged far enough by the body turn, step it back under the body.
  if (ts.on && ts.sw < 0) {
    const k = Math.hypot(turnOff[0][0], turnOff[0][1]) >= Math.hypot(turnOff[1][0], turnOff[1][1]) ? 0 : 1;
    if (Math.hypot(turnOff[k][0], turnOff[k][1]) > 9 || Math.abs(ts.yaw[k]) > 28 * DEG) {
      ts.sw = k; ts.u = 0; ts.from = [turnOff[k][0], turnOff[k][1], ts.yaw[k]];
    }
  }
  if (ts.sw >= 0) {
    ts.u += dt / STEP_T;
    if (ts.u >= 1) { turnOff[ts.sw][0] = turnOff[ts.sw][1] = 0; ts.yaw[ts.sw] = 0; ts.sw = -1; }
  }
  [5, 10].forEach((o, k) => {
    const to = turnOff[k], swing = ts.sw === k;
    if (swing) {
      const e = ts.u * ts.u * (3 - 2 * ts.u), r = 1 - e;
      to[0] = ts.from[0] * r; to[1] = ts.from[1] * r; ts.yaw[k] = ts.from[2] * r;
      mm.out[o + 1] += STEP_LIFT * Math.sin(Math.PI * ts.u) ** 1.5;
    } else {
      const planted = mm.out[o + 1] < STATE.ANKLE_H + 1.2 && Math.hypot(to[0], to[1]) < 22;
      if (planted && Math.abs(dTurn) > 1e-6) {
        const px = mm.out[o] + to[0], pz = mm.out[o + 2] + to[1], ct = Math.cos(dTurn), st = Math.sin(dTurn);
        to[0] += (px * ct - pz * st) - px; to[1] += (px * st + pz * ct) - pz;
        ts.yaw[k] = mm.speed < 30 ? clamp(ts.yaw[k] - dTurn, -1.2, 1.2) : ts.yaw[k] * Math.exp(-10 * dt);
      } else if (!planted) { const d = Math.exp(-12 * dt); to[0] *= d; to[1] *= d; ts.yaw[k] *= d; }
      else if (!ts.on) ts.yaw[k] *= Math.exp(-6 * dt);
    }
    mm.out[o] += to[0]; mm.out[o + 2] += to[1]; mm.out[o + 4] += ts.yaw[k] / DEG;
  });
  for (const o of [5, 10]) {
    const liftInert = Math.hypot(mm.inertX[o], mm.inertX[o + 2]);
    if (liftInert > 1.5) mm.out[o + 1] += Math.min(4.5, 0.14 * (liftInert - 1.5));
  }
  if (dt > 1e-5) for (let i = 0; i < NP; i++) {
    mm.outVel[i] += ((mm.out[i] - mm.prev[i]) / dt - mm.outVel[i]) * Math.min(1, dt * 25);
    mm.prev[i] = mm.out[i];
  }
}
