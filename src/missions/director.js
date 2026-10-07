
/**
 * Data-driven mission runtime: objectives, scripted events (radio, spawns, radar disruption, cinematics)
 * and failure conditions. Knows nothing about rendering; talks to Game through the hooks it is given.
 */
const PASSIVE = new Set(['manual', 'protect', 'protect_group', 'max_damage', 'max_missiles', 'avoid_friendly_fire', 'prevent_arrival', 'survive_entity', 'avoid_zone_fire', 'time_limit']);
const CONSTRAINT = new Set(['avoid_friendly_fire', 'max_damage', 'max_missiles', 'survive_entity', 'avoid_zone_fire', 'time_limit']);
const endBound = (o) => (o.type === 'protect' || o.type === 'protect_group') && o.params?.until === 'end';
const clamp1 = (v) => Math.max(-1, Math.min(1, v));

export class Director {
  constructor(mission, game) {
    this.m = mission; this.g = game; this.t = 0;
    this.objectives = [];
    for (const kind of ['primary', 'secondary', 'optional'])
      for (const o of mission.objectives?.[kind] || []) this.objectives.push({ ...o, kind, state: 'active', progress: 0, hit: new Set(), note: '' });
    this.events = (mission.events || []).map((e) => ({ ...e, fired: false, lastFired: -1e9, queue: [] }));
    this.flags = new Set(); this.pending = [];
    this.result = null; this.endScheduled = null; this.firedInZone = false; this.roeViolation = false;
    this.outsideT = 0; this.formationTime = 0; this.formationTotal = 0; this.speedHold = 0; this.hasEndAction = (mission.events || []).some((e) => e.do.some((a) => a.endMission));
    this.allPrimaryDoneAt = null; this.failReason = '';
  }
  obj(id) { return this.objectives.find((o) => o.id === id); }
  get primaries() { return this.objectives.filter((o) => o.kind === 'primary'); }
  currentObjective() { return this.primaries.find((o) => o.state === 'active' && !PASSIVE.has(o.type)) || this.primaries.find((o) => o.state === 'active'); }

  targetPos(id) { const e = this.g.byId.get(id); if (e) return e.pos; const w = this.waypoint(id); return w ? { x: w.pos[0], y: w.pos[1], z: w.pos[2] } : null; }
  /** World markers for the HUD: where to fly next, which ground targets to hit, who to protect. */
  markers() {
    const out = [], cur = this.currentObjective(), g = this.g; if (!cur) return out;
    const P = cur.params || {}, wp = (id) => { const w = this.waypoint(id); return w && { pos: { x: w.pos[0], y: w.pos[1], z: w.pos[2] }, label: w.label }; };
    const add = (pos, label, color) => out.push({ pos, label, color });
    if (cur.type === 'reach_area') { const id = (P.waypoints || []).find((w) => !cur.hit.has(w)), w = id && wp(id); if (w) add(w.pos, w.label, '#ffcf3d'); }
    else if (cur.type === 'hold_area' || cur.type === 'entity_at') { const w = wp(P.waypoint); if (w) add(w.pos, w.label, '#ffcf3d'); }
    else if (cur.type === 'recon_site') { const t = this.targetPos(P.target); if (t) add(t, cur.label, '#ffcf3d'); }
    else if (cur.type === 'destroy') for (const id of P.targets || []) { const e = g.byId.get(id); if (e && e.alive && e.isGround) add(e.pos, e.callsign, '#ff5348'); }
    for (const o of this.objectives) if (o.state === 'active' && (o.type === 'protect' || o.type === 'entity_at') && o.params.target) { const e = g.byId.get(o.params.target); if (e && e.alive && !e.landed) add(e.pos, e.callsign || e.name, '#4cc9ff'); }
    return out;
  }
  forceObjective(id, state) { const o = this.obj(id); if (o && o.state === 'active') { o.state = state; if (state === 'complete') this.g.onObjective?.(o); } }
  zone(id) { return (this.m.zones || []).find((z) => z.id === id); }
  waypoint(id) { return (this.m.waypoints || []).find((z) => z.id === id); }
  inside(p, z) { return Math.hypot(p.x - z.pos[0], (p.z - z.pos[2])) < z.radius; }

