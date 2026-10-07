import * as THREE from 'three';
import enemiesData from '../data/enemies.json';
import aircraftData from '../data/aircraft.json';
import difficultyData from '../data/difficulty.json';
import { World } from './world/world.js';
import { GroundUnit } from './ai/ground.js';
import { noise2 } from './util/noise.js';
import { Particles } from './weapons/particles.js';
import { Weapons } from './weapons/weapons.js';
import { buildFighter, buildModel } from './aircraft/model.js';
import { Entity } from './aircraft/entity.js';
import { FlightModel } from './physics/flight.js';
import { Radar } from './radar/radar.js';
import { Pilot } from './ai/pilot.js';
import { Director } from './missions/director.js';
import { CameraRig, CAMERA_IDS } from './camera/cameras.js';
import { Recorder } from './replay/replay.js';
import { clamp, rand, DEG, wrapPi } from './util/math.js';
import { Settings } from './settings/settings.js';

const ENEMY = enemiesData.types;
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _eu = new THREE.Euler();
const FWD = new THREE.Vector3(0, 0, -1);
export const aircraftById = (id) => aircraftData.aircraft.find((a) => a.id === id) || aircraftData.aircraft[0];

/**
 * One mission session. Builds the scene from mission JSON, simulates it and reports the outcome to the app.
 * No mission-specific logic lives here - everything comes from the definition via Director.
 */
export class Game {
  constructor(app, mission, opts = {}) {
    this.app = app; this.mission = mission; this.opts = opts; const { audio, hud, comms, input } = app;
    this.audio = audio; this.hud = hud; this.comms = comms; this.input = input;
    this.scene = new THREE.Scene(); this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 1.5, 140000);
    this.settings = Settings.s; this.diffName = opts.difficulty || this.settings.difficulty; this.diffData = difficultyData.levels[this.diffName] || difficultyData.levels.PILOT;
    this.time = 0; this.missionTime = 0; this.state = 'flight'; this.paused = false; this.ended = false; this.endTimer = 0; this.endResult = null;
    this.entities = []; this.byId = new Map(); this.wrecks = []; this.pilots = []; this.cine = null; this.cineT = 0; this.pullUp = false; this.boundary = 0;
    this.lastFirePos = null; this.cannonAcc = 0; this.flareCd = 0; this.musicBase = 'IDLE'; this.launchCamT = 0; this.prevCam = null; this.idProgress = 0; this.fireHeld = 0;
    this.units = []; this.burners = []; this.samLock = 0; this.friendlyFire = false; this.transition = null; this.turbulence = mission.env?.turbulence || 0;
    this.wingmanFree = false; this.hudHidden = false; this.radarLockOn = null; this.missileHud = 'MOUNTED'; this.launchedUntil = 0; this.rumbleT = 0; this.crashed = false;

    this.particles = new Particles(this.scene);
    this.world = new World(this.scene);
    const sp = mission.spawn, centre = mission.base ? [mission.base.pos[0], 0, mission.base.pos[2] - 1500] : sp.pos;
    this.world.build(mission, centre);
    this.weapons = new Weapons(this.scene, this.particles, {
      audio, entities: () => this.entities.filter((e) => e.alive), groundY: (x, z) => this.world.groundY(x, z), diff: () => this.diffData,
      listener: () => this.camera.position, damage: (e, a, o, k) => this.damage(e, a, o, k), explosion: (p, s, o) => this.onExplosion(p, s, o),
      onLaunch: (m) => this.rec?.event('launch', m.pos, m.dir)
    });
    this.radar = new Radar(); this.radar.disabled = mission.flags?.radar === 'none';
    this.camRig = new CameraRig(this.camera); this.camRig.settings = { shake: this.settings.cameraShake, reducedMotion: this.settings.reducedMotion };
    this.createPlayer(opts);
    if (mission.wingman?.enabled && !mission.noWingman) this.createWingman();
    this.director = new Director(mission, this);
    for (const g of mission.groups || []) if (g.spawn !== 'event') this.spawnGroup(g.id);
    this.rec = new Recorder(this);
    this.accuracyCache = 0;

