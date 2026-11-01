import * as THREE from 'three';
import { BONE_MAP } from '../data/clips.js';

const FPS = 30;
const UP = new THREE.Vector3(0, 1, 0);

// Target bone -> child used for its rest direction (both rigs are measured with the same pairs).
const DIR_CHILD = { pelvis: 'spine_01', spine_01: 'spine_02', spine_02: 'spine_03', spine_03: 'neck_01', neck_01: 'head' };
for (const s of ['l', 'r']) {
  Object.assign(DIR_CHILD, { [`clavicle_${s}`]: `upperarm_${s}`, [`upperarm_${s}`]: `lowerarm_${s}`, [`lowerarm_${s}`]: `hand_${s}`, [`hand_${s}`]: `middle_01_${s}`,
    [`thigh_${s}`]: `calf_${s}`, [`calf_${s}`]: `foot_${s}`, [`foot_${s}`]: `ball_${s}` });
  for (const f of ['thumb', 'index', 'middle', 'ring', 'pinky']) { DIR_CHILD[`${f}_01_${s}`] = `${f}_02_${s}`; DIR_CHILD[`${f}_02_${s}`] = `${f}_03_${s}`; }
}
const TGT_TO_SRC = Object.fromEntries(Object.entries(BONE_MAP).map(([s, t]) => [t, s]));

function basis(dir, sec) {
  const x = dir.clone().normalize(), y = sec.clone().addScaledVector(x, -sec.dot(x));
  if (y.lengthSq() < 1e-8) y.set(0, 0, 1).addScaledVector(x, -x.z);
  y.normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, new THREE.Vector3().crossVectors(x, y)));
}
const yawQ = a => new THREE.Quaternion().setFromAxisAngle(UP, a);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

// Bakes source-rig clips (T-pose, names in BONE_MAP) onto the UE Mannequin (A-pose).
// Rotations: world-space deltas from the source rest pose, applied to the target rest pose after a
// per-bone rest alignment (so T-pose arms do not come out raised on the A-pose rig).
// Root motion: horizontal hips travel + facing yaw are removed from the pelvis and returned separately.
export class Retargeter {
  constructor(tgtScene) {
    tgtScene.updateMatrixWorld(true);
    this.bones = []; this.index = new Map();
    tgtScene.traverse(o => { if (o.isBone) { this.index.set(o, this.bones.length); this.bones.push(o); } });
    this.byName = new Map(this.bones.map((b, i) => [b.name, i]));
    this.parent = this.bones.map(b => this.index.get(b.parent) ?? -1);
    this.restLocal = this.bones.map(b => b.quaternion.clone());
    this.restWorld = this.bones.map(b => b.getWorldQuaternion(new THREE.Quaternion()));
    this.restPos = this.bones.map(b => b.getWorldPosition(new THREE.Vector3()));
    this.rootParentQ = this.bones.map(b => b.parent.getWorldQuaternion(new THREE.Quaternion()));
    const pb = this.bones[this.byName.get('pelvis')];
    this.pelvisParentInv = pb.parent.matrixWorld.clone().invert();
    this.pelvisRestWorld = pb.getWorldPosition(new THREE.Vector3());
    this.posScale = null;
  }

  // Rotation taking each target rest bone frame onto the matching source rest frame.
  alignment(src) {
    const P = (name, tgt) => tgt ? this.restPos[this.byName.get(name)] : src.getObjectByName(name)?.getWorldPosition(new THREE.Vector3());
    const across = (s, tgt) => tgt ? P(`index_01_${s}`, true).clone().sub(P(`pinky_01_${s}`, true))
      : P(`${s === 'l' ? 'Left' : 'Right'}HandIndex1`).sub(P(`${s === 'l' ? 'Left' : 'Right'}HandPinky1`));
    const A = new Map();
    const order = this.bones.map((b, i) => i); // parents come first in traversal order
    for (const i of order) {
      const tn = this.bones[i].name, sn = TGT_TO_SRC[tn]; if (!sn) continue;
      const ch = DIR_CHILD[tn], sch = ch && TGT_TO_SRC[ch];
      const pA = this.parent[i] >= 0 ? A.get(this.parent[i]) : null;
      if (!ch || !sch || !src.getObjectByName(sch)) { A.set(i, pA ? pA.clone() : new THREE.Quaternion()); continue; }
      const dT = P(ch, true).clone().sub(P(tn, true)), dS = P(sch).sub(P(sn));
      const side = tn.endsWith('_l') ? 'l' : 'r';
      let sT, sS;
      if (/^(hand|thumb|index|middle|ring|pinky)/.test(tn)) { sT = across(side, true); sS = across(side, false); }
      else if (/^(foot)/.test(tn)) { sT = sS = new THREE.Vector3(1, 0, 0); }
      else { sT = sS = new THREE.Vector3(0, 0, 1); }
      A.set(i, basis(dS, sS).multiply(basis(dT, sT).invert()));
    }
    return A;
  }

