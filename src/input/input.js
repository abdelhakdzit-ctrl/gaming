import { clamp } from '../util/math.js';

// Keyboard + mouse + gamepad -> one normalised control frame per poll().
// Keys: W/Up nose up, S/Down nose down, A/D roll, Q/E yaw, Shift/Ctrl throttle, Space gun, F missile, X flares,
// T cycle target, I identify (hold), B airbrake, C camera, 1-8 direct camera, M mouse-flight, Esc/P pause.
// Touch devices: see ./touch.js (floating aim stick, action buttons, throttle slider).
export class Input {
  constructor(canvasEl, settings) {
    this.settings = settings; this.keys = new Set(); this.pressed = new Set(); this.mouse = { x: 0, y: 0, dx: 0, dy: 0, left: false, right: false };
    this.stick = { x: 0, y: 0 }; this.enabled = false; this.pad = null; this.padPrev = [];
    this.mouseFlight = false; this.wheel = 0; this.lastDevice = 'keyboard'; this.touch = null;
    const kd = (e) => {
      if (!this.enabled) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code); this.lastDevice = 'keyboard';
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled || this.touch?.active) return;
      this.mouse.dx += e.movementX || 0; this.mouse.dy += e.movementY || 0;
      this.mouse.x = (e.clientX / innerWidth) * 2 - 1; this.mouse.y = (e.clientY / innerHeight) * 2 - 1;
    });
    window.addEventListener('mousedown', (e) => {
      if (!this.enabled || this.touch?.active || e.target.closest?.('.ui-block')) return;
      if (e.button === 0) this.mouse.left = true; if (e.button === 2) this.mouse.right = true;
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.mouse.left = false; if (e.button === 2) this.mouse.right = false; });
    window.addEventListener('contextmenu', (e) => { if (this.enabled) e.preventDefault(); });
    window.addEventListener('wheel', (e) => { if (this.enabled) this.wheel += Math.sign(e.deltaY); }, { passive: true });
  }
  was(code) { return this.pressed.has(code); }
  down(...codes) { return codes.some((c) => this.keys.has(c)); }

  setMouseFlight(v) { this.mouseFlight = v; this.stick.x = this.stick.y = 0; }

  poll(dt) {
    const s = this.settings, dz = s.deadzone ?? 0.08, sens = s.sensitivity ?? 1, inv = s.invertY ? -1 : 1;
    const out = { pitch: 0, roll: 0, yaw: 0, throttleDelta: 0, throttleSet: undefined, brake: false, fire: false, missile: false, flare: false, cycle: false, identify: false, camera: 0, cameraDirect: -1, pause: false, mouseToggle: false, hudToggle: false, look: { x: 0, y: 0 } };
    // keyboard
    const kp = (this.down('KeyW', 'ArrowUp') ? 1 : 0) - (this.down('KeyS', 'ArrowDown') ? 1 : 0);
    const kr = (this.down('KeyD', 'ArrowRight') ? 1 : 0) - (this.down('KeyA', 'ArrowLeft') ? 1 : 0);
    const ky = (this.down('KeyE') ? 1 : 0) - (this.down('KeyQ') ? 1 : 0);
    const ramp = (cur, tgt) => { const rate = tgt === 0 ? 5 : (Math.sign(tgt) !== Math.sign(cur) && cur !== 0 ? 9 : 2.6); const d = tgt - cur; return Math.abs(d) <= rate * dt ? tgt : cur + Math.sign(d) * rate * dt; };
    const kb = this.kb || (this.kb = { p: 0, r: 0, y: 0 });
    kb.p = ramp(kb.p, kp); kb.r = ramp(kb.r, kr); kb.y = ramp(kb.y, ky);
    const ex = (v) => Math.sign(v) * (0.35 * Math.abs(v) + 0.65 * v * v);
    out.pitch = ex(kb.p) * inv; out.roll = ex(kb.r); out.yaw = kb.y;
    out.throttleDelta = (this.down('ShiftLeft', 'ShiftRight', 'Equal') ? 1 : 0) - (this.down('ControlLeft', 'ControlRight', 'Minus') ? 1 : 0);
    out.throttleDelta -= this.wheel * 0.9; this.wheel = 0;
    out.brake = this.down('KeyB');
    out.fire = this.down('Space') || this.mouse.left;
    out.missile = this.was('KeyF') || this.mouse.right && !this._rightLatched;
    this._rightLatched = this.mouse.right;
    out.flare = this.was('KeyX');
    out.cycle = this.was('KeyT'); out.identify = this.down('KeyI');
    if (this.was('KeyC')) out.camera = 1;
    for (let i = 1; i <= 8; i++) if (this.was('Digit' + i)) out.cameraDirect = i - 1;
    out.pause = this.was('Escape') || this.was('KeyP'); out.mouseToggle = this.was('KeyM'); out.hudToggle = this.was('KeyH');
    out.look.x = (this.down('ArrowRight') ? 1 : 0) - (this.down('ArrowLeft') ? 1 : 0);
    // mouse (virtual stick)
    // mouse flight: the cursor offset from the screen centre is the aim demand (resolved in Game against the camera FOV)
    out.mouseAim = this.mouseFlight ? { x: clamp(this.mouse.x, -1, 1), y: clamp(this.mouse.y, -1, 1), sens, inv } : null;
    out.look.dx = this.mouse.dx; out.look.dy = this.mouse.dy; this.mouse.dx = this.mouse.dy = 0;
    // touch: the floating stick is an aim demand just like the mouse cursor (neutral = hold attitude, wings level)
    const tc = this.touch;
    if (tc && tc.active) {
      const t = tc.read(); this.lastDevice = 'touch';
      out.mouseAim = { x: t.x * 0.7, y: t.y * 0.7, sens, inv };
      out.fire = out.fire || t.fire; out.identify = out.identify || t.identify; out.brake = out.brake || t.brake;
      out.missile = out.missile || t.missile; out.flare = out.flare || t.flare; out.cycle = out.cycle || t.cycle;
      if (t.camera) out.camera = 1; if (t.pause) out.pause = true; if (t.throttle !== undefined) out.throttleSet = t.throttle;
    }
    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const p = pads && [...pads].find((q) => q && q.connected);
    this.pad = p || null;
    if (p) {
      const ax = (i) => { const v = p.axes[i] || 0; return Math.abs(v) < dz ? 0 : Math.sign(v) * (Math.abs(v) - dz) / (1 - dz); };
      const b = (i) => !!p.buttons[i]?.pressed, bp = (i) => b(i) && !this.padPrev[i];
      const gx = ax(0) * sens, gy = -ax(1) * sens * inv, gyaw = ax(2);
      if (gx || gy || gyaw) this.lastDevice = 'gamepad';
      out.roll = clamp(out.roll + gx, -1, 1); out.pitch = clamp(out.pitch + gy, -1, 1); out.yaw = clamp(out.yaw + gyaw, -1, 1);
      out.throttleDelta += (b(12) ? 1 : 0) - (b(13) ? 1 : 0);
      out.fire = out.fire || (p.buttons[7]?.value || 0) > 0.4;
      out.brake = out.brake || (p.buttons[6]?.value || 0) > 0.4;
      out.missile = out.missile || bp(0); out.flare = out.flare || bp(1); out.cycle = out.cycle || bp(2); out.identify = out.identify || b(3);
      if (bp(4)) out.camera = 1; if (bp(5)) out.camera = 1; if (bp(9)) out.pause = true;
      this.padPrev = p.buttons.map((x) => x.pressed);
    }
    this.pressed.clear();
    return out;
  }

  rumble(strong, weak, ms = 120) {
    const a = this.pad?.vibrationActuator;
    a?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: clamp(strong, 0, 1), weakMagnitude: clamp(weak, 0, 1) }).catch?.(() => {});
  }
}
