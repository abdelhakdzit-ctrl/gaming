import * as THREE from 'three';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _pq = new THREE.Quaternion(), _wq = new THREE.Quaternion(), _dq = new THREE.Quaternion();

export function applyWorldDelta(bone, dq) {
  bone.parent.getWorldQuaternion(_pq); bone.getWorldQuaternion(_wq);
  _wq.premultiply(dq);
  bone.quaternion.copy(_pq.invert().multiply(_wq));
  bone.updateMatrixWorld(true);
}

// Analytic two-bone IK in world space. `pole` is a world point the elbow/knee bends toward.
// weight < 1 blends from the current pose.
export function twoBoneIK(upper, lower, end, target, pole, weight = 1) {
  if (weight <= 0) return;
  const q0u = upper.quaternion.clone(), q0l = lower.quaternion.clone();
  const A = upper.getWorldPosition(_a).clone(), B = lower.getWorldPosition(_b).clone(), C = end.getWorldPosition(_c).clone();
  const l1 = A.distanceTo(B), l2 = B.distanceTo(C);
  const toT = _d.copy(target).sub(A); const dist = THREE.MathUtils.clamp(toT.length(), 0.05, (l1 + l2) * 0.999);
  toT.normalize();
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const pd = pole.clone().sub(A); pd.addScaledVector(toT, -pd.dot(toT)); if (pd.lengthSq() < 1e-8) pd.set(0, -1, 0); pd.normalize();
  const Bn = A.clone().addScaledVector(toT, a).addScaledVector(pd, h);
  applyWorldDelta(upper, _dq.setFromUnitVectors(B.clone().sub(A).normalize(), Bn.clone().sub(A).normalize()));
  lower.getWorldPosition(_b); end.getWorldPosition(_c);
  const tgt = target.clone().sub(_b).normalize();
  applyWorldDelta(lower, _dq.setFromUnitVectors(_c.clone().sub(_b).normalize(), tgt));
  if (weight < 1) { upper.quaternion.slerpQuaternions(q0u, upper.quaternion.clone(), weight); lower.quaternion.slerpQuaternions(q0l, lower.quaternion.clone(), weight); upper.updateMatrixWorld(true); }
}