  // srcScene: FBX with animations[0]. Returns a baked AnimationClip for the target skeleton.
  bake(srcScene, name, { loop = true, reverse = false } = {}) {
    const srcClip = srcScene.animations[0];
    srcScene.updateMatrixWorld(true);
    const A = this.alignment(srcScene);
    const pairs = [];
    for (const [s, t] of Object.entries(BONE_MAP)) {
      const sb = srcScene.getObjectByName(s), ti = this.byName.get(t);
      if (sb && ti !== undefined) pairs.push({ sb, ti, restInv: sb.getWorldQuaternion(new THREE.Quaternion()).invert() });
    }
    const pairByTgt = new Map(pairs.map((p, k) => [p.ti, k]));
    const B = n => srcScene.getObjectByName(n);
    const hips = B('Hips'), legL = B('LeftLeg'), legR = B('RightLeg'), footL = B('LeftFoot'), footR = B('RightFoot');
    const dur = srcClip.duration, n = Math.max(2, Math.floor(dur * FPS) + 1);
    const mixer = new THREE.AnimationMixer(srcScene);
    const act = mixer.clipAction(srcClip); act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true; act.play();

    // Sample (never at t = duration: a looping mixer would wrap back to frame 0 there).
    const H = [], yaw = [], fL = [], fR = [], deltas = [];
    const tp = new THREE.Vector3(), ts = new THREE.Vector3(), q = new THREE.Quaternion();
    for (let i = 0; i < n; i++) {
      let t = Math.min(i / FPS, dur - 1e-4); if (reverse) t = Math.max(0, dur - 1e-4 - i / FPS);
      mixer.setTime(t); srcScene.updateMatrixWorld(true);
      H.push(hips.getWorldPosition(new THREE.Vector3()));
      const lat = legL.getWorldPosition(new THREE.Vector3()).sub(legR.getWorldPosition(tp));
      const fwd = new THREE.Vector3().crossVectors(lat, UP);
      yaw.push(Math.atan2(fwd.x, fwd.z));
      fL.push(footL.getWorldPosition(new THREE.Vector3())); fR.push(footR.getWorldPosition(new THREE.Vector3()));
      deltas.push(pairs.map(p => { p.sb.matrixWorld.decompose(tp, q, ts); return q.clone().multiply(p.restInv); }));
    }
    mixer.stopAllAction(); mixer.uncacheRoot(srcScene);
    for (let i = 1; i < n; i++) yaw[i] = yaw[i - 1] + wrap(yaw[i] - yaw[i - 1]); // unwrap
    if (this.posScale === null) this.posScale = this.pelvisRestWorld.y / H[0].y;
    const S = this.posScale;

    // Everything is expressed relative to the start: origin under the hips, facing +Z.
    const y0 = yaw[0], R0 = yawQ(-y0), o0 = new THREE.Vector3(H[0].x, 0, H[0].z);
    const toLocal = v => v.clone().sub(o0).applyQuaternion(R0);
    const Hl = H.map(toLocal), Ll = fL.map(toLocal), Rl = fR.map(toLocal), rel = yaw.map(a => a - y0);

    // Frame range + root trajectory.
    let a = 0, b = n - 1, root, rootYaw, vel = new THREE.Vector3(), cyclic = false;
    const avgSpeed = Math.hypot(Hl[n - 1].x - Hl[0].x, Hl[n - 1].z - Hl[0].z) / ((n - 1) / FPS);
    if (loop && avgSpeed > 15) {
      // Many source clips start from a standstill: use the fastest full cycle (cruise), not the middle one.
      const ev = plants(Ll, Hl);
      let best = null;
      for (let k = 0; k + 1 < ev.length; k++) {
        const i0 = ev[k], i1 = ev[k + 1], len = i1 - i0; if (len < 0.45 * FPS || len > 2.2 * FPS) continue;
        const c = Math.hypot(Hl[i1].x - Hl[i0].x, Hl[i1].z - Hl[i0].z) / len; if (!best || c > best.c) best = { c, a: i0, b: i1 };
      }
      if (best) { a = best.a; b = best.b; cyclic = true; }
      vel.set(Hl[b].x - Hl[a].x, 0, Hl[b].z - Hl[a].z).divideScalar((b - a) / FPS);
      root = i => new THREE.Vector3(Hl[a].x, 0, Hl[a].z).addScaledVector(vel, (i - a) / FPS);
      rootYaw = () => 0;
    } else if (loop) {
      root = () => new THREE.Vector3(); rootYaw = () => 0;
    } else {
      const sm = smooth(Hl.map(v => [v.x, v.z]), Math.round(0.2 * FPS)), sy = smooth(rel.map(v => [v]), Math.round(0.1 * FPS));
      const r0 = sm[0], ry0 = sy[0][0];
      root = i => new THREE.Vector3(sm[i][0] - r0[0], 0, sm[i][1] - r0[1]);
      rootYaw = i => sy[i][0] - ry0;
    }
    const m = b - a + 1, times = new Float32Array(m);
    for (let j = 0; j < m; j++) times[j] = j / FPS;
    const clipDur = (m - 1) / FPS;

    // Bake local rotations.
    const nb = this.bones.length, out = new Map(pairs.map(p => [p.ti, new Float32Array(m * 4)]));
    const wq = new Array(nb), inv = new THREE.Quaternion();
    for (let j = 0; j < m; j++) {
      const f = a + j, Rc = yawQ(-rootYaw(f)).multiply(R0);
      for (let i = 0; i < nb; i++) {
        const pi = this.parent[i], parentQ = pi >= 0 ? wq[pi] : this.rootParentQ[i], k = pairByTgt.get(i);
        if (k !== undefined) {
          const desired = Rc.clone().multiply(deltas[f][k]).multiply(A.get(i)).multiply(this.restWorld[i]);
          inv.copy(parentQ).invert().multiply(desired).toArray(out.get(i), j * 4);
          wq[i] = desired;
        } else wq[i] = parentQ.clone().multiply(this.restLocal[i]);
      }
    }
    // Pelvis: hips relative to the root (sway, bob, crouch depth all stay in the animation).
    const pel = [];
    for (let j = 0; j < m; j++) {
      const f = a + j, r = root(f), d = Hl[f].clone().sub(r).applyQuaternion(yawQ(-rootYaw(f)));
      pel.push(new THREE.Vector3(d.x, Hl[f].y, d.z));
    }
    if (loop) { // close the loop: distribute the end/start mismatch over the cycle
      const dp = pel[m - 1].clone().sub(pel[0]);
      pel.forEach((p, j) => p.addScaledVector(dp, -j / (m - 1)));
      const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), e = new THREE.Quaternion(), I = new THREE.Quaternion();
      for (const arr of out.values()) {
        qa.fromArray(arr, 0); qb.fromArray(arr, (m - 1) * 4);
        const err = qa.clone().multiply(qb.clone().invert()); // premultiply to turn qb into qa
        for (let j = 1; j < m; j++) { e.slerpQuaternions(I, err, j / (m - 1)); qb.fromArray(arr, j * 4); e.clone().multiply(qb).toArray(arr, j * 4); }
      }
    }
    const pv = new Float32Array(m * 3), base = this.pelvisRestWorld;
    pel.forEach((p, j) => tp.set(base.x + p.x * S, p.y * S, base.z + p.z * S).applyMatrix4(this.pelvisParentInv).toArray(pv, j * 3));
    const tracks = [...out].map(([ti, arr]) => new THREE.QuaternionKeyframeTrack(`${this.bones[ti].name}.quaternion`, times, arr));
    tracks.push(new THREE.VectorKeyframeTrack('pelvis.position', times, pv));
    const clip = new THREE.AnimationClip(name, clipDur, tracks);

