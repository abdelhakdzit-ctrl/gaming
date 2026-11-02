import * as THREE from 'three';
import { STATE } from '../state.js';
import { charRoot } from '../scene.js';
import { smoother } from './curves.js';

// Pose crossfade (inertial-style): snapshot the last rendered pose in world space, then blend it out over `dur`
// on top of whatever the new state produces. Hides pops at ladder mount/dismount and clip switches.
const X = { t: 0, dur: 0, bones: [], q: [], pelvis: null, pelM: new THREE.Matrix4(), gun: null, gunM: new THREE.Matrix4(), lastRoot: new THREE.Matrix4() };
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const _p2 = new THREE.Vector3(), _q2 = new THREE.Quaternion(), _s2 = new THREE.Vector3();

function collect() {
  if (X.bones.length || !STATE.mannequinRoot) return;
  STATE.mannequinRoot.traverse(o => { if (o.isBone) { X.bones.push(o); X.q.push(new THREE.Quaternion()); } });
  X.pelvis = X.bones.find(b => b.name === 'pelvis') ?? null;
}

export function captureXfade(dur, gunObj = null) {
  collect();
  if (!X.pelvis) return;
  charRoot.updateMatrixWorld(true);
  _m.copy(charRoot.matrixWorld).invert();
  X.bones.forEach((b, i) => X.q[i].copy(b.quaternion));
  // pelvis in world space via the last placement (charRoot may currently be reset to identity for solving)
  X.pelM.copy(X.lastRoot).multiply(_m2.multiplyMatrices(_m, X.pelvis.matrixWorld));
  X.gun = gunObj && gunObj.visible ? gunObj : null;
  if (X.gun) X.gunM.copy(X.lastRoot).multiply(X.gun.matrix);
  X.t = 0; X.dur = dur;
}

// Call every frame right after the character has been placed in the world.
export function applyXfade(dt, gunObj = null) {
  charRoot.updateMatrixWorld(true);
  if (X.t < X.dur && X.pelvis) {
    X.t += dt;
    const w = 1 - smoother(X.t / X.dur);   // weight of the old pose
    if (w > 1e-3) {
      // pelvis: blend in world space, then express in its parent's space
      X.pelvis.matrixWorld.decompose(_p, _q, _s);
      X.pelM.decompose(_p2, _q2, _s2);
      _p.lerp(_p2, w); _q.slerp(_q2, w);
      const par = X.pelvis.parent; par.updateWorldMatrix(true, false);
      _m.compose(_p, _q, _s.set(1, 1, 1)).premultiply(_m2.copy(par.matrixWorld).invert());
      _m.decompose(X.pelvis.position, X.pelvis.quaternion, _s);
      X.bones.forEach((b, i) => { if (b !== X.pelvis) b.quaternion.slerp(X.q[i], w); });
      if (gunObj && X.gun === gunObj) {
        _m.multiplyMatrices(charRoot.matrixWorld, gunObj.matrix).decompose(_p, _q, _s);
        X.gunM.decompose(_p2, _q2, _s2);
        _p.lerp(_p2, w); _q.slerp(_q2, w);
        gunObj.matrix.compose(_p, _q, _s).premultiply(_m2.copy(charRoot.matrixWorld).invert());
        gunObj.matrixWorldNeedsUpdate = true;
      }
      STATE.mannequinRoot.updateMatrixWorld(true);
    }
  }
  X.lastRoot.copy(charRoot.matrixWorld);
}
