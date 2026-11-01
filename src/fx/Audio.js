import * as THREE from 'three';
import { asset } from '../character/Assets.js';

// WebAudio: decoded mp3 samples with pitch variation and distance attenuation/pan.
export class GameAudio {
  constructor(listener) {
    this.listener = listener; this.ctx = null; this.buf = new Map(); this.master = 0.6;
  }
  async init() {
    const AC = window.AudioContext || window.webkitAudioContext; this.ctx = new AC();
    this.out = this.ctx.createGain(); this.out.gain.value = this.master; this.out.connect(this.ctx.destination);
    await Promise.all(['bolt', 'kar_shot', 'mag_in', 'pistol_shot', 'rifle_shot', 'rifle_tail', 'slide_rack'].map(async n => {
      try { this.buf.set(n, await this.ctx.decodeAudioData(await (await fetch(asset(`sfx/${n}.mp3`))).arrayBuffer())); } catch (e) { console.warn('sfx', n, e); }
    }));
  }
  resume() { this.ctx?.resume(); }
  play(name, { pos, vol = 1, rate = 1, own = false, ref = 8 } = {}) {
    const b = this.buf.get(name); if (!b || !this.ctx) return;
    const src = this.ctx.createBufferSource(); src.buffer = b; src.playbackRate.value = rate * (0.97 + Math.random() * 0.06);
    const g = this.ctx.createGain(); let node = g;
    if (pos && !own) {
      const rel = pos.clone().sub(this.listener.pos), dist = rel.length();
      g.gain.value = vol * Math.min(1, ref / Math.max(ref, dist)) ** 1.1;
      const pan = this.ctx.createStereoPanner?.(); if (pan) { const r = new THREE.Vector3(Math.cos(this.listener.yaw), 0, -Math.sin(this.listener.yaw)); pan.pan.value = THREE.MathUtils.clamp(-rel.normalize().dot(r), -1, 1) * 0.8; g.connect(pan); node = pan; }
    } else g.gain.value = vol;
    src.connect(g); node.connect(this.out); src.start();
  }
  weapon(kind, def, pos, own) {
    const o = { pos, own, vol: def.vol ?? 1, ref: kind === 'shot' ? 25 : 6 };
    if (kind === 'shot') { this.play(def.sfx, { ...o, rate: def.pitch ?? 1 }); if (def.sfx !== 'pistol_shot') this.play('rifle_tail', { ...o, vol: o.vol * 0.4, ref: 40 }); }
    else if (kind === 'reload') this.play(def.reloadStyle === 'shell' ? 'bolt' : 'mag_in', { ...o, vol: 0.7 });
    else if (kind === 'shell') this.play('mag_in', { ...o, vol: 0.4, rate: 1.4 });
    else if (kind === 'cycle') this.play(def.pump ? 'slide_rack' : 'bolt', { ...o, vol: 0.8 });
    else if (kind === 'dry') this.play('slide_rack', { ...o, vol: 0.3, rate: 1.6 });
  }
}
