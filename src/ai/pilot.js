import * as THREE from 'three';
import { clamp, rand, DEG, smoothstep } from '../util/math.js';

const G = 9.81, UPV = new THREE.Vector3(0, 1, 0), _e2 = new THREE.Euler();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _m = new THREE.Matrix4();

/** Shared kinematic flight for AI: turn-rate limited steering with the same energy rules as the player. */
export function steer(e, dt, desired, desiredSpeed, agility = 1) {
  const d = e.def, cur = e.dir;
  const ang = Math.acos(clamp(cur.dot(desired), -1, 1));
  const spd = e.speed, corner = d.cruise * 1.05;
  const stall = smoothstep(95, 130, spd);
  const maxTurn = d.maxTurn * agility * clamp(spd / corner, 0.3, 1.1) * (0.35 + 0.65 * stall);
  const turn = Math.min(ang, maxTurn * dt);
  if (ang > 1e-4) { _a.crossVectors(cur, desired); if (_a.lengthSq() < 1e-10) _a.set(0, 1, 0); cur.applyAxisAngle(_a.normalize(), turn).normalize(); }
  const rate = turn / Math.max(dt, 1e-4), gl = clamp(1 + (spd * rate) / G, 1, 9);
  const thr = clamp(0.5 + (desiredSpeed - spd) * 0.12, 0, 1), vr = spd / d.maxSpeed;
  let acc = d.thrust * thr * Math.max(0, 1 - vr * vr) - G * cur.y - 0.9 * vr * vr * d.thrust - e.bleed * 0.9 * Math.pow(Math.max(0, gl - 1), 1.35);
  e.speed = clamp(spd + acc * dt, 60, d.maxSpeed * 1.05); e.throttle = thr;
  // bank
  _b.crossVectors(cur, desired); const side = Math.sign(_b.y) * clamp(rate / Math.max(d.maxTurn, 0.1), 0, 1);
  e.bank += (side * 1.15 - e.bank) * Math.min(1, dt * 3);
  _a.crossVectors(cur, UPV); if (_a.lengthSq() < 1e-4) _a.set(1, 0, 0); _a.normalize(); // right
  _b.crossVectors(_a, cur).normalize();
  _a.applyAxisAngle(cur, e.bank); _b.applyAxisAngle(cur, e.bank);
  _c.copy(cur).negate();
  e.quat.setFromRotationMatrix(_m.makeBasis(_a, _b, _c));
  e.vel.copy(cur).multiplyScalar(e.speed); e.pos.addScaledVector(e.vel, dt);
  e.turnRate = rate;
}

const ang = (u, v) => Math.acos(clamp(u.dot(v), -1, 1));

export class Pilot {
  constructor(entity, game, cfg = {}) {
    this.e = entity; this.game = game; this.cfg = cfg; this.t = 0;
    const d = entity.def, df = game.diff().ai, tr = d.traits;
    this.tr = { skill: clamp(tr.skill + (entity.side === 'hostile' ? df.skill : 0), 0.05, 1), aggression: clamp(tr.aggression + (entity.side === 'hostile' ? df.aggression : 0), 0, 1), reaction: tr.reactionTime * (entity.side === 'hostile' ? df.reaction : 1), awareness: tr.awareness, discipline: tr.discipline, risk: tr.riskTolerance, formation: tr.formationSkill };
    this.route = (cfg.route || []).map((p) => new THREE.Vector3(...p)); this.wp = 0;
    this.state = entity.role === 'wingman' ? 'FORMATION' : entity.role === 'asset' ? 'ROUTE' : 'PATROL';
    entity.state = this.state; this.timer = 0; this.target = null; this.alert = 0; this.burst = 0; this.pause = rand(0, 2);
    this.missileCd = rand(2, 6); this.evadeSeen = 0; this.flareCd = 0; this.jink = 0; this.jinkDir = 1; this.reposPt = new THREE.Vector3(); this.idTime = 0;
    this.egress = cfg.egress ? new THREE.Vector3(...cfg.egress) : null; this.disengageT = 0; this.permanentLeave = cfg.permanentLeave !== false;
    this.priority = cfg.targetPriority || 'player'; this.missileOnAsset = !!cfg.missileOnAsset;
    entity.dir = new THREE.Vector3(0, 0, -1).applyQuaternion(entity.quat); entity.bank = 0; entity.bleed = df ? (game.diff().energyBleed) : 1; entity.throttle = 0.6;
  }
  set(s) { if (this.state !== s) { this.state = s; this.e.state = s; this.timer = 0; this.game.onAIState?.(this.e, s); } }

