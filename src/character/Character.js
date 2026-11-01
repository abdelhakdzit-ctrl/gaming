import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { AnimController } from './AnimController.js';
import { WeaponSystem } from '../weapons/WeaponSystem.js';
import { applyWorldDelta, twoBoneIK } from './IK.js';
import { clamp, damp, dampAngle, rotateBoneWorld } from '../core/math.js';

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const AIM_SPLIT = [['spine_01', 0.2], ['spine_02', 0.35], ['spine_03', 0.45]];
const HIT_SEGMENTS = [
  ['head', 'head', null, 0.115, 'head', 0.08], ['neck', 'neck_01', 'head', 0.07, 'torso'],
  ['torso', 'pelvis', 'spine_03', 0.17, 'torso'], ['chest', 'spine_03', 'neck_01', 0.17, 'torso'],
  ['uarm_l', 'upperarm_l', 'lowerarm_l', 0.055, 'limb'], ['farm_l', 'lowerarm_l', 'hand_l', 0.05, 'limb'],
  ['uarm_r', 'upperarm_r', 'lowerarm_r', 0.055, 'limb'], ['farm_r', 'lowerarm_r', 'hand_r', 0.05, 'limb'],
  ['thigh_l', 'thigh_l', 'calf_l', 0.08, 'limb'], ['calf_l', 'calf_l', 'foot_l', 0.065, 'limb'],
  ['thigh_r', 'thigh_r', 'calf_r', 0.08, 'limb'], ['calf_r', 'calf_r', 'foot_r', 0.065, 'limb'],
];
const ZONE_MUL = { head: 1, torso: 1, limb: 0.6 };

// Critically-damped-ish spring used for recoil (same model as legacy-viewer).
class Spring {
  constructor(hz, zeta) { this.w = 2 * Math.PI * hz; this.z = zeta; this.x = 0; this.v = 0; this.target = 0; }
  step(dt) {
    const n = Math.max(1, Math.ceil(dt / 0.002)), h = dt / n;
    for (let i = 0; i < n; i++) { this.v += (-this.w * this.w * (this.x - this.target) - 2 * this.z * this.w * this.v) * h; this.x += this.v * h; }
  }
  kick(peak) { const s = Math.sqrt(1 - this.z * this.z); this.v += peak * this.w * Math.exp(this.z * Math.atan(s / this.z) / s); }
}

const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4(), _m4 = new THREE.Matrix4();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _s = new THREE.Vector3();
function setWorldQuat(bone, q, w = 1) {
  bone.parent.getWorldQuaternion(_q2);
  const local = _q2.invert().multiply(q);
  if (w >= 1) bone.quaternion.copy(local); else bone.quaternion.slerp(local, w);
  bone.updateMatrixWorld(true);
}

