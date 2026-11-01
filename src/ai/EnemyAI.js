import * as THREE from 'three';
import { clamp, dampAngle, rand, wrapAngle } from '../core/math.js';
import { ENEMY_TYPES, DIFFICULTY } from '../data/enemies.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// Squad-level shared knowledge + role assignment (flankers vs. suppressors).
export class Squad {
  constructor() { this.members = []; this.lastSeen = null; this.lastSeenT = -99; }
  report(pos, t) { this.lastSeen = pos.clone(); this.lastSeenT = t; }
  assignRoles(target) {
    const live = this.members.filter(m => !m.c.dead);
    live.sort((a, b) => a.c.pos.distanceTo(target.pos) - b.c.pos.distanceTo(target.pos));
    live.forEach((m, i) => { m.role = i === 0 ? 'suppress' : (i % 2 ? 'flank' : 'suppress'); if (m.type.aggr < 0.2) m.role = 'suppress'; });
  }
}

// Utility-AI enemy brain. Every think-tick each action is scored from perception + state;
// the best (with hysteresis) runs. Add behaviours by adding an entry to ACTIONS (score + run).
export class EnemyAI {
  constructor(game, character, squad, typeId, diffId = 'normal') {
    this.game = game; this.c = character; this.squad = squad; this.type = ENEMY_TYPES[typeId]; this.diff = DIFFICULTY[diffId];
    squad.members.push(this); this.role = 'suppress';
    this.target = game.player;
    this.action = 'patrol'; this.actionT = 0; this.thinkT = rand(0, 0.3);
    this.mem = { visible: false, visT: 0, aware: 0, lastPos: null, lastVel: V(), age: 99, heard: null, heardAge: 99 };
    this.path = []; this.pathGoal = null; this.pathT = 0; this.suppression = 0; this.underFire = 0;
    this.cover = null; this.coverPhase = 'hide'; this.coverT = 0; this.peekSide = 1;
    this.burst = 0; this.burstPause = 0; this.aimErr = V(); this.aimErrT = 0;
    this.aimYaw = rand(-Math.PI, Math.PI); this.aimPoint = V(); this.patrolGoal = null; this.fireHold = 0;
    this.debug = ''; this.lastTargetPos = null; this.targetVel = V();
    character.getAimRay = () => this.aimRay();
    character.onDamaged = ({ attacker, from }) => this.onDamaged(attacker, from);
    this.unsubs = [game.events.on('gunshot', e => this.onSound(e.pos, e.loudness, e.owner)), game.events.on('noise', e => this.onSound(e.pos, e.loudness * 0.6, e.owner))];
  }
  dispose() { this.unsubs.forEach(u => u()); const i = this.squad.members.indexOf(this); if (i >= 0) this.squad.members.splice(i, 1); if (this.cover) this.cover.taken = null; }

