import * as THREE from 'three';
import { Assets } from './character/Assets.js';
import { Character } from './character/Character.js';
import { World } from './world/World.js';
import { Fx } from './fx/Fx.js';
import { GameAudio } from './fx/Audio.js';
import { Input } from './core/Input.js';
import { Events } from './core/Events.js';
import { PlayerController } from './player/PlayerController.js';
import { EnemyAI, Squad } from './ai/EnemyAI.js';
import { ENEMY_TYPES, DIFFICULTY } from './data/enemies.js';
import { SLOT_ORDER } from './data/weapons.js';
import { Hud } from './Hud.js';
import { rand, pick } from './core/math.js';

const ENEMY_DMG = 0.5;

export class Game {
  constructor(canvasHost, params) {
    this.params = params; this.time = 0; this.events = new Events(); this.characters = []; this.ais = [];
    this.difficulty = params.get('diff') || 'normal';
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.setSize(innerWidth, innerHeight);
    canvasHost.append(this.renderer.domElement);
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x9fb4c8); this.scene.fog = new THREE.Fog(0x9fb4c8, 40, 110);
    this.camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.05, 300);
    this.input = new Input(this.renderer.domElement);
    for (const k of (params.get('keys') || '').split(',').filter(Boolean)) this.input.keys.add(k);
    this.hud = new Hud(this);
    addEventListener('resize', () => { this.renderer.setSize(innerWidth, innerHeight); this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); });
  }

  async init() {
    this.assets = new Assets();
    await this.assets.init(p => this.hud.loading(p));
    this.setupLights();
    this.world = new World(this.scene); this.fx = new Fx(this.scene);
    this.listener = { pos: new THREE.Vector3(), yaw: 0 }; this.audio = new GameAudio(this.listener);
    this.events.on('damage', e => this.onDamage(e)); this.events.on('death', e => this.onDeath(e));
    this.assets.getClip('vault'); // lazily fetched clips used by gameplay
    await this.spawnPlayer();
    this.wave = 0; this.waveT = 2; this.kills = 0; this.score = 0; this.state = 'play';
    this.hud.ready();
  }
  setupLights() {
    this.scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x4a4a40, 1.1));
    const sun = this.sun = new THREE.DirectionalLight(0xfff0d8, 2.4); sun.position.set(25, 40, 15); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); const c = sun.shadow.camera; c.left = c.bottom = -32; c.right = c.top = 32; c.near = 1; c.far = 120; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
    this.scene.add(sun, sun.target);
  }
  async spawnPlayer() {
    this.player = new Character(this, { team: 'player', name: 'You', tint: 0x7d97b8, weapons: SLOT_ORDER });
    this.player.dmgMul = 1; this.player.pos.set(0, 0, 22); this.player.yaw = Math.PI;
    this.player.intent.aimYaw = Math.PI;
    this.scene.add(this.player.group); this.characters.push(this.player);
    await this.player.ready;
    this.ctl = new PlayerController(this, this.player); this.ctl.yaw = Math.PI;
    const wi = this.params.get('weapon'); if (wi !== null) { this.player.weapons.index = +wi; this.player.onWeaponChanged(); }
    if (this.params.has('ads')) this.player.intent.ads = true;
    this.player.onDamaged = ({ from }) => { this.lastHurt = this.time; };
  }
  async spawnEnemy(typeId, pos, squad) {
    const T = ENEMY_TYPES[typeId], diff = DIFFICULTY[this.difficulty];
    const c = new Character(this, { team: 'enemy', name: T.name, tint: T.tint, weapons: T.weapon, infiniteAmmo: true, health: T.hp });
    c.dmgMul = ENEMY_DMG * diff.dmg; c.pos.copy(pos); c.yaw = Math.atan2(-pos.x, -pos.z);
    this.scene.add(c.group); this.characters.push(c); await c.ready;
    const ai = new EnemyAI(this, c, squad, typeId, this.difficulty); this.ais.push(ai);
    this.hud.addLabel(ai); return ai;
  }
  spawnWave() {
    this.wave++; const n = Math.min(14, 2 + Math.floor(this.wave * 1.6)), squad = new Squad(); this.squad = squad;
    const pool = this.wave < 2 ? ['rifleman'] : this.wave < 3 ? ['rifleman', 'rusher'] : this.wave < 5 ? ['rifleman', 'rusher', 'breacher'] : ['rifleman', 'rusher', 'breacher', 'marksman'];
    for (let i = 0; i < n; i++) {
      let p, tries = 0;
      do { const a = Math.random() * Math.PI * 2, r = 20 + Math.random() * 6; p = new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r); } while ((this.world.pointBlocked(p.x, p.z, 0.8) || p.distanceTo(this.player.pos) < 18) && ++tries < 40);
      this.spawnEnemy(i === 0 && this.wave >= 3 ? 'breacher' : pick(pool), p, squad);
    }
    this.hud.banner(`WAVE ${this.wave}`, `${n} hostiles`);
  }

  // Hitscan resolution shared by player and AI.
  shoot({ owner, origin, dir, muzzle, def }) {
    const maxD = Math.min(def.range * 1.6, 300);
    let best = null;
    const wh = this.world.raycast(origin, dir, maxD);
    if (wh) best = { dist: wh.dist, world: wh };
    for (const ch of this.characters) {
      if (ch === owner || ch.team === owner.team || ch.dead) continue;
      const h = ch.rayHit(origin, dir, best?.dist ?? maxD);
      if (h && (!best || h.dist < best.dist)) best = { dist: h.dist, hit: h };
    }
    const end = origin.clone().addScaledVector(dir, best ? best.dist : Math.min(maxD, 120));
    this.fx.tracer(muzzle, end);
    for (const ai of this.ais) { // suppression for enemies the shot passes close to
      if (ai.c.team === owner.team || ai.c.dead) continue;
      const to = ai.c.center.sub(origin), t = to.dot(dir);
      if (t > 0 && t < (best?.dist ?? maxD) && to.addScaledVector(dir, -t).length() < 1.6) ai.nearMiss(0.2);
    }
    if (owner !== this.player && this.player && !this.player.dead) { const to = this.player.center.sub(origin), t = to.dot(dir); if (t > 0 && t < (best?.dist ?? maxD) && to.addScaledVector(dir, -t).length() < 1.8 && !best?.hit) this.hud.suppress(0.25); }
    if (!best) return;
    if (best.hit) {
      const h = best.hit, [fa, fb] = def.falloff, fall = THREE.MathUtils.clamp(1 - (best.dist - fa) / Math.max(1, fb - fa), 0, 1) * 0.55 + 0.45;
      const zoneMul = h.zone === 'head' ? def.headMul : h.mul;
      const dmg = def.damage * (best.dist <= fa ? 1 : fall) * zoneMul * (owner.dmgMul ?? 1);
      this.fx.impact(h.point, dir.clone().multiplyScalar(-1), 'blood');
      h.character.damage(dmg, { zone: h.zone, from: owner.pos, attacker: owner, point: h.point });
    } else if (best.world) this.fx.impact(best.world.point, best.world.normal, 'world');
  }
  onDamage(e) {
    if (e.attacker === this.player && e.target !== this.player) this.hud.hitMarker(e.zone === 'head', e.target.dead);
    if (e.target === this.player) this.hud.damaged(e.attacker?.pos ?? e.from, e.amount);
  }
  onDeath(e) {
    if (e.target === this.player) { this.state = 'dead'; this.hud.gameOver(this); return; }
    this.kills++; this.score += e.zone === 'head' ? 150 : 100; e.target.deadAt = this.time; this.hud.kill(e.target, e.zone === 'head');
  }

  restart() { location.reload(); }

  update(dt) {
    this.time += dt;
    const P = this.player;
    if (this.state === 'play' || this.state === 'dead') {
      this.ctl.update(dt);
      P.update(dt);
      if (!P.dead && this.time - (this.lastHurt ?? -99) > 5 && P.health < P.maxHealth) P.health = Math.min(P.maxHealth, P.health + 8 * dt);
      for (const ai of this.ais) if (!ai.c.dead) ai.update(dt); else ai.c.update(dt);
      // corpses
      for (let i = this.ais.length - 1; i >= 0; i--) { const c = this.ais[i].c; if (c.dead && this.time - (c.deadAt ?? this.time) > 8) { this.scene.remove(c.group); this.characters.splice(this.characters.indexOf(c), 1); this.hud.removeLabel(this.ais[i]); this.ais.splice(i, 1); } }
      // waves
      if (this.state === 'play') {
        const alive = this.ais.filter(a => !a.c.dead).length;
        if (alive === 0) {
          this.waveT -= dt;
          if (this.waveT <= 0) {
            if (this.wave > 0) { P.health = Math.min(P.maxHealth, P.health + 40); for (const s of P.weapons.slots) { s.reserve = s.def.reserve; } }
            this.spawnWave(); this.waveT = 7;
          } else if (this.wave > 0 && this.waveT > 6.5) this.hud.banner('WAVE CLEARED', 'resupplied');
        }
      }
    }
    this.ctl.updateCamera(dt, this.camera);
    this.listener.pos.copy(this.camera.position); this.listener.yaw = this.ctl.yaw;
    this.sun.position.set(P.pos.x + 25, 40, P.pos.z + 15); this.sun.target.position.copy(P.pos);
    this.fx.update(dt);
    this.hud.update(dt);
    this.input.endFrame();
  }
  frame = () => {
    const now = performance.now(); const dt = Math.min(0.05, (now - (this.last ?? now)) / 1000); this.last = now;
    if (!this.paused) this.update(dt);
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.frame);
  };
  start() { this.last = performance.now(); requestAnimationFrame(this.frame); }
}
