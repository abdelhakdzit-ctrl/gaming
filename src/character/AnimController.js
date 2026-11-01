import * as THREE from 'three';
import { LOCOMOTION } from '../data/clips.js';
import { clamp, damp } from '../core/math.js';
import { sampleMotion } from './Retarget.js';

// Data-driven animation state: directional locomotion blending (phase-synced, stride-scaled)
// plus a one-shot layer (jump, roll, vault, ...). New moves = new CLIPS entry + playOnce().
export class AnimController {
  constructor(root, assets) {
    this.assets = assets;
    this.mixer = new THREE.AnimationMixer(root);
    this.actions = new Map();
    this.w = new Map();          // smoothed locomotion weights per clip
    this.phase = 0;
    this.one = null;             // active one-shot {name, action, clip, w, fadeIn, fadeOut, last, onMove}
    this.loco = { set: 'stand', gait: 'walk', speed: 0, dx: 0, dz: 1, moving: false };
    this.frozen = false;
  }
  action(name) {
    let a = this.actions.get(name);
    if (!a) {
      const clip = this.assets.clips.get(name);
      if (!clip) { this.assets.getClip(name); return null; } // lazy: available next frames
      a = this.mixer.clipAction(clip); a.play(); a.setEffectiveWeight(0); a.setEffectiveTimeScale(0);
      this.actions.set(name, a);
    }
    return a;
  }
  get busy() { return !!this.one; }
  get oneName() { return this.one?.name; }

  // dx: +right, dz: +forward in the character frame; speed in m/s.
  setLocomotion(loco) { Object.assign(this.loco, loco); }

  playOnce(name, { fadeIn = 0.12, fadeOut = 0.15, timeScale = 1, onMove, onDone } = {}) {
    const clip = this.assets.clips.get(name);
    if (!clip) { this.assets.getClip(name); return false; }
    this.stopOnce(true);
    const action = this.mixer.clipAction(clip);
    action.reset().setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true;
    action.setEffectiveTimeScale(timeScale).setEffectiveWeight(0).play();
    this.one = { name, action, clip, w: 0, fadeIn, fadeOut, last: { x: 0, z: 0, y: 0 }, onMove, onDone, timeScale };
    return clip.duration / timeScale;
  }
  stopOnce(silent) {
    if (!this.one) return;
    this.one.action.stop(); const { onDone } = this.one; this.one = null;
    if (!silent) onDone?.();
  }

  update(dt) {
    if (this.frozen) return;
    const L = this.loco, set = LOCOMOTION[L.set];
    const target = new Map();
    const moveBlend = L.moving ? 1 : 0;
    target.set(set.idle, 1 - moveBlend);
    let rate = 0;
    if (L.moving) {
      const g = set.gaits[L.gait];
      const n = Math.hypot(L.dx, L.dz) || 1, dx = L.dx / n, dz = L.dz / n;
      const dirs = { f: Math.max(0, dz), b: Math.max(0, -dz), r: Math.max(0, dx), l: Math.max(0, -dx) };
      let sum = 0; for (const k in dirs) { dirs[k] **= 1.5; sum += dirs[k]; }
      for (const k in dirs) { const c = g[k]; target.set(c, (target.get(c) ?? 0) + dirs[k] / sum); }
    }
    // Smooth weights over all clips ever used by this controller.
    for (const c of target.keys()) if (!this.w.has(c)) this.w.set(c, 0);
    let total = 0;
    for (const [c, cur] of this.w) { const v = damp(cur, target.get(c) ?? 0, 10, dt); this.w.set(c, v < 0.002 && !target.get(c) ? 0 : v); total += this.w.get(c); }
    const oneW = this.one ? this.one.w : 0;
    // Phase advance from the weighted stride ratio of active moving clips.
    if (L.moving) {
      let r = 0, ws = 0;
      for (const [c, w] of this.w) {
        if (c === set.idle || w <= 0) continue; const clip = this.assets.clips.get(c); if (!clip) continue;
        const stride = clip.userData.speed || L_STRIDE_FALLBACK;
        r += w * clamp(L.speed / stride, 0.45, 1.9) / clip.duration; ws += w;
      }
      rate = ws ? r / ws : 0; this.phase = (this.phase + rate * dt) % 1;
    } else this.phase = (this.phase + dt / 4) % 1;
    for (const [c, w] of this.w) {
      const a = this.action(c); if (!a) continue;
      if (w <= 0) { a.setEffectiveWeight(0); continue; }
      a.setEffectiveWeight(total > 0 ? w / total * (1 - oneW) : 0);
      a.time = (c === set.idle || c === 'crouch_idle' ? this.phase : this.phase) * a.getClip().duration;
    }
    // One-shot layer
    const o = this.one;
    if (o) {
      const t = o.action.time, d = o.clip.duration;
      const finishing = t >= d - o.fadeOut * o.timeScale - 1e-3;
      o.w = clamp(o.w + (finishing ? -dt / o.fadeOut : dt / o.fadeIn), 0, 1);
      o.action.setEffectiveWeight(o.w || 0.0001);
      const s = sampleMotion(o.clip, t);
      o.onMove?.(s.x - o.last.x, s.z - o.last.z, s.y, s); o.last = s;
      this.liftY = s.y;
      if (finishing && o.w <= 0 || t >= d && o.w <= 0) { this.stopOnce(); this.liftY = 0; }
    } else this.liftY = 0;
    this.mixer.update(dt);
  }
}
const L_STRIDE_FALLBACK = 1.5;