  // ---------- perception ----------
  onSound(pos, loudness, owner) {
    if (this.c.dead || !owner || owner.team === this.c.team) return;
    const d = pos.distanceTo(this.c.pos); if (d > loudness) return;
    if (!this.mem.visible) { this.mem.heard = pos.clone().add(V(rand(-1, 1), 0, rand(-1, 1)).multiplyScalar(d * 0.06)); this.mem.heardAge = 0; if (loudness > 40) this.mem.aware = Math.max(this.mem.aware, 0.4); }
  }
  onDamaged(attacker, from) {
    this.underFire = 3; this.suppression = Math.min(1, this.suppression + 0.35);
    const src = attacker?.pos ?? from; if (src) { this.mem.lastPos = src.clone(); this.mem.age = 1.5; this.squad.report(src, this.game.time); }
    this.mem.aware = 1;
  }
  nearMiss(strength = 0.25) { this.suppression = Math.min(1, this.suppression + strength); this.mem.aware = Math.max(this.mem.aware, 0.6); }
  perceive(dt) {
    const c = this.c, t = this.target, m = this.mem;
    m.age += dt; m.heardAge += dt; this.underFire = Math.max(0, this.underFire - dt); this.suppression = Math.max(0, this.suppression - dt * 0.18);
    if (t.dead) { m.visible = false; return; }
    const eye = c.eye, tc = t.center, d = eye.distanceTo(tc);
    const to = tc.clone().sub(eye); to.y = 0; const ang = Math.abs(wrapAngle(Math.atan2(to.x, to.z) - c.yaw));
    const inCone = ang < THREE.MathUtils.degToRad(80) || d < 5;
    const range = t.crouching ? 32 : 55;
    let vis = inCone && d < range && this.game.world.hasLOS(eye, tc);
    if (!vis && inCone && d < range) vis = this.game.world.hasLOS(eye, t.eye);
    const was = m.visible; m.visible = vis;
    if (vis) {
      m.visT += dt; m.age = 0; m.aware = Math.min(1, m.aware + dt * (d < 15 ? 2.2 : 1.1) / this.diff.react);
      if (this.lastTargetPos) this.targetVel.copy(t.pos).sub(this.lastTargetPos).divideScalar(Math.max(dt, 1e-3)).lerp(this.targetVel, 0.7);
      m.lastPos = t.pos.clone(); m.lastVel.copy(this.targetVel);
      if (!was) this.squad.report(t.pos, this.game.time);
    } else { m.visT = 0; m.aware = Math.max(0, m.aware - dt * 0.05); }
    this.lastTargetPos = t.pos.clone();
  }
  get engaged() { return this.mem.visible && this.mem.aware >= 0.99; }

  // ---------- decision making ----------
  think() {
    const c = this.c, m = this.mem, w = c.weapons, T = this.type;
    const hp = c.health / c.maxHealth, ammo = w.slot.mag / w.def.mag;
    const known = m.lastPos && m.age < 14; const tpos = known ? m.lastPos : null;
    const dist = tpos ? c.pos.distanceTo(tpos) : 99; const vis = m.visible && m.aware > 0.5;
    const [rmin, rmax] = T.range, inRange = dist >= rmin * 0.7 && dist <= rmax * 1.2;
    const inCover = this.cover && c.pos.distanceTo(this.cover.pos) < 1.2;
    const needReload = w.slot.mag === 0 || (ammo < 0.25 && !vis);
    const S = {};
    S.patrol = known || m.heardAge < 6 ? 0.05 : 0.3;
    S.investigate = (known && !vis ? 0.55 + T.aggr * 0.25 : 0) + (m.heardAge < 8 && !known ? 0.5 : 0);
    S.advance = vis && dist > rmax ? 0.55 + T.aggr * 0.3 : (vis && dist > rmax * 0.8 ? 0.3 : 0);
    S.engage = vis && inRange && hp > 0.3 && this.suppression < 0.7 ? 0.62 + (T.aggr > 0.7 ? 0.15 : 0) : 0;
    S.cover = known ? 0.25 + this.suppression * 0.7 + (1 - hp) * 0.5 + (needReload ? 0.9 : 0) + (this.underFire > 0 ? 0.2 : 0) + (1 - T.aggr) * 0.3 + (vis && dist < rmin ? 0.2 : 0) : 0;
    if (inCover && known) S.cover += 0.15; // stay once hidden
    S.peek = inCover && known && !needReload && hp > 0.2 ? 0.7 : 0;
    S.flank = known && this.role === 'flank' && T.aggr > 0.3 && (!vis || m.visT > 4) && hp > 0.4 ? 0.58 + T.aggr * 0.2 : 0;
    S.retreat = known && hp < 0.25 ? 1.0 : 0;
    S.reload = needReload && (inCover || !vis || this.suppression < 0.3 && dist > 20) ? 1.2 : 0;
    if (T.aggr > 0.8 && vis && dist < rmax * 1.3 && hp > 0.35) S.advance = Math.max(S.advance, 0.66);
    let best = this.action, bestS = -1;
    for (const k in S) { const s = S[k] + (k === this.action ? 0.12 : 0) + rand(0, 0.04); if (s > bestS) { best = k; bestS = s; } }
    this.debug = `${best} ${bestS.toFixed(2)}`;
    if (best !== this.action) this.enter(best, tpos);
    this.known = known; this.tpos = tpos; this.needReload = needReload;
  }

