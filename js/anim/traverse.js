import * as THREE from 'three';
import { DEG, Spring, V, angWrap, clamp, insideBox2, lerp, rayBox, sstep } from '../math.js';
import { STATE } from '../state.js';
import { bones, setWorldQuat, twoBoneIK, worldPos, worldQuat } from '../skeleton.js';
import { smoother } from './curves.js';
import { applyXfade, captureXfade } from './xfade.js';
import { charPos, keys, mm, retargetFrame, slingWeaponOnBack } from '../locomotion.js';
import { isAiming, placeCharacter } from '../character.js';
import { getMotionProfile } from '../motion-studio.js';
import { ARENA } from '../ai.js';
import { game, tps } from '../game.js';
import { touch } from '../ui.js';
import { W, playClick } from '../weapons.js';

// ======================================================================
//  TRAVERSAL — height-selected mocap mantles with phase-based motion warping, plus drop/dodge rolls.
//  Timings read from the FBX hand/foot tracks (s): tPlant/tRel = hands on/off the edge, vUp/vDown = window in which a
//  higher/lower real ledge is absorbed by the root, tOut = earliest exit when the player moves or aims, tEnd = clip done.
//  The authored ledge height and face distance are measured from the clip itself at load (see measureEdge).
// ======================================================================
const CLIPS = {
  low:  { id: 'climb-low',   tPlant: 0.40, tRel: 0.80, vUp: [0.40, 0.78], vDown: [0.40, 0.78], tOut: 1.25, tEnd: 1.75, hMin: 55,  hMax: 150, standIn: 40 },
  mid:  { id: 'climb-up-03', tPlant: 0.00, tRel: 1.48, vUp: [0.00, 1.40], vDown: [0.00, 0.30], tOut: 1.72, tEnd: 2.15, hMin: 150, hMax: 215, standIn: 26 },
  high: { id: 'climb-up-02', tPlant: 0.80, tRel: 2.28, vUp: [0.80, 2.20], vDown: [0.55, 0.80], tOut: 2.52, tEnd: 2.95, hMin: 215, hMax: 300, standIn: 26 },
  roll: { id: 'jump-roll', tTake: 0.55, tHands: 0.82, tOut: 1.45, tEnd: 1.90 },
};
const ARM_ROOTS = ['clavicle_l', 'clavicle_r'];

export const TRAV = {
  active: false, kind: '', clip: null, src: null, t: 0, rate: 1,
  base: V(), fwd: V(), yaw0: 0, yaw1: 0, dn: 0, top: 0, dz: 0, dy: 0, k: 1, t0: 0, pelZ0: 0,
  track: V(), onCover: null, fallV: 0, dip: new Spring(3.2, 0.55), ready: false,
};

// ---- lazy loading: clips are fetched one by one in idle time after the game starts, never on the hot path ----
let _load = null;
export function preloadTraversal() {
  if (_load) return _load;
  const idle = cb => (self.requestIdleCallback ? requestIdleCallback(cb, { timeout: 4000 }) : setTimeout(cb, 300));
  _load = (async () => {
    for (const c of Object.values(CLIPS)) {
      await new Promise(r => idle(r));
      c.src = await getMotionProfile(c.id);
      c.pz = sampleRootZ(c.src);   // pelvis forward track, sampled once, for phase-matched entry and roll scaling
      if (c.tRel) measureEdge(c);
    }
    TRAV.ready = true;
  })().catch(e => { console.warn('Traversal clips unavailable:', e); _load = null; });
  return _load;
}
function sampleRootZ(src) {
  const out = [], ab = src.abones;
  for (let i = 0; i * (1 / 30) <= src.dur; i++) {
    src.mixer.setTime(i / 30); src.anim.updateMatrixWorld(true);
    out.push(src.mPelvis0.z + (worldPos(ab.pelvis).z - src.aPelvis0.z) * src.ratio);
  }
  return out;
}
// Authored ledge/face measured from the clip's legs (cm, mannequin space): ledge = soles at the end of the clip; face = the
// plane every leg point still below the top stays in front of (toes/knees pressed on the wall). Warping to these puts the
// real wall where the mocap's wall was.
const LEG_R = { ball_l: 6, ball_r: 6, foot_l: 7, foot_r: 7, calf_l: 8, calf_r: 8 };
function measureEdge(c) {
  const src = c.src, ab = src.abones, at = (b, t) => {
    src.mixer.setTime(t); src.anim.updateMatrixWorld(true);
    return src.mPelvis0.clone().addScaledVector(worldPos(ab[b]).sub(src.aPelvis0), src.ratio);
  };
  c.ledge = Math.min(at('foot_l', c.tEnd).y, at('foot_r', c.tEnd).y) - STATE.ANKLE_H;
  let lo = -1e9;
  for (let t = 0; t <= c.tEnd; t += 1 / 30) for (const b in LEG_R) {
    if (!ab[b]) continue;
    const p = at(b, t);
    if (p.y < c.ledge - 3) lo = Math.max(lo, p.z + LEG_R[b]);   // joint centre below the top: still on the wall side
  }
  c.face = lo;
}
const pzAt = (c, t) => { const f = clamp(t * 30, 0, c.pz.length - 1), i = Math.floor(f), j = Math.min(i + 1, c.pz.length - 1); return lerp(c.pz[i], c.pz[j], f - i); };

