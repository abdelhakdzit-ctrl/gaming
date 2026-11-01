import * as THREE from 'three';
import { clamp, damp } from '../core/math.js';

const BASE_FOV = 65;

// Player input -> Character intent, plus the over-the-shoulder camera.
export class PlayerController {
  constructor(game, character) {
    this.game = game; this.c = character; this.input = game.input;
    this.yaw = 0; this.pitch = 0; this.shoulder = 1; this.sens = 0.0021;
    this.crouchToggle = false; this.fov = BASE_FOV; this.scoped = false; this.adsT = 0; this.crouchLerp = 0;
    this.camPos = new THREE.Vector3(); this.camDir = new THREE.Vector3(0, 0, 1); this.pivot = character.pos.clone();
    this.sprinting = false;
    character.getAimRay = () => this.aimRay();
    character.onFired = d => this.recoil(d);
    // Upper-body aim converges on what the crosshair actually covers.
    character.getAimPoint = () => {
      const { origin, dir } = this.aimRay(), h = game.world.raycast(origin, dir, 300);
      return origin.addScaledVector(dir, h ? Math.max(2, h.dist) : 300);
    };
  }
  recoil(d) {
    const r = d.recoil, k = THREE.MathUtils.degToRad(1) * (this.c.intent.ads ? 0.7 : 1);
    this.pitch += r.pitch * k * (0.75 + Math.random() * 0.5);
    this.yaw += (Math.random() - 0.5) * 2 * r.yaw * k;
    this.c.kick += r.pitch * 2.2;
  }
  // Shots travel along the camera ray (through the crosshair); tracers start at the muzzle.
  aimRay() {
    const off = this.camPos.distanceTo(this.pivot);
    return { origin: this.camPos.clone().addScaledVector(this.camDir, off), dir: this.camDir.clone() };
  }
  update(dt) {
    const I = this.input, c = this.c, it = c.intent, w = c.weapons;
    if (c.dead) return;
    if (I.locked) {
      const s = this.sens * (it.ads ? (this.scoped ? 0.25 : 0.6) : 1);
      this.yaw -= I.mouse.dx * s; this.pitch = clamp(this.pitch - I.mouse.dy * s, -1.25, 1.2);
    }
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)), left = new THREE.Vector3(fwd.z, 0, -fwd.x);
    const mv = new THREE.Vector3();
    if (I.down('KeyW')) mv.add(fwd); if (I.down('KeyS')) mv.sub(fwd);
    if (I.down('KeyA')) mv.add(left); if (I.down('KeyD')) mv.sub(left);
    if (mv.lengthSq() > 0) mv.normalize();
    it.move.copy(mv);
    this.sprinting = I.down('ShiftLeft') && mv.dot(fwd) > 0.3 && !it.ads && !c.crouching;
    it.gait = this.sprinting ? 'sprint' : I.down('AltLeft') ? 'walk' : 'run';
    if (I.pressed('KeyC')) this.crouchToggle = !this.crouchToggle;
    if (this.sprinting) this.crouchToggle = false;
    it.crouch = this.crouchToggle;
    if (I.pressed('KeyH')) it.drawn = !it.drawn;
    if (I.pressed('KeyZ')) this.shoulder *= -1;
    ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'].forEach((k, i) => { if (I.pressed(k) && w.select(i)) it.drawn = true; });
    if (I.mouse.wheel) w.cycle(I.mouse.wheel > 0 ? 1 : -1);
    if (I.pressed('KeyR')) w.reload();
    const lmb = (I.mouseDown(0) && I.locked) || I.down('KeyF'), rmb = I.mouseDown(2) && I.locked;
    if (lmb && !it.drawn) it.drawn = true;
    const free = !this.sprinting && !c.anim.busy;
    it.lowered = this.sprinting;
    it.ads = (rmb || this.game.params.has('ads')) && it.drawn && free;
    w.trigger = lmb && it.drawn && free;
    it.aimYaw = this.yaw; it.aimPitch = this.pitch; it.strafe = !this.sprinting;
    if (I.pressed('Space')) { if (!c.tryVault()) c.jump(); }
    if (I.pressed('KeyV')) c.roll(mv.lengthSq() > 0 ? mv : fwd);
  }

  updateCamera(dt, camera) {
    const c = this.c, it = c.intent, def = c.weapons.def;
    this.adsT = damp(this.adsT, it.ads ? 1 : 0, 12, dt);
    this.scoped = !!def.scope && this.adsT > 0.85;
    this.crouchLerp = damp(this.crouchLerp, c.crouching ? 1 : 0, 8, dt);
    const d = this.camDir.set(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    const left = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const side = this.shoulder * THREE.MathUtils.lerp(0.62, 0.42, this.adsT);
    const base = c.pos.clone(); base.y += THREE.MathUtils.lerp(1.62, 1.12, this.crouchLerp);
    const pivot = base.clone().addScaledVector(left, -side);
    const toP = pivot.clone().sub(base), lp = toP.length();
    const hit0 = lp > 0 ? this.game.world.raycast(base, toP.clone().normalize(), lp + 0.2) : null;
    if (hit0?.collider) pivot.copy(base).addScaledVector(toP.normalize(), Math.max(0, hit0.dist - 0.2));
    this.pivot.copy(pivot);
    let dist = THREE.MathUtils.lerp(2.9, 1.7, this.adsT) * THREE.MathUtils.lerp(1, 0.8, this.crouchLerp);
    if (this.scoped) dist = 0;
    const back = d.clone().multiplyScalar(-1);
    const hit = dist > 0 ? this.game.world.raycast(pivot, back, dist + 0.3) : null;
    if (hit?.collider) dist = Math.max(0.3, hit.dist - 0.3);
    this.camPos.copy(pivot).addScaledVector(back, dist);
    camera.position.copy(this.camPos); camera.lookAt(this.camPos.clone().add(d));
    const tf = BASE_FOV * (it.ads ? def.adsFov : 1) * (this.sprinting ? 1.08 : 1);
    this.fov = damp(this.fov, tf, 10, dt); camera.fov = this.fov; camera.updateProjectionMatrix();
    const orb = this.game.params.get('orbit');
    if (orb) { const [a, r, h, hy] = orb.split(',').map(Number); const dir = new THREE.Vector3(Math.sin(this.yaw + a), 0, Math.cos(this.yaw + a)); camera.position.copy(c.pos).addScaledVector(dir, r); camera.position.y = h; camera.lookAt(c.pos.x, hy ?? 1.2, c.pos.z); camera.fov = 40; camera.updateProjectionMatrix(); }
    c.model.visible = c.holder.visible = !this.scoped;
  }
}