  enter(action, tpos) {
    if (this.cover && !['cover', 'peek', 'reload'].includes(action)) { this.cover.taken = null; this.cover = null; }
    this.action = action; this.actionT = 0; this.path = []; this.pathGoal = null; this.fireHold = 0;
    const world = this.game.world, c = this.c;
    if (action === 'cover' || action === 'retreat') {
      const p = this.pickCover(tpos ?? this.target.pos, action === 'retreat');
      if (p) { if (this.cover) this.cover.taken = null; this.cover = p; p.taken = this; this.coverPhase = 'move'; } else this.action = 'engage';
    } else if (action === 'peek') { this.coverPhase = 'hide'; this.coverT = rand(0.6, 1.6); }
    else if (action === 'flank') this.flankGoal = this.pickFlank(tpos ?? this.target.pos);
    else if (action === 'patrol') this.patrolGoal = null;
  }

  pickCover(threat, away) {
    const c = this.c, w = this.game.world; let best = null, bs = -1e9;
    for (const p of w.coverPoints) {
      if (p.taken && p.taken !== this) continue;
      const dMe = p.pos.distanceTo(c.pos); if (dMe > 26) continue;
      if (!w.coverQuality(p, threat)) continue;
      const dT = p.pos.distanceTo(threat);
      let s = -dMe * 0.9;
      const [rmin, rmax] = this.type.range;
      if (!away) s -= Math.abs(clamp(dT, rmin, rmax) - dT) * 0.6; else s += dT * 0.5;
      // don't run through the threat's line of fire to reach it
      const toP = p.pos.clone().sub(c.pos).normalize(), toT = threat.clone().sub(c.pos).setY(0).normalize();
      if (toP.dot(toT) > 0.5 && dT < c.pos.distanceTo(threat)) s -= 6;
      if (this.role === 'flank' && !away) s += Math.abs(toP.cross(toT).y) * 4;
      if (p.low) s -= 1; if (this.cover === p) s += 3;
      if (s > bs) { bs = s; best = p; }
    }
    return best;
  }
  pickFlank(threat) {
    const c = this.c, w = this.game.world; const base = Math.atan2(c.pos.x - threat.x, c.pos.z - threat.z);
    const radius = clamp(c.pos.distanceTo(threat), 9, 22); let best = null, bs = -1e9;
    for (let i = 0; i < 10; i++) {
      const ang = base + (Math.random() < 0.5 ? -1 : 1) * rand(1.0, 1.9);
      const p = V(threat.x + Math.sin(ang) * radius, 0, threat.z + Math.cos(ang) * radius);
      if (w.pointBlocked(p.x, p.z, 0.6)) continue;
      const path = w.findPath(c.pos, p); if (!path) continue;
      let len = 0, prev = c.pos; for (const q of path) { len += prev.distanceTo(q); prev = q; }
      const visibleFromThreat = w.hasLOS(V(threat.x, 1.5, threat.z), V(p.x, 1.5, p.z));
      const s = -len + (visibleFromThreat ? -8 : 6) + rand(0, 4);
      if (s > bs) { bs = s; best = p; }
    }
    return best;
  }

