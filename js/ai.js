import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { DEG, Spring, V, _cd, angWrap, clamp, cvWorld, ease, gauss, insideBox2, lerp, rayBox, rayCapsule, rnd, segBox2 } from './math.js';
import { IS_TOUCH, STATE, rec } from './state.js';
import { camera, charRoot, scene } from './scene.js';
import { audio, playSample, sfxBus } from './audio.js';
import { bones, rotateWorld, worldPos } from './skeleton.js';
import { impactFX, muzzleFlashAt, radialTexture, tracerFX } from './fx.js';
import { ikFromJson, ikToJson } from './ik.js';
import { charPos, charVelW, footRoll, gaitParams, gaitPose, mm, retargetFrame } from './locomotion.js';
import { M4, RIFLE_MUZZLE, W, chainOf, dropped, playClick, poseHandFrom, setGunMatrix } from './weapons.js';
import { AIM_SPLIT, playerCrouch, tmpM, tmpQ } from './character.js';
import { TGROUP, endRound, game, hitMarker, hittables, playDing, popup, ray, tps } from './game.js';
import { ANIM_T0 } from './main.js';

// ======================================================================
//  COMBAT  arena with cover + AI squad. Enemies are clones of the mannequin posed from snapshots of the
//  player's own rig (stand / crouch / run / strafe), so they share its gait and two-handed M4 grip.
//  Brain per enemy: pick a protected cover spot -> run there -> crouch (low cover) or hide (wall) ->
//  stand up / step out, aim (reaction time; accuracy improves while aiming) and fire short bursts -> duck ->
//  reload in cover -> reposition: flank when the player hides, fall back when hurt, push when far.
//  At most 2-3 shoot at once; near misses make them duck. Cover blocks shots both ways.
// ======================================================================
export const AI = { on: false, enemies: [], snaps: null, names: [], template: null, gunGeo: null, gunInHand: null, yaw0: 0, pitch0: 0, crouchH: 115,
  walkCycle: 165, runCycle: 276, strCycle: 100, hp: 100, lastHit: -9, wave: 1, toKill: 5, killed: 0, spawned: 0, kills: 0, heads: 0, spawnT: 0, breakT: 0,
  lastSeen: 0, heardAt: -9, knownPos: V(), knownVel: V(), shooting: 0, chest: V(), head: V(), caps: [], diff: null, drops: [], src: [], flash: 0, hitFrom: null, hitT: -9 };
export const ARENA = { group: new THREE.Group(), covers: [], pts: [],
  spawns: [V(-1300, 0, 3700), V(0, 0, 3950), V(1300, 0, 3700), V(-1750, 0, 2500), V(1750, 0, 2500)] };
