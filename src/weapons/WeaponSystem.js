import * as THREE from 'three';
import { WEAPONS } from '../data/weapons.js';

// Per-character weapon inventory + firing/reload state machine. Stats live in data/weapons.js;
// models, reload and bolt-cycle timing come from the baked grip library (assets.grips).
// `seq` / `seqT` tell the character which baked upper-body sequence to play.
export class WeaponSystem {
  constructor(owner, ids, { infinite = false } = {}) {
    this.owner = owner; this.infinite = infinite;
    const lib = owner.game.assets.grips;
    this.slots = ids.filter(id => WEAPONS[id] && lib.get(WEAPONS[id].model)).map(id => {
      const def = WEAPONS[id], model = lib.instance(def.model); model.visible = false;
      return { id, def, mag: def.mag, reserve: def.reserve, model, grip: lib.get(def.model) };
    });
    this.index = 0; this.state = 'ready'; this.t = 0; this.cool = 0; this.bloom = 0;
    this.trigger = false; this.triggerPrev = false;
    this.seq = null; this.seqT = 0; this.seqDur = 0; this.reloadProgress = 0; this.shots = 0;
    this.lastShot = -99; this.time = 0;
  }
  get slot() { return this.slots[this.index]; }
  get def() { return this.slot.def; }
  get busy() { return this.state !== 'ready'; }
  get ammoText() { return `${this.slot.mag} / ${this.infinite ? '∞' : this.slot.reserve}`; }

  select(i) {
    if (i === this.index || i < 0 || i >= this.slots.length || this.state !== 'ready') return false;
    this.state = 'switch'; this.t = 0; this.switchDur = 0.8; this.nextIndex = i; this.seq = null;
    this.owner.events?.emit('weaponSwitch', { owner: this.owner });
    return true;
  }
  cycle(dir) { this.select((this.index + dir + this.slots.length) % this.slots.length); }

  play(seq, state) {
    const s = this.slot.grip.seqs[seq]; if (!s) return false;
    this.state = state; this.seq = seq; this.seqT = 0; this.seqDur = s.duration; this.reloadProgress = 0;
    return true;
  }
  reload() {
    const s = this.slot;
    if (this.state !== 'ready' || s.mag >= s.def.mag || (!this.infinite && s.reserve <= 0)) return false;
    const seqs = s.grip.seqs, seq = s.mag === 0 || !seqs.reload ? 'reloadEmpty' : 'reload';
    if (!this.play(seq, 'reload')) return false;
    this.owner.sound?.('reload', s.def);
    return true;
  }

  currentSpread() {
    const o = this.owner, d = this.def.spread, ads = o.intent.ads;
    let s = ads ? d.ads : d.hip;
    if (o.crouching) s = Math.min(s, ads ? d.ads : d.crouch);
    s += (o.speed / 4) * d.move * (ads ? 0.35 : 0.5);
    return s + this.bloom;
  }

  update(dt) {
    const s = this.slot, d = s.def;
    this.time += dt;
    this.cool = Math.max(0, this.cool - dt);
    this.bloom = Math.max(0, this.bloom - dt * 3);
    if (this.state === 'switch') {
      this.t += dt / this.switchDur;
      if (this.t >= 0.5 && this.nextIndex !== undefined) { this.slot.model.visible = false; this.index = this.nextIndex; this.nextIndex = undefined; this.owner.onWeaponChanged?.(); }
      if (this.t >= 1) { this.state = 'ready'; this.t = 0; }
    } else if (this.state === 'reload' || this.state === 'cycle') {
      this.seqT += dt; this.reloadProgress = Math.min(1, this.seqT / this.seqDur);
      if (this.seqT >= this.seqDur) {
        if (this.state === 'reload') {
          const need = d.mag - s.mag, take = this.infinite ? need : Math.min(need, s.reserve);
          s.mag += take; if (!this.infinite) s.reserve -= take;
        }
        this.state = 'ready'; this.seq = null; this.reloadProgress = 0;
      }
    }
    const pressed = this.trigger && (d.auto || !this.triggerPrev);
    if (this.state === 'ready' && pressed && this.cool <= 0) {
      if (s.mag > 0) this.fire();
      else if (!this.triggerPrev) { this.owner.sound?.('dry', d); this.reload(); }
    }
    this.triggerPrev = this.trigger;
  }

  fire() {
    const s = this.slot, d = s.def, o = this.owner;
    s.mag--; this.shots++; this.cool = 60 / d.rpm; this.lastShot = this.time;
    this.bloom = Math.min(4, this.bloom + (d.auto ? 0.28 : 0.9) * (d.recoil.pitch * 0.5));
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
    if (d.bolt && s.mag > 0) { this.play('cycle', 'cycle'); this.seqT = -0.25; o.sound?.('cycle', d); } // short pause before working the bolt
  }
}