  // ---------- locomotion helpers ----------
  moveTo(goal, gait = 'run', arrive = 0.5) {
    const c = this.c, w = this.game.world; this.pathT -= this.dtLast;
    if (!this.pathGoal || this.pathGoal.distanceTo(goal) > 1 || (this.pathT <= 0 && this.path.length === 0)) {
      this.path = w.findPath(c.pos, goal) ?? []; this.pathGoal = goal.clone(); this.pathT = 1.2;
    }
    while (this.path.length && c.pos.distanceTo(this.path[0]) < (this.path.length > 1 ? 0.6 : arrive)) this.path.shift();
    if (!this.path.length) { c.intent.move.set(0, 0, 0); return true; }
    const d = this.path[0].clone().sub(c.pos); d.y = 0; d.normalize();
    // soft separation from squad mates
    for (const o of this.squad.members) { if (o === this || o.c.dead) continue; const off = c.pos.clone().sub(o.c.pos); const l = off.length(); if (l < 1.3 && l > 0.01) d.addScaledVector(off.divideScalar(l), (1.3 - l) * 0.8); }
    c.intent.move.copy(d.normalize()); c.intent.gait = gait; return false;
  }
  stop() { this.c.intent.move.set(0, 0, 0); }
  lookToward(point, dt, rate = this.type.turn) {
    const c = this.c, d = point.clone().sub(c.pos); const yaw = Math.atan2(d.x, d.z);
    const diff = wrapAngle(yaw - this.aimYaw), step = THREE.MathUtils.degToRad(rate) * dt;
    this.aimYaw += clamp(diff, -step, step); return Math.abs(diff);
  }

  // ---------- aiming / shooting ----------
  aimRay() {
    const c = this.c, s = c.weapons.slot.model.userData.muzzle; const o = s.getWorldPosition(V());
    const d = this.aimPoint.clone().sub(o).normalize();
    return { origin: o, dir: d };
  }
  updateAim(dt, canShoot) {
    const c = this.c, t = this.target, m = this.mem;
    // lead the target a little (bounded) and add a slowly changing error
    const lead = clamp(c.pos.distanceTo(t.pos) / 120, 0, 0.35);
    const base = t.center.clone().addScaledVector(m.visible ? this.targetVel : V(), lead);
    if (!m.visible) base.copy(m.lastPos ?? t.pos).setY(1.3);
    this.aimErrT -= dt; if (this.aimErrT <= 0) { const d = c.pos.distanceTo(t.pos); const deg = this.type.acc * this.diff.acc * (0.5 + d / 20) * (c.moving ? 1.4 : 1) * (this.targetVel.length() > 2 ? 1.25 : 1) * (c.crouching ? 0.8 : 1); const e = Math.tan(THREE.MathUtils.degToRad(deg)) * d; this.aimErr.set(rand(-e, e), rand(-e, e) * 0.6, rand(-e, e)); this.aimErrT = rand(0.25, 0.6); }
    this.aimPoint.copy(base).add(this.aimErr);
    const diff = this.lookToward(this.aimPoint, dt);
    c.intent.aimYaw = this.aimYaw;
    const o = c.eye, d = this.aimPoint.clone().sub(o); c.intent.aimPitch = Math.atan2(d.y, Math.hypot(d.x, d.z)) * 0.9;
    return diff;
  }
  fireControl(dt, diff, canShoot) {
    const c = this.c, w = c.weapons, T = this.type, m = this.mem;
    this.burstPause -= dt;
    if (!canShoot || diff > 0.12 || !m.visible || m.aware < 0.99 || this.burstPause > 0 && this.burst <= 0) { w.trigger = false; if (this.burst > 0 && !canShoot) this.burst = 0; if (!canShoot) return; }
    if (canShoot && diff <= 0.12 && m.visible && m.aware >= 0.99) {
      if (this.burst <= 0 && this.burstPause <= 0) { this.burst = Math.round(rand(T.burst[0], T.burst[1])); }
      if (this.burst > 0) {
        const before = w.slot.mag; w.trigger = true; w.triggerPrev = w.def.auto ? w.triggerPrev : false;
        if (w.slot.mag < before || w.cool > 0 && this.lastMag !== w.slot.mag) { /* counted below */ }
      }
      if (this.lastMag !== undefined && w.slot.mag < this.lastMag) { this.burst -= this.lastMag - w.slot.mag; if (this.burst <= 0) { this.burstPause = w.def.auto ? rand(0.5, 1.4) : rand(0.7, 1.6) * (w.def.bolt ? 1.5 : 1); w.trigger = false; } }
    }
    this.lastMag = w.slot.mag;
  }