ARENA.group.visible = false; scene.add(ARENA.group);
function noiseTex(base, amt, planks) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); g.fillStyle = base; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 900; i++) { g.fillStyle = Math.random() < 0.5 ? `rgba(255,255,255,${Math.random() * amt})` : `rgba(0,0,0,${Math.random() * amt})`; g.fillRect(Math.random() * 128, Math.random() * 128, 2, 2); }
  if (planks) { g.strokeStyle = 'rgba(40,22,10,.55)'; g.lineWidth = 3; for (let y = 0; y <= 128; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(128, y); g.stroke(); } g.strokeRect(3, 3, 122, 122); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const COVER_MAT = { concrete: new THREE.MeshStandardMaterial({ map: noiseTex('#8d9196', 0.18), roughness: 0.95 }),
  wall: new THREE.MeshStandardMaterial({ map: noiseTex('#a9a59c', 0.14), roughness: 0.9 }),
  crate: new THREE.MeshStandardMaterial({ map: noiseTex('#8a6238', 0.2, true), roughness: 0.8 }) };
// x, z, width (local X), depth (local Z), height, yaw°, kind. Low cover (130) hides a crouching enemy; walls (225+) hide a standing one.
const COVER_DEFS = [
  [-430, 560, 300, 40, 225, 0, 'wall'], [470, 600, 280, 40, 225, 0, 'wall'], [40, 900, 300, 70, 130, 0, 'concrete'],
  [-720, 1250, 130, 130, 130, 15, 'crate'], [260, 1380, 320, 70, 130, 10, 'concrete'], [-160, 1720, 360, 45, 230, 0, 'wall'],
  [860, 1650, 130, 130, 130, -10, 'crate'], [-1060, 1900, 140, 140, 135, 30, 'crate'], [660, 2160, 45, 340, 230, 0, 'wall'],
  [-460, 2460, 320, 70, 130, -12, 'concrete'], [200, 2660, 140, 140, 230, 0, 'crate'], [1010, 2800, 300, 70, 130, 15, 'concrete'],
  [-900, 3020, 380, 45, 230, 0, 'wall'], [-150, 3220, 130, 130, 130, 20, 'crate'], [520, 3360, 320, 70, 130, 0, 'concrete'],
];
export function buildArena() {
  for (const [x, z, w, d, h, yd, kind] of COVER_DEFS) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), COVER_MAT[kind]);
    m.position.set(x, h / 2, z); m.rotation.y = yd * DEG; m.castShadow = m.receiveShadow = true;
    ARENA.group.add(m);
    const cv = { c: V(x, 0, z), hx: w / 2, hz: d / 2, h, kind, tall: h > 180, cos: Math.cos(yd * DEG), sin: Math.sin(yd * DEG) };
    ARENA.covers.push(cv);
    // Cover spots 42 cm off each face; on walls only next to the ends (so the enemy can step out to shoot).
    for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const half = nx ? cv.hz : cv.hx, L = half * 2, n = Math.max(1, Math.floor(L / 110));
      for (let k = 0; k < n; k++) {
        const off = n === 1 ? 0 : -half + 45 + (L - 90) * k / (n - 1);
        if (cv.tall && n > 1 && k > 0 && k < n - 1) continue;
        const lx = nx ? nx * (cv.hx + 42) : off, lz = nz ? nz * (cv.hz + 42) : off;
        let peek = null;
        if (cv.tall) { const e = (off >= 0 ? 1 : -1) * (half + 58); peek = nx ? cvWorld(cv, lx, e) : cvWorld(cv, e, lz); }
        ARENA.pts.push({ cover: cv, pos: cvWorld(cv, lx, lz), peek, tall: cv.tall, owner: null });
      }
    }
  }
}
// Ray vs. a yawed box (x/z half extents, y 0..h): { t, n } or null.
export function pushOutOfCover(p, r) {
  for (const cv of ARENA.covers) {
    const ox = p.x - cv.c.x, oz = p.z - cv.c.z, c = cv.cos, s = cv.sin;
    let lx = ox * c - oz * s, lz = ox * s + oz * c;
    const px = cv.hx + r - Math.abs(lx), pz = cv.hz + r - Math.abs(lz);
    if (px <= 0 || pz <= 0) continue;
    if (px < pz) lx = Math.sign(lx || 1) * (cv.hx + r); else lz = Math.sign(lz || 1) * (cv.hz + r);
    p.x = cv.c.x + lx * c + lz * s; p.z = cv.c.z - lx * s + lz * c;
  }
}
const _la = V(), _ld = V();
function losClear(a, b) {
  _ld.subVectors(b, a); const L = _ld.length(); _ld.divideScalar(L);
  for (const cv of ARENA.covers) if (rayBox(a, _ld, cv, L)) return false;
  return true;
}
// Hidden from the player: the spot's own cover is between the (crouched / standing) head and the player's eyes.
function isProtected(cp, P) {
  const a = _la.set(cp.pos.x, cp.tall ? 165 : AI.crouchH, cp.pos.z);
  const targetY = 150 - (playerCrouch?.w || 0) * 35;
  _ld.set(P.x - a.x, targetY - a.y, P.z - a.z); const L = _ld.length(); _ld.divideScalar(L);
  return !!rayBox(a, _ld, cp.cover, L);
}
function canPeek(cp, P) { const q = cp.tall ? cp.peek : cp.pos; return losClear(V(q.x, 150, q.z), V(P.x, 135, P.z)); }
function planPath(from, to) {   // straight line with detours around the corners of blocking cover
  const path = []; let cur = from.clone();
  for (let it = 0; it < 5; it++) {
    let blk = null, bt = 2;
    for (const cv of ARENA.covers) {
      if (insideBox2(cur.x, cur.z, cv, 38)) continue;
      const t = segBox2(cur.x, cur.z, to.x, to.z, cv, 38);
      if (t >= 0 && t < bt) { bt = t; blk = cv; }
    }
    if (!blk) break;
    let bc = null, bl = Infinity;
    for (const [sx, sz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      const c = cvWorld(blk, sx * (blk.hx + 62), sz * (blk.hz + 62));
      if (segBox2(cur.x, cur.z, c.x, c.z, blk, 38) >= 0) continue;
      const l = cur.distanceTo(c) + c.distanceTo(to);
      if (l < bl) { bl = l; bc = c; }
    }
    if (!bc) break;
    path.push(bc); cur = bc;
  }
  path.push(to.clone());
  return path;
}
const ENEMY_CAPS = [['head', 'head', 'head', 13], ['torso', 'pelvis', 'neck_01', 18], ['limb', 'thigh_l', 'calf_l', 9], ['limb', 'thigh_r', 'calf_r', 9],
  ['limb', 'calf_l', 'foot_l', 7], ['limb', 'calf_r', 'foot_r', 7], ['limb', 'upperarm_l', 'lowerarm_l', 7], ['limb', 'upperarm_r', 'lowerarm_r', 7],
  ['limb', 'lowerarm_l', 'hand_l', 6], ['limb', 'lowerarm_r', 'hand_r', 6]];
function rayEnemy(o, d, e, tmax) {
  const cx = e.pos.x - o.x, cy = 95 - o.y, cz = e.pos.z - o.z, tc = cx * d.x + cy * d.y + cz * d.z;
  if (tc < -130 || tc - 130 > tmax || cx * cx + cy * cy + cz * cz - tc * tc > 135 * 135) return null;
  let best = null;
  for (const [part, a, b, r] of e.caps) { const t = rayCapsule(o, d, a, b, r); if (t >= 0 && t < tmax && (!best || t < best.t)) best = { t, part }; }
  return best;
}
// Nearest hit for player shots / the aim ray: trainer targets, cover, enemies, ground.
export function castWorld(o, d, far = 9000, near = 0) {
  let bt = far, best = null;
  if (d.y < -1e-4) { const t = -o.y / d.y; if (t > near && t < bt) { bt = t; best = { kind: 'ground', n: V(0, 1, 0) }; } }
  if (TGROUP.visible) { ray.set(o, d); ray.near = near; ray.far = bt; const h = ray.intersectObjects(hittables, false)[0]; if (h) { bt = h.distance; best = { kind: 'target', hit: h }; } }
  if (ARENA.group.visible) {
    for (const cv of ARENA.covers) { const h = rayBox(o, d, cv, bt); if (h && h.t > near && h.t < bt) { bt = h.t; best = { kind: 'cover', n: h.n, cover: cv }; } }
    for (const e of AI.enemies) { if (!e.alive) continue; const h = rayEnemy(o, d, e, bt); if (h && h.t > near) { bt = h.t; best = { kind: 'enemy', e, part: h.part }; } }
  }
  best ||= { kind: 'none' }; best.t = bt; best.point = o.clone().addScaledVector(d, bt);
  return best;
}
function castEnemyShot(o, d) {
  let bt = 9000, best = { kind: 'none' };
  if (d.y < -1e-4) { const t = -o.y / d.y; if (t < bt) { bt = t; best = { kind: 'ground', n: V(0, 1, 0) }; } }
  for (const cv of ARENA.covers) { const h = rayBox(o, d, cv, bt); if (h && h.t < bt) { bt = h.t; best = { kind: 'cover', n: h.n, cover: cv }; } }
  for (const [part, a, b, r] of AI.caps) { const t = rayCapsule(o, d, a, b, r); if (t >= 0 && t < bt) { bt = t; best = { kind: 'player', part, n: d.clone().negate() }; } }
  best.t = bt; best.point = o.clone().addScaledVector(d, bt);
  return best;
}
function playerCaps() {
  const w = n => worldPos(bones[n]);
  AI.head.copy(w('head')).y += 9; AI.chest.copy(w('spine_03'));
  AI.caps = [['head', AI.head, AI.head, 12], ['torso', w('pelvis'), w('neck_01'), 17],
    ['limb', w('thigh_l'), w('calf_l'), 9], ['limb', w('thigh_r'), w('calf_r'), 9], ['limb', w('calf_l'), w('foot_l'), 7], ['limb', w('calf_r'), w('foot_r'), 7],
    ['limb', w('upperarm_l'), w('lowerarm_l'), 6.5], ['limb', w('upperarm_r'), w('lowerarm_r'), 6.5]];
}

// ---- enemy bodies: pose snapshots taken from the player's rig at load ----
export function captureEnemyPoses() {
  const R = W.list.rifle, keep = { cur: W.cur, blend: W.blend, speed: mm.speed, ik: ikToJson() };
  ikFromJson({ foot: { l: [0, 0, 0], r: [0, 0, 0] }, footQ: { l: [0, 0, 0, 1], r: [0, 0, 0, 1] }, knee: { l: [0, 0, 0], r: [0, 0, 0] }, pelvis: [0, 0, 0], gun: [0, 0, 0], gunQ: [0, 0, 0, 1] });
  W.cur = R; W.blend = 1;
  AI.names = []; AI.template.traverse(n => { if (n.isBone) AI.names.push(n.name); });
  const piv = V(0.34, -9.5, -8.5);
  const lower = (deg, down) => G => {   // low ready: muzzle down about the grip
    G.multiply(new THREE.Matrix4().makeTranslation(piv.x, piv.y, piv.z)).multiply(new THREE.Matrix4().makeRotationX(deg * DEG)).multiply(new THREE.Matrix4().makeTranslation(-piv.x, -piv.y, -piv.z));
    G.premultiply(new THREE.Matrix4().makeTranslation(0, -down, 0));
  };
  const snap = (vec, speed, gunFn) => {
    mm.speed = speed;
    charRoot.position.set(0, 0, 0); charRoot.rotation.set(0, 0, 0); charRoot.updateMatrixWorld(true);
    retargetFrame(ANIM_T0, vec);
    bones.hand_r.updateWorldMatrix(true, false);
    const G = new THREE.Matrix4().multiplyMatrices(bones.hand_r.matrixWorld, R.inHand);
    gunFn?.(G);
    setGunMatrix(G);
    poseHandFrom('r', R.J.r, G, 1, R.fq.r, 1); poseHandFrom('l', R.J.l, G, 1, R.fq.l, 1);
    chainOf('index', 'r').forEach((b, i) => b.quaternion.copy(R.trig.rest[i]));
    const q = new Float32Array(AI.names.length * 4);
    AI.names.forEach((n, i) => bones[n].quaternion.toArray(q, i * 4));
    bones.hand_r.updateWorldMatrix(true, false);
    return { q, pel: bones.pelvis.position.clone(), gun: bones.hand_r.matrixWorld.clone().invert().multiply(G), G, head: worldPos(bones.head) };
  };
  const crouch = STATE.IDLE.slice(); crouch[1] = -40; crouch[4] = 14;
  const back = STATE.IDLE[7] < STATE.IDLE[12] ? 5 : 10, [ay, sh] = footRoll(28);   // rear foot rolls onto the ball
  crouch[back + 1] = ay; crouch[back + 2] += sh; crouch[back + 3] = 28;
  const S = { stand: snap(null, 0), crouch: snap(crouch, 0, lower(26, 3)), walk: [], run: [], strL: [], strR: [] };
  for (let k = 0; k < 12; k++) S.walk.push(snap(gaitPose(0, 165, k / 12), 165, lower(18, 2)));
  for (let k = 0; k < 12; k++) S.run.push(snap(gaitPose(0, 400, k / 12), 400, lower(20, 1)));
  for (let k = 0; k < 8; k++) { S.strL.push(snap(gaitPose(160, 0, k / 8), 160)); S.strR.push(snap(gaitPose(-160, 0, k / 8), 160)); }
  AI.snaps = S; AI.gunInHand = S.stand.gun;
  const bar = V(0, 0, 1).transformDirection(S.stand.G);
  AI.yaw0 = Math.atan2(bar.x, bar.z); AI.pitch0 = Math.asin(clamp(bar.y, -1, 1));
  AI.crouchH = S.crouch.head.y + 14;
  AI.walkCycle = 165 / gaitParams(165, 0).freq; AI.runCycle = 400 / gaitParams(400, 0).freq; AI.strCycle = 160 / gaitParams(160, 1).freq;
  W.cur = keep.cur; W.blend = keep.blend; mm.speed = keep.speed; ikFromJson(keep.ik);
}
export function buildEnemyGun() {   // the M4's visible parts merged into one mesh (weapon space)
  M4.holder.updateMatrixWorld(true);
  const inv = M4.holder.matrixWorld.clone().invert(), P = [], N = [], v = V();
  M4.holder.traverse(o => {
    if (!o.isMesh || o.isSkinnedMesh || !o.visible) return;
    const m = inv.clone().multiply(o.matrixWorld), nm = new THREE.Matrix3().getNormalMatrix(m), g = o.geometry, idx = g.index, pa = g.attributes.position, na = g.attributes.normal;
    for (let i = 0, n = idx ? idx.count : pa.count; i < n; i++) {
      const j = idx ? idx.getX(i) : i;
      v.fromBufferAttribute(pa, j).applyMatrix4(m); P.push(v.x, v.y, v.z);
      if (na) { v.fromBufferAttribute(na, j).applyMatrix3(nm).normalize(); N.push(v.x, v.y, v.z); } else N.push(0, 1, 0);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.computeBoundingSphere();
  return g;
}
function makeAiBadgeTex(label, bg, border, fg = '#ffffff') {
  const c = document.createElement('canvas'); c.width = 160; c.height = 64;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 160, 64);
  g.fillStyle = bg; g.strokeStyle = border; g.lineWidth = 4;
  g.beginPath(); g.roundRect(8, 8, 144, 48, 22); g.fill(); g.stroke();
  g.fillStyle = fg; g.font = 'bold 24px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(label, 80, 33);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const AI_BADGES = {
  patrol:   makeAiBadgeTex('PATROL', 'rgba(20,32,28,0.82)', '#4fd1a5', '#b9f6df'),
  hesitate: makeAiBadgeTex('?  ?',   'rgba(44,32,10,0.88)', '#f5b942', '#ffe39e'),
  search:   makeAiBadgeTex('SEARCH', 'rgba(46,26,10,0.88)', '#fb923c', '#fed7aa'),
  plan:     makeAiBadgeTex('PLAN',   'rgba(12,34,48,0.88)', '#38bdf8', '#bae6fd'),
  alert:    makeAiBadgeTex('!',      'rgba(60,12,16,0.92)', '#f87171', '#fecaca'),
};
function setEnemyBadge(e, kind, dur = 1.6) {
  if (!e.badge) return;
  if (!kind || !AI_BADGES[kind]) { e.badgeT = 0; e.badge.visible = false; return; }
  e.badgeKind = kind; e.badgeT = dur;
  if (e.badge.material.map !== AI_BADGES[kind]) { e.badge.material.map = AI_BADGES[kind]; e.badge.material.needsUpdate = true; }
  e.badge.visible = true;
}
const enemyMat = new THREE.MeshStandardMaterial({ color: 0x8b3a2f, roughness: 0.6, metalness: 0.05 });
const enemyGunMat = new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.5, metalness: 0.6 });
const POOL = IS_TOUCH ? 6 : 7;
let blobIM = null;
export function buildEnemyPool() {
  for (let i = 0; i < POOL; i++) {
    const skin = SkeletonUtils.clone(AI.template), B = {};
    skin.traverse(n => { if (n.isBone) B[n.name] = n; if (n.isMesh) { n.material = enemyMat; n.castShadow = false; } });
    const root = new THREE.Group(); root.add(skin); ARENA.group.add(root);
    const gun = new THREE.Mesh(AI.gunGeo, enemyGunMat); gun.matrixAutoUpdate = false; ARENA.group.add(gun);
    const badge = new THREE.Sprite(new THREE.SpriteMaterial({ map: AI_BADGES.hesitate, transparent: true, depthTest: false, depthWrite: false }));
    badge.scale.set(44, 18, 1); badge.renderOrder = 15; badge.visible = false; ARENA.group.add(badge);
    root.visible = gun.visible = false;
    AI.enemies.push({ root, B, bones: AI.names.map(n => B[n]), gun, badge, badgeKind: null, badgeT: 0,
      pos: V(), lastKnown: V(), searchPos: V(), yaw: 0, moveYaw: 0, muzzle: V(), flinch: new Spring(3.5, 0.4), seed: i * 1.7,
      lookYaw: 0, lookPitch: 0, headTilt: 0, wantLookYaw: 0, wantLookPitch: 0, wantTilt: 0,
      alert: 1, searchCount: 0, patrolWait: 0, dur: 1.4, nextIntent: 'plan', role: i % 3 === 0 ? 'flanker' : i % 3 === 1 ? 'assault' : 'support',
      caps: ENEMY_CAPS.map(([p, , , r]) => [p, V(), V(), r]), active: false, alive: false, state: 'off', path: [], phase: 0, sPhase: 0,
      wWalk: 0, wRun: 0, wCrouch: 0, wStr: 0, strDir: 1, speed: 0 });
  }
  // contact shadows: one instanced draw call (enemies are outside the sun's shadow frustum)
  blobIM = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: radialTexture([[0, 'rgba(0,0,0,0.5)'], [1, 'rgba(0,0,0,0)']], 64), transparent: true, depthWrite: false }), POOL);
  blobIM.count = 0; blobIM.frustumCulled = false; blobIM.renderOrder = 1; ARENA.group.add(blobIM);
}
function aiDifficulty() {
  const w = AI.wave;
  return { sigma: Math.max(0.015, 0.034 - 0.0028 * (w - 1)) * (IS_TOUCH ? 1.25 : 1), react: Math.max(0.3, 0.75 - 0.06 * (w - 1)) * (IS_TOUCH ? 1.2 : 1),
    maxAlive: Math.min(2 + w, IS_TOUCH ? 4 : 5), shooters: w < 3 ? 2 : 3, toKill: 3 + 2 * w };
}
function banner(text) {
  const b = document.getElementById('banner'); b.textContent = text; b.classList.add('on');
  clearTimeout(banner.t); banner.t = setTimeout(() => b.classList.remove('on'), 1600);
}
export function startAI() {
  for (const e of AI.enemies) despawn(e);
  for (const d of AI.drops) { scene.remove(d.m); const i = dropped.indexOf(d); if (i >= 0) dropped.splice(i, 1); }
  AI.drops.length = 0;
  for (const p of ARENA.pts) p.owner = null;
  Object.assign(AI, { on: true, hp: 100, lastHit: -9, wave: 1, killed: 0, spawned: 0, kills: 0, heads: 0, spawnT: 1.0, breakT: 0,
    lastSeen: STATE.simTime - 3.5, heardAt: -9, flash: 0, hitT: -9 });
  AI.knownPos.copy(charPos); AI.knownVel.set(0, 0, 0);
  AI.diff = aiDifficulty(); AI.toKill = AI.diff.toKill;
  ARENA.group.visible = true;
  banner('WAVE 1');
}
export function stopAI() {
  AI.on = false; ARENA.group.visible = false;
  for (const e of AI.enemies) despawn(e);
  for (const d of AI.drops) scene.remove(d.m);
  AI.drops.length = 0;
}
function despawn(e) {
  if (e.cp) e.cp.owner = null;
  Object.assign(e, { active: false, alive: false, state: 'off', cp: null, badgeT: 0 });
  e.root.visible = e.gun.visible = false;
  if (e.badge) e.badge.visible = false;
}
function targetPosFor(e) {
  return (STATE.simTime - AI.lastSeen < 2.8 || e.state === 'peek' && e.vis) ? charPos : e.lastKnown;
}
function pickPatrolPoint(e) {
  let best = null, bs = -Infinity;
  for (const cp of ARENA.pts) {
    if (cp.owner && cp.owner !== e) continue;
    const dE = Math.hypot(cp.pos.x - e.pos.x, cp.pos.z - e.pos.z);
    if (dE < 420 || dE > 1950) continue;
    let sc = -Math.abs(dE - 980) / 500 + rnd(0, 1.3);
    for (const o of AI.enemies) {
      if (o === e || !o.alive) continue;
      const dd = Math.hypot(o.pos.x - cp.pos.x, o.pos.z - cp.pos.z);
      if (dd < 450) sc -= (450 - dd) / 140;
    }
    if (sc > bs) { bs = sc; best = cp; }
  }
  return best ? best.pos.clone() : V(clamp(e.pos.x + rnd(-750, 750), -1500, 1500), 0, clamp(e.pos.z + rnd(-750, 750), 400, 3600));
}
function enterPatrol(e) {
  if (e.cp) { e.cp.owner = null; e.cp = null; }
  e.state = 'patrol'; e.alert = 0.2; e.patrolWait = 0; e.t = 0;
  const wp = pickPatrolPoint(e);
  e.path = planPath(e.pos, wp);
  setEnemyBadge(e, 'patrol', 2.4);
}
function enterHesitate(e, nextIntent = 'plan', dur = rnd(1.15, 1.85)) {
  e.state = 'hesitate'; e.t = 0; e.dur = dur; e.nextIntent = nextIntent;
  e.path.length = 0;
  setEnemyBadge(e, 'hesitate', dur + 0.15);
}
function enterPlan(e, dur = rnd(0.85, 1.4)) {
  e.state = 'plan'; e.t = 0; e.dur = dur;
  setEnemyBadge(e, 'plan', dur + 0.2);
}
function enterSearch(e) {
  if (e.cp) { e.cp.owner = null; e.cp = null; }
  e.state = 'search'; e.t = 0; e.alert = 0.65;
  // Fan squadmates out across different angles around the player's last known position + predicted drift
  const ang = e.seed * 1.9 + e.searchCount * 2.1;
  const rad = e.searchCount === 0 ? rnd(140, 340) : rnd(340, 650);
  const pred = AI.knownPos.clone().addScaledVector(AI.knownVel, 0.75);
  const sx = clamp(pred.x + Math.cos(ang) * rad, -1650, 1650);
  const sz = clamp(pred.z + Math.sin(ang) * rad, 220, 3700);
  e.searchPos.set(sx, 0, sz);
  pushOutOfCover(e.searchPos, 46);
  e.lastKnown.copy(e.searchPos);
  e.path = planPath(e.pos, e.searchPos);
  setEnemyBadge(e, 'search', 3.2);
}
function spotPlayer(e, vis) {
  const wasUnaware = e.alert < 0.85 || e.state === 'patrol' || e.state === 'search' || e.state === 'hesitate';
  AI.lastSeen = STATE.simTime;
  AI.knownPos.copy(charPos);
  AI.knownVel.copy(charVelW);
  e.lastKnown.copy(charPos);
  e.alert = 1; e.searchCount = 0; e.vis = vis;
  if (wasUnaware) setEnemyBadge(e, 'alert', 0.95);
  // Radio nearby squadmates with fresh target coordinates
  for (const o of AI.enemies) {
    if (o === e || !o.alive) continue;
    if (o.pos.distanceTo(e.pos) < 1350) {
      o.lastKnown.copy(charPos);
      if (o.state === 'patrol') enterPlan(o, rnd(0.55, 0.95));
      else if (o.state === 'search' && o.pos.distanceTo(charPos) > 700) reposition(o, o.role === 'flanker' ? 'flank' : 'advance');
    }
  }
}
export function onPlayerGunshot() {
  if (!AI.on || game.state !== 'play') return;
  AI.heardAt = STATE.simTime;
  AI.knownPos.copy(charPos).add(V(rnd(-65, 65), 0, rnd(-65, 65)));
  AI.knownVel.copy(charVelW);
  for (const e of AI.enemies) {
    if (!e.alive) continue;
    const d = e.pos.distanceTo(charPos);
    if (d > 3200) continue;
    e.lastKnown.copy(AI.knownPos);
    if (e.state === 'patrol') {
      if (d < 1350) { e.alert = 1; setEnemyBadge(e, 'alert', 0.9); if (!reposition(e, 'advance')) enterSearch(e); }
      else { e.alert = 0.6; enterHesitate(e, 'search', rnd(0.8, 1.3)); }
    } else if (e.state === 'hesitate' && d < 1500) {
      e.nextIntent = 'search'; e.t = Math.max(e.t, e.dur - 0.35);
    }
  }
}
function enemySees(e) {
  const eye = _cd.setFromMatrixPosition(e.B.head.matrixWorld).clone();
  return losClear(eye, AI.chest) ? 'chest' : losClear(eye, AI.head) ? 'head' : null;
}
function enemyCanDetect(e) {
  const dP = Math.hypot(e.pos.x - charPos.x, e.pos.z - charPos.z);
  const vis = enemySees(e);
  if (!vis) return null;
  if (dP < 360) return vis;   // close-quarters footsteps / peripheral awareness
  const toP = Math.atan2(charPos.x - e.pos.x, charPos.z - e.pos.z);
  const gaze = e.yaw + AI.yaw0 + e.lookYaw;
  const halfFov = e.state === 'patrol' ? 1.22 : 1.62;
  return Math.abs(angWrap(toP - gaze)) <= halfFov ? vis : null;
}
function spawnEnemy() {
  const e = AI.enemies.find(x => !x.active); if (!e) return;
  const far = ARENA.spawns.slice().sort((a, b) => b.distanceTo(charPos) - a.distanceTo(charPos));
  e.pos.copy(far[Math.random() * 3 | 0]).add(V(rnd(-150, 150), 0, rnd(-150, 150)));
  const startPatrol = (STATE.simTime - AI.lastSeen > 3.2 && Math.random() < 0.65) || (AI.spawned % 3 === 1 && e.pos.distanceTo(charPos) > 1900);
  Object.assign(e, { active: true, alive: true, hp: 100, state: 'move', t: 0, dur: 1.2, cp: null, path: [], ammo: 30, peeks: 0, peekLimit: 2, aimT: 0, lostT: 0,
    suppress: 0, burstLeft: 0, burstIdx: 0, bursts: 0, burstLimit: 1, nextShot: 0, wWalk: 0, wRun: startPatrol ? 0 : 1, wCrouch: 0, wStr: 0, speed: 0, deadT: 0, fallX: 0, yOff: 0,
    lookYaw: 0, lookPitch: 0, headTilt: 0, wantLookYaw: 0, wantLookPitch: 0, wantTilt: 0, alert: startPatrol ? 0.2 : 1, searchCount: 0, patrolWait: 0,
    landed: false, crouch: false, strafing: false, exposed: 0, vis: null, sigma: AI.diff.sigma * rnd(0.85, 1.2), react: AI.diff.react * rnd(0.8, 1.25) });
  e.lastKnown.copy(AI.knownPos);
  e.yaw = e.moveYaw = Math.atan2(e.lastKnown.x - e.pos.x, e.lastKnown.z - e.pos.z);
  e.flinch.x = e.flinch.v = 0;
  e.root.visible = e.gun.visible = true;
  setEnemyBadge(e, null, 0);
  AI.spawned++;
  if (startPatrol) enterPatrol(e);
  else if (!reposition(e, e.role === 'flanker' ? 'flank' : 'advance')) { e.state = 'cover'; e.t = 0.8; }
}
function pickCover(e, mode) {
  const P = targetPosFor(e), pref = mode === 'advance' ? 1020 : mode === 'retreat' ? 2550 : mode === 'ambush' ? 1450 : 1580;
  let best = null, bs = -Infinity;
  for (const cp of ARENA.pts) {
    if (cp.owner && cp.owner !== e) continue;
    const dP = Math.hypot(cp.pos.x - P.x, cp.pos.z - P.z);
    if (dP < 620 || !isProtected(cp, P)) continue;
    const dE = Math.hypot(cp.pos.x - e.pos.x, cp.pos.z - e.pos.z);
    let sc = -Math.abs(dP - pref) / 450 - dE / 1100 + rnd(0, 0.55);
    sc += canPeek(cp, P) ? (mode === 'flank' ? 2.6 : mode === 'ambush' ? 2.2 : 1.4) : -1.2;
    const a2 = Math.atan2(cp.pos.x - P.x, cp.pos.z - P.z);
    for (const o of AI.enemies) {   // spread out: not next to a squad mate, wide crossfire angles
      if (o === e || !o.alive) continue;
      const q = o.cp ? o.cp.pos : o.pos, dd = Math.hypot(q.x - cp.pos.x, q.z - cp.pos.z);
      if (dd < 420) sc -= (420 - dd) / 125;
      const angDiff = Math.abs(angWrap(Math.atan2(q.x - P.x, q.z - P.z) - a2));
      if (angDiff < 0.28) sc -= 0.75;
      else if (mode === 'flank' && angDiff > 0.55) sc += Math.min(1.3, angDiff * 0.85);
    }
    if (e.cp && cp.cover === e.cp.cover) sc -= 1.5;
    if (mode === 'flank' && e.cp) sc += Math.min(1.2, Math.abs(angWrap(Math.atan2(e.cp.pos.x - P.x, e.cp.pos.z - P.z) - a2)) / 0.55);
    if (sc > bs) { bs = sc; best = cp; }
  }
  return best;
}
function reposition(e, mode) {
  const cp = pickCover(e, mode);
  if (!cp) return false;
  if (e.cp) e.cp.owner = null;
  e.cp = cp; cp.owner = e;
  e.path = planPath(e.pos, cp.pos); e.state = 'move'; e.t = 0; e.peeks = 0; e.peekLimit = 2 + (Math.random() * 2 | 0);
  return true;
}
function aiMode(e) {
  if (e.hp < 45) return 'retreat';
  if (STATE.simTime - AI.lastSeen > 3.4) return 'search';
  if (e.role === 'flanker' || Math.random() < 0.5) return 'flank';
  if (Math.hypot(e.pos.x - e.lastKnown.x, e.pos.z - e.lastKnown.z) > 2200) return 'advance';
  return 'any';
}
function executePlan(e) {
  const dKnown = Math.hypot(e.pos.x - e.lastKnown.x, e.pos.z - e.lastKnown.z);
  const intelAge = STATE.simTime - AI.lastSeen;
  if (e.hp < 45 || dKnown < 500) {
    if (reposition(e, 'retreat')) return;
  }
  if (intelAge > 3.2) {
    enterSearch(e);
    return;
  }
  // Coordinated pincer: ask a squadmate in cover to lay suppressing fire while this unit flanks wide
  const ally = AI.enemies.find(o => o !== e && o.alive && o.state === 'cover' && o.cp && o.ammo > 5 && o.suppress < 0.8);
  if (ally && (e.role === 'flanker' || Math.random() < 0.6)) {
    if (AI.shooting < AI.diff.shooters && canPeek(ally.cp, targetPosFor(ally))) startPeek(ally);
    if (reposition(e, 'flank')) return;
  }
  // Overwatch ambush: hold a good sightline cover and pre-aim for the player's peek
  if (e.cp && isProtected(e.cp, targetPosFor(e)) && canPeek(e.cp, targetPosFor(e)) && e.ammo >= 10 && Math.random() < 0.35) {
    e.state = 'cover'; e.t = rnd(0.25, 0.55); e.peeks = 0; e.aimT = e.react * 0.4;
    return;
  }
  const mode = aiMode(e);
  if (mode === 'search') { enterSearch(e); return; }
  if (!reposition(e, mode)) { e.state = 'cover'; e.t = 0.5; e.peeks = 0; }
}
function moveAlong(e, dt, speed) {
  const cyc = speed < 240 ? AI.walkCycle : AI.runCycle;
  while (e.path.length) {
    const tg = e.path[0], dx = tg.x - e.pos.x, dz = tg.z - e.pos.z, d = Math.hypot(dx, dz);
    if (d < 22) { e.path.shift(); continue; }
    const st = Math.min(d, speed * dt);
    e.pos.x += dx / d * st; e.pos.z += dz / d * st; e.speed = speed; e.moveYaw = Math.atan2(dx, dz);
    e.phase = (e.phase + st / cyc) % 1;
    return false;
  }
  return true;
}
function sideStep(e, x, z, dt) {   // strafe while facing the target (stepping out of / back behind a wall)
  const dx = x - e.pos.x, dz = z - e.pos.z, d = Math.hypot(dx, dz);
  if (d < 6) return true;
  const st = Math.min(d, 210 * dt);
  e.pos.x += dx / d * st; e.pos.z += dz / d * st; e.strafing = true;
  e.strDir = dx * Math.cos(e.yaw) - dz * Math.sin(e.yaw) >= 0 ? 1 : -1;   // body +X = left
  e.sPhase = (e.sPhase + st / AI.strCycle) % 1;
  return d - st < 6;
}
function startPeek(e) {
  Object.assign(e, { state: 'peek', t: 0, aimT: e.aimT > 0 ? Math.min(e.aimT, e.react * 0.45) : 0, lostT: 0, bursts: 0, burstIdx: 0, burstLeft: 3 + (Math.random() * 3 | 0), burstLimit: 1 + (Math.random() * 2.5 | 0), nextShot: 0 });
  AI.shooting++;
}
function endPeek(e) { e.state = 'cover'; e.t = rnd(0.75, 1.65) + e.suppress; e.peeks++; e.aimT = 0; }
function stepEnemy(e, dt) {
  if (e.state === 'dead') { deadStep(e, dt); return; }
  e.suppress = Math.max(0, e.suppress - 0.6 * dt);
  e.flinch.step(dt);
  if (e.badgeT > 0) {
    e.badgeT -= dt;
    if (e.badgeT <= 0 && e.badge) e.badge.visible = false;
  }
  e.speed = 0; e.strafing = false; e.crouch = false;
  e.wantLookYaw = 0; e.wantLookPitch = 0; e.wantTilt = 0;
  if (STATE.simTime - AI.lastSeen < 1.2) e.lastKnown.copy(AI.knownPos);
  const P = targetPosFor(e), cp = e.cp, dReal = Math.hypot(e.pos.x - charPos.x, e.pos.z - charPos.z);

  switch (e.state) {
    case 'patrol': {
      e.t += dt;
      e.wantLookYaw = 0.52 * Math.sin(STATE.simTime * 1.35 + e.seed);
      e.wantLookPitch = -0.05 + 0.05 * Math.cos(STATE.simTime * 0.9 + e.seed);
      const vis = enemyCanDetect(e);
      if (vis) {
        if (dReal > 1850 && e.alert < 0.45) {
          e.lastKnown.copy(charPos);
          e.alert = 0.55;
          enterHesitate(e, 'search', rnd(0.85, 1.3));
        } else {
          spotPlayer(e, vis);
          if (!reposition(e, dReal < 700 ? 'retreat' : 'advance')) enterPlan(e, 0.55);
        }
        break;
      }
      if (e.patrolWait > 0) {
        e.patrolWait -= dt;
        e.wantLookYaw = 0.65 * Math.sin(e.t * 2.1 + e.seed);
        if (e.patrolWait <= 0) {
          e.path = planPath(e.pos, pickPatrolPoint(e));
          setEnemyBadge(e, 'patrol', 2.2);
        }
      } else if (moveAlong(e, dt, 158)) {
        e.patrolWait = rnd(1.0, 1.8);
      }
      break;
    }
    case 'hesitate': {
      e.t += dt;
      // Puzzled double-take: look sharply one way, tilt head, look the other way, then decide
      const u = clamp(e.t / Math.max(0.4, e.dur), 0, 1);
      const side = (e.seed % 2 < 1) ? 1 : -1;
      e.wantLookYaw = side * (u < 0.34 ? lerp(0, 0.68, ease(u / 0.34))
                    : u < 0.76 ? lerp(0.68, -0.72, ease((u - 0.34) / 0.42))
                    : lerp(-0.72, 0.1, ease((u - 0.76) / 0.24)));
      e.wantTilt = side * 0.19 * Math.sin(u * Math.PI);
      e.wantLookPitch = 0.08 * Math.sin(u * Math.PI * 2);
      const vis = enemyCanDetect(e);
      if (vis) {
        spotPlayer(e, vis);
        if (e.cp && isProtected(e.cp, charPos)) startPeek(e);
        else if (!reposition(e, dReal < 650 ? 'retreat' : 'advance')) { e.state = 'cover'; e.t = 0.25; }
        break;
      }
      if (e.t >= e.dur) {
        if (e.nextIntent === 'patrol') enterPatrol(e);
        else if (e.nextIntent === 'search') enterSearch(e);
        else enterPlan(e, rnd(0.8, 1.3));
      }
      break;
    }
    case 'plan': {
      e.t += dt;
      e.crouch = cp ? !cp.tall : true;
      if (cp && Math.hypot(cp.pos.x - e.pos.x, cp.pos.z - e.pos.z) > 10) sideStep(e, cp.pos.x, cp.pos.z, dt);
      // Glance toward nearest squadmate / flank lane and nod while formulating tactic
      const ally = AI.enemies.find(o => o !== e && o.alive && o.pos.distanceTo(e.pos) < 1200);
      if (ally) {
        const toAlly = Math.atan2(ally.pos.x - e.pos.x, ally.pos.z - e.pos.z);
        e.wantLookYaw = clamp(angWrap(toAlly - (e.yaw + AI.yaw0)), -0.75, 0.75) * Math.sin(clamp(e.t / e.dur, 0, 1) * Math.PI);
      } else {
        e.wantLookYaw = 0.38 * Math.sin(e.t * 3.6 + e.seed);
      }
      e.wantLookPitch = 0.12 * Math.sin(e.t * 7.5);
      const vis = dReal < 620 ? enemyCanDetect(e) : null;
      if (vis) { spotPlayer(e, vis); if (cp) { startPeek(e); break; } }
      if (e.t >= e.dur) executePlan(e);
      break;
    }
    case 'search': {
      e.t += dt;
      e.wantLookYaw = 0.58 * Math.sin(STATE.simTime * 2.15 + e.seed);
      e.wantTilt = 0.08 * Math.cos(STATE.simTime * 1.7 + e.seed);
      const vis = enemyCanDetect(e);
      if (vis) {
        spotPlayer(e, vis);
        if (!reposition(e, dReal < 620 ? 'retreat' : (e.role === 'flanker' ? 'flank' : 'advance'))) {
          e.state = 'cover'; e.t = 0.2;
        }
        break;
      }
      if (e.badgeT < 0.3) setEnemyBadge(e, 'search', 1.5);
      if (moveAlong(e, dt, 182) || e.t > 7.5) {
        e.searchCount++;
        enterHesitate(e, e.searchCount < 2 ? 'plan' : 'patrol', rnd(1.25, 1.9));
      }
      break;
    }
    case 'move': {
      e.t += dt;
      const vis = dReal < 950 ? enemyCanDetect(e) : null;
      if (vis) spotPlayer(e, vis);
      if (cp && Math.floor(e.t / 0.6) !== Math.floor((e.t - dt) / 0.6) && !isProtected(cp, P)) reposition(e, 'any');
      if (moveAlong(e, dt, 380)) { e.state = 'cover'; e.t = rnd(0.35, 0.9); }
      break;
    }
    case 'cover': case 'reload': {
      if (!cp) { enterPlan(e, rnd(0.55, 0.95)); break; }
      e.crouch = !cp.tall;
      const away = Math.hypot(cp.pos.x - e.pos.x, cp.pos.z - e.pos.z) > 8;
      if (away) sideStep(e, cp.pos.x, cp.pos.z, dt);
      const visDirect = enemyCanDetect(e);
      if (visDirect) spotPlayer(e, visDirect);
      if (!isProtected(cp, visDirect ? charPos : P)) {   // flanked: hesitate briefly if surprised, then relocate or fight back
        if ((e.exposed += dt) > 0.28) {
          e.exposed = 0;
          if (!visDirect && Math.random() < 0.45) { enterHesitate(e, 'plan', rnd(0.65, 1.0)); break; }
          if (!reposition(e, dReal < 600 ? 'retreat' : 'flank') && e.state !== 'peek') startPeek(e);
        }
        break;
      }
      e.exposed = 0;
      e.t -= dt;
      if (e.state === 'reload') { if (e.t <= 0) { e.ammo = 30; e.state = 'cover'; e.t = rnd(0.2, 0.55); } break; }
      if (dReal < 520 && visDirect && e.t > 0.18) e.t = 0.18;
      if (e.t > 0 || away) break;
      if (e.ammo <= 0) { e.state = 'reload'; e.t = 2.3; break; }
      // Player vanished behind cover for a while -> pause to plan / search instead of staring at walls forever
      if (STATE.simTime - AI.lastSeen > 3.4) { enterPlan(e, rnd(0.85, 1.35)); break; }
      if (e.peeks >= e.peekLimit || (dReal < 520 && visDirect && Math.random() < 0.5)) {
        enterPlan(e, dReal < 520 ? 0.35 : rnd(0.75, 1.25));
        break;
      }
      if ((AI.shooting < AI.diff.shooters || (dReal < 520 && visDirect)) && e.suppress < 0.65) startPeek(e);
      else e.t = rnd(0.25, 0.65);
      break;
    }
    case 'peek': {
      if (!cp) { enterPlan(e, 0.6); break; }
      e.t += dt;
      const out = cp.tall ? sideStep(e, cp.peek.x, cp.peek.z, dt) : e.wCrouch < 0.3;
      if (!out) { if (e.t > 2.5) endPeek(e); break; }
      const vis = enemySees(e);
      if (vis) {
        e.aimT += dt; e.lostT = 0;
        spotPlayer(e, vis);
      } else {
        e.lostT += dt; e.aimT = Math.max(0, e.aimT - 2 * dt);
        e.wantLookYaw = 0.32 * Math.sin(e.lostT * 5.0 + e.seed);
      }
      if (e.lostT > 0.85) {
        // Player disappeared from sightline! Look puzzled briefly, then plan a search or flank
        endPeek(e); e.peeks = e.peekLimit;
        if (STATE.simTime - AI.lastSeen > 1.6) enterHesitate(e, 'plan', rnd(0.95, 1.45));
        break;
      }
      if (vis && e.aimT >= e.react && STATE.simTime >= e.nextShot && e.ammo > 0) {
        enemyShoot(e); e.ammo--; e.burstIdx++;
        if (--e.burstLeft > 0) e.nextShot = STATE.simTime + rnd(0.095, 0.13);
        else { e.bursts++; e.burstIdx = 0; e.burstLeft = 3 + (Math.random() * 3 | 0); e.nextShot = STATE.simTime + rnd(0.45, 0.85); }
      }
      if (e.bursts >= e.burstLimit || e.ammo <= 0 || e.suppress > 1.8 || e.t > 4.5) endPeek(e);
      break;
    }
  }
  pushOutOfCover(e.pos, 34);
  if (dReal < 70) { const k = (70 - dReal) / (dReal || 1); e.pos.x += (e.pos.x - charPos.x) * k; e.pos.z += (e.pos.z - charPos.z) * k; }
  for (const o of AI.enemies) {
    if (o === e || !o.alive) continue;
    const dx = e.pos.x - o.pos.x, dz = e.pos.z - o.pos.z, d = Math.hypot(dx, dz);
    if (d < 65 && d > 1e-3) { const k = (65 - d) / d * 0.5; e.pos.x += dx * k; e.pos.z += dz * k; }
  }
}
function deadStep(e, dt) {
  e.deadT += dt;
  const t = e.deadT, u = Math.min(1, t / 0.7);
  e.dieCrouch = t < 0.25 ? 0.5 * t / 0.25 : Math.max(0, 0.5 - (t - 0.25) * 1.5);   // knees buckle, then the body goes limp-straight
  e.fallX = e.fallSign * 1.5 * u * u;
  if (t > 0.7 && !e.landed) { e.landed = true; playClick(240, 0.12, 0.3); }
  e.yOff = 9 * Math.sin(Math.abs(e.fallX)) - (t > 4.5 ? (t - 4.5) * 30 : 0);
  if (t > 5.6) despawn(e);
}
function poseEnemy(e, dt) {
  const S = AI.snaps, k = 1 - Math.exp(-9 * dt), dead = e.state === 'dead';
  const wantWalk = !dead && e.speed > 20 && e.speed < 240 ? 1 : 0;
  const wantRun  = !dead && e.speed >= 240 ? 1 : 0;
  e.wWalk += (wantWalk - e.wWalk) * k;
  e.wRun  += (wantRun  - e.wRun)  * k;
  e.wStr  += ((!dead && e.strafing ? 1 : 0) - e.wStr) * k;
  if (dead) e.wCrouch = e.dieCrouch; else e.wCrouch += ((e.crouch || e.state === 'reload' ? 1 : 0) - e.wCrouch) * (1 - Math.exp(-7 * dt));
  const kl = 1 - Math.exp(-8 * dt);
  e.lookYaw   += ((dead ? 0 : e.wantLookYaw)   - e.lookYaw)   * kl;
  e.lookPitch += ((dead ? 0 : e.wantLookPitch) - e.lookPitch) * kl;
  e.headTilt  += ((dead ? 0 : e.wantTilt)      - e.headTilt)  * kl;
  if (!dead) {
    const faceP = targetPosFor(e);
    const moving = (e.wRun + e.wWalk) > 0.45;
    const want = moving ? e.moveYaw : Math.atan2(faceP.x - e.pos.x, faceP.z - e.pos.z) - AI.yaw0;
    const turnSpd = e.state === 'patrol' ? 4.8 : e.state === 'search' ? 6.2 : 8.5;
    e.yaw += clamp(angWrap(want - e.yaw), -turnSpd * dt, turnSpd * dt);
  }
  e.root.position.set(e.pos.x, e.yOff, e.pos.z);
  e.root.rotation.set(e.fallX, e.yaw, 0, 'YXZ');
  const src = AI.src; src.length = 0;
  const wR = e.wRun, wW = e.wWalk * (1 - wR), wS = e.wStr * Math.max(0, 1 - wR - wW), wB = Math.max(0, 1 - wR - wW - wS);
  const cyc = (arr, ph, w) => { const n = arr.length, x = ph * n, i = Math.floor(x) % n, f = x - Math.floor(x); if (w * (1 - f) > 1e-3) src.push([arr[i], w * (1 - f)]); if (w * f > 1e-3) src.push([arr[(i + 1) % n], w * f]); };
  if (wB * (1 - e.wCrouch) > 1e-3) src.push([S.stand, wB * (1 - e.wCrouch)]);
  if (wB * e.wCrouch > 1e-3) src.push([S.crouch, wB * e.wCrouch]);
  if (wW > 1e-3) cyc(S.walk, e.phase, wW);
  if (wR > 1e-3) cyc(S.run, e.phase, wR);
  if (wS > 1e-3) cyc(e.strDir > 0 ? S.strL : S.strR, e.sPhase, wS);
  blendSnaps(e, src);
  e.root.updateMatrixWorld(true);
  if (e.alive) {
    const f = V(Math.sin(e.yaw + AI.yaw0), 0, Math.cos(e.yaw + AI.yaw0)), ax = V().crossVectors(f, V(0, 1, 0)), upY = V(0, 1, 0);
    const calmLow = (e.state === 'patrol' ? 0.55 : e.state === 'hesitate' ? 0.35 : e.state === 'search' ? 0.22 : 0) * (1 - e.wRun - e.wWalk);
    const aimW = (1 - e.wRun - e.wWalk * 0.85) * (1 - e.wCrouch) * (1 - calmLow);
    if (aimW > 0.02) {   // pitch the upper body onto the target chest
      const tgtY = STATE.simTime - AI.lastSeen < 2.8 ? AI.chest : V(e.lastKnown.x, 130, e.lastKnown.z);
      const d = tgtY.clone().sub(worldPos(e.B.spine_03));
      const pitch = clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)) - AI.pitch0, -0.8, 0.8);
      for (const [n, kk] of AIM_SPLIT) rotateWorld(e.B[n], ax, pitch * kk * aimW);
    } else if (calmLow > 0.01) {
      rotateWorld(e.B.spine_02, ax, -0.14 * calmLow);
      rotateWorld(e.B.spine_03, ax, -0.18 * calmLow);
    }
    // Upper-torso & head scanning / double-take hesitation / planning nod (spine_03 carries both hands + M4 rigidly together)
    if (Math.abs(e.lookYaw) > 1e-3) rotateWorld(e.B.spine_03, upY, e.lookYaw * 0.26);
    rotateWorld(e.B.spine_03, ax, 0.012 * Math.sin(STATE.simTime * 1.6 + e.seed) - e.flinch.x);   // breathing + hit flinch
    if (e.B.neck_01) {
      rotateWorld(e.B.neck_01, upY, e.lookYaw * 0.34);
      rotateWorld(e.B.neck_01, ax, e.lookPitch * 0.35);
    }
    rotateWorld(e.B.head, upY, e.lookYaw * 0.52);
    rotateWorld(e.B.head, ax, e.lookPitch * 0.65);
    if (Math.abs(e.headTilt) > 1e-3) rotateWorld(e.B.head, f, e.headTilt);

    e.B.hand_r.updateWorldMatrix(true, false);
    e.gun.matrix.multiplyMatrices(e.B.hand_r.matrixWorld, AI.gunInHand); e.gun.matrixWorldNeedsUpdate = true;
    e.muzzle.copy(RIFLE_MUZZLE).applyMatrix4(e.gun.matrix);
    if (e.badge && e.badge.visible) {
      const hp = _cd.setFromMatrixPosition(e.B.head.matrixWorld);
      e.badge.position.set(hp.x, hp.y + 34 + Math.sin(STATE.simTime * 3.5 + e.seed) * 1.8, hp.z);
      e.badge.material.opacity = clamp(e.badgeT * 2.4, 0, 0.92);
    }
  } else if (e.badge) {
    e.badge.visible = false;
  }
  for (let i = 0; i < ENEMY_CAPS.length; i++) {
    const [, an, bn] = ENEMY_CAPS[i], c = e.caps[i];
    c[1].setFromMatrixPosition(e.B[an].matrixWorld); c[2].setFromMatrixPosition(e.B[bn].matrixWorld);
    if (an === 'head') { c[1].y += 9; c[2].copy(c[1]); }
  }
}
function blendSnaps(e, src) {
  const B = e.bones, ref = src[0][0].q;
  let tw = 0; for (const s of src) tw += s[1];
  for (let i = 0, o = 0; i < B.length; i++, o += 4) {
    let x = 0, y = 0, z = 0, w = 0;
    for (let k = 0; k < src.length; k++) {
      const q = src[k][0].q, wt = src[k][1];
      const sg = q[o] * ref[o] + q[o + 1] * ref[o + 1] + q[o + 2] * ref[o + 2] + q[o + 3] * ref[o + 3] < 0 ? -wt : wt;
      x += q[o] * sg; y += q[o + 1] * sg; z += q[o + 2] * sg; w += q[o + 3] * sg;
    }
    const l = Math.hypot(x, y, z, w) || 1;
    B[i].quaternion.set(x / l, y / l, z / l, w / l);
  }
  const pel = e.B.pelvis.position.set(0, 0, 0);
  for (const s of src) pel.addScaledVector(s[0].pel, s[1] / tw);
}
function enemyShoot(e) {
  const m = e.muzzle.clone(), tgt = (e.vis === 'head' || Math.random() < 0.12 ? AI.head : AI.chest).clone().add(V(rnd(-6, 6), rnd(-10, 10), rnd(-6, 6)));
  const d = tgt.sub(m).normalize();
  const sig = e.sigma * (1 + 1.8 * Math.exp(-e.aimT / 0.9)) * (1 + mm.speed / 320) * (1 + 0.15 * e.burstIdx);
  d.x += gauss() * sig; d.y += gauss() * sig; d.z += gauss() * sig; d.normalize();
  const h = castEnemyShot(m, d);
  muzzleFlashAt(m, d, 1.35);
  tracerFX(m.clone().addScaledVector(d, 40), h.point, false);
  if (h.kind === 'player') damagePlayer(h.part === 'head' ? 30 : h.part === 'torso' ? 11 : 7, e.pos);
  else {
    if (h.kind !== 'none') impactFX(h.point, h.n, h.kind === 'cover' ? (h.cover.kind === 'crate' ? 'wood' : 'concrete') : 'ground');
    nearMiss(m, d, h.t);
  }
  const dist = m.distanceTo(camera.position);
  playSample('rifle_shot', { rate: 0.94 + Math.random() * 0.1, gain: clamp(1.1 - dist / 4500, 0.25, 0.85), delay: dist / 34300, pan: panFor(m), lp: 2500 + 15000 * clamp(1 - dist / 4000, 0, 1) });
}
function nearMiss(o, d, tHit) {   // supersonic crack when a round passes close to the player's head
  const t = clamp(_cd.subVectors(AI.head, o).dot(d), 0, tHit);
  if (o.clone().addScaledVector(d, t).distanceTo(AI.head) < 120) { playCrack(panFor(AI.head.clone().addScaledVector(d, -200))); rec.cam.kick(0.12); }
}
export function suppressNear(o, d, tHit) {   // the player's rounds passing close make enemies duck or hesitate
  for (const e of AI.enemies) {
    if (!e.alive) continue;
    const hd = e.caps[0][1], t = clamp(_cd.subVectors(hd, o).dot(d), 0, tHit);
    if (o.clone().addScaledVector(d, t).distanceTo(hd) < 140) {
      e.suppress += 0.8;
      e.lastKnown.copy(charPos);
      if (e.state === 'patrol' || e.state === 'search') {
        e.alert = 1; setEnemyBadge(e, 'alert', 0.9);
        if (!reposition(e, 'any')) enterHesitate(e, 'plan', 0.7);
      }
    }
  }
}
function damagePlayer(amount, from) {
  if (game.state !== 'play') return;
  AI.hp -= amount; AI.lastHit = STATE.simTime; AI.flash = Math.min(1, AI.flash + 0.5 + amount / 60);
  AI.hitFrom = from.clone(); AI.hitT = STATE.simTime;
  rec.cam.kick(0.3); playHurt();
  if (AI.hp <= 0) { AI.hp = 0; endRound(); }
}
export function onEnemyHit(e, part, p, d, customDmg = null) {
  impactFX(p, d.clone().negate(), 'blood');
  if (game.state !== 'play') return;
  const baseDmg = customDmg != null ? customDmg : (W.cur.dmg || 30);
  const dmg = baseDmg * (part === 'head' ? 4 : part === 'torso' ? 1 : 0.65);
  e.hp -= dmg; game.hits++;
  e.flinch.kick(part === 'head' ? 0.45 : 0.22); e.suppress += 1.2;
  spotPlayer(e, 'chest');
  if (e.hp <= 0) {
    const head = part === 'head', pts = head ? 150 : 100;
    killEnemy(e, d); game.score += pts; AI.kills++; if (head) { AI.heads++; game.heads++; }
    hitMarker(head); popup((head ? 'HEADSHOT +' : 'KILL +') + pts, p); playDing(0, head ? 1400 : 900);
  } else {
    hitMarker(false); playClick(3200, 0.02, 0.25);
    if (e.state === 'peek' && Math.random() < 0.55) endPeek(e);
    else if (e.state === 'patrol' || e.state === 'search' || e.state === 'hesitate') {
      if (!reposition(e, e.hp < 50 ? 'retreat' : 'any')) enterPlan(e, 0.45);
    }
  }
}
export function killEnemy(e, d) {
  e.alive = false; e.state = 'dead'; e.deadT = 0; e.landed = false; AI.killed++;
  setEnemyBadge(e, null, 0);
  e.fallSign = d.x * Math.sin(e.yaw) + d.z * Math.cos(e.yaw) > 0 ? 1 : -1;   // shot from behind -> falls forward
  if (e.cp) { e.cp.owner = null; e.cp = null; }
  // the rifle drops and tumbles (reuses the magazine drop physics)
  const m = new THREE.Group(), body = new THREE.Mesh(AI.gunGeo, enemyGunMat), ctr = AI.gunGeo.boundingSphere.center;
  body.position.copy(ctr).negate(); m.add(body);
  e.gun.matrix.clone().multiply(new THREE.Matrix4().makeTranslation(ctr.x, ctr.y, ctr.z)).decompose(m.position, m.quaternion, m.scale);
  scene.add(m); e.gun.visible = false;
  const dr = { m, v: d.clone().multiplyScalar(120).add(V(0, 140, 0)), w: V(rnd(-4, 4), rnd(-3, 3), rnd(-4, 4)), rest: false, hit: false };
  dropped.push(dr); AI.drops.push(dr);
}
function waveStep(dt) {
  const alive = AI.enemies.filter(e => e.alive).length;
  if (AI.breakT > 0) {
    AI.breakT -= dt;
    if (AI.breakT <= 0) { AI.wave++; AI.diff = aiDifficulty(); AI.toKill = AI.diff.toKill; AI.killed = 0; AI.spawned = 0; AI.spawnT = 0.3; banner(`WAVE ${AI.wave}`); }
    return;
  }
  if (AI.killed >= AI.toKill && alive === 0) { AI.breakT = 3.5; AI.hp = 100; banner(`WAVE ${AI.wave} CLEARED`); return; }
  if (AI.spawned < AI.toKill && alive < AI.diff.maxAlive && (AI.spawnT -= dt) <= 0) { spawnEnemy(); AI.spawnT = rnd(0.8, 2.0); }
}
export function updateAI(dt) {
  if (!AI.on) return;
  playerCaps();
  AI.shooting = 0; for (const e of AI.enemies) if (e.active && e.state === 'peek') AI.shooting++;
  if (game.state === 'play') {
    waveStep(dt);
    for (const e of AI.enemies) if (e.active) stepEnemy(e, dt);
    if (STATE.simTime - AI.lastHit > 3.5 && AI.hp > 0) AI.hp = Math.min(100, AI.hp + 22 * dt);
  }
  let n = 0;
  for (const e of AI.enemies) {
    if (!e.active) continue;
    poseEnemy(e, dt);
    const dead = e.state === 'dead', f = e.fallSign * Math.min(1, e.deadT / 0.7);
    blobIM.setMatrixAt(n++, tmpM.compose(V(e.pos.x + Math.sin(e.yaw) * f * 85, 0.4, e.pos.z + Math.cos(e.yaw) * f * 85),
      tmpQ.setFromAxisAngle(V(0, 1, 0), e.yaw), V(85, 1, dead ? 85 + 110 * Math.abs(f) : 85)));
  }
  blobIM.count = n; blobIM.instanceMatrix.needsUpdate = true;
  AI.flash = Math.max(0, AI.flash - dt * 1.6);
}
function panFor(p) {
  const r = V(-Math.cos(tps.yaw), 0, Math.sin(tps.yaw)), d = p.clone().sub(camera.position); d.y = 0;
  return clamp(d.normalize().dot(r), -1, 1) * 0.85;
}
function playCrack(pan) {
  if (!STATE.soundOn) return;
  const ac = audio(), len = Math.ceil(ac.sampleRate * 0.06), b = ac.createBuffer(1, len, ac.sampleRate), dd = b.getChannelData(0);
  for (let i = 0; i < len; i++) dd[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.18));
  const src = ac.createBufferSource(), hp = ac.createBiquadFilter(), g = ac.createGain();
  src.buffer = b; hp.type = 'highpass'; hp.frequency.value = 2200; g.gain.value = 0.55;
  let node = src.connect(hp).connect(g);
  if (ac.createStereoPanner) { const pn = ac.createStereoPanner(); pn.pan.value = pan; node = node.connect(pn); }
  node.connect(sfxBus); src.start();
}
function playHurt() {
  if (!STATE.soundOn) return;
  const ac = audio(), t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
  o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.16);
  g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  o.connect(g).connect(sfxBus); o.start(t); o.stop(t + 0.22);
}
