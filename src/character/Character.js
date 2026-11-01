import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { AnimController } from './AnimController.js';
import { WeaponSystem } from '../weapons/WeaponSystem.js';
import { applyWorldDelta, twoBoneIK } from './IK.js';
import { HAND_POSES } from '../data/handPoses.js';
import { clamp, damp, dampAngle, lerp } from '../core/math.js';

const RIGHT_MASK = ['clavicle_r', 'upperarm_r', 'lowerarm_r', 'hand_r', 'upperarm_twist_01_r', 'lowerarm_twist_01_r'];
const LEFT_MASK = ['clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l', 'upperarm_twist_01_l', 'lowerarm_twist_01_l'];
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const fingerBones = s => FINGERS.flatMap(f => [1, 2, 3].map(i => `${f}_0${i}_${s}`));
const POSE_MASK = ['spine_02', 'spine_03', 'neck_01', 'head', ...RIGHT_MASK, ...LEFT_MASK, ...fingerBones('r'), ...fingerBones('l')];
const SPEEDS = { walk: 1.7, run: 4.0, sprint: 6.4, crouch: 1.6, crouchRun: 2.4 };
const HIT_SEGMENTS = [
  ['head', 'head', null, 0.115, 'head', 0.08], ['neck', 'neck_01', 'head', 0.07, 'torso'],
  ['torso', 'pelvis', 'spine_03', 0.17, 'torso'], ['chest', 'spine_03', 'neck_01', 0.17, 'torso'],
  ['uarm_l', 'upperarm_l', 'lowerarm_l', 0.055, 'limb'], ['farm_l', 'lowerarm_l', 'hand_l', 0.05, 'limb'],
  ['uarm_r', 'upperarm_r', 'lowerarm_r', 0.055, 'limb'], ['farm_r', 'lowerarm_r', 'hand_r', 0.05, 'limb'],
  ['thigh_l', 'thigh_l', 'calf_l', 0.08, 'limb'], ['calf_l', 'calf_l', 'foot_l', 0.065, 'limb'],
  ['thigh_r', 'thigh_r', 'calf_r', 0.08, 'limb'], ['calf_r', 'calf_r', 'foot_r', 0.065, 'limb'],
];
const ZONE_MUL = { head: 1, torso: 1, limb: 0.6 };
const UP = new THREE.Vector3(0, 1, 0);

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
    this.holder = new THREE.Object3D(); this.holder.scale.setScalar(100); this.bones.hand_r.add(this.holder);
    this.weapons = new WeaponSystem(this, weapons, { infinite: infiniteAmmo });
    for (const s of this.weapons.slots) this.holder.add(s.model);
    this.pos = this.group.position; this.yaw = 0; this.vel = new THREE.Vector3(); this.speed = 0;
    this.radius = 0.35; this.crouching = false; this.health = this.maxHealth = health; this.dead = false;
    this.intent = { move: new THREE.Vector3(), gait: 'run', crouch: false, ads: false, aimYaw: 0, aimPitch: 0, drawn: true, strafe: true };
    this.aimW = 0; this.adsT = 0; this.kick = 0; this.flinch = 0; this.bobDist = 0; this.deadT = 0;
    this.hitboxes = HIT_SEGMENTS.map(([id, a, b, r, zone]) => ({ id, a: this.bones[a], b: b ? this.bones[b] : null, r, zone }));
    this.poseCache = new Map(); this.tmpV = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this.getAimRay = () => { const o = new THREE.Vector3(); this.bones.head.getWorldPosition(o); const d = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)); return { origin: o, dir: d }; };
    this.ready = this.loadPoses().then(() => this.onWeaponChanged());
  }

  async loadPoses() {
    const files = new Set(this.weapons.slots.flatMap(s => [s.def.pose.hip, s.def.pose.ads]));
    await Promise.all([...files].map(async f => this.poseCache.set(f, await this.game.assets.getPose(f))));
  }
  onWeaponChanged() {
    const s = this.weapons.slot; s.model.visible = this.intent.drawn;
    const hp = HAND_POSES[s.def.model] ?? HAND_POSES.rifle, r = hp.right;
    this.holder.position.set(...r.pos.map(v => v * 100));
    this.holder.rotation.set(...r.rot.map(THREE.MathUtils.degToRad));
    this.poseHip = this.poseCache.get(s.def.pose.hip); this.poseAds = this.poseCache.get(s.def.pose.ads);
    this.leftOff = new THREE.Quaternion().setFromEuler(new THREE.Euler(...hp.left.rot.map(THREE.MathUtils.degToRad)));
    this.leftPos = new THREE.Vector3(...hp.left.pos);
  }
  sound(kind, def, pos) { this.game.audio?.weapon(kind, def, pos ?? this.pos, this === this.game.player); }

  // ---- gameplay state ----
  get eye() { return this.bones.head.getWorldPosition(new THREE.Vector3()); }
  get center() { return this.bones.spine_02.getWorldPosition(new THREE.Vector3()); }
  get moving() { return this.speed > 0.2; }

  damage(amount, { zone = 'torso', from = null, attacker = null, point = null } = {}) {
    if (this.dead) return;
    this.health = Math.max(0, this.health - amount); this.flinch = Math.min(1, this.flinch + amount / 40);
    this.events.emit('damage', { target: this, attacker, amount, zone, from, point });
    this.onDamaged?.({ amount, attacker, from, zone });
    if (this.health <= 0) this.die(attacker, zone);
  }
  die(attacker, zone) {
    this.dead = true; this.weapons.trigger = false; this.intent.move.set(0, 0, 0);
    this.anim.stopOnce(true); this.deadT = 0;
    this.events.emit('death', { target: this, attacker, zone });
  }

  // ---- actions (animation-driven; displacement comes from the baked clip) ----
  canAct() { return !this.dead && !this.anim.busy; }
  displace(dx, dz, ignore) {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    this.game.world.moveCircle(this.pos, dx * c + dz * s, -dx * s + dz * c, this.radius, ignore);
  }
  jump() {
    if (!this.canAct()) return;
    const clip = this.speed > 2.5 ? 'jump_run' : 'jump';
    this.lockYaw = this.yaw;
    this.anim.playOnce(clip, { fadeOut: 0.2, onMove: (dx, dz) => this.displace(dx, dz) });
  }
  roll(dirWorld) {
    if (!this.canAct()) return;
    const d = dirWorld && dirWorld.lengthSq() > 0.01 ? dirWorld : new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.yaw = Math.atan2(d.x, d.z); this.group.rotation.y = this.yaw; this.crouching = false;
    this.weapons.trigger = false;
    this.anim.playOnce('roll', { fadeIn: 0.08, fadeOut: 0.18, onMove: (dx, dz) => this.displace(dx, dz) });
    this.rolling = true; this.anim.one.onDone = () => { this.rolling = false; };
  }
  tryVault() {
    if (!this.canAct()) return false;
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const hit = this.game.world.vaultTarget(this.pos, fwd);
    if (!hit) return false;
    this.yaw = Math.atan2(-hit.normal.x, -hit.normal.z); this.group.rotation.y = this.yaw;
    if (!this.game.assets.clips.get('vault')) return false;
    const ignore = new Set([hit.collider]);
    this.weapons.trigger = false;
    this.pos.addScaledVector(fwd, Math.max(0, hit.dist - 0.45));
    this.vaulting = true;
    this.anim.playOnce('vault', {
      fadeOut: 0.2, onMove: (dx, dz) => this.displace(dx, dz, ignore),
      onDone: () => { this.vaulting = false; this.game.world.pushOut(this.pos, this.radius); },
    });
    return true;
  }

  update(dt) {
    if (this.dead) return this.updateDead(dt);
    const it = this.intent, wp = this.weapons;
    this.crouching = it.crouch && !this.anim.busy;
    // --- horizontal movement
    const busy = this.anim.busy;
    const wantMove = it.move.lengthSq() > 0.001 && !busy;
    let maxSpeed = this.crouching ? (it.gait === 'walk' ? SPEEDS.crouch : SPEEDS.crouchRun) : SPEEDS[it.gait] ?? SPEEDS.run;
    if (it.ads) maxSpeed = Math.min(maxSpeed, SPEEDS.walk * 1.1);
    if (it.drawn) maxSpeed *= wp.def.moveSpeed;
    const wr = wp.state === 'reload' ? 0.85 : 1; maxSpeed *= wr;
    const desired = wantMove ? it.move.clone().normalize().multiplyScalar(maxSpeed * Math.min(1, it.move.length())) : new THREE.Vector3();
    const k = wantMove ? 11 : 16;
    this.vel.x = damp(this.vel.x, desired.x, k, dt); this.vel.z = damp(this.vel.z, desired.z, k, dt);
    if (busy) this.vel.set(0, 0, 0);
    else this.game.world.moveCircle(this.pos, this.vel.x * dt, this.vel.z * dt, this.radius);
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    // --- facing
    if (!busy) {
      const strafe = it.drawn && it.strafe;
      if (strafe) this.yaw = dampAngle(this.yaw, it.aimYaw, it.ads ? 18 : 12, dt);
      else if (this.speed > 0.4) this.yaw = dampAngle(this.yaw, Math.atan2(this.vel.x, this.vel.z), 9, dt);
    }
    this.group.rotation.y = this.yaw;
    // --- locomotion animation
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const dz = this.vel.x * s + this.vel.z * c, dx = -(this.vel.x * c - this.vel.z * s);
    const gait = this.speed > 5 ? 'sprint' : this.speed > 2.9 ? 'run' : 'walk';
    this.anim.setLocomotion({ set: this.crouching ? 'crouch' : 'stand', gait, speed: this.speed, dx, dz, moving: this.speed > 0.25 });
    this.anim.update(dt);
    this.group.position.y = this.anim.liftY || 0;
    if (this.speed > 0.5) {
      this.bobDist += this.speed * dt;
      if (this.bobDist > (this.speed > 3 ? 1.5 : 1.1)) { this.bobDist = 0; this.events.emit('noise', { pos: this.pos.clone(), owner: this, loudness: this.crouching ? 2 : this.speed > 5 ? 22 : this.speed > 2.9 ? 12 : 5 }); this.game.audio?.step?.(this.pos, this === this.game.player); }
    }
    // --- weapon / upper body
    wp.update(dt);
    const showWeapon = it.drawn && !this.rolling && !this.vaulting;
    wp.slot.model.visible = showWeapon && wp.state !== 'switch' || (wp.state === 'switch' && wp.t > 0.22 && showWeapon);
    const aimTarget = showWeapon && !busy ? 1 : 0;
    this.aimW = damp(this.aimW, aimTarget, 12, dt);
    this.adsT = damp(this.adsT, it.ads ? 1 : 0, 14, dt);
    this.kick = damp(this.kick, 0, wp.def.recoil.recover, dt);
    this.flinch = damp(this.flinch, 0, 7, dt);
    this.group.updateMatrixWorld(true);
    this.applyUpperBody(dt);
  }

  applyUpperBody(dt) {
    const it = this.intent, B = this.bones;
    if (this.aimW > 0.002 && this.poseHip) {
      const q = new THREE.Quaternion();
      for (const n of POSE_MASK) {
        const b = B[n], h = this.poseHip.get(n); if (!b || !h) continue;
        q.copy(h); const a = this.poseAds.get(n); if (a && this.adsT > 0.001) q.slerp(a, this.adsT);
        b.quaternion.slerp(q, this.aimW);
      }
      this.group.updateMatrixWorld(true);
      const left = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const pitch = clamp(it.aimPitch, -1.2, 1.2) + this.kick * 0.012 + this.flinch * 0.05;
      const share = [['spine_01', 0.16], ['spine_02', 0.26], ['spine_03', 0.26], ['neck_01', 0.12], ['head', 0.2]];
      const dq = new THREE.Quaternion();
      for (const [n, f] of share) applyWorldDelta(B[n], dq.setFromAxisAngle(left, -pitch * f * this.aimW));
      this.applyFingers();
      this.applyLeftHand();
    } else if (this.flinch > 0.01) {
      const left = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      applyWorldDelta(B.spine_02, new THREE.Quaternion().setFromAxisAngle(left, this.flinch * 0.12));
    }
    this.group.updateMatrixWorld(true);
  }

  applyFingers() {
    const f = (HAND_POSES[this.weapons.def.model] ?? {}).fingers; if (!f) return;
    const q = new THREE.Quaternion(), ax = new THREE.Vector3(0, 0, 1);
    for (const side of ['r', 'l']) {
      const set = f[side]; if (!set) continue;
      FINGERS.forEach((fn, fi) => { for (let j = 1; j <= 3; j++) { const b = this.bones[`${fn}_0${j}_${side}`]; if (b) b.quaternion.multiply(q.setFromAxisAngle(ax, THREE.MathUtils.degToRad(set[fi] ?? 0))); } });
    }
  }

  // Support hand: two-bone IK onto the weapon's foregrip, with a procedural path during reloads.
  applyLeftHand() {
    const wp = this.weapons, model = wp.slot.model, ud = model.userData; const B = this.bones;
    const grip = ud.foregrip; if (!grip) return;
    const gp = grip.getWorldPosition(this.tmpV[0]).clone(), gq = grip.getWorldQuaternion(new THREE.Quaternion());
    const target = gp.clone().add(this.leftPos.clone().applyQuaternion(model.getWorldQuaternion(new THREE.Quaternion())));
    let w = 1;
    const mq = model.getWorldQuaternion(new THREE.Quaternion());
    const local = v => v.clone().applyQuaternion(mq).add(gp);
    const rp = wp.reloadProgress;
    if (wp.state === 'reload' || wp.state === 'cycle') {
      const d = wp.def;
      if (d.reloadStyle === 'shell' && wp.state === 'reload') {
        const u = 1 - Math.max(0, wp.t) / wp.reloadTotal, k = Math.sin(u * Math.PI);
        target.copy(gp).lerp(local(new THREE.Vector3(0, -0.08, -0.25)), k);
      } else if (wp.state === 'reload') {
        const u = rp, p = u < 0.3 ? u / 0.3 : u < 0.55 ? 1 : u < 0.85 ? 1 - (u - 0.55) / 0.3 * 0.1 : 0.9 * (1 - (u - 0.85) / 0.15);
        const magPos = local(new THREE.Vector3(0, -0.2, 0.06));
        target.copy(gp).lerp(magPos, clamp(p, 0, 1));
        if (ud.mag) ud.mag.visible = !(u > 0.28 && u < 0.58);
      } else if (d.pump) {
        const k = Math.sin(rp * Math.PI); target.addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(mq), 0.16 * k);
        const pm = model.getObjectByName('pump'); if (pm) pm.position.z = 0.4 - 0.12 * k;
      } else if (d.bolt) { const bm = model.getObjectByName('bolt'); if (bm) bm.position.z = 0.02 - 0.08 * Math.sin(rp * Math.PI); }
    } else { if (ud.mag) ud.mag.visible = true; const pm = model.getObjectByName('pump'); if (pm) pm.position.z = 0.4; const bm = model.getObjectByName('bolt'); if (bm) bm.position.z = 0.02; }
    const upper = B.upperarm_l, pole = B.lowerarm_l.getWorldPosition(this.tmpV[1]).clone();
    twoBoneIK(upper, B.lowerarm_l, B.hand_l, target, pole, this.aimW * w);
    // orient the hand to the foregrip frame
    const hq = gq.clone().multiply(this.leftOff);
    const cur = B.hand_l.getWorldQuaternion(new THREE.Quaternion());
    const want = cur.clone().slerp(hq, this.aimW * this.gripOrient());
    applyWorldDelta(B.hand_l, want.multiply(cur.invert()));
  }
  gripOrient() { return HAND_POSES[this.weapons.def.model]?.left?.orient ?? 0; }

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
      if (hb.id === 'head') { a.y -= 0.0; }
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