  // ---------- main update ----------
  update(dt) {
    const c = this.c; this.dtLast = dt;
    if (c.dead) { this.dispose(); return; }
    this.perceive(dt);
    this.thinkT -= dt; if (this.thinkT <= 0) { this.thinkT = rand(0.25, 0.4); this.squad.assignRoles(this.target); this.think(); }
    this.actionT += dt;
    const it = c.intent, m = this.mem, vis = m.visible && m.aware >= 0.99;
    it.ads = false; it.crouch = false; it.gait = 'run'; it.strafe = true; it.drawn = true;
    c.weapons.trigger = false;
    let canShoot = false, face = null;
    const w = c.weapons;
    switch (this.action) {
      case 'patrol': {
        if (!this.patrolGoal || this.actionT > 12) { this.patrolGoal = this.randomPoint(); this.actionT = 0; }
        if (this.moveTo(this.patrolGoal, 'walk', 0.8)) this.patrolGoal = null;
        face = this.path[0] ?? null; break;
      }
      case 'investigate': {
        const goal = (m.age < 14 && m.lastPos) ? m.lastPos : m.heard; if (!goal) { this.stop(); break; }
        const arrived = this.moveTo(goal, m.age < 4 ? 'run' : 'walk', 1.5); face = this.path[0] ?? goal;
        if (arrived && this.actionT > 1) { m.age = 99; m.heardAge = 99; }
        break;
      }
      case 'advance': { this.moveTo(this.target.pos, 'run', this.type.range[1] * 0.6); canShoot = c.speed < 3.2 || this.type.aggr > 0.7; break; }
      case 'engage': {
        // hold ground and strafe unpredictably
        this.strafeT = (this.strafeT ?? 0) - dt; if (this.strafeT <= 0) { this.strafeDir = Math.random() < 0.5 ? -1 : 1; this.strafeT = rand(0.8, 2.2); }
        const to = this.target.pos.clone().sub(c.pos).setY(0).normalize(), side = V(to.z, 0, -to.x).multiplyScalar(this.strafeDir);
        const probe = c.pos.clone().addScaledVector(side, 1.2); if (this.game.world.pointBlocked(probe.x, probe.z, 0.5)) this.strafeDir *= -1;
        const dist = c.pos.distanceTo(this.target.pos);
        it.move.copy(side).multiplyScalar(0.7).addScaledVector(to, dist < this.type.range[0] ? -0.6 : dist > this.type.range[1] ? 0.5 : 0);
        it.gait = 'walk'; it.ads = this.type.range[0] > 20 || (dist > 22 && w.def.adsFov < 0.7); canShoot = true; break;
      }
      case 'cover': case 'retreat': this.runCover(dt, false); canShoot = this.coverCanShoot; face = this.coverFace; break;
      case 'peek': this.runCover(dt, true); canShoot = this.coverCanShoot; face = this.coverFace; break;
      case 'flank': {
        if (!this.flankGoal) { this.flankGoal = this.pickFlank(this.mem.lastPos ?? this.target.pos); }
        const arrived = this.flankGoal ? this.moveTo(this.flankGoal, 'sprint', 1) : true;
        canShoot = vis && c.speed < 3; if (arrived) { this.role = 'suppress'; this.action = 'engage'; }
        face = vis ? null : (this.path[0] ?? null); break;
      }
      case 'reload': {
        this.stop(); it.crouch = !!(this.cover && this.cover.low); if (!w.busy && w.slot.mag < w.def.mag) w.reload();
        if (!w.busy) this.thinkT = 0; face = null; break;
      }
    }
    // aiming: toward the threat when we know where it is, otherwise along the path of travel
    const lookAtThreat = (m.lastPos && (m.age < 3 || vis)) || this.underFire > 0;
    let diff = 9;
    if (lookAtThreat && m.aware > 0.5) { diff = this.updateAim(dt, canShoot); }
    else {
      const pt = face ? face : (m.heard && m.heardAge < 3 ? m.heard : c.pos.clone().add(V(Math.sin(c.yaw), 0, Math.cos(c.yaw))));
      this.lookToward(pt, dt, 200); it.aimYaw = this.aimYaw; it.aimPitch = 0;
      this.aimPoint.copy(c.eye).add(V(Math.sin(c.yaw), 0, Math.cos(c.yaw)));
    }
    if (it.move.lengthSq() < 0.001 && !it.strafe) it.strafe = true;
    if (w.def.scope === undefined || true) this.fireControl(dt, THREE.MathUtils.degToRad(diff) < 0 ? 0 : diff, canShoot && !w.busy);
    c.update(dt);
  }
  randomPoint() {
    const h = this.game.world.half - 3;
    for (let i = 0; i < 20; i++) { const x = rand(-h, h), z = rand(-h, h); if (!this.game.world.pointBlocked(x, z, 0.8)) return V(x, 0, z); }
    return V(0, 0, 0);
  }