  pickTarget() {
    const g = this.game, e = this.e; let best = null, bs = 0;
    const list = e.side === 'hostile' ? [g.player, ...g.entities.filter((x) => x.side === 'friendly' && x.alive && x !== g.player)] : g.entities.filter((x) => x.side === 'hostile' && x.alive && x.identified);
    for (const c of list) {
      if (!c.alive) continue;
      const d = c.pos.distanceTo(e.pos); if (d > 16000) continue;
      let w = 1 / (d + 500);
      if (e.side === 'hostile') { const isAsset = !!c.asset; if (this.priority === 'asset' && isAsset) w *= 4; if (this.priority === 'player' && c.isPlayer) w *= 4; if (c.role === 'wingman') w *= 0.7; }
      if (w > bs) { bs = w; best = c; }
    }
    return best;
  }

  steerTo(dt, point, speed, agility = 1) { _c.copy(point).sub(this.e.pos); if (_c.lengthSq() < 1) _c.copy(this.e.dir); this.avoidGround(_c); steer(this.e, dt, _c.normalize(), speed, agility); }
  avoidGround(dir) {
    const e = this.e, g = this.game; const look = e.pos.clone().addScaledVector(e.dir, e.speed * 3.2);
    const gy = Math.max(g.groundY(look.x, look.z), g.groundY(e.pos.x, e.pos.z));
    const margin = 250 - (look.y - gy);
    if (margin > 0) { dir.normalize(); dir.y += clamp(margin / 200, 0, 1.6); }
  }
  lead(target, speedProj = 0) {
    const e = this.e, dist = target.pos.distanceTo(e.pos), t = dist / (speedProj || Math.max(e.speed + 200, 400));
    return target.pos.clone().addScaledVector(target.vel, t);
  }

  update(dt) {
    const e = this.e; this.t += dt; this.timer += dt;
    const role = e.role;
    if (role === 'asset') return this.updateAsset(dt);
    if (role === 'courier') return this.updateCourier(dt);
    if (role === 'heli') return this.updateHeli(dt);
    if (role === 'wingman') return this.updateWing(dt);
    return this.updateHostile(dt);
  }

  followRoute(dt, speed, loop = false) {
    const e = this.e;
    if (!this.route.length || this.routeDone) { _c.copy(e.dir).multiplyScalar(8000).add(e.pos); return this.steerTo(dt, _c, speed); }
    if (this.route[this.wp].distanceTo(e.pos) < (this.cfg.reach || 900)) { if (this.wp < this.route.length - 1) this.wp++; else if (loop) this.wp = 0; else this.routeDone = true; }
    this.steerTo(dt, this.route[this.wp], speed, 0.8);
  }

  updateAsset(dt) {
    const e = this.e, inc = this.game.weapons.incoming(e);
    this.flareCd -= dt;
    if (inc.length && this.flareCd <= 0) { this.game.weapons.dropFlares(e, 2); this.flareCd = 1.2; }
    this.followRoute(dt, this.cfg.cruise || e.def.cruise, this.cfg.loop);
  }

  /** Courier: runs its route at full throttle, jinks and flares when a missile is inbound, and escapes at the end of the route. */
  updateCourier(dt) {
    const e = this.e, g = this.game, w = g.weapons; this.flareCd -= dt;
    const inc = w.incoming(e).filter((m) => m.pos.distanceTo(e.pos) < 6000);
    if (inc.length && this.flareCd <= 0) { w.dropFlares(e, 2); this.flareCd = 1.0; this.jinkT = 2.4; this.jinkDir = Math.random() < 0.5 ? -1 : 1; }
    const speed = e.def.maxSpeed * (this.cfg.throttle || 0.97);
    if (this.jinkT > 0) { this.jinkT -= dt; _b.copy(e.dir).applyAxisAngle(UPV, this.jinkDir * 0.9).add(_c.set(0, -0.15, 0)).normalize(); steer(e, dt, _b, speed, 1.2); }
    else this.followRoute(dt, speed);
    if (this.routeDone && g.player.pos.distanceTo(e.pos) > 2500) { e.despawned = true; e.alive = false; g.onAIGone?.(e); }
  }

