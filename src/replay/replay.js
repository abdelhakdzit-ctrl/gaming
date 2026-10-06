import * as THREE from 'three';
import { World } from '../world/world.js';
import { Particles } from '../weapons/particles.js';
import { buildFighter, buildModel, buildMissileMesh } from '../aircraft/model.js';
import { Settings } from '../settings/settings.js';
import dialogue from '../../data/dialogue.json';
import { clamp, lerp } from '../util/math.js';

const r1 = (n) => Math.round(n * 10) / 10, r3 = (n) => Math.round(n * 1000) / 1000;
const MAX_FRAMES = 2600, HZ = 8;

/** Records a lightweight replay: player/camera/entity transforms at 8 Hz plus discrete events. */
export class Recorder {
  constructor(game) {
    this.g = game; this.frames = []; this.events = []; this.acc = 0; this.meta = []; this.idx = new Map(); this.t = 0;
  }
  event(kind, pos, dir, extra) { this.events.push({ t: r3(this.t), k: kind, p: pos ? [r1(pos.x), r1(pos.y), r1(pos.z)] : null, x: extra ?? null }); }
  slot(key, kind, side) { if (!this.idx.has(key)) { this.idx.set(key, this.meta.length); this.meta.push({ kind, side }); } return this.idx.get(key); }
  update(dt) {
    this.t += dt; this.acc += dt; if (this.acc < 1 / HZ || this.frames.length >= MAX_FRAMES) return; this.acc = 0;
    const g = this.g, cam = g.camera, e = [];
    const push = (i, p, q) => e.push(i, r1(p.x), r1(p.y), r1(p.z), r3(q.x), r3(q.y), r3(q.z), r3(q.w));
    if (g.player.alive) push(this.slot(g.player, 'player', 'friendly'), g.player.pos, g.player.quat);
    for (const en of g.entities) if (!en.isPlayer && en.alive) push(this.slot(en, en.role === 'wingman' ? 'wingman' : en.def.model, en.side), en.pos, en.quat);
    for (const w of g.wrecks) if (!w.nomodel) push(this.slot(w.e, w.e.def.model, w.e.side), w.e.pos, w.e.model.root.quaternion);
    for (const m of g.weapons.missiles) push(this.slot(m, 'missile', 'x'), m.pos, m.mesh.quaternion);
    this.frames.push({ t: r3(this.t), e, c: [r1(cam.position.x), r1(cam.position.y), r1(cam.position.z), r3(cam.quaternion.x), r3(cam.quaternion.y), r3(cam.quaternion.z), r3(cam.quaternion.w), r1(cam.fov)], th: r3(g.flight.throttle) });
  }
  export() {
    const g = this.g, m = g.mission;
    return { v: 1, title: m.title, id: m.id, env: m.env, base: m.base, zones: m.zones, spawn: m.spawn, paint: g.opts.paint, meta: this.meta, frames: this.frames, events: this.events, duration: this.t, date: Date.now() };
  }
}

