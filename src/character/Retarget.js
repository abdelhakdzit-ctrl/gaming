import * as THREE from 'three';
import { BONE_MAP } from '../data/clips.js';

const FPS = 30;

// Bakes Mixamo-rig clips onto the UE Mannequin skeleton by transferring world-space
// rotation deltas from the source rest pose (works across T/A-pose and axis conventions).
export class Retargeter {
  constructor(tgtScene) {
    tgtScene.updateMatrixWorld(true);
    this.bones = []; this.index = new Map();
    tgtScene.traverse(o => { if (o.isBone) { this.index.set(o, this.bones.length); this.bones.push(o); } });
    this.byName = new Map(this.bones.map((b, i) => [b.name, i]));
    this.parent = this.bones.map(b => this.index.get(b.parent) ?? -1);
    this.restLocal = this.bones.map(b => b.quaternion.clone());
    this.restWorld = this.bones.map(b => b.getWorldQuaternion(new THREE.Quaternion()));
    this.rootParentQ = this.bones.map(b => b.parent.getWorldQuaternion(new THREE.Quaternion()));
    const pb = this.bones[this.byName.get('pelvis')];
    this.pelvisParentInv = pb.parent.matrixWorld.clone().invert();
    this.pelvisRestWorld = pb.getWorldPosition(new THREE.Vector3());
    this.posScale = null;
  }

  // srcScene: FBX with animations[0]. Returns a baked AnimationClip for the target skeleton.
  bake(srcScene, name, { loop = true } = {}) {
    const srcClip = srcScene.animations[0];
    srcScene.updateMatrixWorld(true);
    const pairs = [];
    for (const [s, t] of Object.entries(BONE_MAP)) {
      const sb = srcScene.getObjectByName(s), ti = this.byName.get(t);
      if (sb && ti !== undefined) pairs.push({ sb, ti, restInv: sb.getWorldQuaternion(new THREE.Quaternion()).invert() });
    }
    const pairByTgt = new Map(pairs.map((p, k) => [p.ti, k]));
    const hips = srcScene.getObjectByName('Hips');
    const dur = srcClip.duration, n = Math.max(2, Math.ceil(dur * FPS) + 1);
    const times = new Float32Array(n);
    const mixer = new THREE.AnimationMixer(srcScene);
    mixer.clipAction(srcClip).play();

    const hipsPos = [], deltas = [];
    const tp = new THREE.Vector3(), ts = new THREE.Vector3(), q = new THREE.Quaternion();
    for (let i = 0; i < n; i++) {
      const t = Math.min(dur, i / FPS); times[i] = t;
      mixer.setTime(t); srcScene.updateMatrixWorld(true);
      hips.matrixWorld.decompose(tp, q, ts); hipsPos.push(tp.clone());
      deltas.push(pairs.map(p => { p.sb.matrixWorld.decompose(tp, q, ts); return q.clone().multiply(p.restInv); }));
    }
    mixer.stopAllAction(); mixer.uncacheRoot(srcScene);
    if (this.posScale === null) this.posScale = this.pelvisRestWorld.y / hipsPos[0].y;
    const S = this.posScale;

    const nb = this.bones.length;
    const out = new Map(pairs.map(p => [p.ti, new Float32Array(n * 4)]));
    const wq = new Array(nb);
    const inv = new THREE.Quaternion();
    for (let f = 0; f < n; f++) {
      for (let i = 0; i < nb; i++) {
        const pi = this.parent[i];
        const parentQ = pi >= 0 ? wq[pi] : this.rootParentQ[i];
        const k = pairByTgt.get(i);
        if (k !== undefined) {
          const desired = deltas[f][k].clone().multiply(this.restWorld[i]);
          inv.copy(parentQ).invert().multiply(desired).toArray(out.get(i), f * 4);
          wq[i] = desired;
        } else wq[i] = parentQ.clone().multiply(this.restLocal[i]);
      }
    }
    const tracks = [];
    for (const [ti, arr] of out) tracks.push(new THREE.QuaternionKeyframeTrack(`${this.bones[ti].name}.quaternion`, times, arr));

    // Loops: in-place (linear drift removed, sway kept). One-shots: pelvis is held at its standing
    // position and the displacement/lift curves are returned so the controller applies the real
    // motion (vault, roll, jump arcs) with collision.
    const first = hipsPos[0], last = hipsPos[n - 1];
    const drift = new THREE.Vector3(last.x - first.x, 0, last.z - first.z);
    const speed = loop ? drift.length() * S / 100 / dur : 0;
    const pv = new Float32Array(n * 3), motion = new Float32Array(n * 2), lift = new Float32Array(n);
    const base = this.pelvisRestWorld;
    for (let i = 0; i < n; i++) {
      const h = hipsPos[i], u = times[i] / dur;
      let wx, wy, wz;
      if (loop) {
        wx = base.x + (h.x - first.x - drift.x * u) * S; wz = base.z + (h.z - first.z - drift.z * u) * S; wy = h.y * S;
      } else {
        wx = base.x; wz = base.z; wy = first.y * S;
        motion[i * 2] = (h.x - first.x) * S / 100; motion[i * 2 + 1] = (h.z - first.z) * S / 100;
        lift[i] = (h.y - first.y) * S / 100;
      }
      tp.set(wx, wy, wz).applyMatrix4(this.pelvisParentInv).toArray(pv, i * 3);
    }
    tracks.push(new THREE.VectorKeyframeTrack('pelvis.position', times, pv));
    const clip = new THREE.AnimationClip(name, dur, tracks);
    clip.userData = { loop, speed, motion: loop ? null : motion, lift: loop ? null : lift, times, fps: FPS };
    return clip;
  }
}

// Displacement (m, in the character's local frame, +z forward) and vertical lift of a baked one-shot at time t.
export function sampleMotion(clip, t) {
  const u = clip.userData; if (!u.motion) return { x: 0, z: 0, y: 0 };
  const f = Math.min(u.times.length - 1.001, Math.max(0, t * u.fps)), i = Math.floor(f), a = f - i;
  const L = (arr, k, s) => arr[i * s + k] * (1 - a) + arr[(i + 1) * s + k] * a;
  return { x: L(u.motion, 0, 2), z: L(u.motion, 1, 2), y: L(u.lift, 0, 1) };
}