  update(dt) {
    const g = this.g; this.t += dt; const p = g.player;
    if (this.result) return;
    this.updateObjectives(dt);
    this.updateEvents();
    // scheduled actions
    for (let i = this.pending.length - 1; i >= 0; i--) { const a = this.pending[i]; if (this.t >= a.at) { this.pending.splice(i, 1); this.run(a.act); } }
    // boundary
    const bz = (this.m.zones || []).find((z) => z.type === 'boundary');
    if (bz && this.allPrimaryDoneAt === null) {
      if (!this.inside(p.pos, bz)) { this.outsideT += dt; if (this.outsideT > 25) this.fail('LEFT THE OPERATIONS AREA'); } else this.outsideT = Math.max(0, this.outsideT - dt * 2);
    }
    // time limit
    const lim = this.m.scoring?.timeLimit; if (lim && this.t > lim && !this.allPrimaryDone) this.fail('TIME EXPIRED');
    // outcomes
    const failed = this.primaries.find((o) => o.state === 'failed');
    if (failed) this.fail(failed.note || failed.label + ' FAILED');
    if (!p.alive && this.allPrimaryDoneAt === null) this.fail('AIRCRAFT DESTROYED');
    // constraint objectives (no friendly fire, protect-until-end, ...) only matter by failing; they never block completion
    const core = this.primaries.filter((o) => !CONSTRAINT.has(o.type) && !endBound(o)), bound = this.primaries.filter((o) => CONSTRAINT.has(o.type) || endBound(o));
    this.allPrimaryDone = this.primaries.length > 0 && (core.length ? core.every((o) => o.state === 'complete') && bound.every((o) => o.state !== 'failed') : this.primaries.every((o) => o.state === 'complete'));
    if (this.allPrimaryDone) for (const o of bound) if (o.state === 'active') o.state = 'complete';
    if (this.allPrimaryDone && this.allPrimaryDoneAt === null) {
      this.allPrimaryDoneAt = this.t;
      if (!this.hasEndAction) this.pending.push({ at: this.t + 3.5, act: { endMission: { result: 'complete' } } });
    }
    this.firedInZone = false; this.roeViolation = false;
  }