// Character = skinned Mannequin + locomotion (retargeted clips, root motion) + upper body driven by
// the baked grip library (legacy-viewer hand shapes), aim correction, recoil, and hit capsules.
export class Character {
  constructor(game, { team = 'player', name = 'Soldier', tint = 0x8fa3b8, weapons = ['rifle', 'pistol'], infiniteAmmo = false, health = 100 } = {}) {
    this.game = game; this.events = game.events; this.team = team; this.name = name;
    this.group = new THREE.Group();
    this.model = SkeletonUtils.clone(game.assets.template);
    this.model.scale.setScalar(0.01);
    const mat = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.6, metalness: 0.15 });
    this.model.traverse(o => { if (o.isMesh) { o.material = mat; o.castShadow = true; o.frustumCulled = false; } });
    this.group.add(this.model);
    this.bones = {}; this.model.traverse(o => { if (o.isBone) this.bones[o.name] = o; });
    this.anim = new AnimController(this.group, game.assets);
    // Weapon container: placed every frame from hand_r * baked gun-in-hand (weapon space is cm).
    this.holder = new THREE.Group(); this.holder.matrixAutoUpdate = false; this.holder.visible = false; this.group.add(this.holder); // shown once placed
    this.weapons = new WeaponSystem(this, weapons, { infinite: infiniteAmmo });
    for (const s of this.weapons.slots) this.holder.add(s.model);
    const lib = game.assets.grips;
    this.upper = lib.bones.map(n => this.bones[n]);
    this.pose = lib.newPose(); this.tmpPose = lib.newPose();
    this.pos = this.group.position; this.yaw = 0; this.vel = new THREE.Vector3(); this.speed = 0;
    this.radius = 0.35; this.crouching = false; this.health = this.maxHealth = health; this.dead = false;
    this.intent = { move: new THREE.Vector3(), gait: 'run', crouch: false, ads: false, aimYaw: 0, aimPitch: 0, drawn: true, strafe: true };
    this.aimW = 0; this.lowW = 0; this.adsT = 0; this.kick = 0; this.flinch = 0; this.bobDist = 0; this.deadT = 0; this.aimClock = Math.random() * 3;
    this.rec = { flip: new Spring(5.0, 0.48), back: new Spring(7.5, 0.55), up: new Spring(5.0, 0.5), yaw: new Spring(5.5, 0.5), roll: new Spring(5.5, 0.5), spine: new Spring(3.0, 0.38) };
    this.hitboxes = HIT_SEGMENTS.map(([id, a, b, r, zone]) => ({ id, a: this.bones[a], b: b ? this.bones[b] : null, r, zone }));
    this.tmpV = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this.getAimRay = () => { const o = this.eye, p = this.aimPoint(); return { origin: o, dir: p.sub(o).normalize() }; };
    this.onWeaponChanged();
    this.ready = Promise.resolve();
  }

  onWeaponChanged() {
    for (const s of this.weapons.slots) s.model.visible = false;
    this.weapons.slot.model.visible = this.intent.drawn;
  }
  sound(kind, def, pos) { this.game.audio?.weapon(kind, def, pos ?? this.pos, this === this.game.player); }

  // ---- gameplay state ----
  get eye() { return this.bones.head.getWorldPosition(new THREE.Vector3()); }
  get center() { return this.bones.spine_02.getWorldPosition(new THREE.Vector3()); }
  get moving() { return this.speed > 0.2; }
  aimPoint() {
    const p = this.getAimPoint?.(); if (p) return p.clone();
    const it = this.intent, c = Math.cos(it.aimPitch);
    return this.eye.add(new THREE.Vector3(Math.sin(it.aimYaw) * c, Math.sin(it.aimPitch), Math.cos(it.aimYaw) * c).multiplyScalar(30));
  }

  damage(amount, { zone = 'torso', from = null, attacker = null, point = null } = {}) {
    if (this.dead) return;
    this.health = Math.max(0, this.health - amount); this.flinch = Math.min(1, this.flinch + amount / 40);
    this.events.emit('damage', { target: this, attacker, amount, zone, from, point });
    this.onDamaged?.({ amount, attacker, from, zone });
    if (this.health <= 0) this.die(attacker, zone);
  }
  die(attacker, zone) {
    this.dead = true; this.weapons.trigger = false; this.intent.move.set(0, 0, 0);
    this.anim.stopOnce(true); this.deadT = 0; this.holder.visible = false;
    this.events.emit('death', { target: this, attacker, zone });
  }

  // ---- actions: root motion from the clip moves the character (with collision) ----
  canAct() { return !this.dead && !this.anim.busy; }
  displace(dx, dz, ignore) {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    this.game.world.moveCircle(this.pos, dx * c + dz * s, -dx * s + dz * c, this.radius, ignore);
  }
  rootMotion(ignore) { return (dx, dz, dyaw) => { this.displace(dx, dz, ignore); this.yaw += dyaw; }; }
  jump() {
    if (!this.canAct()) return;
    this.anim.playOnce(this.speed > 2.5 ? 'jump_run' : 'jump', { fadeIn: 0.15, fadeOut: 0.25, onMove: this.rootMotion() });
  }
  roll(dirWorld) {
    if (!this.canAct()) return;
    const d = dirWorld && dirWorld.lengthSq() > 0.01 ? dirWorld : new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.yaw = Math.atan2(d.x, d.z); this.group.rotation.y = this.yaw; this.crouching = false;
    this.weapons.trigger = false; this.rolling = true;
    this.anim.playOnce('roll', { fadeIn: 0.1, fadeOut: 0.25, onMove: this.rootMotion(), onDone: () => { this.rolling = false; } });
  }
  tryVault() {
    if (!this.canAct() || !this.game.assets.clips.get('vault')) return false;
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const hit = this.game.world.vaultTarget(this.pos, fwd);
    if (!hit) return false;
    this.yaw = Math.atan2(-hit.normal.x, -hit.normal.z); this.group.rotation.y = this.yaw;
    const ignore = new Set([hit.collider]);
    this.weapons.trigger = false; this.vaulting = true;
    this.pos.addScaledVector(fwd, Math.max(0, hit.dist - 0.6));
    this.anim.playOnce('vault', { fadeIn: 0.1, fadeOut: 0.25, onMove: this.rootMotion(ignore),
      onDone: () => { this.vaulting = false; this.game.world.pushOut(this.pos, this.radius); } });
    return true;
  }

  update(dt) {
    if (this.dead) return this.updateDead(dt);
    const it = this.intent, wp = this.weapons, busy = this.anim.busy;
    this.crouching = it.crouch && !busy;
    // --- horizontal movement: max speed = the animation's natural speed for this gait and direction
    const set = this.crouching ? 'crouch' : 'stand';
    const wantMove = it.move.lengthSq() > 0.001 && !busy;
    let gait = this.crouching ? 'walk' : it.gait; if (it.ads && !this.crouching) gait = 'walk';
    const s0 = Math.sin(this.yaw), c0 = Math.cos(this.yaw);
    const mdz = it.move.x * s0 + it.move.z * c0, mdx = -(it.move.x * c0 - it.move.z * s0);
    let maxSpeed = this.anim.gaitSpeed(set, gait, mdx, mdz);
    if (it.drawn && gait !== 'sprint') maxSpeed *= wp.def.moveSpeed;
    const desired = wantMove ? it.move.clone().normalize().multiplyScalar(maxSpeed * Math.min(1, it.move.length())) : new THREE.Vector3();
    const k = wantMove ? 7 : 10;
    this.vel.x = damp(this.vel.x, desired.x, k, dt); this.vel.z = damp(this.vel.z, desired.z, k, dt);
    if (busy) this.vel.set(0, 0, 0);
    else this.game.world.moveCircle(this.pos, this.vel.x * dt, this.vel.z * dt, this.radius);
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    // --- facing
    if (!busy) {
      if (it.drawn && it.strafe) this.yaw = dampAngle(this.yaw, it.aimYaw, it.ads ? 16 : 10, dt);
      else if (this.speed > 0.4) this.yaw = dampAngle(this.yaw, Math.atan2(this.vel.x, this.vel.z), 8, dt);
    }
    this.group.rotation.y = this.yaw; this.group.position.y = 0;
    // --- locomotion animation (character frame: dx = right, dz = forward)
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const dz = this.vel.x * s + this.vel.z * c, dx = -(this.vel.x * c - this.vel.z * s);
    this.anim.setLocomotion({ set, speed: this.speed, dx, dz });
    this.anim.update(dt);
    const B = this.bones;
    if (Math.abs(this.anim.hipYaw) > 1e-3) { // sideways crouch: legs turn toward the motion, torso stays
      this.group.updateMatrixWorld(true);
      rotateBoneWorld(B.pelvis, UP, -this.anim.hipYaw); B.pelvis.updateMatrixWorld(true);
      rotateBoneWorld(B.spine_01, UP, this.anim.hipYaw);
    }
    if (this.speed > 0.5) {
      this.bobDist += this.speed * dt;
      if (this.bobDist > (this.speed > 3 ? 1.5 : 1.1)) {
        this.bobDist = 0;
        this.events.emit('noise', { pos: this.pos.clone(), owner: this, loudness: this.crouching ? 2 : this.speed > 4 ? 22 : this.speed > 1.8 ? 12 : 5 });
        this.game.audio?.step?.(this.pos, this === this.game.player, this.speed);
      }
    }
    // --- weapon / upper body
    wp.update(dt);
    this.adsT = damp(this.adsT, it.ads ? 1 : 0, 14, dt);
    this.kick = damp(this.kick, 0, wp.def.recoil.recover, dt);
    this.flinch = damp(this.flinch, 0, 7, dt);
    this.group.updateMatrixWorld(true);
    this.applyUpperBody(dt);
  }

  // Recoil impulse (called by WeaponSystem through onFired as well as directly).
  recoilKick() {
    const k = this.weapons.slot.grip.meta.kick, v = () => 0.85 + Math.random() * 0.3, r = this.rec;
    if (!k) return;
    r.flip.kick(k.flip * v()); r.back.kick(k.back * v()); r.up.kick(k.up * v());
    r.yaw.kick((Math.random() - 0.5) * k.yaw); r.roll.kick(k.roll[0] + Math.random() * k.roll[1]);
  }

  applyUpperBody(dt) {
    const it = this.intent, wp = this.weapons, slot = wp.slot, G = slot.grip, meta = G.meta, B = this.bones, P = this.pose, T = this.tmpPose;
    const show = it.drawn && !this.rolling && !this.vaulting;
    this.aimW = damp(this.aimW, show ? 1 : 0, show ? 12 : 14, dt);
    this.lowW = damp(this.lowW, it.lowered ? 1 : 0, 7, dt);
    if (wp.shots !== this.lastShots) { if (wp.shots > (this.lastShots ?? 0)) this.recoilKick(); this.lastShots = wp.shots; }
    const r = this.rec; for (const k in r) r[k].step(dt);
    r.spine.target = 0.12 * r.flip.x + 0.4 * r.back.x;
    const w = this.aimW;
    if (w < 0.01) { this.holder.visible = false; this.applyFlinch(); return; }

    // 1. Compose the baked pose: aim loop, lowered (sprint), weapon swap dip, reload/bolt sequence.
    this.aimClock += dt;
    G.seqs.aim.sample(this.aimClock, P, true);
    let low = Math.max(this.lowW, 1 - w); // raise through the low-ready pose when (re)drawing
    if (wp.state === 'switch') low = Math.max(low, Math.sin(Math.PI * clamp(wp.t, 0, 1)));
    if (low > 0) P.mix(G.seqs.low.frames[0], low);
    const acting = wp.seq && wp.seqT >= 0 && G.seqs[wp.seq];
    if (acting) { G.seqs[wp.seq].sample(wp.seqT, T); P.mix(T, 1); }
    else {
      const ft = wp.time - wp.lastShot, fs = G.seqs.fire;
      if (fs && ft >= 0 && ft < fs.duration) { fs.sample(ft, T); for (const [k, v] of T.parts) P.part(k).copyFrom(v); }
    }
    // 2. Upper-body bones. spine_01 is set in character space so the hold is independent of hip sway.
    for (let i = 0; i < this.upper.length; i++) {
      const b = this.upper[i]; if (!b || b === B.spine_01) continue;
      _q1.fromArray(P.q, i * 4); if (w >= 1) b.quaternion.copy(_q1); else b.quaternion.slerp(_q1, w);
    }
    this.group.getWorldQuaternion(_q1).multiply(P.s1);
    setWorldQuat(B.spine_01, _q1, w);
    this.group.updateMatrixWorld(true);
    // 3. Aim: rotate the spine so the barrel points at the aim point (2 iterations, as legacy applyAim).
    const target = this.aimPoint(), muzzleLocal = _v3.fromArray(meta.muzzle);
    const kAim = w * (1 - 0.9 * low) * (acting ? 0.7 : 1);
    if (kAim > 0.01) for (let iter = 0; iter < 2; iter++) {
      const M = _m1.multiplyMatrices(B.hand_r.matrixWorld, P.gunMatrix(_m2));
      const muzzle = _v1.copy(muzzleLocal).applyMatrix4(M), bar = _v2.set(0, 0, 1).transformDirection(M);
      const D = target.clone().sub(muzzle).normalize();
      const yawE = clamp(Math.atan2(Math.sin(Math.atan2(D.x, D.z) - Math.atan2(bar.x, bar.z)), Math.cos(Math.atan2(D.x, D.z) - Math.atan2(bar.x, bar.z))), -1.2, 1.2) * kAim;
      const pitchE = clamp(Math.asin(clamp(D.y, -1, 1)) - Math.asin(clamp(bar.y, -1, 1)), -1, 1) * kAim;
      const ax = new THREE.Vector3().crossVectors(new THREE.Vector3(D.x, 0, D.z).normalize(), UP);
      for (const [n, f] of AIM_SPLIT) { applyWorldDelta(B[n], _q1.setFromAxisAngle(UP, yawE * f)); applyWorldDelta(B[n], _q1.setFromAxisAngle(ax, pitchE * f)); }
    }
    // 4. Recoil: chest absorbs, gun kicks about its pivot; both hands follow the gun by IK.
    const left = _v1.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    applyWorldDelta(B.spine_03, _q1.setFromAxisAngle(left, -(0.55 * r.spine.x + this.flinch * 4) * DEG));
    const pv = meta.pivot ?? [0, 0, 0];
    const rec = _m3.makeTranslation(0, r.up.x, -r.back.x)
      .multiply(_m4.makeTranslation(pv[0], pv[1], pv[2]))
      .multiply(_m2.makeRotationFromEuler(new THREE.Euler(-r.flip.x * DEG, r.yaw.x * DEG, r.roll.x * DEG, 'YXZ')))
      .multiply(_m4.makeTranslation(-pv[0], -pv[1], -pv[2]));
    const gunHand = P.gunMatrix(new THREE.Matrix4());
    const gunW = new THREE.Matrix4().multiplyMatrices(B.hand_r.matrixWorld, gunHand).multiply(rec);
    this.driveHand('r', _m1.copy(gunW).multiply(_m2.copy(gunHand).invert()), w);
    this.driveHand('l', _m1.copy(gunW).multiply(P.handLMatrix(_m2)), w);
    // 5. Trigger finger.
    if (!acting) {
      const ft = wp.time - wp.lastShot, held = slot.def.auto && wp.trigger && slot.mag > 0;
      const tv = held ? 1 : ft < 0.05 ? 1 : clamp(1 - (ft - 0.05) / 0.08, 0, 1);
      if (tv > 0) ['index_01_r', 'index_02_r', 'index_03_r'].forEach((n, i) => B[n].quaternion.fromArray(meta.trig.rest[i]).slerp(_q1.fromArray(meta.trig.pulled[i]), tv));
    }
    // 6. Place the weapon and its animated parts.
    this.holder.matrix.copy(this.group.matrixWorld).invert().multiply(gunW); this.holder.matrixWorldNeedsUpdate = true;
    this.holder.visible = w > 0.6 && !(wp.state === 'switch' && Math.abs(wp.t - 0.5) < 0.08);
    for (const [name, node] of slot.model.userData.parts) {
      const p = P.parts.get(name); if (!p) continue;
      node.matrix.compose(p.p, p.q, p.s); node.visible = p.vis; node.matrixWorldNeedsUpdate = true;
    }
    this.group.updateMatrixWorld(true);
  }
  // Two-bone arm IK onto a hand transform (world matrix), keeping the current elbow direction.
  driveHand(s, M, w) {
    const B = this.bones; M.decompose(_v2, _q1, _s);
    const pole = B[`lowerarm_${s}`].getWorldPosition(new THREE.Vector3());
    twoBoneIK(B[`upperarm_${s}`], B[`lowerarm_${s}`], B[`hand_${s}`], _v2.clone(), pole, w);
    setWorldQuat(B[`hand_${s}`], _q1.clone(), w);
  }
  applyFlinch() {
    if (this.flinch < 0.01) return;
    const left = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    applyWorldDelta(this.bones.spine_02, new THREE.Quaternion().setFromAxisAngle(left, this.flinch * 0.12));
    this.group.updateMatrixWorld(true);
  }

  updateDead(dt) {
    this.deadT += dt;
    this.anim.update(dt);
    const k = Math.min(1, this.deadT / 0.7), e = 1 - (1 - k) ** 3;
    this.model.rotation.x = -e * Math.PI * 0.5; this.model.position.y = e * 0.12; this.model.position.z = -e * 0.35;
    this.group.updateMatrixWorld(true);
  }

  // Closest ray hit against this character's hit capsules (no hit when dead).
  rayHit(origin, dir, maxDist) {
    if (this.dead) return null;
    let best = null; const c = this.tmpV;
    for (const hb of this.hitboxes) {
      const a = hb.a.getWorldPosition(c[0]).clone();
      const b = hb.b ? hb.b.getWorldPosition(c[1]).clone() : a.clone().add(new THREE.Vector3(0, hb.id === 'head' ? 0.16 : 0.1, 0));
      const t = raySegment(origin, dir, a, b, hb.r);
      if (t !== null && t <= maxDist && (!best || t < best.dist)) best = { dist: t, zone: hb.zone, mul: ZONE_MUL[hb.zone], character: this, point: origin.clone().addScaledVector(dir, t) };
    }
    return best;
  }
}

// Ray vs capsule (segment ab, radius r). Returns distance along ray or null.
const _u = new THREE.Vector3(), _w0 = new THREE.Vector3(), _q = new THREE.Vector3();
function raySegment(o, d, a, b, r) {
  _u.copy(b).sub(a); _w0.copy(a).sub(o);
  const uu = _u.dot(_u), ud = _u.dot(d), den = uu - ud * ud;
  const s = clamp(den > 1e-8 ? (ud * d.dot(_w0) - _u.dot(_w0)) / den : 0, 0, 1);
  _q.copy(a).addScaledVector(_u, s);
  const t = Math.max(0, d.dot(_w0.copy(_q).sub(o)));
  const dist = _w0.copy(o).addScaledVector(d, t).distanceTo(_q);
  return dist > r ? null : Math.max(0, t - Math.sqrt(r * r - dist * dist));
}
