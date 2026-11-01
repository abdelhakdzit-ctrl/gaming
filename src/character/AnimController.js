import * as THREE from 'three';
import { LOCOMOTION } from '../data/clips.js';
import { clamp, damp } from '../core/math.js';
import { sampleMotion } from './Retarget.js';

const DIRS = ['f', 'r', 'b', 'l'];
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

// Locomotion blend space + one-shot layer.
//  - Loop clips are single gait cycles that start on a left-foot plant, so all directions and gaits
//    share one normalized phase (feet stay in step while blending).
//  - Blend weights come from each clip's measured root velocity direction (handles off-axis strafes),
//    and playback rate follows ground speed / blended clip speed (no foot sliding).
//  - One-shots return root motion (dx, dz, dyaw) every frame; the character applies it with collision.
export class AnimController {
  constructor(root, assets) {
    this.assets = assets;
    this.mixer = new THREE.AnimationMixer(root);
    this.actions = new Map();
    this.w = new Map();
    this.phase = 0; this.idleT = 0;
    this.one = null;
    this.loco = { set: 'stand', speed: 0, dx: 0, dz: 1 };
    this.hipYaw = 0;
    this.frozen = false;
  }
  clip(name) { const c = this.assets.clips.get(name); if (!c) this.assets.getClip(name); return c; }
  action(name) {
    let a = this.actions.get(name);
    if (!a) {
      const clip = this.clip(name); if (!clip) return null;
      a = this.mixer.clipAction(clip); a.play(); a.setEffectiveWeight(0); a.setEffectiveTimeScale(0);
      this.actions.set(name, a);
    }
    return a;
  }
  get busy() { return !!this.one; }
  get oneName() { return this.one?.name; }
  setLocomotion(loco) { Object.assign(this.loco, loco); }

  // Directional blend of one gait for heading angle th (0 = forward, +pi/2 = right).
  // Returns { weights: [[clip, w]...], speed (m/s at rate 1), period (s), hipYaw }.
  dirBlend(setName, gait, th) {
    const g = LOCOMOTION[setName].gaits[gait], items = [];
    for (const k of DIRS) {
      const c = g[k] && this.clip(g[k]); if (!c || items.some(i => i.name === g[k])) continue;
      const v = c.userData.vel; items.push({ name: g[k], a: Math.atan2(-v.x, v.z), speed: c.userData.speed, T: c.duration });
    }
    if (!items.length) return null;
    let res;
    if (items.length < 3) { // forward/back only: pick the closer one and twist the legs toward the heading
      const it = items.reduce((p, c) => Math.abs(wrap(th - c.a)) < Math.abs(wrap(th - p.a)) ? c : p);
      res = { weights: [[it.name, 1]], speed: it.speed, period: it.T, hipYaw: clamp(wrap(th - it.a), -1.3, 1.3) };
    } else {
      items.sort((p, q) => p.a - q.a);
      let i0 = items.length - 1, i1 = 0;
      for (let i = 0; i < items.length; i++) { const j = (i + 1) % items.length; const span = wrap(items[j].a - items[i].a + 1e-9) || 2 * Math.PI; const d = wrap(th - items[i].a);
        if (d >= 0 && d <= (span < 0 ? span + 2 * Math.PI : span)) { i0 = i; i1 = j; break; } }
      const A = items[i0], B = items[i1];
      let span = wrap(B.a - A.a); if (span <= 0) span += 2 * Math.PI;
      let d = wrap(th - A.a); if (d < 0) d += 2 * Math.PI;
      const u = clamp(d / span, 0, 1);
      res = { weights: [[A.name, 1 - u], [B.name, u]], speed: A.speed * (1 - u) + B.speed * u, period: A.T * (1 - u) + B.T * u, hipYaw: 0 };
    }
    return res;
  }
  // Natural ground speed of a gait in a direction (used as the character's max speed).
  gaitSpeed(setName, gait, dx, dz) { return this.dirBlend(setName, gait, Math.atan2(dx, dz))?.speed ?? 1.5; }

