import * as THREE from 'three';
import { BillboardBatch } from '../world/billboards.js';
import { buildMissileMesh } from '../aircraft/model.js';
import { clamp, rand, DEG } from '../util/math.js';

const G = 9.81;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();

/**
 * Cannon, air-to-air missiles and flares. Game hooks: damage(entity, amt, owner, kind), explosion(pos, size, owner),
 * entities() -> live damageable entities, groundY(x,z), audio, diff().
 */
export class Weapons {
  constructor(scene, particles, hooks) {
    this.scene = scene; this.fx = particles; this.h = hooks;
    this.bullets = []; this.missiles = []; this.flares = [];
    this.tracers = new BillboardBatch(900, { additive: true, fog: false });
    scene.add(this.tracers.mesh);
    this.mslProto = buildMissileMesh();
    this.stats = { shots: 0, hits: 0, launched: 0, missileHits: 0, flaresDropped: 0 };
    this.lastPlayerMissile = null; this.playerMissileLaunchedAt = -99;
  }

  reset() {
    for (const m of this.missiles) this.scene.remove(m.mesh);
    this.bullets.length = 0; this.missiles.length = 0; this.flares.length = 0;
    this.stats = { shots: 0, hits: 0, launched: 0, missileHits: 0, flaresDropped: 0 }; this.lastPlayerMissile = null;
  }

  // ---------- cannon
  fireCannon(owner, origin, dir, ownerVel, { spread = 0.006, damage = 5, assistDir = null } = {}) {
    const d = _a.copy(assistDir || dir);
    d.x += (Math.random() - 0.5) * spread; d.y += (Math.random() - 0.5) * spread; d.z += (Math.random() - 0.5) * spread; d.normalize();
    const vel = d.clone().multiplyScalar(980).add(ownerVel);
    this.bullets.push({ pos: origin.clone(), prev: origin.clone(), vel, life: 1.7, owner, damage });
    if (owner.isPlayer) this.stats.shots++;
    this.fx.spark(origin, ownerVel.clone().addScaledVector(d, 40).add(new THREE.Vector3(rand(-6, 6), rand(-6, 6), rand(-6, 6))), 0.12);
    this.fx.emit({ pos: origin, life: 0.07, size0: 4, size1: 6, c0: [1, 0.85, 0.5, 0.9], c1: [1, 0.5, 0.1, 0], additive: true });
    this.h.audio?.play('cannon', owner.isPlayer ? 1 : 0.4 * clamp(1 - owner.pos.distanceTo(this.h.listener()) / 4000, 0, 1));
  }

  // ---------- missiles
  fireMissile(owner, target, origin, dir, ownerVel, opts = {}) {
    const mesh = this.mslProto.clone(true); mesh.userData.flame = mesh.children[mesh.children.length - 1];
    mesh.position.copy(origin); this.scene.add(mesh);
    const dm = this.h.diff().missile;
    const m = {
      mesh, pos: origin.clone(), dir: dir.clone().normalize(), speed: Math.max(ownerVel.length(), 120) + 40, owner, target, age: 0,
      maxG: (opts.maxG || 38) * (owner.isPlayer ? 1 : dm.enemyAgility), seeker: (opts.seeker || 58) * DEG * (owner.isPlayer ? 1 : dm.seeker),
      lost: 0, alive: true, trail: 0, ownerIsPlayer: !!owner.isPlayer, boost: 3.4, life: 17, vel: new THREE.Vector3()
    };
    m.vel.copy(m.dir).multiplyScalar(m.speed);
    this.missiles.push(m); owner.missilesLeft = Math.max(0, owner.missilesLeft - 1);
    if (owner.isPlayer) { this.stats.launched++; this.lastPlayerMissile = m; this.playerMissileLaunchedAt = performance.now(); }
    this.h.audio?.play('missile', owner.isPlayer ? 1 : 0.5);
    this.h.onLaunch?.(m);
    return m;
  }

  incoming(entity) { return this.missiles.filter((m) => m.alive && m.target === entity); }