  updateObjectives(dt) {
    const g = this.g, p = g.player;
    for (const o of this.objectives) {
      if (o.state !== 'active') continue;
      const P = o.params || {}; let s = null;
      switch (o.type) {
        case 'airborne': if (p.airborne && g.flight.agl > P.altitude) s = 'complete'; break;
        case 'reach_area': {
          const wps = P.waypoints || []; let idx = wps.findIndex((w) => !o.hit.has(w));
          if (P.sequence) { const w = this.waypoint(wps[idx]); if (w && Math.hypot(p.pos.x - w.pos[0], p.pos.z - w.pos[2]) < w.radius && Math.abs(p.pos.y - w.pos[1]) < Math.max(w.radius, 1500)) o.hit.add(wps[idx]); }
          else for (const w of wps) { const z = this.waypoint(w); if (z && Math.hypot(p.pos.x - z.pos[0], p.pos.z - z.pos[2]) < z.radius) o.hit.add(w); }
          o.progress = o.hit.size / wps.length; if (o.hit.size >= wps.length) s = 'complete'; break;
        }
        case 'identify': { const es = (P.targets || []).map((id) => g.byId.get(id)).filter(Boolean); if (es.length && es.every((e) => e.identified)) s = 'complete'; o.progress = es.filter((e) => e.identified).length / Math.max(1, (P.targets || []).length); break; }
        case 'protect': { const e = g.byId.get(P.target); if (e && !e.alive) { s = 'failed'; o.note = e.name + ' WAS LOST'; g.say?.('gen_asset_lost'); } else if (P.until && P.until !== 'end' && this.obj(P.until)?.state === 'complete') s = 'complete'; break; }
        case 'destroy': {
          const es = (P.targets || []).map((id) => g.byId.get(id)).filter(Boolean);
          const escaped = es.find((e) => e.despawned);
          if (escaped) { s = 'failed'; o.note = escaped.callsign + ' ESCAPED'; break; }
          o.progress = es.filter((e) => !e.alive).length / Math.max(1, (P.targets || []).length);
          if (es.length === (P.targets || []).length && es.every((e) => !e.alive)) s = 'complete'; break;
        }
        case 'recon_site': {
          const tp = this.targetPos(P.target); if (!tp) break;
          const dx = tp.x - p.pos.x, dy = tp.y - p.pos.y, dz = tp.z - p.pos.z, dist = Math.hypot(dx, dy, dz), fw = g.flight.fwd;
          const ang = Math.acos(clamp1((dx * fw.x + dy * fw.y + dz * fw.z) / Math.max(dist, 1)));
          const ok = dist < (P.range || 2500) && ang < (P.cone || 55) * Math.PI / 180 && g.flight.agl < (P.maxAgl || 2500) && p.speed > 70 && g.state === 'flight';
          o.live = ok; o.hold = ok ? (o.hold || 0) + dt : Math.max(0, (o.hold || 0) - dt * 0.6); o.progress = Math.min(1, o.hold / P.seconds);
          if (o.hold >= P.seconds) s = 'complete'; break;
        }
        case 'hold_area': {
          const z = this.waypoint(P.waypoint); if (!z) break;
          const inside = Math.hypot(p.pos.x - z.pos[0], p.pos.z - z.pos[2]) < z.radius && (!P.requireAlive || g.byId.get(P.requireAlive)?.alive);
          o.live = inside; o.hold = inside ? (o.hold || 0) + dt : o.hold || 0; o.progress = Math.min(1, o.hold / P.seconds); if (o.hold >= P.seconds) s = 'complete'; break;
        }
        case 'entity_at': {
          const z = this.waypoint(P.waypoint); if (!z) break;
          if (P.targets) {
            const es = P.targets.map((id) => g.byId.get(id)).filter((e) => e && e.alive), need = P.min || 1;
            const n = es.filter((e) => Math.hypot(e.pos.x - z.pos[0], e.pos.z - z.pos[2]) < z.radius).length; o.progress = Math.min(1, n / need); if (n >= need) s = 'complete'; break;
          }
          const e = g.byId.get(P.target); if (!e) break;
          if (!e.alive) { s = 'failed'; o.note = e.name + ' WAS LOST'; break; }
          if (Math.hypot(e.pos.x - z.pos[0], e.pos.z - z.pos[2]) < z.radius) s = 'complete'; break;
        }
        case 'prevent_arrival': {
          const e = g.byId.get(P.target), z = this.waypoint(P.waypoint); if (!e || !z) break;
          if (e.alive && Math.hypot(e.pos.x - z.pos[0], e.pos.z - z.pos[2]) < z.radius) { s = 'failed'; o.note = P.message || 'TARGET REACHED THE LINE'; }
          else if (!e.alive || e.despawned) s = 'complete'; break;
        }
        case 'protect_group': {
          const es = (P.targets || []).map((id) => g.byId.get(id)).filter(Boolean), alive = es.filter((e) => e.alive).length;
          o.progress = alive / Math.max(1, (P.targets || []).length);
          if (alive < (P.min || 1)) { s = 'failed'; o.note = 'ESCORT LOST'; } else if (P.until && P.until !== 'end' && this.obj(P.until)?.state === 'complete') s = 'complete'; break;
        }
        case 'avoid_friendly_fire': if (g.friendlyFire) { s = 'failed'; o.note = 'FRIENDLY FIRE — ROE VIOLATION'; } break;
        case 'survive_entity': { const e = g.byId.get(P.target); if (e && !e.alive) s = 'failed'; break; }
        case 'avoid_zone_fire': if (this.firedInZone && this.zoneOf(P.zone)) s = 'failed'; break;
        case 'time_limit': if (this.t > P.seconds) s = 'failed'; break;
        case 'accuracy': break;
        case 'max_damage': if (p.damageTaken > (P.max || 0) + 0.5) s = 'failed'; break;
        case 'max_missiles': if (g.weapons.stats.launched > P.max) { s = 'failed'; o.note = 'MISSILE LIMIT EXCEEDED'; } break;
        case 'formation': {
          const w = g.byId.get('wingman'); const reach = this.primaries.find((q) => q.type === 'reach_area');
          if (w && w.alive && p.airborne && (!reach || reach.state !== 'complete')) { this.formationTotal += dt; if (w.pos.distanceTo(p.pos) < P.range) this.formationTime += dt; }
          o.progress = this.formationTotal > 5 ? this.formationTime / this.formationTotal : 1; break;
        }
        case 'reach_speed': { if (p.speed * 3.6 >= P.kmh) { this.speedHold += dt; } else this.speedHold = Math.max(0, this.speedHold - dt); o.progress = Math.min(1, this.speedHold / P.hold); if (this.speedHold >= P.hold) s = 'complete'; break; }
        case 'survive': { o.progress = Math.min(1, this.t / P.seconds); if (this.t >= P.seconds) s = 'complete'; break; }
      }
      if (s) { o.state = s; if (s === 'complete') this.g.onObjective?.(o); }
    }
  }
  civilianAt(pos) { return (this.m.zones || []).some((z) => z.type === 'civilian' && this.inside(pos, z)); }
  zoneOf(id) { return this.g.lastFirePos && this.zone(id) && this.inside(this.g.lastFirePos, this.zone(id)); }

