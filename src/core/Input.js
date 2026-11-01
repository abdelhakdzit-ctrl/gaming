// Keyboard / mouse input with pointer lock. Query with down(), pressed() (edge, cleared each frame).
export class Input {
  constructor(el) {
    this.el = el;
    this.keys = new Set(); this._pressed = new Set();
    this.mouse = { dx: 0, dy: 0, buttons: 0, wheel: 0 };
    this.locked = false;
    addEventListener('keydown', e => {
      if (e.repeat) return;
      this.keys.add(e.code); this._pressed.add(e.code);
      if (this.locked && ['Space', 'Tab'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.mouse.buttons = 0; });
    el.addEventListener('mousedown', e => { this.mouse.buttons |= 1 << e.button; this._pressed.add('Mouse' + e.button); });
    addEventListener('mouseup', e => { this.mouse.buttons &= ~(1 << e.button); });
    addEventListener('mousemove', e => { if (this.locked) { this.mouse.dx += e.movementX; this.mouse.dy += e.movementY; } });
    addEventListener('wheel', e => { this.mouse.wheel += Math.sign(e.deltaY); }, { passive: true });
    el.addEventListener('contextmenu', e => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === el;
      this.onLockChange?.(this.locked);
    });
  }
  lock() { this.el.requestPointerLock?.(); }
  down(code) { return this.keys.has(code); }
  pressed(code) { return this._pressed.has(code); }
  mouseDown(b) { return !!(this.mouse.buttons & (1 << b)); }
  endFrame() { this._pressed.clear(); this.mouse.dx = this.mouse.dy = this.mouse.wheel = 0; }
}