  // ---------- flares
  dropFlares(owner, count = 2) {
    if (owner.flaresLeft <= 0) return false;
    const n = Math.min(count, owner.flaresLeft); owner.flaresLeft -= n;
    const back = owner.forward(_a).clone().multiplyScalar(-1);
    for (let i = 0; i < n; i++) {
      this.flares.push({ pos: owner.pos.clone().addScaledVector(back, 9 + i * 2), vel: owner.vel.clone().multiplyScalar(0.55).add(new THREE.Vector3(rand(-14, 14), -10 - rand(0, 9), rand(-14, 14))), age: 0, burn: 4 + rand(0, 2), owner, intensity: 1, trail: 0 });
    }
    if (owner.isPlayer) this.stats.flaresDropped += n;
    this.h.audio?.play('flare', owner.isPlayer ? 0.8 : 0.3);
    return true;
  }

  update(dt, now) {
    const entities = this.h.entities();
    this.updateFlares(dt);
    this.updateBullets(dt, entities);
    this.updateMissiles(dt, entities);
    this.renderTracers();
  }

  updateFlares(dt) {
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i]; f.age += dt;
      f.vel.multiplyScalar(Math.exp(-0.5 * dt)); f.vel.y -= 4.5 * dt; f.pos.addScaledVector(f.vel, dt);
      f.intensity = f.age < 0.25 ? f.age / 0.25 : clamp(1 - (f.age - 0.25) / (f.burn - 0.25), 0, 1);
      if (f.age > f.burn) { this.flares.splice(i, 1); continue; }
      this.fx.flareGlow(f.pos, 18 + 22 * f.intensity, 0.55 + 0.45 * f.intensity);
      f.trail -= dt; if (f.trail <= 0) { f.trail = 0.04; this.fx.smokePuff(f.pos, new THREE.Vector3(rand(-2, 2), rand(0, 2), rand(-2, 2)), 2.2, 2.2, 0.28 * f.intensity + 0.05); }
      if (Math.random() < 0.5) this.fx.spark(f.pos, new THREE.Vector3(rand(-10, 10), rand(-4, 12), rand(-10, 10)), 0.35);
    }
  }

  updateBullets(dt, entities) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i]; b.prev.copy(b.pos); b.pos.addScaledVector(b.vel, dt); b.life -= dt;
      let hit = false;
      for (const e of entities) {
        if (!e.alive || e === b.owner) continue;
        // closest point on segment to entity centre
        _b.copy(b.pos).sub(b.prev); const L2 = _b.lengthSq(); _c.copy(e.pos).sub(b.prev);
        const t = L2 > 0 ? clamp(_c.dot(_b) / L2, 0, 1) : 0; _d.copy(b.prev).addScaledVector(_b, t);
        if (_d.distanceToSquared(e.pos) < (e.radius * 0.85) ** 2) {
          if (b.owner.isPlayer) this.stats.hits++;
          this.h.damage(e, b.damage, b.owner, 'cannon');
          this.fx.spark(_d, new THREE.Vector3(rand(-30, 30), rand(-10, 40), rand(-30, 30)), 0.5);
          this.fx.emit({ pos: _d, life: 0.12, size0: 6, size1: 12, c0: [1, 0.8, 0.4, 0.9], c1: [1, 0.4, 0.1, 0], additive: true });
          hit = true; break;
        }
      }
      if (hit || b.life <= 0 || b.pos.y < this.h.groundY(b.pos.x, b.pos.z)) {
        if (!hit && b.life > 0) this.fx.smokePuff(b.pos, new THREE.Vector3(0, 6, 0), 5, 1.5, 0.3);
        this.bullets.splice(i, 1);
      }
    }
  }

  renderTracers() {
    const t = this.tracers; t.begin();
    for (const b of this.bullets) {
      t.push(b.pos.x, b.pos.y, b.pos.z, 2.6, 1, 0.8, 0.35, 0.95);
      t.push(b.pos.x - b.vel.x * 0.012, b.pos.y - b.vel.y * 0.012, b.pos.z - b.vel.z * 0.012, 1.8, 1, 0.55, 0.2, 0.7);
    }
    t.end();
  }

  updateMissiles(dt, entities) {
    const diff = this.h.diff();
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i]; m.age += dt;
      let tgt = m.target; const tpos = tgt ? tgt.pos : null;
      if (tgt && tgt.alive === false) { m.target = tgt = null; }
      if (tgt && tgt.burn !== undefined && tgt.age > tgt.burn) m.target = tgt = null;

      if (tgt) {
        _a.copy(tgt.pos).sub(m.pos); const range = _a.length(); _a.divideScalar(Math.max(range, 1));
        const off = Math.acos(clamp(_a.dot(m.dir), -1, 1));
        // flare seduction: only decoys released by the tracked aircraft count
        if (tgt.id !== undefined && m.age > 0.6) {
          for (const f of this.flares) {
            if (f.owner !== tgt || f.intensity < 0.35) continue;
            _b.copy(f.pos).sub(m.pos); const fr = _b.length();
            if (fr > 2800 || Math.acos(clamp(_b.normalize().dot(m.dir), -1, 1)) > m.seeker) continue;
            const base = m.ownerIsPlayer ? 0.55 * (1 - 0.35 * (tgt.def?.traits?.skill ?? 0.3)) : diff.missile.flareSeduction;
            if (Math.random() < base * f.intensity * dt * 2.2) { m.target = f; tgt = f; break; }
          }
        }
        // seeker field of view
        if (tgt && off > m.seeker) { m.lost += dt; if (m.lost > 0.7) { m.target = tgt = null; } } else m.lost = Math.max(0, m.lost - dt);
      }

      if (tgt) {
        const range = tgt.pos.distanceTo(m.pos), tI = clamp(range / Math.max(m.speed, 100), 0, 4);
        _b.copy(tgt.pos).addScaledVector(tgt.vel || _c.set(0, 0, 0), tI * 0.85).sub(m.pos).normalize();
        const ang = Math.acos(clamp(_b.dot(m.dir), -1, 1)), maxTurn = (m.maxG * G) / Math.max(m.speed, 60) * dt;
        if (ang > 1e-4) m.dir.lerp(_b, Math.min(1, maxTurn / ang)).normalize();
      }
      // propulsion
      if (m.age < m.boost) m.speed = Math.min(560, m.speed + 190 * dt); else m.speed = Math.max(0, m.speed - (14 + m.speed * 0.045) * dt);
      m.vel.copy(m.dir).multiplyScalar(m.speed); m.pos.addScaledVector(m.vel, dt);
      m.mesh.position.copy(m.pos); m.mesh.lookAt(_a.copy(m.pos).add(m.dir)); m.mesh.userData.flame.visible = m.age < m.boost;
      m.trail -= dt;
      if (m.trail <= 0) {
        m.trail = 0.018;
        _a.copy(m.pos).addScaledVector(m.dir, -2.4);
        this.fx.smokePuff(_a, _b.set(rand(-1.5, 1.5), rand(-1, 1.5), rand(-1.5, 1.5)), m.age < m.boost ? 2.6 : 1.8, 3.4, m.age < m.boost ? 0.55 : 0.3);
        if (m.age < m.boost) this.fx.fire(_a, m.vel.clone().multiplyScalar(0.1), 3.4, 0.25);
      }
      // proximity fuse / ground / timeout
      let boom = false, victim = null;
      for (const e of entities) {
        if (!e.alive || e === m.owner && m.age < 2.5) continue;
        const dd = e.pos.distanceTo(m.pos);
        const fuse = (m.target === e ? 24 : 12) + e.radius * 0.6;
        if (dd < fuse && m.age > 0.25) { boom = true; victim = e; break; }
      }
      if (m.pos.y < this.h.groundY(m.pos.x, m.pos.z) + 1) boom = true;
      const dead = m.age > m.life || (m.age > m.boost && m.speed < 150);
      if (boom || dead) {
        this.missiles.splice(i, 1); this.scene.remove(m.mesh); m.alive = false;
        if (this.lastPlayerMissile === m) this.lastPlayerMissile = null;
        if (boom) this.detonate(m, entities, victim);
        else this.fx.smokePuff(m.pos, new THREE.Vector3(), 6, 2, 0.4);
      }
    }
  }

  detonate(m, entities, primary) {
    this.fx.explosion(m.pos.clone(), 1.1);
    this.h.explosion(m.pos.clone(), 1.1, m.owner);
    for (const e of entities) {
      if (!e.alive) continue;
      const dd = e.pos.distanceTo(m.pos) - e.radius * 0.4;
      if (dd > 55) continue;
      const dmg = 120 * Math.pow(1 - clamp(dd / 55, 0, 1), 0.8);
      if (dmg < 4) continue;
      if (m.ownerIsPlayer && e === primary) this.stats.missileHits++;
      this.h.damage(e, dmg, m.owner, 'missile');
    }
  }
}