// ---- ground: standing on cover tops, falling off edges ----
export function groundHeightAt(x, z, y) {
  let g = 0, on = null;
  for (const cv of ARENA.covers) if (cv.h <= y + 20 && cv.h > g && insideBox2(x, z, cv, 0)) { g = cv.h; on = cv; }
  return { g, on };
}
export function stepGround(dt) {
  if (!ARENA.group.visible) { charPos.y = 0; TRAV.onCover = null; return; }
  const { g, on } = groundHeightAt(charPos.x, charPos.z, charPos.y);
  TRAV.onCover = on;
  if (charPos.y > g + 0.5 || TRAV.fallV > 0) {
    TRAV.fallV -= 981 * dt;
    charPos.y += TRAV.fallV * dt;
    if (charPos.y <= g) {
      TRAV.dip.kick(clamp(-TRAV.fallV * 0.022, 3, 16));   // landing absorb, scaled by impact speed
      if (TRAV.fallV < -420) playClick(260, 0.06, 0.3);
      charPos.y = g; TRAV.fallV = 0;
    }
  } else { charPos.y = g; TRAV.fallV = 0; }
}
export function stepLandingDip(dt) { TRAV.dip.step(dt); return Math.max(0, TRAV.dip.x); }

// ---- detection ----
const _o = V(), _d = V();
function probeWall(fwd) {
  let best = null;
  _o.set(charPos.x, charPos.y + 30, charPos.z);
  for (const cv of ARENA.covers) {
    if (cv.h <= charPos.y + 40 || cv === TRAV.onCover) continue;
    const h = rayBox(_o, fwd, cv, 140);
    if (!h || h.t <= 0) continue;
    if (!best || h.t < best.t) best = { t: h.t, n: h.n.clone(), cv };
  }
  return best;
}
function freeAhead(o, fwd, maxD, skip) {
  let t = maxD;
  for (const cv of ARENA.covers) {
    if (cv === skip) continue;
    const h = rayBox(o, fwd, cv, maxD);
    if (h && h.t > 0) t = Math.min(t, h.t);
  }
  return t;
}

// Space in game: mantle if a climbable surface is ahead, drop-roll off an edge, or dodge-roll when sprinting.
export function tryTraverse() {
  if (TRAV.active) return false;
  if (!TRAV.ready) { preloadTraversal(); return false; }
  const yaw = STATE.charYaw, fwd = V(Math.sin(yaw), 0, Math.cos(yaw));
  const hit = ARENA.group.visible ? probeWall(fwd) : null;
  if (hit) {
    const n = V(hit.n.x, 0, hit.n.z).normalize(), into = n.clone().negate();
    if (into.dot(fwd) < Math.cos(55 * DEG)) return false;
    const topRel = hit.cv.h - charPos.y;
    const c = Object.values(CLIPS).find(c => c.hMax && topRel >= c.hMin && topRel < c.hMax);
    if (!c) return false;
    const hitP = _o.clone().addScaledVector(fwd, hit.t);
    const dn = hitP.clone().sub(charPos).setY(0).dot(into);
    const stand = hitP.clone().addScaledVector(into, c.standIn);
    if (!insideBox2(stand.x, stand.z, hit.cv, -6)) return false;   // too thin to stand on
    startClimb(c, into, dn, topRel);
    return true;
  }
  if (TRAV.onCover && ARENA.group.visible) {
    // drop off the edge ahead with a dive roll when it's a real drop and the landing zone is clear
    const edge = charPos.clone().addScaledVector(fwd, 110);
    if (insideBox2(edge.x, edge.z, TRAV.onCover, 0) || charPos.y < 100) return false;
    const free = freeAhead(V(charPos.x, 30, charPos.z), fwd, 600, TRAV.onCover);
    if (free < 300) return false;
    let de = 0; while (de < 110 && insideBox2(charPos.x + fwd.x * de, charPos.z + fwd.z * de, TRAV.onCover, 0)) de += 5;
    startRoll(fwd, free, charPos.y, de);
    return true;
  }
  // Directional dodge roll: 8-way from the held movement keys relative to the camera (or the sprint direction).
  const dir = inputDir();
  if (dir || mm.speed > 200) {
    const d = dir || fwd, free = freeAhead(V(charPos.x, 30, charPos.z), d, 600, null);
    if (free < 200) return false;
    startRoll(d, free, 0, -1);
    return true;
  }
  return false;
}

