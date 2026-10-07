import * as THREE from 'three';
import { rand } from '../util/math.js';

const ZERO = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3(), _o = new THREE.Vector3(), _e = new THREE.Euler();

/** Ground-based entities: SAM batteries that track and fire, convoy trucks that follow a route, and static installations. */
export class GroundUnit {
  constructor(entity, game, cfg = {}) {
    this.e = entity; this.game = game; this.cfg = cfg; this.kind = entity.def.kind;
    this.route = (cfg.route || []).map((p) => new THREE.Vector3(p[0], 0, p[2])); this.wp = 0;
    this.speed = cfg.speed || entity.def.speed || 20; this.cd = rand(4, 8); this.lock = 0; this.done = false; this.phase = rand(0, 6);
    this.active = cfg.active !== false; this.range = entity.def.range || 9000;
  }

  update(dt) {
    const e = this.e, g = this.game;
    e.model.setControls?.({}, g.time + this.phase);
    if (this.kind === 'truck') this.drive(dt);
    else if (this.kind === 'sam') this.fire(dt);
    e.pos.y = g.groundY(e.pos.x, e.pos.z) + (this.kind === 'truck' ? 0.3 : 0);
  }

  drive(dt) {
    const e = this.e; if (this.done || !this.route.length) return;
    const tgt = this.route[this.wp]; _d.copy(tgt).sub(e.pos); _d.y = 0; const dist = _d.length();
    if (dist < 40) { if (this.wp < this.route.length - 1) this.wp++; else { this.done = true; e.vel.set(0, 0, 0); } return; }
    _d.divideScalar(dist); e.pos.addScaledVector(_d, this.speed * dt); e.vel.copy(_d).multiplyScalar(this.speed);
    e.quat.setFromEuler(_e.set(0, Math.atan2(-_d.x, -_d.z), 0));
  }

  /** SAM: needs a few seconds of radar lock on the nearest valid target before launching; flares and manoeuvres defeat the missile. */
  fire(dt) {
    const e = this.e, g = this.game, p = g.player;
    if (!this.active || !e.alive) return;
    this.cd -= dt;
    let best = null, bd = this.range;
    const cands = [p, ...g.entities.filter((x) => x !== p && x.alive && x.side === 'friendly' && x.asset && !x.isGround && !x.landed)];
    for (const c of cands) { if (!c.alive) continue; const d = c.pos.distanceTo(e.pos); if (d < bd && c.pos.y - g.groundY(c.pos.x, c.pos.z) > 40) { bd = d; best = c; } }
    if (!best) { this.lock = Math.max(0, this.lock - dt); return; }
    this.lock = Math.min(1, this.lock + dt / 2.4);
    if (best === p) g.samLock = Math.max(g.samLock, this.lock);
    const rate = g.diff().ai.missileRate;
    if (this.lock >= 1 && this.cd <= 0 && e.missilesLeft > 0) {
      _o.copy(e.pos); _o.y += 9; _d.copy(best.pos).addScaledVector(best.vel, bd / 450).sub(_o).normalize().lerp(UP, 0.45).normalize();
      g.weapons.fireMissile(e, best, _o.clone(), _d.clone(), ZERO, { maxG: 24, seeker: 50 });
      this.cd = (this.cfg.reload || e.def.reload || 13) / rate; this.lock = 0.5;
      if (best === p) g.hud.toast('SAM LAUNCH — FLARES AND BREAK', 'bad');
    }
  }
}