  /** Helicopter: kinematic flight along its route, hovers at waypoints listed in cfg.hover ({index: seconds}), waits for an order when cfg.hold. */
  updateHeli(dt) {
    const e = this.e, g = this.game, w = g.weapons; this.flareCd -= dt;
    if (w.incoming(e).length && this.flareCd <= 0) { w.dropFlares(e, 2); this.flareCd = 1.0; }
    const moving = (spd) => { e.speed += (spd - e.speed) * Math.min(1, dt * 0.8); };
    if (this.cfg.hold && !this.go) { this.set('IDLE'); moving(0); e.vel.set(0, 0, 0); return; }
    const hov = this.cfg.hover || {};
    if (this.hoverT > 0) { this.hoverT -= dt; this.set('HOVER'); moving(0); e.vel.set(0, 0, 0); if (this.hoverT <= 0) { this.hoverDone = this.hoverDone || new Set(); this.hoverDone.add(this.wp); this.wp = Math.min(this.wp + 1, this.route.length - 1); this.set('ROUTE'); } return; }
    if (!this.route.length || this.routeDone) { moving(0); e.vel.set(0, 0, 0); return; }
    const tgt = this.route[this.wp]; _c.copy(tgt).sub(e.pos); const horiz = Math.hypot(_c.x, _c.z);
    if (horiz < 140) {
      if (hov[this.wp] && !(this.hoverDone && this.hoverDone.has(this.wp))) { this.hoverT = hov[this.wp]; return; }
      if (this.wp < this.route.length - 1) this.wp++; else this.routeDone = true; return;
    }
    this.set('ROUTE'); moving(Math.min(this.cfg.cruise || e.def.cruise, 20 + horiz * 0.25));
    _b.set(_c.x, 0, _c.z).normalize(); e.dir.copy(_b);
    e.vel.copy(_b).multiplyScalar(e.speed); e.pos.addScaledVector(e.vel, dt);
    // terrain following with look-ahead; route y is only a floor
    const ahead = Math.max(g.groundY(e.pos.x, e.pos.z), g.groundY(e.pos.x + _b.x * 500, e.pos.z + _b.z * 500), g.groundY(e.pos.x + _b.x * 1000, e.pos.z + _b.z * 1000));
    const wantY = Math.max(tgt.y, ahead + 130), dy = Math.max(-25 * dt, Math.min(45 * dt, wantY - e.pos.y)); e.pos.y += dy; e.vel.y = dy / Math.max(dt, 1e-3);
    e.quat.setFromEuler(_e2.set(-0.12 * Math.min(1, e.speed / 60), Math.atan2(-_b.x, -_b.z), 0, 'YXZ'));
  }

  updateWing(dt) {
    const e = this.e, g = this.game, p = g.player, w = g.weapons;
    this.flareCd -= dt; this.missileCd -= dt; this.pause -= dt;
    const inc = w.incoming(e);
    if (inc.length && this.flareCd <= 0) { w.dropFlares(e, 2); this.flareCd = 1.1; }
    const foe = this.target && this.target.alive ? this.target : (this.target = this.pickTarget());
    if (g.wingmanFree && foe && foe.pos.distanceTo(e.pos) < 9000 && p.alive) {
      this.set('ENGAGE');
      const lp = this.lead(foe), dist = foe.pos.distanceTo(e.pos);
      this.steerTo(dt, lp, Math.max(foe.speed + 40, 240), 1.0);
      const aim = ang(e.dir, _a.copy(lp).sub(e.pos).normalize());
      if (dist < 900 && aim < 4 * DEG && this.pause <= 0) { this.burst = 0.7; this.pause = 2.4; }
      if (dist < 6000 && dist > 1500 && aim < 20 * DEG && e.missilesLeft > 0 && this.missileCd <= 0) { w.fireMissile(e, foe, e.pos.clone().addScaledVector(e.dir, 8), e.dir, e.vel); this.missileCd = 14; }
      if (this.burst > 0) { this.burst -= dt; this.gunAcc = (this.gunAcc || 0) + dt; while (this.gunAcc >= 1 / 14) { this.gunAcc -= 1 / 14; w.fireCannon(e, e.pos.clone().addScaledVector(e.dir, 10), e.dir, e.vel, { spread: 0.018, damage: 4 }); } } else this.gunAcc = 0;
      return;
    }
    this.set('FORMATION'); this.target = null;
    const slot = p.pos.clone().addScaledVector(p.forward(_a), -70).addScaledVector(_b.set(1, 0, 0).applyQuaternion(p.quat), 130).add(new THREE.Vector3(0, 8, 0));
    const dist = slot.distanceTo(e.pos);
    const spd = clamp(p.speed + (dist - 40) * 0.25, 90, e.def.maxSpeed);
    this.steerTo(dt, dist > 400 ? slot : slot.clone().addScaledVector(p.forward(_a), 600), spd, dist > 400 ? 1.1 : 1.6);
    if (dist < 400) { e.dir.lerp(p.forward(_a), Math.min(1, dt * 1.2)).normalize(); }
  }