  playOnce(name, { fadeIn = 0.12, fadeOut = 0.15, timeScale = 1, start, end, onMove, onDone } = {}) {
    const clip = this.clip(name); if (!clip) return false;
    const r = clip.userData.range; start ??= r?.[0] ?? 0; end ??= r?.[1] ?? clip.duration;
    this.stopOnce(true);
    const action = this.mixer.clipAction(clip);
    action.reset().setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.time = start;
    action.setEffectiveTimeScale(timeScale).setEffectiveWeight(0).play();
    const s0 = sampleMotion(clip, start);
    this.one = { name, action, clip, w: 0, fadeIn, fadeOut, end: end ?? clip.duration, last: s0, onMove, onDone, timeScale };
    return ((end ?? clip.duration) - start) / timeScale;
  }
  stopOnce(silent) {
    if (!this.one) return;
    this.one.action.stop(); const { onDone } = this.one; this.one = null;
    if (!silent) onDone?.();
  }

  update(dt) {
    if (this.frozen) return;
    const L = this.loco, set = LOCOMOTION[L.set];
    const target = new Map([[set.idle, 0]]);
    const th = Math.atan2(L.dx, L.dz);
    // 1D speed blend across gaits (idle -> walk -> run -> sprint), each gait a directional blend.
    const gaits = [];
    for (const g of Object.keys(set.gaits)) { const b = this.dirBlend(L.set, g, th); if (b && (!gaits.length || b.speed > gaits[gaits.length - 1].speed + 0.1)) gaits.push(b); }
    let rate = 1, period = 1, moveW = 0, hip = 0;
    if (gaits.length) {
      let g0 = gaits[0], g1 = gaits[0], u = 0;
      if (L.speed <= gaits[0].speed) { moveW = clamp(L.speed / (gaits[0].speed * 0.55), 0, 1); rate = clamp(L.speed / gaits[0].speed, 0.55, 1); }
      else {
        moveW = 1;
        for (let i = 0; i + 1 < gaits.length; i++) if (L.speed > gaits[i].speed) { g0 = gaits[i]; g1 = gaits[i + 1]; }
        if (g1 === g0 || L.speed >= g1.speed) { g0 = g1 = gaits[gaits.length - 1]; rate = clamp(L.speed / g1.speed, 1, 1.35); }
        else { u = (L.speed - g0.speed) / (g1.speed - g0.speed); rate = L.speed / (g0.speed * (1 - u) + g1.speed * u); }
      }
      if (moveW > 0) {
        for (const [c, w] of g0.weights) target.set(c, (target.get(c) ?? 0) + w * (1 - u) * moveW);
        if (g1 !== g0) for (const [c, w] of g1.weights) target.set(c, (target.get(c) ?? 0) + w * u * moveW);
        period = g0.period * (1 - u) + g1.period * u; hip = g0.hipYaw * (1 - u) + g1.hipYaw * u;
      }
    }
    target.set(set.idle, (target.get(set.idle) ?? 0) + 1 - moveW);
    this.hipYaw = damp(this.hipYaw, moveW > 0.3 ? hip : 0, 8, dt);
    for (const c of target.keys()) if (!this.w.has(c)) this.w.set(c, 0);
    let total = 0;
    for (const [c, cur] of this.w) { let v = damp(cur, target.get(c) ?? 0, 9, dt); if (v < 0.003 && !target.get(c)) v = 0; this.w.set(c, v); total += v; }
    if (moveW > 0) this.phase = (this.phase + dt * rate / period) % 1;
    this.idleT += dt;
    const oneW = this.one ? this.one.w : 0;
    for (const [c, w] of this.w) {
      const a = this.action(c); if (!a) continue;
      a.setEffectiveWeight(total > 0 && w > 0 ? w / total * (1 - oneW) : 0);
      const d = a.getClip().duration;
      a.time = a.getClip().userData.cyclic ? this.phase * d : this.idleT % d;
    }
    // One-shot layer with root motion.
    const o = this.one;
    if (o) {
      const t = o.action.time, d = o.end;
      const finishing = t >= d - o.fadeOut * o.timeScale - 1e-3;
      o.w = clamp(o.w + (finishing ? -dt / o.fadeOut : dt / o.fadeIn), 0, 1);
      o.action.setEffectiveWeight(o.w || 0.0001);
      const s = sampleMotion(o.clip, Math.min(t, d));
      o.onMove?.(s.x - o.last.x, s.z - o.last.z, s.yaw - o.last.yaw, o.w); o.last = s;
      if ((finishing && o.w <= 0) || t >= d) this.stopOnce();
    }
    this.mixer.update(dt);
  }
}
