import * as THREE from 'three';
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
export const wrapAngle = a => { a = (a + Math.PI) % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a - Math.PI; };
export const dampAngle = (a, b, k, dt) => a + wrapAngle(b - a) * (1 - Math.exp(-k * dt));
export const rand = (a, b) => a + Math.random() * (b - a);
export const pick = arr => arr[(Math.random() * arr.length) | 0];

// Rotate `bone` by `angle` around a world-space axis, independent of the bone's local axes.
const _q = new THREE.Quaternion(), _p = new THREE.Quaternion(), _w = new THREE.Quaternion();
export function rotateBoneWorld(bone, axis, angle) {
  bone.parent.getWorldQuaternion(_p);
  bone.getWorldQuaternion(_w);
  _q.setFromAxisAngle(axis, angle);
  _w.premultiply(_q);
  bone.quaternion.copy(_p.invert().multiply(_w));
}