  updateHostile(dt) {
    const e = this.e, g = this.game, w = g.weapons, tr = this.tr, d = e.def;
    this.missileCd -= dt; this.flareCd -= dt; this.alert = Math.max(0, this.alert - dt);
    if (e.damageTaken > 0 && e.lastDamageBy) this.alert = Math.max(this.alert, 8);
    const p = g.player;
    const tgt = this.target && this.target.alive ? this.target : (this.target = this.pickTarget());
    const dist = tgt ? tgt.pos.distanceTo(e.pos) : 1e9;
    const toT = tgt ? _a.copy(tgt.pos).sub(e.pos).normalize().clone() : null;
    const ata = tgt ? ang(e.dir, toT) : 0;
    const aa = tgt ? ang(tgt.forward(_b), toT.clone().negate()) : 0;       // small = I'm behind the target
    const inc = w.incoming(e).filter((m) => m.pos.distanceTo(e.pos) < 5500);
    const energy = e.speed / d.maxSpeed;
    const frac = e.hp / e.maxHp, leave = !this.cfg.stand && (d.disengageHp !== undefined ? frac < d.disengageHp : frac < 0.35 * (1 - tr.risk));
    const detect = 14000 * tr.awareness * (tgt && ata > 100 * DEG ? 0.55 : 1);

    // global interrupts
    if (this.state !== 'DISENGAGE' && this.state !== 'EVADE' && inc.length) { this.evadeSeen += dt; if (this.evadeSeen > tr.reaction * 0.8) this.set('EVADE'); } else if (!inc.length) this.evadeSeen = 0;
    if (this.state !== 'DISENGAGE' && (leave || (d.role === 'recon' && tgt && (tgt.isPlayer && (dist < 3200 || p.hunted) )) || (d.role === 'recon' && frac < 0.7))) this.set('DISENGAGE');

    const spdCruise = this.cfg.cruise || d.cruise;
    switch (this.state) {
      case 'PATROL': {
        this.followRoute(dt, spdCruise, true);
        if (tgt && (dist < detect || this.alert > 0) && this.timer > 1) { this.set('DETECT'); }
        break;
      }
      case 'DETECT': {
        if (!tgt) { this.set('PATROL'); break; }
        this.steerTo(dt, tgt.pos, spdCruise * 1.1);
        if (this.timer > tr.reaction * (1.4 - tr.skill * 0.5)) this.set('IDENTIFY');
        break;
      }
      case 'IDENTIFY': {
        if (!tgt) { this.set('PATROL'); break; }
        const hold = tgt.pos.clone().addScaledVector(tgt.forward(_c), -1800).add(new THREE.Vector3(600, 150, 0));
        this.steerTo(dt, dist > 3000 ? tgt.pos : hold, Math.max(tgt.speed, spdCruise));
        if (d.role === 'recon') { if (this.timer > 20) this.set('PATROL'); break; }
        const held = this.cfg.engageWhenPlayerWithin && p.pos.distanceTo(e.pos) > this.cfg.engageWhenPlayerWithin && this.alert <= 0;
        if (!held && (dist < 3800 || this.timer > 9) && (tr.aggression > 0.25 || this.alert > 0)) this.set('INTERCEPT');
        break;
      }
      case 'INTERCEPT': {
        if (!tgt) { this.set('PATROL'); break; }
        this.steerTo(dt, this.lead(tgt), Math.max(tgt.speed + 70, spdCruise * 1.2));
        if (dist < 5200 && ata < 70 * DEG) this.set('ATTACK');
        if (this.group && this.leaderFar()) this.set('REGROUP');
        break;
      }
      case 'ATTACK': {
        if (!tgt) { this.set('PATROL'); break; }
        const lp = this.lead(tgt, 1000);
        this.steerTo(dt, lp, Math.max(tgt.speed + 40, spdCruise * 1.1), 1.0 + (tr.skill - 0.5) * 0.2);
        const aim = ang(e.dir, _a.copy(lp).sub(e.pos).normalize());
        this.pause -= dt;
        const canGun = d.weapons.cannon && dist < 950;
        if (canGun && aim < (2.6 + (1 - tr.skill) * 4.5) * DEG && this.pause <= 0) { this.burst = 0.5 + tr.aggression * 0.8; this.pause = 1.6 + (1 - tr.discipline) * 1.5 + rand(0, 1); }
        if (this.burst > 0) { this.burst -= dt; this.gunAcc = (this.gunAcc || 0) + dt; while (this.gunAcc >= 1 / 14) { this.gunAcc -= 1 / 14; if (dist < 1300) w.fireCannon(e, e.pos.clone().addScaledVector(e.dir, 10), e.dir, e.vel, { spread: 0.014 * (1.5 - tr.skill), damage: 5 }); } } else this.gunAcc = 0;
        const mOK = d.weapons.missiles > 0 && e.missilesLeft > 0 && (tgt.isPlayer || this.missileOnAsset) && dist > 1500 && dist < 6200 && ata < (tr.discipline > 0.7 ? 14 : 26) * DEG && (tr.discipline < 0.7 || aa < 70 * DEG || dist < 3600);
        if (mOK && this.missileCd <= 0 && this.timer > 1.2 / g.diff().ai.missileRate) { w.fireMissile(e, tgt, e.pos.clone().addScaledVector(e.dir, 8), e.dir, e.vel); this.missileCd = (16 - tr.skill * 6) / g.diff().ai.missileRate; }
        if (dist < 220 || ata > 105 * DEG) this.set('REPOSITION');
        if (tgt.isPlayer && aa > 150 * DEG && dist < 2200 && this.timer > 2) { this.set('EVADE'); }   // player on my six
        if (tgt.isPlayer && tr.discipline > 0.7 && energy < 0.5) this.set('REPOSITION');
        break;
      }
      case 'EVADE': {
        const threat = inc[0] ? inc[0].pos : (tgt ? tgt.pos : e.pos.clone().add(e.dir));
        _c.copy(threat).sub(e.pos).normalize();
        const perp = _b.crossVectors(_c, UPV).normalize().multiplyScalar(this.jinkDir);
        const brk = perp.clone().add(new THREE.Vector3(0, -0.45, 0)).addScaledVector(e.dir, 0.2).normalize();
        steer(e, dt, brk.multiplyScalar(1).normalize().add(e.dir.clone().multiplyScalar(0.01)).normalize(), d.maxSpeed, 1.15);
        if (inc.length && this.flareCd <= 0 && Math.random() < g.diff().ai.flareChance * (0.6 + tr.skill * 0.6)) { w.dropFlares(e, 2); this.flareCd = 0.9; }
        if (this.timer > 1.2 && Math.random() < dt * 0.6) this.jinkDir *= -1;
        if (!inc.length && this.timer > 3.5) this.set(d.role === 'elite' || tr.aggression > 0.4 ? 'REPOSITION' : 'PATROL');
        if (this.timer === 0) this.jinkDir = Math.random() < 0.5 ? -1 : 1;
        break;
      }
      case 'REPOSITION': {
        if (!tgt) { this.set('PATROL'); break; }
        if (this.timer < 0.05) { const side = Math.random() < 0.5 ? -1 : 1; this.reposPt.copy(tgt.pos).addScaledVector(tgt.forward(_c), -2600).add(new THREE.Vector3(side * 1400, rand(-100, 500), 0).applyQuaternion(tgt.quat)); }
        this.steerTo(dt, this.reposPt, d.maxSpeed, 0.9);
        this.jink -= dt; if (d.role === 'elite' && this.jink < 0) { this.jink = rand(1.5, 3); this.reposPt.add(new THREE.Vector3(rand(-500, 500), rand(-200, 300), rand(-500, 500))); }
        if ((energy > 0.72 && this.timer > 3) || this.timer > 9) this.set('INTERCEPT');
        break;
      }
      case 'REGROUP': {
        const l = this.leader; if (!l || !l.alive || !this.leaderFar()) { this.set('INTERCEPT'); break; }
        this.steerTo(dt, l.pos, d.maxSpeed * 0.9); break;
      }
      case 'DISENGAGE': {
        this.disengageT += dt;
        const away = this.egress ? this.egress.clone() : e.pos.clone().addScaledVector(tgt ? _c.copy(e.pos).sub(tgt.pos).normalize() : e.dir, 30000);
        away.y = Math.max(away.y, 2500);
        this.steerTo(dt, away, d.maxSpeed, 1.0);
        if (e.def.role === 'elite' && !this.permanentLeave && this.disengageT > 14 && energy > 0.8 && frac > 0.3) { this.disengageT = 0; this.set('REPOSITION'); break; }
        if (p.pos.distanceTo(e.pos) > 22000 && this.disengageT > 6) { e.despawned = true; e.alive = false; this.game.onAIGone?.(e); }
        break;
      }
    }
    // low-skill / scripted: recon drones flee when painted
    if (e.def.role === 'recon' && g.radarLockOn === e) p.hunted = true;
  }
  leaderFar() { return this.leader && this.leader.alive && this.leader.pos.distanceTo(this.e.pos) > 4500; }
}