const _arm = { bones: [], q: [], gunRel: new THREE.Matrix4(), ok: false };
const _mA = new THREE.Matrix4(), _mB = new THREE.Matrix4();
function captureArms() {
  // Weapon-holding arms in parent space (relative to the chest) + gun relative to the right hand, from the last frame.
  if (!_arm.bones.length) for (const r of ARM_ROOTS) bones[r].traverse(b => { if (b.isBone) { _arm.bones.push(b); _arm.q.push(new THREE.Quaternion()); } });
  _arm.bones.forEach((b, i) => _arm.q[i].copy(b.quaternion));
  const g = W.cur?.obj; _arm.ok = !!g;
  if (!g) return;
  const root = g.parent; root.updateMatrixWorld(true);
  _mA.copy(root.matrixWorld).invert().multiply(bones.hand_r.matrixWorld);   // hand in the gun's parent space
  _arm.gunRel.copy(_mA.invert()).multiply(g.matrix);
}
function holdWeapon(w) {
  _arm.bones.forEach((b, i) => b.quaternion.slerp(_arm.q[i], w));
  STATE.mannequinRoot.updateMatrixWorld(true);
  const g = W.cur?.obj;
  if (!_arm.ok || !g) return;
  g.matrixAutoUpdate = false;
  g.matrix.multiplyMatrices(bones.hand_r.matrixWorld, _arm.gunRel);   // charRoot is identity while solving
  g.matrixWorldNeedsUpdate = true;
}

function inputDir() {
  const k = (...c) => c.some(x => keys.has(x)) ? 1 : 0;
  let x = k('KeyA', 'ArrowLeft') - k('KeyD', 'ArrowRight'), z = k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown');
  if (touch.mv.id !== null && touch.mv.m > 0.25) { x = -touch.mv.x; z = -touch.mv.y; }
  if (Math.hypot(x, z) < 0.2) return null;
  const y = tps.yaw;   // +x = left: left vector is (cos y, 0, -sin y)
  return V(Math.sin(y) * z + Math.cos(y) * x, 0, Math.cos(y) * z - Math.sin(y) * x).normalize();
}

function begin(kind, c, fwd) {
  if (kind === 'roll') captureArms();
  captureXfade(kind === 'roll' ? 0.12 : 0.16, W.cur?.obj);
  Object.assign(TRAV, { active: true, kind, clip: c, src: c.src, base: charPos.clone(), fwd: fwd.clone(), yaw0: STATE.charYaw, yaw1: Math.atan2(fwd.x, fwd.z), dz: 0, dy: 0, vz: 0, lastZ: null });
  TRAV.fallV = 0;
  mm.vel[0] = mm.vel[1] = mm.speed = 0;
}
function startClimb(c, into, dn, topRel) {
  begin('climb', c, into);
  TRAV.dn = dn; TRAV.top = topRel;
  // Phase-matched entry: when already close to the wall, skip the clip's approach so the hands still land on time.
  let t0 = 0;
  if (c.tPlant > 0.2) { const want = c.face - dn; for (let t = 0; t < c.tPlant - 0.18; t += 1 / 30) if (pzAt(c, t) - pzAt(c, 0) <= want) t0 = t; }
  TRAV.t0 = TRAV.t = t0;
  TRAV.pelZ0 = pzAt(c, t0) - pzAt(c, 0);
  TRAV.rate = clamp(1 + 0.22 * (c.ledge - topRel) / c.ledge, 0.88, 1.2);   // shorter climbs play a touch faster
}
function startRoll(fwd, free, drop, edgeDist) {
  const c = CLIPS.roll;
  begin('roll', c, fwd);
  // drop: start so the take-off lands on the edge; dodge: skip most of the wind-up
  let t0 = 0.32;
  if (edgeDist >= 0) { t0 = 0.2; for (let t = 0.2; t <= 0.5; t += 1 / 30) if (pzAt(c, c.tTake) - pzAt(c, t) >= edgeDist) t0 = t; }
  const travel = pzAt(c, c.tEnd) - pzAt(c, t0);
  TRAV.k = clamp((free - 60) / travel, edgeDist >= 0 ? 0.55 : 0.4, edgeDist >= 0 ? 1 : 0.8);
  TRAV.top = drop; TRAV.t0 = TRAV.t = t0; TRAV.pelZ0 = pzAt(c, t0); TRAV.rate = 1.05;
}

