import * as THREE from 'three';
import { DEG, Spring, V, angWrap, clamp, insideBox2, lerp, rayBox, sstep } from '../math.js';
import { STATE } from '../state.js';
import { bones, setWorldQuat, twoBoneIK, worldPos, worldQuat } from '../skeleton.js';
import { smoother } from './curves.js';
import { applyXfade, captureXfade } from './xfade.js';
import { charPos, mm, retargetFrame, slingWeaponOnBack } from '../locomotion.js';
import { placeCharacter } from '../character.js';
import { getMotionProfile } from '../motion-studio.js';
import { ARENA } from '../ai.js';
import { W, playClick } from '../weapons.js';

// ======================================================================
//  TRAVERSAL — height-selected mocap mantles with phase-based motion warping, plus drop/dodge rolls.
//  Clip metadata was measured from the FBX root/hand/foot tracks (cm, clip root space, +Z forward):
//   ledge = surface height the clip was authored for, face = wall face distance ahead of the start root,
//   tPlant = hands land on the edge, tRel = hands leave, tLift = feet leave the ground, tTop = feet on top,
//   tEnd = handed back to locomotion (the rest of the clip is a held pose).
// ======================================================================
const CLIPS = {
  low:  { id: 'climb-low',   ledge: 86,  face: 68, tPlant: 0.45, tRel: 1.40, tLift: 0.50, tTop: 0.98, tEnd: 1.80, hMin: 55,  hMax: 150, standIn: 40 },
  mid:  { id: 'climb-up-03', ledge: 258, face: 50, tPlant: 0.06, tRel: 1.02, tLift: 0.00, tTop: 1.75, tEnd: 2.20, hMin: 150, hMax: 215, standIn: 26 },
  high: { id: 'climb-up-02', ledge: 258, face: 50, tPlant: 0.86, tRel: 1.82, tLift: 0.60, tTop: 2.55, tEnd: 3.00, hMin: 215, hMax: 300, standIn: 26 },
  roll: { id: 'jump-roll', tTake: 0.55, tHands: 0.82, tEnd: 1.95 },
};

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
  if (mm.speed > 200) {
    const free = freeAhead(V(charPos.x, 30, charPos.z), fwd, 600, null);
    if (free < 320) return false;
    startRoll(fwd, free, 0, -1);
    return true;
  }
  return false;
}

function begin(kind, c, fwd) {
  captureXfade(kind === 'roll' ? 0.2 : 0.24, W.cur?.obj);
  Object.assign(TRAV, { active: true, kind, clip: c, src: c.src, base: charPos.clone(), fwd: fwd.clone(), yaw0: STATE.charYaw, yaw1: Math.atan2(fwd.x, fwd.z), dz: 0, dy: 0 });
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
  TRAV.k = clamp((free - 60) / travel, 0.55, edgeDist >= 0 ? 1 : 0.8);
  TRAV.top = drop; TRAV.t0 = TRAV.t = t0; TRAV.pelZ0 = pzAt(c, t0); TRAV.rate = 1.05;
}

// ---- per-frame ----
function finish() {
  const pel = worldPos(bones.pelvis);
  captureXfade(0.42, W.cur?.obj);   // back to the weapon stance, gun crossfades from the back to the hands
  const off = V(pel.x, 0, pel.z).applyAxisAngle(V(0, 1, 0), STATE.charYaw);
  charPos.add(off);
  charPos.y = TRAV.kind === 'climb' ? TRAV.base.y + TRAV.top : TRAV.base.y + TRAV.dy;
  TRAV.active = false;
  mm.vel[0] = mm.vel[1] = mm.speed = 0;
  if (STATE.IDLE) { mm.out.set(STATE.IDLE); mm.prev.set(STATE.IDLE); }
  return false;
}