  /** Finalises the end-of-mission states of passive objectives. */
  finalize(result) {
    const g = this.g;
    for (const o of this.objectives) {
      if (o.state !== 'active') continue;
      const P = o.params || {};
      if (result !== 'complete' && o.kind === 'primary') { o.state = 'failed'; continue; }
      switch (o.type) {
        case 'survive_entity': o.state = g.byId.get(P.target)?.alive ? 'complete' : 'failed'; break;
        case 'avoid_zone_fire': case 'max_damage': case 'max_missiles': case 'time_limit': case 'protect': case 'protect_group': case 'avoid_friendly_fire': case 'prevent_arrival': o.state = 'complete'; break;
        case 'accuracy': o.state = g.accuracy() >= P.min ? 'complete' : 'failed'; break;
        case 'formation': o.state = o.progress >= P.ratio ? 'complete' : 'failed'; break;
        default: o.state = result === 'complete' && o.kind === 'primary' ? 'complete' : 'failed';
      }
    }
  }

  // ---------- events
  cond(w) {
    const g = this.g, e = (id) => g.byId.get(id);
    switch (w.type) {
      case 'time': return this.t >= w.t;
      case 'objective': return this.obj(w.id)?.state === (w.state || 'complete');
      case 'range': { const a = e(w.a), b = e(w.b); return a && b && a.alive && b.alive && a.pos.distanceTo(b.pos) < w.lt; }
      case 'identified': return !!e(w.id)?.identified;
      case 'destroyed': { const x = e(w.id); return !!x && !x.alive && !x.despawned; }
      case 'state': return e(w.id)?.state === w.state;
      case 'damaged': { const x = e(w.id); return !!x && x.damageTaken > 0 && x.alive; }
      case 'incoming_missile': return g.weapons.incoming(g.player).length > 0;
      case 'outside': { const z = this.zone(w.zone); return z && !this.inside(g.player.pos, z); }
      case 'fired_in_zone': return this.firedInZone && this.zoneOf(w.zone);
      case 'roe_violation': return this.roeViolation;
      case 'flag': return this.flags.has(w.name);
      case 'all_destroyed': return (w.ids || []).length > 0 && w.ids.every((id) => { const x = e(id); return !!x && !x.alive; });
      case 'hp_below': { const x = e(w.id); return !!x && x.alive && x.hp / x.maxHp < w.frac; }
      case 'in_area': { const z = this.waypoint(w.waypoint); return !!z && this.inside(g.player.pos, z); }
      case 'entity_in_area': { const x = e(w.id), z = this.waypoint(w.waypoint); return !!x && !!z && x.alive && this.inside(x.pos, z); }
      default: return false;
    }
  }
  updateEvents() {
    for (const ev of this.events) {
      if (ev.once !== false && ev.cooldown === undefined && ev.fired) continue;
      if (ev.cooldown !== undefined && this.t - ev.lastFired < ev.cooldown) continue;
      if (!this.cond(ev.when)) continue;
      ev.fired = true; ev.lastFired = this.t;
      for (const a of ev.do) this.pending.push({ at: this.t + (a.delay || 0), act: a });
    }
  }
  run(a) {
    const g = this.g;
    if (a.say) g.say(a.say);
    else if (a.music) g.setMusic(a.music);
    else if (a.disrupt) g.radar.disrupt(a.disrupt.duration, a.disrupt.severity);
    else if (a.spawn) g.spawnGroup(a.spawn);
    else if (a.cinematic) g.playCinematic(a.cinematic, a.args || {});
    else if (a.evidence) g.showEvidence(a.evidence);
    else if (a.flag) this.flags.add(a.flag);
    else if (a.travel) g.travel(a.travel);
    else if (a.callout) g.callout(a.callout);
    else if (a.radar) g.setRadar(a.radar);
    else if (a.order) g.order(a.order.id, a.order.order, a.order);
    else if (a.reveal) for (const id of a.reveal) { const x = g.byId.get(id); if (x) g.identify(x); }
    else if (a.retag) { const x = g.byId.get(a.retag.id); if (x) x.iffShown = a.retag.iff; }
    else if (a.complete) this.forceObjective(a.complete, 'complete');
    else if (a.fail) this.forceObjective(a.fail, 'failed');
    else if (a.show) { const o = this.obj(a.show); if (o) o.hidden = false; }
    else if (a.kill) { const x = g.byId.get(a.kill); if (x && x.alive) g.damage(x, 99999, g.byId.get(a.by) || null, 'script'); }
    else if (a.card) g.titleCard(a.card);
    else if (a.repair) g.repair(a.repair);
    else if (a.env) g.setEnv(a.env);
    else if (a.endMission) this.end(a.endMission.result || 'complete');
  }

  end(result) {
    if (this.result) return; this.finalize(result); this.result = result; this.g.onMissionEnd?.(result);
  }
  fail(reason) { if (this.result) return; this.failReason = reason; this.end('failed'); }

  summary() { return this.objectives.map((o) => ({ id: o.id, kind: o.kind, label: o.label, state: o.state })); }
}