// ---- per-frame ----
function finish() {
  const pel = worldPos(bones.pelvis);
  const turnBack = TRAV.kind === 'roll' && game.active ? Math.abs(angWrap(tps.yaw - STATE.charYaw)) / Math.PI : 0;
  captureXfade(TRAV.kind === 'roll' ? 0.16 + 0.2 * turnBack : 0.26, W.cur?.obj);   // back to the weapon stance (climbs: gun from the back to the hands)
  const off = V(pel.x, 0, pel.z).applyAxisAngle(V(0, 1, 0), STATE.charYaw);
  charPos.add(off);
  charPos.y = TRAV.kind === 'climb' ? TRAV.base.y + TRAV.top : TRAV.base.y + TRAV.dy;
  TRAV.active = false;
  // Rolls come out facing the aim again (side/back rolls turned the body); the pose crossfade turns it smoothly.
  if (TRAV.kind === 'roll' && game.active) STATE.charYaw = tps.yaw;
  const sp = moveHeld() ? clamp(TRAV.vz, 0, 330) : 0, y = STATE.charYaw;   // keep the momentum when the player keeps moving
  mm.vel[0] = sp * (TRAV.fwd.x * Math.cos(y) - TRAV.fwd.z * Math.sin(y));
  mm.vel[1] = sp * (TRAV.fwd.x * Math.sin(y) + TRAV.fwd.z * Math.cos(y));
  mm.gaitVel[0] = mm.vel[0]; mm.gaitVel[1] = mm.vel[1]; mm.speed = sp;
  if (STATE.IDLE) { mm.out.set(STATE.IDLE); mm.prev.set(STATE.IDLE); }
  return false;
}
const moveHeld = () => ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].some(k => keys.has(k));

export function updateTraverse(dt, fast = false) {
  if (!TRAV.active) return false;
  const c = TRAV.clip;
  let rate = TRAV.rate * (fast ? 1.12 : 1);
  // Drop roll: stretch the clip's airborne window to the real free-fall time for this height (t = sqrt(2h/g)).
  if (TRAV.kind === 'roll' && TRAV.top > 0 && TRAV.t > c.tTake - 0.05 && TRAV.t < c.tHands)
    rate *= clamp((c.tHands - c.tTake + 0.05) / Math.sqrt(2 * TRAV.top / 981), 0.35, 1);
  TRAV.t += dt * rate;
  if (TRAV.t >= c.tEnd || (TRAV.t >= c.tOut && (moveHeld() || isAiming()))) return finish();   // input cancels the settle
  const t = TRAV.t;

  retargetFrame(t, null, TRAV.src, true);
  const pelZ = worldPos(bones.pelvis).z;
  let yaw = TRAV.yaw1;
  if (TRAV.kind === 'climb') {
    // forward warp lands the hands on the edge exactly at tPlant; vertical warp is spread over the airborne/pull phase
    const tA = Math.max(c.tPlant, TRAV.t0 + 0.22);
    TRAV.dz = -TRAV.pelZ0 + (TRAV.dn - c.face + TRAV.pelZ0) * smoother((t - TRAV.t0) / (tA - TRAV.t0));
    const dH = TRAV.top - c.ledge, [va, vb] = dH < 0 ? c.vDown : c.vUp;
    TRAV.dy = dH * smoother((t - va) / Math.max(1e-3, vb - va));
    yaw = TRAV.yaw0 + angWrap(TRAV.yaw1 - TRAV.yaw0) * smoother((t - TRAV.t0) / Math.max(0.2, (tA - TRAV.t0) * 0.8));
  } else {
    // body swings into the roll direction during the crouch of the wind-up (crossfade hides the first frames)
    const dYaw = angWrap(TRAV.yaw1 - TRAV.yaw0);
    yaw = TRAV.yaw0 + dYaw * smoother((t - TRAV.t0) / (0.12 + 0.2 * Math.abs(dYaw) / Math.PI));   // wider turns take longer
    TRAV.dz = -TRAV.pelZ0 - (1 - TRAV.k) * (pelZ - TRAV.pelZ0);   // compress the dive to the free space
    const s = clamp((t - (c.tTake - 0.05)) / (c.tHands - c.tTake + 0.05), 0, 1);
    TRAV.dy = -TRAV.top * s * s;   // accelerating fall from the edge
  }
  if (TRAV.kind === 'climb') { solveContacts(t); slingWeaponOnBack(W.cur); }
  else holdWeapon(sstep(0, 0.08, t - TRAV.t0) * (1 - sstep(c.tOut - 0.1, c.tEnd, t)) * 0.85 + 0.15);   // roll keeps the gun in a tucked ready pose

  charPos.copy(TRAV.base).addScaledVector(TRAV.fwd, TRAV.dz); charPos.y += TRAV.dy;
  const zNow = TRAV.dz + pelZ;
  if (TRAV.lastZ !== null && dt > 0) TRAV.vz += ((zNow - TRAV.lastZ) / dt - TRAV.vz) * Math.min(1, dt * 12);
  TRAV.lastZ = zNow;
  STATE.charYaw = yaw;
  const pel = worldPos(bones.pelvis);
  // rolls: the camera follows the tumble horizontally but only a quarter of its dip, so it never drops into the body
  TRAV.track.copy(charPos).add(V(pel.x, (pel.y - 97.4) * (TRAV.kind === 'roll' ? 0.25 : 1), pel.z).applyAxisAngle(V(0, 1, 0), yaw));
  placeCharacter();
  applyXfade(dt, W.cur?.obj);
  return true;
}