    // Root motion in meters (clip frame: +z forward, +x = character's left).
    let motion = null;
    if (!loop) {
      motion = new Float32Array(m * 3);
      for (let j = 0; j < m; j++) { const r = root(a + j); motion[j * 3] = r.x * S / 100; motion[j * 3 + 1] = r.z * S / 100; motion[j * 3 + 2] = rootYaw(a + j); }
    }
    const v = vel.clone().multiplyScalar(S / 100);
    clip.userData = { loop, cyclic, speed: loop ? v.length() : 0, vel: { x: v.x, z: v.z }, motion, times, fps: FPS };
    return clip;
  }
}

// Frames where the left foot becomes planted (horizontal speed drops while low).
function plants(F, Hp) {
  const n = F.length, sp = [], hs = [];
  for (let i = 0; i < n; i++) {
    const p = F[Math.max(0, i - 1)], c = F[Math.min(n - 1, i + 1)], k = (Math.min(n - 1, i + 1) - Math.max(0, i - 1)) / FPS;
    sp.push(Math.hypot(c.x - p.x, c.z - p.z) / k);
    const hp = Hp[Math.max(0, i - 1)], hc = Hp[Math.min(n - 1, i + 1)]; hs.push(Math.hypot(hc.x - hp.x, hc.z - hp.z) / k);
  }
  const hips = hs.slice().sort((x, y) => x - y)[n >> 1], minY = Math.min(...F.map(v => v.y));
  const thr = Math.max(12, hips * 0.35), ev = [];
  for (let i = 1; i < n; i++) if (sp[i] < thr && sp[i - 1] >= thr && F[i].y < minY + 12) ev.push(i);
  return ev;
}
function smooth(rows, w) {
  const n = rows.length;
  return rows.map((_, i) => {
    const s = rows[0].map(() => 0); let c = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) { rows[k].forEach((v, d) => s[d] += v); c++; }
    return s.map(v => v / c);
  });
}

// Root displacement (m, character frame: +z forward, +x left) and yaw (rad) of a baked one-shot at time t.
export function sampleMotion(clip, t) {
  const u = clip.userData; if (!u.motion) return { x: 0, z: 0, yaw: 0 };
  const f = Math.min(u.times.length - 1.001, Math.max(0, t * u.fps)), i = Math.floor(f), a = f - i;
  const L = k => u.motion[i * 3 + k] * (1 - a) + u.motion[(i + 1) * 3 + k] * a;
  return { x: L(0), z: L(1), yaw: L(2) };
}