  // cover: move -> hide (crouch, reload) -> peek (step out, shoot) -> hide ...
  runCover(dt, startedInCover) {
    const c = this.c, it = c.intent, p = this.cover, w = c.weapons; this.coverCanShoot = false; this.coverFace = null;
    if (!p) { this.action = 'engage'; return; }
    const threat = this.mem.lastPos ?? this.target.pos;
    if (this.coverPhase === 'move') {
      const arrived = this.moveTo(p.pos, c.pos.distanceTo(p.pos) > 6 ? 'sprint' : 'run', 0.4);
      this.coverCanShoot = this.mem.visible && c.speed < 3; this.coverFace = this.path[0] ?? null;
      if (arrived || c.pos.distanceTo(p.pos) < 0.7) { this.coverPhase = 'hide'; this.coverT = rand(1.0, 2.6); }
      return;
    }
    // re-validate cover if the threat moved to a position that exposes us
    this.revalT = (this.revalT ?? 0) - dt;
    if (this.revalT <= 0) { this.revalT = 1; if (!this.game.world.coverQuality(p, threat) && this.coverPhase === 'hide') { this.enter('cover', threat); return; } }
    this.stop(); this.coverT -= dt;
    if (this.coverPhase === 'hide') {
      it.crouch = p.low || Math.random() < 0.0; if (!p.low) it.crouch = false;
      if (w.slot.mag < w.def.mag * 0.5 && !w.busy) w.reload();
      if (this.coverT <= 0 && !w.busy && w.slot.mag > 0 && this.action !== 'retreat') { this.coverPhase = 'peek'; this.coverT = rand(1.2, 2.8) * (0.6 + this.type.aggr); this.peekSide = Math.random() < 0.5 ? -1 : 1; this.peekGoal = null; }
      return;
    }
    // peek: low cover -> stand up; high cover -> lean out sideways along the wall
    this.coverCanShoot = true;
    if (p.low) { it.crouch = false; }
    else {
      if (!this.peekGoal) { const side = V(-p.normal.z, 0, p.normal.x).multiplyScalar(this.peekSide); this.peekGoal = p.pos.clone().addScaledVector(side, 1.4); if (this.game.world.pointBlocked(this.peekGoal.x, this.peekGoal.z, 0.4)) { this.peekSide *= -1; this.peekGoal = p.pos.clone().addScaledVector(V(-p.normal.z, 0, p.normal.x).multiplyScalar(this.peekSide), 1.4); } }
      const d = this.peekGoal.clone().sub(c.pos).setY(0); if (d.length() > 0.25) { it.move.copy(d.normalize()); it.gait = 'walk'; }
    }
    const out = this.mem.visible;
    if (this.coverT <= 0 || w.slot.mag === 0 || (this.underFire > 2.2 && this.suppression > 0.6)) { this.coverPhase = 'move'; this.pathGoal = null; this.coverBack = true; this.coverT = 0; }
    if (this.coverPhase === 'peek' && !out && this.coverT < 0.6) this.coverT = 0;
  }
}