// Hand-to-edge IK: the hands keep exactly the relation to the REAL edge that the mocap had to its authored edge
// (hang -> re-grip -> push all preserved), so the correction is only the part of the warp still in progress.
// Then hard guards: never inside the wall, never below the top once over it; feet on the face or on the top.
function solveContacts(t) {
  const c = TRAV.clip, top = TRAV.top - TRAV.dy, face = TRAV.dn - TRAV.dz;   // real ledge in current root space
  const dY = top - c.ledge, dZ = face - c.face;
  const wH = sstep(c.tPlant - 0.1, c.tPlant + 0.02, t) * (1 - sstep(c.tRel - 0.06, c.tRel + 0.1, t));
  for (const s of ['l', 'r']) {
    const up = bones['upperarm_' + s], lo = bones['lowerarm_' + s], hand = bones['hand_' + s];
    const hp = worldPos(hand), hq = worldQuat(hand), tg = hp.clone();
    tg.y += dY * wH; tg.z += dZ * wH;
    if (tg.z > face - 3 && tg.y < top + 3) { if (tg.y > top - 8 && wH > 0.3) tg.y = top + 3; else tg.z = face - 3; }
    if (tg.distanceToSquared(hp) > 0.01) {
      // keep the elbow from flipping when the reach shortens: pole = current elbow direction
      twoBoneIK(up, lo, hand, tg, worldPos(lo).sub(worldPos(up)));
      setWorldQuat(hand, hq);
    }
  }
  for (const s of ['l', 'r']) {
    const th = bones['thigh_' + s], ca = bones['calf_' + s], ft = bones['foot_' + s];
    const fp = worldPos(ft), fq = worldQuat(ft), tg = fp.clone();
    if (tg.z > face + 2 && tg.y < top + STATE.ANKLE_H) tg.y = top + STATE.ANKLE_H;        // on top: not sunk into it
    else if (tg.y < top - 2 && tg.z > face - 6) tg.z = face - 6;                          // on the wall: toes at the face
    if (tg.distanceToSquared(fp) > 0.01) { twoBoneIK(th, ca, ft, tg, worldPos(ca).sub(worldPos(th))); setWorldQuat(ft, fq); }
    // knee guard: a knee that would enter the wall swings outward about the hip->foot axis (foot stays planted)
    const kp = worldPos(ca);
    if (kp.y < top - 4 && kp.z > face - 5) {
      const hip = worldPos(th), f2 = worldPos(ft), ax = f2.sub(hip).normalize(), sg = s === 'l' ? 1 : -1, fq2 = worldQuat(ft);
      let a = 0;
      for (a = 6; a <= 60; a += 6) if (kp.clone().sub(hip).applyAxisAngle(ax, sg * a * DEG).add(hip).z <= face - 5) break;
      th.quaternion.premultiply(_qk.setFromAxisAngle(_vk.copy(ax).transformDirection(_mk.copy(th.parent.matrixWorld).invert()), sg * a * DEG));
      th.updateMatrixWorld(true); setWorldQuat(ft, fq2);
    }
  }
}
const _qk = new THREE.Quaternion(), _vk = new THREE.Vector3(), _mk = new THREE.Matrix4();