/** Plays back a recording in its own scene with several replay cameras. */
export class ReplaySession {
  constructor(rep) {
    this.rep = rep; this.scene = new THREE.Scene(); this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.8, 140000);
    this.world = new World(this.scene); this.particles = new Particles(this.scene);
    const c = rep.base ? [rep.base.pos[0], 0, rep.base.pos[2] - 1500] : rep.spawn.pos;
    this.world.build({ env: rep.env, base: rep.base, zones: rep.zones }, c);
    this.models = rep.meta.map((m) => {
      let mod; if (m.kind === 'player') { mod = buildFighter(rep.paint); mod.root = mod.group; } else if (m.kind === 'wingman') mod = buildModel('wingman', rep.paint); else if (m.kind === 'missile') mod = { root: buildMissileMesh() }; else mod = buildModel(m.kind);
      mod.root.visible = false; this.scene.add(mod.root); return mod;
    });
    this.time = 0; this.speed = 1; this.playing = true; this.camMode = 0; this.camNames = ['RECORDED', 'CHASE', 'CINEMATIC', 'FLYBY', 'TACTICAL', 'FREE'];
    this.ei = 0; this.pos = new THREE.Vector3(); this.q = new THREE.Quaternion(); this.free = { yaw: 0.5, pitch: 0.2 }; this.shotT = 99; this.shotPt = new THREE.Vector3(); this.line = ''; this.lineT = 0;
    this.playerPos = new THREE.Vector3(); this.playerQ = new THREE.Quaternion(); this.fpos = new THREE.Vector3();
    this.camera.position.set(...rep.frames[0].c.slice(0, 3));
  }
  nextCam() { this.camMode = (this.camMode + 1) % this.camNames.length; this.shotT = 99; }
  seek(t) { this.time = clamp(t, 0, this.rep.duration); this.ei = this.rep.events.findIndex((e) => e.t >= this.time); if (this.ei < 0) this.ei = this.rep.events.length; }
  frameAt(t) {
    const F = this.rep.frames; let lo = 0, hi = F.length - 1; while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (F[mid].t <= t) lo = mid; else hi = mid; }
    const a = F[lo], b = F[Math.min(lo + 1, F.length - 1)], k = b.t > a.t ? clamp((t - a.t) / (b.t - a.t), 0, 1) : 0; return { a, b, k };
  }
  update(dt, look) {
    const rep = this.rep; if (this.playing) this.time += dt * this.speed; if (this.time >= rep.duration) { this.time = rep.duration; this.playing = false; }
    const { a, b, k } = this.frameAt(this.time), seen = new Set(), mapB = new Map();
    for (let i = 0; i < b.e.length; i += 8) mapB.set(b.e[i], i);
    for (let i = 0; i < a.e.length; i += 8) {
      const id = a.e[i], j = mapB.get(id), mod = this.models[id]; seen.add(id); mod.root.visible = true;
      this.pos.set(a.e[i + 1], a.e[i + 2], a.e[i + 3]); this.q.set(a.e[i + 4], a.e[i + 5], a.e[i + 6], a.e[i + 7]);
      if (j !== undefined) { this.pos.lerp(this.fpos.set(b.e[j + 1], b.e[j + 2], b.e[j + 3]), k); this.q.slerp(new THREE.Quaternion(b.e[j + 4], b.e[j + 5], b.e[j + 6], b.e[j + 7]), k); }
      mod.root.position.copy(this.pos); mod.root.quaternion.copy(this.q);
      if (rep.meta[id].kind === 'player') { this.playerPos.copy(this.pos); this.playerQ.copy(this.q); }
      mod.setControls?.({ throttle: a.th, roll: 0, pitch: 0 }, this.time);
      if (rep.meta[id].kind === 'missile' && Math.random() < 0.6) this.particles.smokePuff(this.pos, new THREE.Vector3(), 2, 3, 0.4);
    }
    this.models.forEach((m, i) => { if (!seen.has(i)) m.root.visible = false; });
    while (this.ei < rep.events.length && rep.events[this.ei].t <= this.time) {
      const ev = rep.events[this.ei++]; if (this.playing && ev.p) {
        const p = new THREE.Vector3(...ev.p); if (ev.k === 'explosion' || ev.k === 'kill') this.particles.explosion(p, 1.1); else if (ev.k === 'flare') this.particles.flareGlow(p, 30, 1);
      }
      if (ev.k === 'say' && dialogue.lines[ev.x]) { const l = dialogue.lines[ev.x]; this.line = `${dialogue.characters[l.speaker].callsign}: ${l.text[Settings.s.subtitleLang] || l.text.en}`; this.lineT = 4.5; }
      else if (ev.k === 'identify' || ev.k === 'objective' || ev.k === 'launch') { this.line = ev.k === 'launch' ? 'MISSILE LAUNCH' : ev.k === 'identify' ? `IDENTIFIED ${ev.x}` : `✔ ${ev.x}`; this.lineT = 2.5; }
    }
    this.lineT -= dt;
    this.cameraUpdate(dt, a, b, k, look); this.particles.update(dt); this.world.update(dt, this.camera, this.particles);
    this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
  }
  cameraUpdate(dt, a, b, k, look) {
    const cam = this.camera, mode = this.camNames[this.camMode], P = this.playerPos, fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.playerQ);
    if (mode === 'RECORDED') { const c = a.c, d = b.c; cam.position.set(lerp(c[0], d[0], k), lerp(c[1], d[1], k), lerp(c[2], d[2], k)); cam.quaternion.set(c[3], c[4], c[5], c[6]).slerp(new THREE.Quaternion(d[3], d[4], d[5], d[6]), k); cam.fov = c[7]; return; }
    cam.fov = 60; const want = new THREE.Vector3(), look_ = P.clone();
    if (mode === 'CHASE') want.set(0, 6, 28).applyQuaternion(this.playerQ).add(P);
    else if (mode === 'TACTICAL') { want.set(P.x, P.y + 6000, P.z + 1); look_.copy(P); cam.fov = 50; }
    else if (mode === 'FREE') { this.free.yaw -= (look?.dx || 0) * 0.004; this.free.pitch = clamp(this.free.pitch + (look?.dy || 0) * 0.003, -1.2, 1.4); want.set(Math.sin(this.free.yaw) * Math.cos(this.free.pitch), Math.sin(this.free.pitch), Math.cos(this.free.yaw) * Math.cos(this.free.pitch)).multiplyScalar(60).add(P); }
    else {
      this.shotT += dt; if (this.shotT > 6) { this.shotT = 0; this.shotPt.copy(P).addScaledVector(fwd, 600).add(new THREE.Vector3((Math.random() - 0.5) * 500, (Math.random() - 0.3) * 120, (Math.random() - 0.5) * 500)); this.shotAng = Math.random() * 6; }
      if (mode === 'FLYBY') want.copy(this.shotPt); else { const an = this.shotAng + this.shotT * 0.4; want.set(Math.cos(an) * 80, 16, Math.sin(an) * 80).add(P); }
    }
    cam.position.lerp(want, 1 - Math.exp(-(mode === 'FREE' ? 8 : mode === 'TACTICAL' ? 3 : 6) * dt));
    const m = new THREE.Matrix4().lookAt(cam.position, look_, mode === 'TACTICAL' ? new THREE.Vector3(fwd.x, 0, fwd.z).normalize() : new THREE.Vector3(0, 1, 0)); const q = new THREE.Quaternion().setFromRotationMatrix(m);
    cam.quaternion.slerp(q, 1 - Math.exp(-10 * dt)); cam.updateProjectionMatrix();
  }
  dispose() { this.world.clear(); this.scene.traverse((o) => { o.geometry?.dispose?.(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.()); }); this.scene.clear(); }
}
