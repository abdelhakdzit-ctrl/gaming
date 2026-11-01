import * as THREE from 'three';

// Pooled lightweight effects: tracers, muzzle flash, impact sparks/dust, blood, decals.
export class Fx {
  constructor(scene) {
    this.scene = scene; this.items = [];
    this.tracerGeo = new THREE.BoxGeometry(0.012, 0.012, 1);
    this.tracerMat = new THREE.MeshBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.9 });
    this.flashMat = new THREE.MeshBasicMaterial({ color: 0xffcf80, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.flashGeo = new THREE.PlaneGeometry(0.5, 0.5);
    this.partGeo = new THREE.BoxGeometry(0.03, 0.03, 0.03);
    this.decalGeo = new THREE.PlaneGeometry(0.12, 0.12);
    this.decalMat = new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    this.light = new THREE.PointLight(0xffb060, 0, 8); scene.add(this.light); this.lightT = 0;
  }
  add(obj, life, update) { this.scene.add(obj); this.items.push({ obj, life, max: life, update }); }
  tracer(a, b) {
    const len = a.distanceTo(b); if (len < 1) return;
    const m = new THREE.Mesh(this.tracerGeo, this.tracerMat.clone()); m.position.copy(a).lerp(b, 0.5); m.scale.z = Math.min(len, 6); m.lookAt(b);
    const dir = b.clone().sub(a).normalize(), speed = 220; let travelled = 0;
    m.position.copy(a).addScaledVector(dir, m.scale.z / 2);
    this.add(m, len / speed, (it, dt) => { travelled += speed * dt; m.position.copy(a).addScaledVector(dir, Math.min(len, travelled) - m.scale.z / 2); });
  }
  muzzleFlash(marker) {
    const g = new THREE.Group(); marker.getWorldPosition(g.position); marker.getWorldQuaternion(g.quaternion);
    const a = new THREE.Mesh(this.flashGeo, this.flashMat), b = new THREE.Mesh(this.flashGeo, this.flashMat);
    a.rotation.x = Math.PI / 2; b.rotation.y = Math.PI / 2; a.position.z = b.position.z = 0.18;
    g.add(a, b); g.scale.setScalar(0.7 + Math.random() * 0.6); g.rotation.z += Math.random() * 6;
    this.add(g, 0.05);
    this.light.position.copy(g.position); this.light.intensity = 6; this.lightT = 0.06;
  }
  impact(point, normal, kind = 'world') {
    const col = kind === 'blood' ? 0x8a0b0b : 0xffc070;
    const mat = new THREE.MeshBasicMaterial({ color: col });
    for (let i = 0; i < (kind === 'blood' ? 8 : 6); i++) {
      const m = new THREE.Mesh(this.partGeo, mat); m.position.copy(point);
      const v = normal.clone().multiplyScalar(1.5 + Math.random() * 2).add(new THREE.Vector3((Math.random() - .5) * 2, Math.random() * 1.5, (Math.random() - .5) * 2));
      this.add(m, 0.35 + Math.random() * 0.2, (it, dt) => { v.y -= 9 * dt; m.position.addScaledVector(v, dt); m.scale.setScalar(Math.max(0.05, it.life / it.max)); });
    }
    if (kind === 'world' && normal.lengthSq() > 0) {
      const d = new THREE.Mesh(this.decalGeo, this.decalMat); d.position.copy(point).addScaledVector(normal, 0.01); d.lookAt(point.clone().add(normal)); d.rotation.z = Math.random() * 6;
      this.add(d, 12);
    }
  }
  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]; it.life -= dt; it.update?.(it, dt);
      if (it.life <= 0) { this.scene.remove(it.obj); this.items.splice(i, 1); }
    }
    if (this.lightT > 0) { this.lightT -= dt; if (this.lightT <= 0) this.light.intensity = 0; }
  }
}