export function updateTraverse(dt, fast = false) {
  if (!TRAV.active) return false;
  const c = TRAV.clip;
  TRAV.t += dt * TRAV.rate * (fast ? 1.12 : 1);
  if (TRAV.t >= c.tEnd) return finish();
  const t = TRAV.t;

  retargetFrame(t, null, TRAV.src, true);
  const pelZ = worldPos(bones.pelvis).z;
  let yaw = TRAV.yaw1;
  if (TRAV.kind === 'climb') {
    // forward warp lands the hands on the edge exactly at tPlant; vertical warp is spread over the airborne/pull phase
    const tA = Math.max(c.tPlant, TRAV.t0 + 0.22);
    TRAV.dz = -TRAV.pelZ0 + (TRAV.dn - c.face + TRAV.pelZ0) * smoother((t - TRAV.t0) / (tA - TRAV.t0));
    const dH = TRAV.top - c.ledge;
    const tB = dH < 0 ? Math.max(c.tPlant, c.tLift + 0.15) : c.tTop;
    TRAV.dy = dH * smoother((t - c.tLift) / (tB - c.tLift));
    yaw = TRAV.yaw0 + angWrap(TRAV.yaw1 - TRAV.yaw0) * smoother((t - TRAV.t0) / Math.max(0.2, (tA - TRAV.t0) * 0.8));
  } else {
    TRAV.dz = -TRAV.pelZ0 - (1 - TRAV.k) * (pelZ - TRAV.pelZ0);   // compress the dive to the free space
    const s = clamp((t - (c.tTake - 0.05)) / (c.tHands - c.tTake + 0.05), 0, 1);
    TRAV.dy = -TRAV.top * s * s;   // accelerating fall from the edge
  }
  if (TRAV.kind === 'climb') solveContacts(t);
  slingWeaponOnBack(W.cur);

  charPos.copy(TRAV.base).addScaledVector(TRAV.fwd, TRAV.dz); charPos.y += TRAV.dy;
  STATE.charYaw = yaw;
  const pel = worldPos(bones.pelvis);
  TRAV.track.copy(charPos).add(V(pel.x, pel.y - 97.4, pel.z).applyAxisAngle(V(0, 1, 0), yaw));
  placeCharacter();
  applyXfade(dt, W.cur?.obj);
  return true;
}

// Hands pinned on the real edge while in contact; hands/feet never inside the wall; feet on the top surface.
function solveContacts(t) {
  const c = TRAV.clip, top = TRAV.top - TRAV.dy, face = TRAV.dn - TRAV.dz;   // ledge in current root space
  const wH = sstep(c.tPlant - 0.12, c.tPlant, t) * (1 - sstep(c.tRel - 0.1, c.tRel + 0.12, t));
  for (const s of ['l', 'r']) {
    const up = bones['upperarm_' + s], lo = bones['lowerarm_' + s], hand = bones['hand_' + s];
    const hp = worldPos(hand), hq = worldQuat(hand), tg = hp.clone();
    if (wH > 0.001) tg.lerp(V(hp.x, top + 3.5, Math.max(hp.z, face + 7)), wH);
    if (tg.y < top - 2 && tg.z > face - 4) tg.z = face - 4;
    if (tg.distanceToSquared(hp) > 0.01) { twoBoneIK(up, lo, hand, tg, worldPos(lo).sub(worldPos(up))); setWorldQuat(hand, hq); }
  }
  for (const s of ['l', 'r']) {
    const th = bones['thigh_' + s], ca = bones['calf_' + s], ft = bones['foot_' + s];
    const fp = worldPos(ft), fq = worldQuat(ft), tg = fp.clone();
    if (tg.z > face + 2 && tg.y < top + STATE.ANKLE_H) tg.y = top + STATE.ANKLE_H;        // on top: not sunk into it
    else if (tg.y < top - 2 && tg.z > face - 6) tg.z = face - 6;                          // on the wall: toes at the face
    if (tg.distanceToSquared(fp) > 0.01) { twoBoneIK(th, ca, ft, tg, worldPos(ca).sub(worldPos(th))); setWorldQuat(ft, fq); }
  }
}
