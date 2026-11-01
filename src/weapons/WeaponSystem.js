import * as THREE from 'three';
import { WEAPONS } from '../data/weapons.js';
import { buildWeaponModel } from './WeaponModels.js';
import { rand } from '../core/math.js';

// Per-character weapon inventory + firing/reload state machine. Data lives in data/weapons.js.
export class WeaponSystem {
  constructor(owner, ids, { infinite = false } = {}) {
    this.owner = owner; this.infinite = infinite;
    this.slots = ids.map(id => {
      const def = WEAPONS[id];
      const model = buildWeaponModel(def.model); model.visible = false;
      return { id, def, mag: def.mag, reserve: def.reserve, model };
    });
    this.index = 0; this.state = 'ready'; this.t = 0; this.cool = 0; this.bloom = 0;
    this.trigger = false; this.triggerPrev = false; this.pendingCycle = false;
    this.reloadProgress = 0; this.shots = 0;
  }
  get slot() { return this.slots[this.index]; }
  get def() { return this.slot.def; }
  get busy() { return this.state !== 'ready'; }
  get ammoText() { return `${this.slot.mag} / ${this.infinite ? '∞' : this.slot.reserve}`; }

  select(i) {
    if (i === this.index || i < 0 || i >= this.slots.length || this.state === 'switch') return false;
    this.state = 'switch'; this.t = 0.45; this.nextIndex = i; this.reloadProgress = 0;
    this.owner.events?.emit('weaponSwitch', { owner: this.owner });
    return true;
  }
  cycle(dir) { this.select((this.index + dir + this.slots.length) % this.slots.length); }

  reload() {
    const s = this.slot;
    if (this.state !== 'ready' || s.mag >= s.def.mag || (!this.infinite && s.reserve <= 0)) return false;
    this.state = 'reload'; this.reloadTotal = s.def.reload; this.t = this.reloadTotal; this.shellMode = s.def.reloadStyle === 'shell';
    this.owner.sound?.('reload', s.def);
    return true;
  }

  currentSpread() {
    const o = this.owner, d = this.def.spread;
    let s = o.intent.ads ? d.ads : d.hip;
    if (o.crouching) s = Math.min(s, o.intent.ads ? d.ads : d.crouch);
    s += (o.speed / 4) * (d.move - (o.intent.ads ? d.ads : d.hip) * 0.0) * (o.intent.ads ? 0.35 : 0.5);
    return s + this.bloom;
  }

  update(dt) {
    const s = this.slot, d = s.def;
    this.cool = Math.max(0, this.cool - dt);
    this.bloom = Math.max(0, this.bloom - dt * 3);
    if (this.state === 'switch') {
      this.t -= dt; if (this.t <= 0.22 && this.nextIndex !== undefined) { this.slot.model.visible = false; this.index = this.nextIndex; this.nextIndex = undefined; this.owner.onWeaponChanged?.(); }
      if (this.t <= 0) this.state = 'ready';
    } else if (this.state === 'reload') {
      this.t -= dt; this.reloadProgress = 1 - Math.max(0, this.t) / this.reloadTotal;
      if (this.t <= 0) {
        if (this.shellMode) {
          if (s.mag < d.mag && (this.infinite || s.reserve > 0)) { s.mag++; if (!this.infinite) s.reserve--; this.owner.sound?.('shell', d); }
          if (s.mag < d.mag && (this.infinite || s.reserve > 0) && !this.cancelReload) this.t = this.reloadTotal;
          else { this.state = 'ready'; this.cancelReload = false; this.reloadProgress = 0; if (d.bolt) { this.state = 'cycle'; this.t = d.bolt * 0.6; } }
        } else {
          const need = d.mag - s.mag, take = this.infinite ? need : Math.min(need, s.reserve);
          s.mag += take; if (!this.infinite) s.reserve -= take; this.state = 'ready'; this.reloadProgress = 0;
        }
      }
    } else if (this.state === 'cycle') {
      this.t -= dt; this.reloadProgress = 1 - Math.max(0, this.t) / (d.bolt ? d.bolt * 0.6 : 0.3);
      if (this.t <= 0) { this.state = 'ready'; this.reloadProgress = 0; }
    }
    const pressed = this.trigger && (d.auto || !this.triggerPrev);
    if (this.state === 'reload' && this.shellMode && pressed && s.mag > 0) this.cancelReload = true;
    if (this.state === 'ready' && this.trigger && pressed && this.cool <= 0) {
      if (s.mag > 0) this.fire();
      else if (!this.triggerPrev) { this.owner.sound?.('dry', d); this.reload(); }
    }
    this.triggerPrev = this.trigger;
  }

  fire() {
    const s = this.slot, d = s.def, o = this.owner;
    s.mag--; this.shots++; this.cool = 60 / d.rpm; this.bloom = Math.min(4, this.bloom + (d.auto ? 0.28 : 0.9) * (d.recoil.pitch * 0.5));
    const { origin, dir } = o.getAimRay();
    const muzzle = s.model.userData.muzzle.getWorldPosition(new THREE.Vector3());
    const spread = THREE.MathUtils.degToRad(this.currentSpread());
    const right = new THREE.Vector3().crossVectors(dir, THREE.Object3D.DEFAULT_UP).normalize(), up = new THREE.Vector3().crossVectors(right, dir);
    const game = o.game;
    for (let i = 0; i < d.pellets; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread;
      const sd = dir.clone().addScaledVector(right, Math.cos(a) * Math.tan(r)).addScaledVector(up, Math.sin(a) * Math.tan(r)).normalize();
      game.shoot({ owner: o, origin, dir: sd, muzzle, def: d });
    }
    o.sound?.('shot', d, muzzle);
    game.fx.muzzleFlash(s.model.userData.muzzle, d);
    game.events.emit('gunshot', { pos: muzzle.clone(), owner: o, loudness: d.noise });
    o.onFired?.(d);
    if (d.pump || d.bolt) { this.pendingCycle = true; }
    if (s.mag === 0 && !d.pump && !d.bolt) { /* dry next trigger */ }
    if (d.pump || d.bolt) setTimeout(() => {}, 0);
    if (d.pump || d.bolt) { this.state = 'cycle'; this.t = d.pump ?? d.bolt; this.reloadProgress = 0; o.sound?.('cycle', d); }
  }
}
