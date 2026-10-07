import { clamp } from '../util/math.js';

const BUTTONS = [
  { id: 'fire', label: 'FIRE', cls: 'big', hold: true },
  { id: 'missile', label: 'MSL' },
  { id: 'flare', label: 'FLR' },
  { id: 'cycle', label: 'TGT' },
  { id: 'identify', label: 'ID', hold: true },
  { id: 'brake', label: 'BRK', hold: true },
  { id: 'camera', label: 'CAM', cls: 'top' },
  { id: 'pause', label: 'II', cls: 'top' },
  { id: 'fullscreen', label: '⛶', cls: 'top' }
];

/**
 * On-screen controls for phones/tablets (landscape). A floating aim stick on the free half of the screen drives the same
 * "aim demand" controller as the mouse (neutral = level flight), action buttons are held or tapped, and a slider sets throttle.
 * Everything is plain DOM + Pointer Events, so each control tracks its own finger (multi-touch).
 */
export class TouchControls {
  constructor(root, { onFullscreen } = {}) {
    this.root = root; this.stick = { x: 0, y: 0 }; this.held = {}; this.pulses = new Set(); this.throttleSet = undefined; this.throttleShown = 0.7;
    root.innerHTML = `<div class="t-zone" data-t="zone"><div class="t-ring"></div><div class="t-base"><i></i></div><div class="t-hint">DRAG TO STEER</div></div>
      ${BUTTONS.map((b) => `<button class="t-btn t-${b.id} ${b.cls || ''}" data-t="${b.id}" type="button"><span>${b.label}</span></button>`).join('')}
      <div class="t-throttle" data-t="throttle"><i class="t-fill"></i><b class="t-knob"></b><span>THR</span></div>
      <div class="t-rotate">ROTATE YOUR DEVICE TO LANDSCAPE</div>`;
    this.zone = root.querySelector('.t-zone'); this.base = root.querySelector('.t-base'); this.knob = this.base.querySelector('i');
    this.fill = root.querySelector('.t-fill'); this.tknob = root.querySelector('.t-knob'); this.track = root.querySelector('.t-throttle');
    this.onFullscreen = onFullscreen; this.pid = { stick: null, throttle: null };
    if (!document.documentElement.requestFullscreen) root.querySelector('.t-fullscreen').style.display = 'none';
    this.bindStick(); this.bindThrottle(); this.bindButtons();
    for (const ev of ['contextmenu', 'gesturestart', 'dblclick']) root.addEventListener(ev, (e) => e.preventDefault());
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    this.setThrottle(this.throttleShown);
    // turning a phone to portrait mid-flight pauses the game instead of letting the player crash
    window.matchMedia?.('(orientation: portrait)').addEventListener?.('change', (e) => { if (e.matches && this.active) this.pulses.add('pause'); });
  }

  /** True while the touch layout is enabled and a mission is in progress. */
  get active() { const c = document.body.classList; return c.contains('touch-on') && c.contains('playing'); }

  bindStick() {
    const z = this.zone, R = () => clamp(Math.min(innerWidth, innerHeight) * 0.16, 56, 96);
    let ox = 0, oy = 0;
    const set = (x, y) => {
      const r = R(), dx = x - ox, dy = y - oy, len = Math.hypot(dx, dy), k = len > r ? r / len : 1, nx = (dx * k) / r, ny = (dy * k) / r;
      // dead zone + gentle expo so small corrections stay precise
      const sh = (v) => { const a = Math.abs(v); return a < 0.08 ? 0 : Math.sign(v) * (0.35 * a + 0.65 * a * a); };
      this.stick.x = sh(nx); this.stick.y = sh(ny);
      this.knob.style.transform = `translate(${nx * r}px, ${ny * r}px)`;
    };
    z.addEventListener('pointerdown', (e) => {
      if (this.pid.stick !== null || e.target.closest('.t-btn')) return; e.preventDefault(); this.pid.stick = e.pointerId; z.setPointerCapture(e.pointerId);
      const rect = this.root.getBoundingClientRect(); ox = e.clientX; oy = e.clientY; const r = R();
      this.base.style.cssText = `left:${ox - rect.left}px;top:${oy - rect.top}px;width:${r * 2}px;height:${r * 2}px`; this.base.classList.add('on'); z.classList.add('used'); set(ox, oy);
    });
    z.addEventListener('pointermove', (e) => { if (e.pointerId === this.pid.stick) { e.preventDefault(); set(e.clientX, e.clientY); } });
    const end = (e) => { if (e.pointerId !== this.pid.stick) return; this.pid.stick = null; this.stick.x = this.stick.y = 0; this.base.classList.remove('on'); this.knob.style.transform = ''; };
    z.addEventListener('pointerup', end); z.addEventListener('pointercancel', end); z.addEventListener('lostpointercapture', end);
  }

  bindThrottle() {
    const t = this.track, set = (e) => { const r = t.getBoundingClientRect(), v = clamp(1 - (e.clientY - r.top) / r.height, 0, 1); this.throttleSet = v; this.setThrottle(v); };
    t.addEventListener('pointerdown', (e) => { if (this.pid.throttle !== null) return; e.preventDefault(); this.pid.throttle = e.pointerId; t.setPointerCapture(e.pointerId); set(e); });
    t.addEventListener('pointermove', (e) => { if (e.pointerId === this.pid.throttle) { e.preventDefault(); set(e); } });
    const end = (e) => { if (e.pointerId !== this.pid.throttle) return; this.pid.throttle = null; this.throttleSet = undefined; };
    t.addEventListener('pointerup', end); t.addEventListener('pointercancel', end); t.addEventListener('lostpointercapture', end);
  }

  bindButtons() {
    for (const b of BUTTONS) {
      const el = this.root.querySelector('.t-' + b.id); let pid = null;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation(); if (pid !== null) return; pid = e.pointerId; el.setPointerCapture(e.pointerId); el.classList.add('down');
        if (b.hold) this.held[b.id] = true; else if (b.id === 'fullscreen') this.onFullscreen?.(); else this.pulses.add(b.id);
        if (navigator.vibrate) navigator.vibrate(b.id === 'fire' ? 8 : 14);
      });
      const up = (e) => { if (e.pointerId !== pid) return; pid = null; el.classList.remove('down'); this.held[b.id] = false; };
      el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); el.addEventListener('lostpointercapture', up);
    }
  }

  /** Shows the real throttle (set by takeoff, the slider or the autopilot) unless the finger is on the slider. */
  setThrottle(v) { if (this.pid.throttle !== null && v !== this.throttleSet) return; this.throttleShown = v; this.fill.style.height = v * 100 + '%'; this.tknob.style.bottom = `calc(${v * 100}% - 0.5em)`; }
  take(id) { const had = this.pulses.has(id); this.pulses.delete(id); return had; }

  /** One frame of touch input, shaped like the rest of Input.poll(). */
  read() {
    return { x: this.stick.x, y: this.stick.y, fire: !!this.held.fire, identify: !!this.held.identify, brake: !!this.held.brake, missile: this.take('missile'), flare: this.take('flare'), cycle: this.take('cycle'), camera: this.take('camera'), pause: this.take('pause'), throttle: this.throttleSet };
  }
  reset() { this.stick.x = this.stick.y = 0; this.held = {}; this.pulses.clear(); this.throttleSet = undefined; this.pid.stick = this.pid.throttle = null; this.base.classList.remove('on'); }
}