    // cameras: equipped default, unlock-aware
    this.camIndex = 0; this.setCameraMode(CAMERA_IDS[0], true);
    if (mission.spawn.onRunway && mission.cinematics?.intro) { this.playCinematic('intro'); this.state = 'intro'; }
    else if (mission.spawn.onRunway) this.state = 'takeoff';
    this.hud.setTheme(opts.hudColor || '#5dffa8'); this.hud.show(true);
    this.audio.setAmbience('flight', 0.3);
    this.camRig.snap();
    if (mission.number > 0 && !mission.cinematics?.intro) this.hud.titleCard(`MISSION ${String(mission.number).padStart(2, '0')} — ${mission.title}`, `${mission.region} · ${mission.clock || ''} · ${mission.weatherLabel || ''}`);
  }

  diff() { return this.diffData; }
  groundY(x, z) { return this.world.groundY(x, z); }

  // ------------------------------------------------------------ construction
  createPlayer(opts) {
    const ac = aircraftById(opts.aircraft), st = ac.stats, ld = opts.loadout || { missilesDelta: -1, flaresDelta: 10, ammoMult: 1 };
    this.ac = ac; this.flight = new FlightModel(st);
    const sp = this.mission.spawn, onRunway = !!sp.onRunway;
    const pos = new THREE.Vector3(sp.pos[0], onRunway ? this.world.baseAlt + 2.2 : sp.pos[1], sp.pos[2]);
    this.flight.reset(pos, sp.heading || 0, sp.speed || 0, onRunway);
    const p = new Entity({ id: 'player', name: 'FALCON ONE', callsign: 'FALCON ONE', side: 'friendly', type: 'player', role: 'player', pos: this.flight.pos, quat: this.flight.quat, vel: this.flight.vel, hp: st.hp, radius: 9, flares: Math.max(0, ac.weapons.flares + ld.flaresDelta), missiles: Math.max(1, ac.weapons.missiles + ld.missilesDelta), cannon: true, identified: true });
    p.isPlayer = true; p.airborne = false; p.hunted = false; this.player = p; this.maxHp = st.hp;
    this.ammo = Math.round(ac.weapons.cannonRounds * ld.ammoMult); this.startMissiles = p.missilesLeft;
    const paint = opts.paint || { body: '#8f8a7a', accent: '#2f6b3a', trim: '#d9d4c3' };
    this.model = buildFighter(paint); this.scene.add(this.model.group); this.model.setMissilesMounted(p.missilesLeft);
    this.entities.push(p); this.byId.set('player', p);
  }
  createWingman() {
    const def = ENEMY.wingman, sp = this.mission.spawn, hd = (sp.heading || 0) * DEG, ground = !!sp.onRunway;
    const off = new THREE.Vector3(ground ? 42 : 120, ground ? 0 : 6, ground ? 70 : 40).applyAxisAngle(new THREE.Vector3(0, 1, 0), -hd);
    const e = this.makeEntity({ id: 'wingman', name: this.mission.wingman.callsign, callsign: this.mission.wingman.callsign, side: 'friendly', type: 'wingman', pos: this.player.pos.clone().add(off), heading: sp.heading || 0, speed: ground ? 0 : this.flight.speed, identified: true }, def);
    if (ground) { e.onGround = true; e.pos.y = this.world.baseAlt + 2.2; }
    this.wingman = e;
  }
  makeEntity(g, def) {
    const e = new Entity({ id: g.id, name: g.name, callsign: g.callsign, side: g.side, type: g.type, role: def.role, def, hp: def.hp, radius: def.radius, flares: def.weapons.flares, missiles: def.weapons.missiles, cannon: def.weapons.cannon, identified: !!g.identified, iffShown: g.iffShown });
    e.isGround = !!def.ground; e.asset = !!(def.asset || def.role === 'asset'); e.explosive = !!def.explosive; e.landed = false;
    e.pos.set(...(Array.isArray(g.pos) ? g.pos : [g.pos.x, g.pos.y, g.pos.z]));
    if (g.hpFrac) e.hp = e.maxHp * g.hpFrac;
    if (e.isGround) e.pos.y = this.world.groundY(e.pos.x, e.pos.z);
    e.speed = e.isGround ? 0 : (g.speed || def.cruise);
    e.quat.setFromEuler(new THREE.Euler(0, -(g.heading || 0) * DEG, 0)); e.dir = FWD.clone().applyQuaternion(e.quat); e.vel.copy(e.dir).multiplyScalar(e.speed);
    const kind = def.role === 'wingman' ? 'wingman' : def.model;
    e.model = buildModel(kind, this.opts.paint); this.scene.add(e.model.root); e.model.root.position.copy(e.pos); e.model.root.quaternion.copy(e.quat);
    if (e.isGround) { e.unit = new GroundUnit(e, this, { route: g.route, speed: g.speed, active: g.active, reload: g.reload }); this.units.push(e.unit); }
    else { e.pilot = new Pilot(e, this, { route: g.route, egress: g.egress, targetPriority: g.targetPriority, engageWhenPlayerWithin: g.engageWhenPlayerWithin, cruise: g.speed, hover: g.hover, hold: g.hold, reach: g.reach, throttle: g.throttle, loop: g.loop, stand: g.stand, missileOnAsset: g.missileOnAsset, permanentLeave: g.reengage ? false : !this.mission.challenge }); this.pilots.push(e.pilot); }
    this.entities.push(e); this.byId.set(e.id, e); return e;
  }
  spawnGroup(id) {
    if (Array.isArray(id)) return id.map((x) => this.spawnGroup(x));
    let g = (this.mission.groups || []).find((x) => x.id === id); if (!g || this.byId.has(id)) return;
    const def = ENEMY[g.type]; if (!def) { console.warn('unknown enemy type', g.type); return; }
    if (g.near) { const o = new THREE.Vector3(...g.near).applyQuaternion(this.player.quat).add(this.player.pos); g = { ...g, pos: [o.x, o.y, o.z], heading: this.flight.heading + (g.turn || 180) }; }
    const e = this.makeEntity(g, def);
    if (g.side === 'hostile' && g.spawn === 'event' && e.pilot) e.pilot.alert = 20;
    return e;
  }
  /** Takes an entity out of the simulation and scene (despawned, landed or phase change) without destroying it. */
  removeEntity(e) {
    if (e.model) this.scene.remove(e.model.root);
    for (const [list, item] of [[this.entities, e], [this.pilots, e.pilot], [this.units, e.unit]]) { const i = list.indexOf(item); if (i >= 0) list.splice(i, 1); }
  }
  order(id, order, args = {}) {
    const e = this.byId.get(id); if (!e) return;
    if (order === 'go') { if (e.pilot) e.pilot.go = true; if (e.unit) e.unit.active = true; }
    else if (order === 'engage' && e.pilot) { e.pilot.alert = 40; e.pilot.set('INTERCEPT'); }
    else if (order === 'flee' && e.pilot) e.pilot.set('DISENGAGE');
    else if (order === 'land' || order === 'depart') { e.landed = true; this.removeEntity(e); }
    else if (order === 'hp') e.hp = e.maxHp * (args.frac ?? 1);
    else if (order === 'activate' && e.unit) e.unit.active = true;
  }
  setRadar(spec) {
    if (spec.mode === 'off') this.radar.disabled = true; else if (spec.mode === 'on') { this.radar.disabled = false; this.radar.disruptT = 0; }
    if (spec.severity !== undefined) this.radar.disrupt(spec.duration ?? 9999, spec.severity);
  }
  setEnv(env) {
    this.world.sky.set({ time: env.time || this.world.sky.time, weather: env.weather || this.world.sky.weather, fogTint: this.world.biome.fogTint });
    if (env.turbulence !== undefined) this.turbulence = env.turbulence;
  }
  repair(frac) { this.player.hp = Math.min(this.player.maxHp, this.player.hp + this.player.maxHp * frac); this.hud.toast('AIRFRAME REPAIRED', 'ok'); }
  titleCard(card) { this.hud.titleCard(card.text, card.sub || ''); }
  /** Radio call generated from live positions (used when radar cannot paint the picture). */
  callout(spec) {
    const p = this.player; let e = spec.id ? this.byId.get(spec.id) : null;
    if (spec.only && (!e || !e.alive)) return;
    if (!e || !e.alive) {
      e = null; let best = 1e9; const side = spec.nearest || 'hostile';
      for (const x of this.entities) if (x.alive && !x.isPlayer && x.side === side && !x.isGround && !x.landed) { const d = x.pos.distanceTo(p.pos); if (d < best) { best = d; e = x; } }
    }
    if (!e) return;
    const d = e.pos.clone().sub(p.pos), brg = String(Math.round((Math.atan2(d.x, -d.z) * 180 / Math.PI + 360) % 360)).padStart(3, '0'), km = (d.length() / 1000).toFixed(1);
    const lvl = d.y > 600 ? 0 : d.y < -600 ? 1 : 2;
    const L = { bandit: ['Bandit', 'Bandit', 'عدو'], target: ['Target', 'Cible', 'هدف'], traffic: ['Traffic', 'Trafic', 'حركة جوية'] }[spec.label || 'bandit'];
    const H = [['high', 'haut', 'أعلى'], ['low', 'bas', 'أسفل'], ['level', 'même altitude', 'نفس الارتفاع']][lvl];
    this.comms.sayRaw(spec.speaker || 'NADIA', { en: `${L[0]}, bearing ${brg}, ${km} kilometres, ${H[0]}.`, fr: `${L[1]}, cap ${brg}, ${km} kilomètres, ${H[1]}.`, ar: `${L[2]}، الاتجاه ${brg}، ${km} كيلومتر، ${H[2]}.` });
  }

  // ------------------------------------------------------------ phase change (multi-region missions)
  travel(spec) { if (this.transition || this.ended || this.state === 'dead') return; this.transition = { t: 0, spec, applied: false }; this.hud.fade(true); }
  updateTransition(dt) {
    const tr = this.transition; if (!tr) return; tr.t += dt;
    if (!tr.applied && tr.t >= 0.9) { tr.applied = true; this.applyTravel(tr.spec); this.hud.fade(false); }
    if (tr.t >= 2.2) { this.transition = null; if (tr.spec.title) this.hud.titleCard(tr.spec.title, tr.spec.sub || ''); }
  }
  applyTravel(spec) {
    const keep = new Set(['player', 'wingman', ...(spec.keep || [])]);
    for (const e of [...this.entities]) if (!keep.has(e.id)) { e.landed = true; this.removeEntity(e); }
    for (const w of this.wrecks) if (!w.nomodel) this.scene.remove(w.e.model.root);
    this.wrecks.length = 0; this.burners.length = 0; this.weapons.reset(); this.cine = null; this.camRig.override = null;
    const zones = spec.zones || [{ id: 'boundary', type: 'boundary', pos: [spec.pos[0], 0, spec.pos[2] - 10000], radius: 40000, label: 'OPERATIONS AREA' }];
    this.mission.env = spec.env; this.mission.base = null; this.director.m.zones = zones; this.director.m.waypoints = spec.waypoints || []; this.director.outsideT = 0;
    this.world.build({ env: spec.env, base: null, zones }, [spec.pos[0], 0, spec.pos[2]]);
    this.turbulence = spec.env?.turbulence || 0;
    this.flight.reset(new THREE.Vector3(...spec.pos), spec.heading || 0, spec.speed || 230, false); this.flight.throttle = 0.8; this.player.airborne = true; this.state = 'flight';
    const w = this.wingman; if (w && w.alive && !spec.noWingman) { w.pos.copy(this.player.pos).add(new THREE.Vector3(110, 8, 60).applyQuaternion(this.player.quat)); w.quat.copy(this.player.quat); w.dir.copy(this.flight.fwd); w.speed = this.flight.speed; w.vel.copy(this.flight.vel); w.onGround = false; w.pilot?.set('FORMATION'); }
    this.radar.reset(); this.radar.disabled = spec.radar === 'off'; this.camRig.snap(); this.particles.setFog(this.world.sky.fogColor, this.world.sky.scene.fog.density);
    this.rec?.event('travel', this.player.pos, null, { env: spec.env, zones });
  }

    // ------------------------------------------------------------ hooks used by director / weapons
  say(id) { this.comms.say(id); this.rec?.event('say', null, null, id); }
  setMusic(s) { this.musicBase = s; }
  showEvidence(card) { this.hud.showEvidence(card); this.audio.play('objective'); }
  onObjective(o) { if (o.kind === 'primary' || o.kind === 'secondary') { this.hud.toast(`✔ ${o.label}`, 'ok'); this.audio.play('objective'); } this.rec?.event('objective', null, null, o.label); }
  onAIState(e, s) { /* hook for future FX/analytics */ }
  onAIGone(e) { this.hud.toast(`${e.callsign} LEFT THE AREA`, 'warn'); this.removeEntity(e); }
  accuracy() { const s = this.weapons.stats, d = s.shots + s.launched * 12; return d ? clamp((s.hits + s.missileHits * 12) / d, 0, 1) : 0; }
  onMissionEnd(result) {
    if (this.ended) return; this.ended = true; this.endResult = result; this.endTimer = result === 'complete' ? 2.5 : 3.2;
    this.hud.centerMsg(result === 'complete' ? 'MISSION COMPLETE' : 'MISSION FAILED', 3.2, result === 'complete' ? 'good' : 'bad'); this.audio.play(result === 'complete' ? 'confirm' : 'denied');
    if (result === 'complete') this.audio.setMusic('RESOLUTION'); else this.hud.toast(this.director.failReason || 'MISSION FAILED', 'bad');
    this.rec?.event('end', null, null, result);
  }
  snapshot() {
    const dir = this.director, ws = this.weapons.stats;
    const tids = new Set(); for (const o of dir.primaries) if (o.type === 'destroy') (o.params.targets || []).forEach((t) => tids.add(t));
    const targets = [...tids].map((t) => this.byId.get(t)).filter(Boolean);
    return {
      result: this.endResult || 'failed', reason: dir.failReason, time: this.missionTime, shots: ws.shots, accuracy: this.accuracy(), damageTaken: this.player.damageTaken, maxHp: this.maxHp,
      targetsTotal: tids.size, targetsDestroyed: targets.filter((t) => !t.alive && !t.despawned).length,
      allies: [...(this.wingman ? [this.wingman] : []), ...(this.mission.groups || []).filter((q) => q.side === 'friendly').map((q) => this.byId.get(q.id)).filter(Boolean)].map((x) => ({ alive: x.alive })), objectives: dir.summary(), missilesFired: ws.launched, flares: ws.flaresDropped, oneLife: !!this.mission.oneLife
    };
  }

  // ------------------------------------------------------------ damage / destruction
  damage(e, amount, owner, kind) {
    if (!e.alive) return;
    if (e.isPlayer) {
      amount *= this.diffData.damageTaken;
      const killed = e.hurt(amount, owner); this.hud.flashDamage(clamp(amount / 40, 0.15, 0.8)); this.camRig.addTrauma(clamp(amount / 60, 0.2, 0.7));
      this.audio.play('hit'); this.input.rumble(0.7, 0.8, 250);
      if (killed) this.destroyPlayer();
      return;
    }
    if (owner?.isPlayer && e.side === 'friendly') { this.director.roeViolation = true; this.friendlyFire = true; this.hud.centerMsg('FRIENDLY FIRE', 1.8, 'bad'); }
    if (e.pilot) { e.pilot.alert = 10; if (owner) e.lastDamageBy = owner; }
    const killed = e.hurt(amount, owner);
    if (owner?.isPlayer && kind !== 'missile') this.audio.play('hit', 0.25);
    if (e === this.wingman && !killed) this.rec?.event('wing_hit');
    if (killed) this.killEntity(e, owner);
  }
  killEntity(e, owner) {
    this.particles.explosion(e.pos.clone(), e.explosive ? 2.6 : e.asset ? 1.8 : 1.2); this.onExplosion(e.pos, 1.2, owner);
    if (e.isGround) {
      if (e.explosive) for (let i = 0; i < 3; i++) this.particles.explosion(e.pos.clone().add(new THREE.Vector3(rand(-14, 14), rand(2, 10), rand(-14, 14))), 1.5);
      this.burners.push({ pos: e.pos.clone().add(new THREE.Vector3(0, 3, 0)), t: 0, size: Math.max(4, e.radius * 0.35) });
      e.model.root.traverse((o) => { if (o.isMesh && o.material?.color) { o.material = o.material.clone(); o.material.color.multiplyScalar(0.16); } });
    } else this.wrecks.push({ e, t: 0, spin: new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 1, (Math.random() - 0.5) * 4) });
    if (owner?.isPlayer && e.side === 'hostile') this.hud.centerMsg(`${e.callsign} DESTROYED`, 1.6, 'good');
    const idx = this.entities.indexOf(e); if (idx >= 0) this.entities.splice(idx, 1);
    const pi = this.pilots.indexOf(e.pilot); if (pi >= 0) this.pilots.splice(pi, 1);
    const ui = this.units.indexOf(e.unit); if (ui >= 0) this.units.splice(ui, 1);
    this.rec?.event('kill', e.pos, null, e.id);
  }
  destroyPlayer() {
    if (this.crashed) return; this.crashed = true; this.player.alive = false;
    this.particles.explosion(this.player.pos.clone(), 1.6); this.audio.play('explosion', 1); this.model.group.visible = false;
    this.camRig.addTrauma(0.9); this.state = 'dead'; this.wrecks.push({ e: this.player, t: 0, spin: new THREE.Vector3(1, 0.5, 2), nomodel: true });
    this.camRig.override = { pos: this.player.pos.clone().add(new THREE.Vector3(60, 30, 80)), look: this.player.pos.clone(), fov: 55 }; this.camRig.cinema = true;
    this.hud.cinematic(true);
  }
  onExplosion(pos, size, owner) {
    const d = pos.distanceTo(this.camera.position);
    this.audio.play('explosion', clamp(1.2 - d / 5000, 0.1, 1)); this.camRig.addTrauma(0.65 * clamp(1 - d / 2500, 0, 1));
    this.rec?.event('explosion', pos, null, size);
    if (owner?.isPlayer && this.director.civilianAt(pos)) { this.director.firedInZone = true; this.lastFirePos = pos.clone(); }
  }

  // ------------------------------------------------------------ cinematics
  playCinematic(name, args = {}) {
    const def = this.mission.cinematics?.[name]; if (!def || this.state === 'dead') return;
    for (const sh of def.shots) if (sh.d === undefined) sh.d = sh.dur ?? 3;   // authoring alias: `dur` or `d`
    const entity = args.entity ? this.byId.get(args.entity) : null;
    this.cine = { name, def, args, entity, t: 0, shot: -1, total: def.shots.reduce((s, x) => s + x.d, 0), st: {} };
    if (def.bars) this.hud.cinematic(true);
  }
  endCinematic() {
    if (!this.cine) return; const c = this.cine; this.cine = null; this.camRig.override = null; this.camRig.blend = 0;
    this.camRig.setMode(CAMERA_IDS[this.camIndex]); if (!this.camRig.cinema) this.hud.cinematic(false);
    if (c.name === 'intro') { this.state = 'takeoff'; this.hud.centerMsg('TAKEOFF', 2.2, 'stage'); this.camRig.setMode('chase'); this.camRig.snap(); this.setCameraMode(CAMERA_IDS[this.camIndex], true); }
  }
  updateCinematic(dt) {
    const c = this.cine; if (!c) return; c.t += dt;
    let acc = 0, idx = c.def.shots.length - 1; for (let i = 0; i < c.def.shots.length; i++) { if (c.t < acc + c.def.shots[i].d) { idx = i; break; } acc += c.def.shots[i].d; }
    if (c.t >= c.total) return this.endCinematic();
    const shot = c.def.shots[idx], k = clamp((c.t - acc) / shot.d, 0, 1), ease = k * k * (3 - 2 * k);
    if (c.shot !== idx) {
      c.shot = idx; c.st = {};
      if (c.name === 'intro') this.hud.centerMsg(idx === 0 ? 'AIRBASE' : 'COCKPIT', 2.2, 'stage');
      if (shot.anchor === 'cockpit') { this.camRig.override = null; this.camRig.setMode('cockpit'); this.camRig.snap(); } else this.camRig.override = {};
      if (shot.mode === 'flyby' && c.entity !== undefined) { const t = this.byId.get(shot.follow === '$entity' ? c.args.entity : shot.follow) || c.entity || this.player; c.st.pt = t.pos.clone().addScaledVector(t.vel, 1.5).add(new THREE.Vector3(260, 30, 0).applyQuaternion(t.quat)); c.st.target = t; }
    }
    const o = this.camRig.override; if (!o || shot.anchor === 'cockpit') return;
    o.fov = shot.fov || 50; o.snap = false;
    if (shot.mode === 'flyby') { const t = c.st.target || this.player; o.pos = (o.pos || c.st.pt).clone ? c.st.pt.clone() : c.st.pt; o.look = t.pos.clone(); return; }
    if (shot.mode === 'orbit') {
      const t = this.byId.get(shot.follow === '$entity' ? c.args.entity : shot.follow) || this.player, a = c.t * 0.9;
      o.pos = t.pos.clone().add(new THREE.Vector3(Math.cos(a) * shot.radius, shot.radius * 0.35, Math.sin(a) * shot.radius)); o.look = t.pos.clone(); return;
    }
    const frame = (shot.anchor === 'base' ? this.mission.base : null), hd = -((frame?.heading) || 0) * DEG, R = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), hd);
    const origin = shot.anchor === 'base' ? new THREE.Vector3(frame.pos[0], this.world.baseAlt, frame.pos[2]) : this.player.pos.clone();
    const mk = (a, b) => new THREE.Vector3().fromArray(a).lerp(new THREE.Vector3().fromArray(b), ease).applyQuaternion(shot.anchor === 'base' ? R : this.player.quat).add(origin);
    o.pos = mk(shot.from.off, shot.to.off); o.look = mk(shot.from.look, shot.to.look);
  }

  // ------------------------------------------------------------ cameras
  setCameraMode(id, silent) {
    const owned = this.app.unlockedCameras; if (owned && !owned.has(id)) { this.hud.toast('CAMERA LOCKED — RANK UP TO UNLOCK', 'warn'); return; }
    this.camIndex = CAMERA_IDS.indexOf(id); this.camRig.setMode(id);
    this.model.setCockpitVisible(id !== 'cockpit');
    if (!silent) this.hud.camName(this.app.cameraName(id));
  }
  nextCamera() {
    for (let i = 1; i <= CAMERA_IDS.length; i++) { const id = CAMERA_IDS[(this.camIndex + i) % CAMERA_IDS.length]; if (!this.app.unlockedCameras || this.app.unlockedCameras.has(id)) { return this.setCameraMode(id); } }
  }

  // ------------------------------------------------------------ main update
  update(dtRaw) {
    const dt = Math.min(dtRaw, 0.05); if (this.paused) { this.renderCamera(dt, 0); return; }
    const inp = this.input.poll(dt); this.time += dt; this.missionTime += dt;
    this.handleGlobalInput(inp);
    if (this.cine?.def.interruptible && (inp.camera || inp.cameraDirect >= 0)) this.endCinematic();
    const locked = (this.state === 'intro') || this.state === 'dead' || (this.cine?.def.locked);
    this.samLock = 0; this.updateTransition(dt);
    this.updatePlayer(dt, inp, locked);
    this.updateAI(dt);
    this.updateWrecks(dt);
    this.entitiesAlive = this.entities.filter((e) => e.alive && !e.despawned);
    this.radar.update(dt, this.player, this.entitiesAlive, this.diffData, (x, z) => this.world.groundY(x, z), { targetAssist: this.settings.targetAssist });
    this.radarLockOn = this.radar.locked ? this.radar.selected : null;
    this.updateTargeting(dt, inp, locked);
    this.updateWeapons(dt, inp, locked);
    this.weapons.update(dt, this.time);
    this.director.update(dt);
    this.updateCinematic(dt);
    this.updateMusicAndAudio(dt);
    this.comms.update(dt);
    this.rec.update(dt);
    if (this.ended) { this.endTimer -= dt; if (this.endTimer <= 0 && !this.reported) { this.reported = true; this.app.onMissionFinished(this); } }
    this.renderCamera(dt, inp);
  }

  handleGlobalInput(inp) {
    if (inp.camera) this.nextCamera();
    if (inp.cameraDirect >= 0) this.setCameraMode(CAMERA_IDS[inp.cameraDirect]);
    if (inp.mouseToggle) { this.mouseFlight = !this.mouseFlight; this.input.setMouseFlight(this.mouseFlight); this.hud.toast(this.mouseFlight ? 'MOUSE FLIGHT ON (click to capture)' : 'MOUSE FLIGHT OFF'); }
    if (inp.hudToggle) this.hudHidden = !this.hudHidden;
    if (inp.pause) this.app.togglePause();
    if (this.mouseFlight === undefined) { this.mouseFlight = !!this.settings.mouseControl; this.input.setMouseFlight(this.mouseFlight); }
  }

  updatePlayer(dt, inp, locked) {
    const f = this.flight, p = this.player; if (!p.alive) { return; }
    const gy = this.world.groundY(f.pos.x, f.pos.z), d = this.diffData, S = this.settings;
    // ground-impact prediction for PULL UP + assisted recovery
    let tImpact = 99; if (f.airborne) for (let t = 0.4; t <= 5; t += 0.4) { _v.copy(f.pos).addScaledVector(f.vel, t); if (_v.y < this.world.groundY(_v.x, _v.z) + 25) { tImpact = t; break; } }
    this.pullUp = f.airborne && tImpact < 1.5 + 3 * d.warning && f.vspeed < -10;
    const input = { ...inp };
    if (inp.mouseAim && !locked && this.state !== 'dead') this.applyMouseAim(input, inp.mouseAim);
    if (this.state === 'takeoff') { input.throttleSet = 1; if (this.input.touch?.active && f.onGround && f.speed > 98 && f.pitchDeg < 9) input.pitch = Math.max(input.pitch, 0.45); }
    if (d.groundAssist && S.flightMode !== 'EXPERT' && f.airborne && tImpact < 1.8 && !locked) { input.pitch = Math.max(input.pitch, clamp((1.8 - tImpact) * 0.9, 0, 1)); input.roll *= 0.4; if (!this.autoPull) { this.autoPull = true; this.hud.centerMsg('AUTO PULL-UP', 1.2, 'warn'); } } else this.autoPull = false;
    const assistBonus = d.assistBonus + (S.assistLevel - 0.5) * 0.4;
    f.update(dt, input, { mode: S.flightMode, autoLevel: S.autoLevel, groundY: gy, locked, autoTakeoff: this.state === 'takeoff' || this.state === 'intro', diff: { stallForgiveness: d.stallForgiveness, energyBleed: d.energyBleed, assistBonus } });
    if (f.agl > 8) p.airborne = true;
    if (this.turbulence > 0 && p.airborne && !f.onGround) this.applyTurbulence(dt);
    p.speed = f.speed;
    // impact with terrain / sea
    if (p.airborne && f.agl < 1.2 && !f.onGround) { this.damage(p, 9999, null, 'ground'); }
    if (this.state === 'takeoff' && f.agl > 80 && p.airborne) { this.state = 'flight'; this.flight.throttle = Math.max(0.8, this.flight.throttle); this.hud.toast('GEAR UP — YOU HAVE CONTROL', 'ok'); }
    // visuals
    this.model.group.position.copy(f.pos); this.model.group.quaternion.copy(f.quat);
    this.model.setControls({ pitch: f.ctrl.pitch, roll: f.ctrl.roll, yaw: f.ctrl.yaw, brake: f.ctrl.brake, throttle: f.throttle }, this.time);
    // engine trail
    if (f.throttle > 0.15 && Math.random() < 0.35) for (const sx of [-0.5, 0.5]) { _v.set(sx, 0, 9.5).applyQuaternion(f.quat).add(f.pos); this.particles.fire(_v, f.vel.clone().multiplyScalar(0.25), 0.8 + f.throttle * 0.7, 0.16); }
    if (f.agl < 120 && f.speed > 60 && this.world.hasSea && gy <= 0.01) { _v.copy(f.pos); _v.y = 0.5; if (Math.random() < 0.6) this.particles.smokePuff(_v, new THREE.Vector3(0, 3, 0), 12, 2.5, 0.15); }
    // map boundary
    this.boundary = this.director.outsideT;
  }

  /**
   * Mouse aim: the cursor offset from screen centre is an angular demand in WORLD axes (horizontal = heading change,
   * vertical = pitch change, cursor up = nose up). The target direction is resolved in the body frame: its up component
   * drives pitch and its right component drives the rudder (which keeps a banked turn level), while roll banks into the turn.
   */
  applyMouseAim(input, m) {
    const k = clamp(m.sens, 0.5, 2), f = this.flight;
    const nx = clamp(m.x * 1.5, -1, 1) * k, ny = clamp(-m.y * 1.5, -1, 1) * k;
    const hd = f.heading * DEG + clamp(nx, -1, 1) * 60 * DEG, th = clamp(f.pitchDeg * DEG + clamp(ny, -1, 1) * 45 * DEG, -80 * DEG, 80 * DEG);
    const T = _v.set(Math.sin(hd) * Math.cos(th), Math.sin(th), -Math.cos(hd) * Math.cos(th));
    const L = T.applyQuaternion(_q.copy(f.quat).invert());
    const bankRight = -f.bankDeg * DEG, want = clamp(nx, -1, 1) * 70 * DEG, err = wrapPi(want - bankRight);
    const idle = Math.abs(nx) < 0.02 && Math.abs(ny) < 0.02;
    input.roll = clamp(input.roll + (idle && Math.abs(bankRight) < 0.05 ? 0 : clamp(err * 2.4, -1, 1)), -1, 1);
    // command each axis relative to its own authority, then scale both together so the pitch:yaw ratio (which keeps the turn level) survives saturation
    let cq = (L.y * 1.7) / this.ac.stats.pitchRate, cr = (L.x * 1.7) / this.ac.stats.yawRate; const sat = Math.max(1, Math.abs(cq), Math.abs(cr)); cq /= sat; cr /= sat;
    input.pitch = clamp(input.pitch + cq * m.inv, -1, 1);
    input.yaw = clamp(input.yaw + cr, -1, 1);
    this.mouseAimPx = { x: (m.x * 0.5 + 0.5) * innerWidth, y: (m.y * 0.5 + 0.5) * innerHeight };
  }
  /** Control names for on-screen hints (keyboard vs touch buttons). */
  keys() { return this.input.touch?.active ? { tgt: 'TAP TGT', id: 'HOLD ID', fire: 'TAP MSL' } : { tgt: 'T', id: 'HOLD I', fire: 'F / RIGHT CLICK' }; }
  fireHint() {
    const r = this.radar, sel = r.selected, p = this.player, K = this.keys(); if (!p.alive) return '';
    if (this.state === 'takeoff') return this.flight.speed < 85 ? 'ACCELERATING…' : this.flight.onGround ? 'PULL BACK TO TAKE OFF' : '';
    if (p.missilesLeft <= 0) return 'NO MISSILES — USE CANNON';
    if (!sel) return r.contacts.some((k) => k.visible) ? `${K.tgt}: SELECT TARGET` : '';
    const k = r.selectedContact();
    if (!sel.identified) return k && k.range > 7500 ? `CLOSE TO 7 KM — THEN ${K.id} TO IDENTIFY` : r.locked ? `LOCKED — ${K.id} TO IDENTIFY (ROE)` : `${K.id}: IDENTIFY  ·  KEEP NOSE ON TARGET TO LOCK`;
    if (sel.side !== 'hostile') return 'FRIENDLY — DO NOT FIRE';
    if (!r.locked) return r.severity > 0.85 ? 'RADAR JAMMED — NO LOCK' : k && k.range > r.lockRange ? 'OUT OF MISSILE RANGE' : 'KEEP NOSE ON TARGET TO LOCK';
    return `${K.fire}: FIRE MISSILE`;
  }

  /** Storm / mountain-wave buffeting: smooth noise on attitude and vertical speed plus an occasional hard gust. */
  applyTurbulence(dt) {
    const f = this.flight, k = this.turbulence, t = this.time;
    const gx = noise2(t * 0.9, 3.1, 4) - 0.5, gy = noise2(t * 0.6, 9.7, 5) - 0.5, gz = noise2(t * 1.1, 5.3, 6) - 0.5;
    this.gustT = (this.gustT ?? 6) - dt; let gust = 0; if (this.gustT <= 0) { this.gustT = rand(6, 12); this.gust = 1; } if (this.gust > 0) { gust = this.gust; this.gust = Math.max(0, this.gust - dt * 1.4); }
    _q.setFromEuler(_eu.set(gx * dt * 0.7 * k + gust * dt * 0.5 * k, gy * dt * 0.25 * k, gz * dt * 1.3 * k + gust * dt * 1.2 * k * Math.sign(gx || 1)));
    f.quat.multiply(_q).normalize(); f.vel.y += (gy * 22 * k + gust * 18 * k * Math.sign(gy || 1)) * dt;
    this.camRig.addTrauma((0.012 + gust * 0.02) * k);
  }

  updateAI(dt) {
    this.wingmanFree = this.entities.some((e) => e.side === 'hostile' && e.identified && e.alive);
    for (const e of [...this.entities]) {
      if (e.isPlayer || !e.alive) continue;
      if (e.isGround) { e.unit.update(dt); e.model.root.position.copy(e.pos); e.model.root.quaternion.copy(e.quat); continue; }
      if (e.onGround) {
        if (this.player.speed > 15 || this.player.airborne || this.state === 'flight') {
          e.speed = Math.min(e.speed + 15 * dt, 90); e.dir.set(0, 0, -1).applyQuaternion(e.quat).setY(0).normalize(); e.pos.addScaledVector(e.dir, e.speed * dt); e.vel.copy(e.dir).multiplyScalar(e.speed);
          e.pos.y = this.world.baseAlt + 2.2; if (e.speed > 80) { e.onGround = false; e.pos.y += 4; e.dir.y = 0.16; e.dir.normalize(); }
        }
      } else e.pilot?.update(dt);
      // sync
      e.model.root.position.copy(e.pos); e.model.root.quaternion.copy(e.quat);
      e.model.setControls({ throttle: e.throttle ?? 0.6, roll: clamp(e.bank || 0, -1, 1) * 0.6, pitch: 0 }, this.time);
      if (e.pos.y < this.world.groundY(e.pos.x, e.pos.z) + 1.5 && !e.onGround) { e.hp = 0; e.alive = false; this.killEntity(e, null); }
    }
    // asset smoke when damaged
    for (const e of this.entities) if (!e.isPlayer && e.alive && e.hp / e.maxHp < 0.5 && Math.random() < 0.7) this.particles.smokePuff(_v.copy(e.pos).addScaledVector(e.dir || FWD, -6), e.vel.clone().multiplyScalar(0.1), 3 + (1 - e.hp / e.maxHp) * 3, 3, 0.55);
    if (this.player.alive && this.player.hp / this.player.maxHp < 0.5 && Math.random() < 0.7) this.particles.smokePuff(_v.copy(this.player.pos).addScaledVector(this.flight.fwd, -7), this.flight.vel.clone().multiplyScalar(0.1), 3, 2.5, 0.5);
  }

  updateWrecks(dt) {
    for (let i = this.burners.length - 1; i >= 0; i--) {
      const b = this.burners[i]; b.t += dt; if (b.t > 70) { this.burners.splice(i, 1); continue; }
      if (Math.random() < 0.55) this.particles.smokePuff(_v.set(b.pos.x + rand(-b.size, b.size) * 0.4, b.pos.y, b.pos.z + rand(-b.size, b.size) * 0.4), _w.set(rand(-2, 2), 11 + rand(0, 5), rand(-2, 2)), b.size * (1 + b.t * 0.02), 6, 0.5 * (1 - b.t / 80));
      if (b.t < 25 && Math.random() < 0.35) this.particles.fire(_v.set(b.pos.x + rand(-b.size, b.size) * 0.5, b.pos.y - 1, b.pos.z + rand(-b.size, b.size) * 0.5), _w.set(0, 7, 0), b.size * 0.9, 0.5);
    }
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const w = this.wrecks[i], e = w.e; w.t += dt;
      e.vel.y -= 9.81 * dt * 1.2; e.pos.addScaledVector(e.vel, dt); e.vel.multiplyScalar(Math.exp(-0.05 * dt));
      if (!w.nomodel) { e.model.root.position.copy(e.pos); e.model.root.rotateX(w.spin.x * dt); e.model.root.rotateY(w.spin.y * dt); e.model.root.rotateZ(w.spin.z * dt); }
      this.particles.fire(e.pos, new THREE.Vector3(), 6, 0.45); this.particles.smokePuff(e.pos, new THREE.Vector3(0, 4, 0), 9, 4, 0.6);
      const gy = this.world.groundY(e.pos.x, e.pos.z);
      if (e.pos.y < gy + 2 || w.t > 7) {
        if (e.pos.y < gy + 2 && !w.landed) { w.landed = true; this.particles.explosion(new THREE.Vector3(e.pos.x, gy + 2, e.pos.z), 1.0); this.audio.play('explosion', clamp(1 - e.pos.distanceTo(this.camera.position) / 6000, 0, 0.7)); }
        if (!w.nomodel) this.scene.remove(e.model.root); if (w.t > 7 || w.landed) { this.wrecks.splice(i, 1); }
      }
    }
  }

  // ------------------------------------------------------------ targeting + weapons
  updateTargeting(dt, inp, locked) {
    const r = this.radar; if (locked) return;
    if (inp.cycle) { const t = r.cycle(); this.audio.play(t ? 'lock' : 'denied'); this.idProgress = 0; if (t) this.hud.centerMsg(`TRACKING ${t.identified ? t.callsign : 'UNKNOWN CONTACT'}`, 1.1); }
    if (!r.selected && this.settings.targetAssist) {
      const c = r.contacts.filter((k) => k.visible && k.off < 55 * DEG && !(k.entity.identified && k.entity.side !== 'hostile'))[0]; if (c) { r.selected = c.entity; r.lockProgress = 0; this.hud.centerMsg(this.input.touch?.active ? 'CONTACT — TAP TGT TO SWITCH, HOLD ID TO IDENTIFY' : 'CONTACT — PRESS T TO SWITCH, HOLD I TO IDENTIFY', 2.4, 'warn'); this.audio.play('lock'); }
    }
    const c = r.selectedContact();
    if (inp.identify && c && c.visible && c.range < 7500 && c.off < 36 * DEG && !c.entity.identified) {
      this.idProgress = Math.min(1, this.idProgress + dt / (1.9 * clamp(c.range / 3000, 0.4, 1.6)));
      if (this.idProgress >= 1) this.identify(c.entity);
    } else this.idProgress = Math.max(0, this.idProgress - dt * 0.8);
    // visual identification at close range
    for (const k of r.contacts) {
      if (!k.visible || k.entity.identified) continue;
      if (k.range < 1300 && k.off < 80 * DEG) { k.entity.visT = (k.entity.visT || 0) + dt; if (k.entity.visT > 2.5) this.identify(k.entity); } else k.entity.visT = Math.max(0, (k.entity.visT || 0) - dt);
    }
    if (!c && r.contacts.length === 0) this.idProgress = 0;
  }
  identify(e) {
    if (e.identified) return; e.identified = true; this.idProgress = 0;
    const hostile = e.side === 'hostile'; this.hud.centerMsg(`${e.callsign} IDENTIFIED — ${hostile ? 'HOSTILE' : 'FRIENDLY'}`, 2.4, hostile ? 'bad' : 'good'); this.audio.play('confirm');
    this.rec.event('identify', e.pos, null, e.callsign);
  }

  updateWeapons(dt, inp, locked) {
    const p = this.player, f = this.flight, r = this.radar, w = this.weapons; if (!p.alive || locked) { this.updateMissileStatus(); return; }
    this.flareCd -= dt;
    // cannon
    this.cannonAcc += dt; const interval = 1 / 24;
    if (inp.fire && this.ammo > 0 && !f.onGround) {
      while (this.cannonAcc >= interval && this.ammo > 0) {
        this.cannonAcc -= interval; this.ammo--;
        _v.set(0, -0.4, -9).applyQuaternion(f.quat).add(f.pos);
        let assist = null; const c = r.selectedContact(), ad = this.diffData.aimAssist * (this.settings.targetAssist ? 1 : 0);
        if (c && c.visible && ad > 0 && c.range < 1800) {
          const lead = c.entity.pos.clone().addScaledVector(_w.copy(c.entity.vel).sub(f.vel), c.range / 980); const want = lead.sub(f.pos).normalize();
          if (Math.acos(clamp(want.dot(f.fwd), -1, 1)) < 7 * DEG) assist = f.fwd.clone().lerp(want, ad * 0.75).normalize();
        }
        w.fireCannon(p, _v.clone(), f.fwd, f.vel, { spread: 0.007, damage: 5, assistDir: assist });
        this.camRig.addTrauma(0.012); this.input.rumble(0.0, 0.25, 60);
      }
      this.director.firedInZone = true; this.lastFirePos = f.pos.clone(); this.fireHeld += dt;
    } else { this.cannonAcc = Math.min(this.cannonAcc, interval); this.fireHeld = 0; if (inp.fire && this.ammo <= 0) { this.noAmmoT = (this.noAmmoT || 0) - dt; if (this.noAmmoT <= 0) { this.audio.play('denied'); this.noAmmoT = 0.6; this.hud.centerMsg('GUN EMPTY', 0.8, 'warn'); } } }
    // missile
    if (inp.missile) this.tryMissile();
    // flares
    if (inp.flare && this.flareCd <= 0) { if (w.dropFlares(p, 2)) { this.flareCd = 0.3; this.rec.event('flare', p.pos); } else { this.audio.play('denied'); this.hud.centerMsg('FLARES EMPTY', 0.8, 'warn'); } }
    this.updateMissileStatus();
  }
  tryMissile() {
    const p = this.player, r = this.radar, f = this.flight;
    if (p.missilesLeft <= 0) { this.audio.play('denied'); this.hud.centerMsg('NO MISSILES', 1, 'warn'); return; }
    const t = r.selected;
    if (!t || !r.locked) { this.audio.play('denied'); this.hud.centerMsg(t ? 'NO LOCK' : 'NO TARGET', 1, 'warn'); return; }
    if (!t.identified) { this.audio.play('denied'); this.hud.centerMsg('IDENTIFY TARGET FIRST — ROE', 1.8, 'bad'); this.director.roeViolation = true; return; }
    if (t.side !== 'hostile') { this.audio.play('denied'); this.hud.centerMsg('FRIENDLY — HOLD FIRE', 1.8, 'bad'); this.director.roeViolation = true; return; }
    const slot = this.startMissiles - p.missilesLeft, sx = slot % 2 ? 1 : -1, px = slot < 2 ? 3.0 : 4.7;
    _v.set(sx * px, -0.9, 0.6).applyQuaternion(f.quat).add(f.pos);
    this.weapons.fireMissile(p, t, _v.clone(), f.fwd, f.vel); this.model.setMissilesMounted(p.missilesLeft);
    this.camRig.impulse(1); this.camRig.addTrauma(0.2); this.input.rumble(0.5, 0.5, 200); this.director.firedInZone = true; this.lastFirePos = f.pos.clone();
    this.launchedUntil = this.time + 3;
    const cm = CAMERA_IDS[this.camIndex]; if ((cm === 'chase' || cm === 'close') && !this.cine && (!this.app.unlockedCameras || this.app.unlockedCameras.has('missile'))) { this.launchCamT = 2.4; this.prevCamId = cm; this.camRig.setMode('missile'); }
  }
  updateMissileStatus() {
    const p = this.player, r = this.radar, ml = this.weapons.lastPlayerMissile;
    if (ml && ml.alive || this.time < this.launchedUntil) this.missileHud = 'LAUNCHED';
    else if (p.missilesLeft <= 0) this.missileHud = 'EMPTY';
    else if (r.locked) this.missileHud = 'LOCKED';
    else if (r.selected && r.lockProgress > 0.05) this.missileHud = 'READY';
    else this.missileHud = r.selected ? 'READY' : 'MOUNTED';
    if (this.missileHud === 'LOCKED' && this._prevMs !== 'LOCKED') this.audio.play('locked');
    this._prevMs = this.missileHud;
  }

  // ------------------------------------------------------------ audio, music, warnings
  updateMusicAndAudio(dt) {
    const p = this.player, f = this.flight, inc = this.weapons.incoming(p), threatDist = inc.length ? Math.min(...inc.map((m) => m.pos.distanceTo(p.pos))) : 1e9;
    const threat = inc.length ? clamp(1 - threatDist / 6500, 0.12, 1) * this.diffData.warning + (inc.length ? 0.1 : 0) : 0;
    let enemyLock = 0; for (const e of this.entities) if (e.alive && e.pilot && e.side === 'hostile' && e.state === 'ATTACK' && e.pos.distanceTo(p.pos) < 7000) enemyLock = Math.max(enemyLock, 0.6);
    enemyLock = Math.max(enemyLock, this.samLock);
    this.audio.warnings(dt, { missile: clamp(threat, 0, 1), lock: enemyLock, pullup: this.pullUp, stall: f.stalled && !f.onGround && p.airborne });
    if (threat > 0.5) this.input.rumble(0.2 * threat, 0.5 * threat, 120);
    this.audio.setEngine(p.alive, f.throttle, f.speed);
    this.audio.setAmbience('flight', clamp(f.speed / 450, 0, 1));
    // music state: scripted base, escalate on danger
    let st = this.musicBase; if (this.ended && this.endResult === 'complete') st = 'RESOLUTION'; else if (inc.length || this.player.hp / this.player.maxHp < 0.3) st = 'DANGER';
    else if (this.entities.some((e) => e.alive && e.side === 'hostile' && e.state === 'ATTACK' && e.pos.distanceTo(p.pos) < 6000) && st === 'IDLE') st = 'COMBAT';
    this.audio.setMusic(st);
    // launch cam hand-back
    if (this.launchCamT > 0) { this.launchCamT -= dt; if (this.launchCamT <= 0 && this.camRig.mode === 'missile' && this.prevCamId) { this.camRig.setMode(this.prevCamId); } }
  }

  // ------------------------------------------------------------ camera + render prep
  renderCamera(dt, inp) {
    const contacts = this.radar.contacts, inc = this.weapons.incoming(this.player);
    this.camRig.settings = { shake: this.settings.cameraShake, reducedMotion: this.settings.reducedMotion };
    const playing = !this.paused && !this.ended && this.state !== 'dead' && this.state !== 'intro' && !this.cine?.def.locked;
    document.body.classList.toggle('playing', playing); this.input.touch?.setThrottle(this.flight.throttle);
    this.camRig.update(dt, { p: this.player, f: this.flight, missile: this.weapons.lastPlayerMissile, contacts, look: inp && inp.look, buffet: this.flight.buffet });
    this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
    this.particles.update(dt);
    this.exposure = this.world.update(dt, this.camera, this.particles);
    const cur = this.director.currentObjective(), wp = this.currentWaypoint(cur);
    const hud = {
      player: this.player, flight: this.flight, camera: this.camera, radar: this.radar, weapons: this.weapons, director: this.director, diff: this.diffData, camMode: this.camRig.override ? 'cine' : this.camRig.mode,
      incoming: inc, missionTime: this.missionTime, missileStatus: this.missileHud, ammo: this.ammo, hpFrac: this.player.hp / this.player.maxHp, pullUp: this.pullUp, boundary: this.boundary,
      idProgress: this.idProgress, waypoint: wp, mouseFlight: !!this.mouseFlight, mouseAim: (this.mouseFlight || this.input.touch?.active) && !this.cine ? this.mouseAimPx : null, fireHint: this.fireHint(), samLock: this.samLock, markers: this.director.markers(), recon: this.director.objectives.find((o) => o.live && o.state === 'active'), hudHidden: this.hudHidden || !!this.cine?.def.locked || this.state === 'dead'
    };
    document.body.classList.toggle('aim-mouse', !!this.mouseFlight && !this.paused && !this.ended);
    this.hud.update(dt, hud); this.lastHud = hud;
  }
  currentWaypoint(cur) {
    if (!cur || cur.type !== 'reach_area') return null;
    const id = (cur.params.waypoints || []).find((w) => !cur.hit.has(w)); const z = id && this.director.waypoint(id); if (!z) return null;
    const dx = z.pos[0] - this.player.pos.x, dz = z.pos[2] - this.player.pos.z; return { bearing: (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360, dist: Math.hypot(dx, dz) };
  }

  dispose() {
    document.body.classList.remove('aim-mouse', 'playing'); this.input.touch?.reset();
    this.hud.show(false); this.hud.cinematic(false); this.comms.clear(); this.audio.setEngine(false); this.audio.setAmbience('off'); this.input.setMouseFlight(false);
    this.input.enabled = false; window.speechSynthesis?.cancel?.();
    this.scene.traverse((o) => { o.geometry?.dispose?.(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.map?.dispose?.(); m.dispose?.(); }); });
    this.world.clear(); this.scene.clear();
  }
}
