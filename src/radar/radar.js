import * as THREE from 'three';
import { clamp, rand, DEG, smoothstep } from '../util/math.js';

const _l = new THREE.Vector3(), _q = new THREE.Quaternion();
/**
 * Radar abstraction: range, detection cone, noise, disappearing tracks, disruption, lock.
 * Classification is intentionally unreliable until the player identifies a contact.
 */
export class Radar {
  constructor() {
    this.contacts = []; this.byId = new Map(); this.selected = null;
    this.lockProgress = 0; this.locked = false; this.lostTimer = 0; this.idProgress = 0;
    this.disruptT = 0; this.disruptSeverity = 0; this.disabled = false; this.baseRange = 42000;
    this.flickerClock = 0; this.flickerClass = 'unknown';
    this.coneHalf = 65 * DEG; this.lockCone = 22 * DEG; this.lockRange = 15000; this.severity = 0; this.range = 42000;
  }
  disrupt(duration, severity = 0.6) { this.disruptT = duration; this.disruptSeverity = severity; }
  reset() { this.contacts = []; this.byId.clear(); this.selected = null; this.lockProgress = 0; this.locked = false; this.disruptT = 0; this.idProgress = 0; }

  update(dt, player, entities, diff, groundY, opts = {}) {
    if (this.disruptT > 0) this.disruptT -= dt;
    this.severity = this.disruptT > 0 ? clamp(this.disruptSeverity * diff.radar.disruption, 0, 0.95) : 0;
    this.range = this.baseRange * diff.radar.range;
    this.flickerClock -= dt; if (this.flickerClock <= 0) { this.flickerClock = rand(0.25, 0.7); this.flickerClass = ['hostile', 'unknown', 'friendly', 'unknown', 'hostile'][Math.floor(Math.random() * 5)]; }
    const seen = new Set(); _q.copy(player.quat).invert();
    if (!this.disabled) for (const e of entities) {
      if (e === player || !e.alive || e.despawned) continue;
      _l.copy(e.pos).sub(player.pos); const range = _l.length(); const world = _l.clone();
      _l.applyQuaternion(_q);
      const off = Math.acos(clamp(-_l.z / Math.max(range, 1), -1, 1));
      const inCone = off < this.coneHalf;
      let lim = this.range * (inCone ? 1 : 0.38);
      if (e.pos.y - groundY(e.pos.x, e.pos.z) < 60) lim *= 0.65;
      let c = this.byId.get(e.id);
      if (!c) { c = { entity: e, off: 0, range, az: 0, el: 0, cls: 'unknown', quality: 1, stale: false, lastSeen: 0, hidden: 0, jx: 0, jy: 0 }; this.byId.set(e.id, c); }
      c.hidden -= dt;
      if (this.severity > 0 && Math.random() < this.severity * dt * 1.3) c.hidden = rand(0.2, 0.8);
      let vis = range < lim && c.hidden <= 0;
      if (!vis && e === this.selected && range < lim && this.lockProgress > 0.3) vis = true; // lock memory through jamming dropouts
      c.range = range; c.off = off; c.inCone = inCone; c.az = Math.atan2(_l.x, -_l.z); c.el = Math.atan2(_l.y, Math.hypot(_l.x, _l.z));
      c.closure = -world.normalize().dot(e.vel.clone().sub(player.vel));
      if (vis) { c.lastSeen = 0; c.stale = false; c.quality = clamp(1 - this.severity * 0.7 - (range / lim) * 0.35, 0.15, 1); } else { c.lastSeen += dt; c.stale = true; c.quality = Math.max(0, 0.5 - c.lastSeen * 0.2); }
      const noise = diff.radar.noise + this.severity * 0.1; c.jx = (Math.random() - 0.5) * noise * 0.1; c.jy = (Math.random() - 0.5) * noise * 0.1;
      c.visible = vis;
      c.cls = e.identified ? (e.side === 'hostile' ? 'hostile' : 'friendly') : (this.severity > 0.12 ? this.flickerClass : 'unknown');
      if (vis || c.lastSeen < 2.8) seen.add(e.id);
    }
    this.contacts = [...seen].map((k) => this.byId.get(k)).filter((c) => c.entity.alive).sort((a, b) => a.range - b.range);
    for (const k of [...this.byId.keys()]) if (!seen.has(k)) this.byId.delete(k);

    // selection + lock
    const sel = this.selected && this.byId.get(this.selected.id);
    if (!sel || !this.selected.alive || (!sel.visible && sel.lastSeen > 2.5)) { this.selected = null; this.lockProgress = 0; this.locked = false; }
    if (this.selected) {
      const c = sel, cone = this.lockCone * (opts.targetAssist ? 1.35 : 1);
      const ok = c.visible && c.off < cone && c.range < this.lockRange && this.severity < 0.9;
      const need = 1.1 * diff.missile.playerLockTime * (0.55 + 0.45 * smoothstep(1500, this.lockRange, c.range)) * (1 + this.severity * 1.2);
      if (ok) { this.lockProgress = Math.min(1, this.lockProgress + dt / need); this.lostTimer = 0; }
      else { this.lostTimer += dt; this.lockProgress = Math.max(0, this.lockProgress - dt / 0.6); if (this.lostTimer > 0.7) this.locked = false; }
      if (this.lockProgress >= 1) this.locked = true;
      if (this.lockProgress < 0.3) this.locked = false;
    } else { this.locked = false; this.lockProgress = 0; }
  }

  cycle() {
    const vis = this.contacts.filter((c) => c.visible), foes = vis.filter((k) => !(k.entity.identified && k.entity.side !== 'hostile'));
    const list = (foes.length ? foes : vis).sort((a, b) => a.off - b.off);
    if (!list.length) { this.selected = null; return null; }
    const i = list.findIndex((c) => c.entity === this.selected);
    this.selected = list[(i + 1) % list.length].entity; this.lockProgress = 0; this.locked = false; this.idProgress = 0;
    return this.selected;
  }
  selectedContact() { return this.selected ? this.byId.get(this.selected.id) : null; }
}
