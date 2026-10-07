import * as THREE from 'three';
import { clamp, fmtTime, DEG } from '../util/math.js';
import { Settings } from '../settings/settings.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion();

/**
 * HUD in separate layers: primary flight + targeting (canvas), radar scope (canvas), warnings,
 * mission/objectives and cinematic effects (DOM). All numbers scale with the viewport height.
 */
export class Hud {
  constructor(root) {
    this.root = root; this.visible = false; this.theme = '#5dffa8'; this.fps = 60; this.t = 0; this.toastQ = [];
    root.insertAdjacentHTML('beforeend', `
      <div class="hud hidden" id="hud">
        <canvas id="hud-flight"></canvas>
        <canvas id="hud-radar"></canvas>
        <div class="hud-objectives" id="hud-obj"></div>
        <div class="hud-clock" id="hud-clock"></div>
        <div class="hud-warning" id="hud-warn"></div>
        <div class="hud-center-msg" id="hud-msg"></div>
        <div class="hud-evidence hidden" id="hud-evidence"></div>
        <div class="hud-vignette" id="hud-vig"></div>
        <div class="hud-cine-bars" id="hud-bars"><i></i><i></i></div>
        <div class="hud-toasts" id="hud-toasts"></div>
        <div class="hud-cam" id="hud-cam"></div>
      </div>`);
    const q = (s) => root.querySelector(s);
    this.el = q('#hud'); this.fc = q('#hud-flight'); this.rc = q('#hud-radar'); this.obj = q('#hud-obj'); this.clock = q('#hud-clock'); this.warn = q('#hud-warn');
    this.msg = q('#hud-msg'); this.evi = q('#hud-evidence'); this.vig = q('#hud-vig'); this.bars = q('#hud-bars'); this.toasts = q('#hud-toasts'); this.camLabel = q('#hud-cam');
    this.g = this.fc.getContext('2d'); this.rg = this.rc.getContext('2d');
    this.el.insertAdjacentHTML('beforeend', '<div class="hud-title-card" id="hud-title"></div><div class="hud-fade" id="hud-fade"></div>');
    this.titleEl = this.el.querySelector('#hud-title'); this.fadeEl = this.el.querySelector('#hud-fade');
    this.objKey = ''; this.damageFlash = 0; this.msgT = 0; this.camT = 0; this.sweep = 0; this.lockSoundT = 0; this.palette = Settings.palette();
    window.addEventListener('resize', () => this.resize()); this.resize();
  }
  show(v) { this.visible = v; this.el.classList.toggle('hidden', !v); if (v) this.resize(); }
  setTheme(c) { this.theme = c; document.documentElement.style.setProperty('--hud', c); }
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2); this.W = window.innerWidth; this.H = window.innerHeight; this.dpr = dpr;
    this.fc.width = this.W * dpr; this.fc.height = this.H * dpr; this.fc.style.width = this.W + 'px'; this.fc.style.height = this.H + 'px';
    this.u = clamp(this.H / 1080, document.body.classList.contains('touch-on') ? 0.85 : 0.62, 1.5); const rs = Math.round(clamp(this.H * 0.21, document.body.classList.contains('touch-on') ? 100 : 130, 230));
    this.rs = rs; this.rc.width = rs * dpr; this.rc.height = rs * dpr; this.rc.style.width = rs + 'px'; this.rc.style.height = rs + 'px';
  }
  fade(on) { this.fadeEl.classList.toggle('on', !!on); }
  titleCard(text, sub = '') {
    this.titleEl.innerHTML = `<i></i><h2>${text}</h2><p>${sub}</p>`; this.titleEl.classList.remove('on'); void this.titleEl.offsetWidth; this.titleEl.classList.add('on');
    clearTimeout(this._tc); this._tc = setTimeout(() => this.titleEl.classList.remove('on'), 5200);
  }
  toast(text, kind = '') {
    const d = document.createElement('div'); d.className = 'toast ' + kind; d.textContent = text; this.toasts.appendChild(d);
    setTimeout(() => d.classList.add('out'), 3200); setTimeout(() => d.remove(), 3800);
  }
  centerMsg(text, sec = 2.5, kind = '') { this.msg.textContent = text; this.msg.className = 'hud-center-msg on ' + kind; this.msgT = sec; }
  cinematic(on) { this.bars.classList.toggle('on', on); }
  flashDamage(v) { this.damageFlash = Math.min(1, this.damageFlash + v); }
  showEvidence(card, sec = 11) {
    this.evi.innerHTML = `<div class="evi-title">${card.title}</div>${card.lines.map((l, i) => `<div class="evi-line" style="animation-delay:${0.6 + i * 0.7}s">${l}</div>`).join('')}`;
    this.evi.classList.remove('hidden'); setTimeout(() => this.evi.classList.add('hidden'), sec * 1000);
  }
  camName(name) { this.camLabel.textContent = name; this.camLabel.classList.add('on'); this.camT = 1.6; }

  // ---------------------------------------------------------------- per-frame
  update(dt, S) {
    this.t += dt; if (!this.visible) return;
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
    if (this.msgT > 0) { this.msgT -= dt; if (this.msgT <= 0) this.msg.classList.remove('on'); }
    if (this.camT > 0) { this.camT -= dt; if (this.camT <= 0) this.camLabel.classList.remove('on'); }
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.4);
    this.palette = Settings.palette();
    const incoming = S.incoming, near = incoming.length ? incoming.reduce((a, m) => Math.min(a, m.pos.distanceTo(S.player.pos)), 1e9) : 1e9;
    const threat = incoming.length ? clamp(1 - near / 6500, 0.12, 1) : 0;
    this.threat = threat;
    // vignette: damage + missile
    const pulse = 0.5 + 0.5 * Math.sin(this.t * (6 + threat * 10));
    this.vig.style.opacity = Math.min(1, this.damageFlash * 0.9 + threat * 0.45 * pulse * S.diff.warning).toFixed(3);
    this.el.classList.toggle('cine', !!S.hudHidden);
    this.drawObjectives(S);
    this.drawWarnings(S, threat);
    this.clock.textContent = `${fmtTime(S.missionTime)}  ·  ${Settings.s.difficulty}${S.mouseFlight ? '  ·  MOUSE FLIGHT' : ''}${Settings.s.showFps ? '  ·  ' + Math.round(this.fps) + ' FPS' : ''}`;
    this.drawFlight(S, threat); this.drawRadar(S);
  }

  drawObjectives(S) {
    const d = S.director; if (!d) return;
    const cur = d.currentObjective(), rows = (kind) => d.objectives.filter((o) => o.kind === kind && !o.hidden);
    const row = (o) => `<li class="${o.state}${cur === o ? ' current' : ''}"><i></i>${o.label}${o.progress > 0 && o.progress < 1 && o.state === 'active' ? ` <em>${Math.round(o.progress * 100)}%</em>` : ''}</li>`;
    const html = `<h4>OBJECTIVES</h4><ul>${rows('primary').map(row).join('')}</ul>${rows('secondary').length ? `<h5>SECONDARY</h5><ul class="sec">${rows('secondary').map(row).join('')}</ul>` : ''}${rows('optional').length ? `<h5>OPTIONAL</h5><ul class="sec">${rows('optional').map(row).join('')}</ul>` : ''}`;
    if (html !== this.objHtml) { this.objHtml = html; this.obj.innerHTML = html; }
  }

  drawWarnings(S, threat) {
    const list = [], f = S.flight, p = S.player;
    if (threat > 0) list.push({ t: 'MISSILE WARNING', c: 'crit', blink: 4 + threat * 8 });
    if (S.samLock > 0.25) list.push({ t: S.samLock >= 0.99 ? 'SAM LAUNCH' : 'SAM LOCK', c: 'crit', blink: 3 + S.samLock * 8 });
    if (S.pullUp) list.push({ t: 'PULL UP', c: 'crit', blink: 8 });
    if (f.stalled && !f.onGround) list.push({ t: 'STALL', c: 'crit', blink: 6 });
    if (f.overspeed) list.push({ t: 'OVERSPEED', c: 'warn', blink: 3 });
    if (S.radar.severity > 0.1) list.push({ t: 'RADAR JAMMED', c: 'warn', blink: 2 });
    if (S.boundary > 0) list.push({ t: `RETURN TO OPERATIONS AREA  ${Math.ceil(25 - S.boundary)}s`, c: 'warn', blink: 3 });
    if (S.hpFrac < 0.3 && p.alive) list.push({ t: 'CRITICAL DAMAGE', c: 'warn', blink: 3 });
    const html = list.map((w) => `<div class="w ${w.c}" style="animation-duration:${(1 / w.blink).toFixed(2)}s">${w.t}</div>`).join('');
    if (html !== this.warnHtml) { this.warnHtml = html; this.warn.innerHTML = html; }
  }

  // projection into the active camera: returns {x,y,on(screen),front}
  project(cam, p, out = {}) {
    _v.copy(p).applyMatrix4(cam.matrixWorldInverse); out.front = _v.z < -0.5;
    if (!out.front) { out.x = this.W / 2 + _v.x * 1000; out.y = this.H / 2 - _v.y * 1000; out.on = false; return out; }
    _v.applyMatrix4(cam.projectionMatrix); out.x = (_v.x * 0.5 + 0.5) * this.W; out.y = (-_v.y * 0.5 + 0.5) * this.H;
    out.on = out.x > 0 && out.x < this.W && out.y > 0 && out.y < this.H; return out;
  }

  drawFlight(S, threat) {
    const g = this.g, W = this.W, H = this.H, u = this.u, cam = S.camera, f = S.flight, p = S.player, col = this.theme;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); g.clearRect(0, 0, W, H);
    if (S.hudHidden) return;
    const minimal = S.diff.hud.minimal, cockpit = S.camMode === 'cockpit';
    const cx = W / 2, cy = H / 2, focal = (H / 2) / Math.tan((cam.fov * DEG) / 2);
    cam.updateMatrixWorld(); cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    g.lineWidth = Math.max(1.4, 1.6 * u); g.strokeStyle = col; g.fillStyle = col; g.font = `${Math.round(15 * u)}px "Share Tech Mono", ui-monospace, Menlo, monospace`; g.textBaseline = 'middle';
    g.shadowColor = col; g.shadowBlur = 5;
    if (cockpit) this.drawCockpit(g, W, H, u);

    // ---- nose / flight-path / ladder
    const nose = this.project(cam, _w.copy(p.pos).addScaledVector(f.fwd, 2500), this.n1 || (this.n1 = {}));
    const fpm = this.project(cam, _w.copy(p.pos).addScaledVector(f.vel.lengthSq() > 1 ? _q.set(0, 0, 0) && _v.copy(f.vel).normalize() : f.fwd, 2500), this.n2 || (this.n2 = {}));
    // ladder
    if (!minimal && nose.front) {
      const up = this.project(cam, _w.copy(p.pos).addScaledVector(f.fwd, 2500).add(_v.set(0, 250, 0)), this.n3 || (this.n3 = {}));
      const ang = Math.atan2(up.x - nose.x, -(up.y - nose.y)), ppd = focal * Math.PI / 180;
      g.save(); g.translate(nose.x, nose.y); g.rotate(ang); g.beginPath(); g.rect(-190 * u, -190 * u, 380 * u, 380 * u); g.clip();
      g.globalAlpha = 0.9;
      for (let deg = -60; deg <= 60; deg += 10) {
        const y = (f.pitchDeg - deg) * ppd; if (Math.abs(y) > 200 * u) continue;
        if (deg === 0) { g.beginPath(); g.moveTo(-170 * u, y); g.lineTo(-30 * u, y); g.moveTo(30 * u, y); g.lineTo(170 * u, y); g.stroke(); continue; }
        const dir = deg > 0 ? 1 : -1, w = 46 * u, tick = 9 * u * dir;
        g.setLineDash(deg < 0 ? [8 * u, 6 * u] : []);
        g.beginPath(); g.moveTo(-w - 30 * u, y + tick); g.lineTo(-w - 30 * u, y); g.lineTo(-30 * u, y); g.moveTo(30 * u, y); g.lineTo(w + 30 * u, y); g.lineTo(w + 30 * u, y + tick); g.stroke(); g.setLineDash([]);
        g.textAlign = 'right'; g.fillText(Math.abs(deg), -w - 38 * u, y); g.textAlign = 'left'; g.fillText(Math.abs(deg), w + 38 * u, y);
      }
      g.restore();
    }
    // gun cross (aircraft nose) and flight path marker
    if (nose.front) { const x = nose.x, y = nose.y, r = 11 * u; g.beginPath(); g.moveTo(x - r * 1.7, y); g.lineTo(x - r * 0.5, y); g.moveTo(x + r * 1.7, y); g.lineTo(x + r * 0.5, y); g.moveTo(x, y - r * 1.2); g.lineTo(x, y - r * 0.4); g.stroke(); }
    if (fpm.front && !minimal) { const x = fpm.x, y = fpm.y, r = 8 * u; g.beginPath(); g.arc(x, y, r, 0, 6.283); g.moveTo(x - r, y); g.lineTo(x - r * 2.2, y); g.moveTo(x + r, y); g.lineTo(x + r * 2.2, y); g.moveTo(x, y - r); g.lineTo(x, y - r * 1.9); g.stroke(); }

    // ---- heading tape
    this.drawHeading(g, cx, 38 * u, u, f.heading, S);
    // ---- speed / altitude
    const sx = cx - Math.min(W * 0.27, 400 * u), ax = cx + Math.min(W * 0.27, 400 * u);
    this.drawTape(g, sx, cy, u, f.speed * 3.6, 'KM/H', 100, 'left', `M ${(f.speed / 340).toFixed(2)}`);
    this.drawTape(g, ax, cy, u, f.pos.y, 'ALT M', 100, 'right', f.agl < 1500 ? `AGL ${Math.round(f.agl)}` : `VS ${Math.round(f.vspeed)}`);
    // ---- G, throttle
    g.textAlign = 'left'; const bx = sx - 20 * u, by = cy + 190 * u;
    g.fillStyle = f.g > 7 || f.g < -2 ? '#ff5348' : col; g.fillText(`G ${f.g.toFixed(1)}`, bx, by);
    g.fillStyle = col; g.fillText(`AOA ${(f.aoa / DEG).toFixed(0)}°`, bx, by + 22 * u);
    g.strokeRect(bx, by + 40 * u, 110 * u, 9 * u); g.fillRect(bx, by + 40 * u, 110 * u * f.throttle, 9 * u);
    g.fillText(`THR ${Math.round(f.throttle * 100)}%${f.afterburner ? ' AB' : ''}${f.ctrl.brake > 0.5 ? ' BRK' : ''}`, bx, by + 62 * u);

    // ---- weapons
    this.drawWeapons(g, S, cx, H - 96 * u, u);
    // ---- contacts + target
    this.drawMarkers(g, S, cam, u);
    this.drawContacts(g, S, cam, nose, cx, cy, u, focal, minimal);
    if (S.recon) { const o = S.recon, x = cx, y = cy + 150 * u; g.save(); g.strokeStyle = '#ffcf3d'; g.fillStyle = '#ffcf3d'; g.shadowColor = '#ffcf3d'; g.globalAlpha = 0.35; g.beginPath(); g.arc(x, y, 26 * u, 0, 6.283); g.stroke(); g.globalAlpha = 1; g.beginPath(); g.arc(x, y, 26 * u, -Math.PI / 2, -Math.PI / 2 + 6.283 * o.progress); g.stroke(); g.textAlign = 'center'; g.fillText(o.type === 'recon_site' ? 'RECORDING — HOLD STEADY' : 'COVERING THE AREA', x, y + 46 * u); g.restore(); }
    // ---- missile warning arrows
    if (threat > 0) this.drawIncoming(g, S, cx, cy, u, threat);
    // ---- mouse aim cursor + line from the nose marker
    if (S.mouseAim) { const mx = S.mouseAim.x, my = S.mouseAim.y, r = 15 * u; g.save(); g.globalAlpha = 0.85; g.strokeStyle = '#ffffff'; g.fillStyle = '#ffffff'; g.shadowColor = '#000'; g.shadowBlur = 3;
      if (nose.front) { g.globalAlpha = 0.25; g.beginPath(); g.moveTo(nose.x, nose.y); g.lineTo(mx, my); g.stroke(); g.globalAlpha = 0.9; }
      g.beginPath(); g.arc(mx, my, r, 0, 6.283); g.moveTo(mx - r * 1.6, my); g.lineTo(mx - r * 0.5, my); g.moveTo(mx + r * 1.6, my); g.lineTo(mx + r * 0.5, my); g.moveTo(mx, my - r * 1.6); g.lineTo(mx, my - r * 0.5); g.moveTo(mx, my + r * 1.6); g.lineTo(mx, my + r * 0.5); g.stroke(); g.restore(); }
    g.shadowBlur = 0;
  }

  drawCockpit(g, W, H, u) {
    g.save(); g.shadowBlur = 0;
    const grd = g.createLinearGradient(0, H * 0.78, 0, H); grd.addColorStop(0, 'rgba(8,11,14,0)'); grd.addColorStop(0.35, 'rgba(8,11,14,0.92)'); grd.addColorStop(1, '#05070a');
    g.fillStyle = grd; g.fillRect(0, H * 0.78, W, H * 0.22);
    g.fillStyle = '#0a0d11'; g.beginPath(); g.moveTo(0, 0); g.lineTo(W, 0); g.lineTo(W, H * 0.06); g.quadraticCurveTo(W / 2, H * 0.12, 0, H * 0.06); g.fill();
    g.fillStyle = '#080a0d'; g.beginPath(); g.moveTo(0, 0); g.lineTo(W * 0.075, 0); g.lineTo(W * 0.02, H * 0.9); g.lineTo(0, H * 0.9); g.fill();
    g.beginPath(); g.moveTo(W, 0); g.lineTo(W * 0.925, 0); g.lineTo(W * 0.98, H * 0.9); g.lineTo(W, H * 0.9); g.fill();
    g.strokeStyle = 'rgba(120,140,150,0.25)'; g.lineWidth = 2; g.beginPath(); g.moveTo(W * 0.075, 0); g.lineTo(W * 0.02, H * 0.9); g.moveTo(W * 0.925, 0); g.lineTo(W * 0.98, H * 0.9); g.stroke();
    g.restore();
  }

  drawHeading(g, cx, y, u, hdg, S) {
    const pxDeg = 5.2 * u, wdt = 330 * u; g.save(); g.beginPath(); g.rect(cx - wdt, y - 30 * u, wdt * 2, 60 * u); g.clip();
    g.textAlign = 'center';
    for (let d = Math.floor(hdg - 66); d <= hdg + 66; d++) {
      if (d % 5) continue; const x = cx + (d - hdg) * pxDeg, hv = ((d % 360) + 360) % 360, major = hv % 10 === 0;
      g.beginPath(); g.moveTo(x, y + 6 * u); g.lineTo(x, y + (major ? 18 : 12) * u); g.stroke();
      if (hv % 30 === 0) { const lbl = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[hv] || String(hv / 10).padStart(2, '0'); g.fillText(lbl, x, y - 4 * u); }
    }
    const wp = S.waypoint; if (wp) { let rel = ((wp.bearing - hdg + 540) % 360) - 180; rel = clamp(rel, -66, 66); const x = cx + rel * pxDeg; g.beginPath(); g.moveTo(x, y + 8 * u); g.lineTo(x - 7 * u, y + 22 * u); g.lineTo(x + 7 * u, y + 22 * u); g.closePath(); g.fillStyle = '#ffcf3d'; g.fill(); g.fillStyle = this.theme; }
    g.restore();
    g.beginPath(); g.moveTo(cx, y + 30 * u); g.lineTo(cx - 7 * u, y + 40 * u); g.lineTo(cx + 7 * u, y + 40 * u); g.closePath(); g.fill();
    g.textAlign = 'center'; g.fillText(String(Math.round(hdg) % 360).padStart(3, '0') + '°', cx, y + 56 * u);
  }

  drawTape(g, x, cy, u, value, label, step, side, sub) {
    const h = 250 * u; g.save(); g.beginPath(); g.rect(x - 70 * u, cy - h / 2, 140 * u, h); g.clip();
    const dir = side === 'left' ? -1 : 1; g.textAlign = side === 'left' ? 'right' : 'left';
    const per = step / 2, pix = (h / 2) / (step * 2.4);
    for (let v = Math.floor((value - step * 2.4) / per) * per; v <= value + step * 2.4; v += per) {
      const y = cy - (v - value) * pix; const major = Math.round(v) % step === 0;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + dir * (major ? 14 : 8) * u, y); g.stroke();
      if (major && v >= 0) g.fillText(String(Math.round(v)), x + dir * 20 * u + (side === 'left' ? -0 : 0), y);
    }
    g.restore();
    const bw = 76 * u, bh = 26 * u, bxx = side === 'left' ? x - bw - 4 * u : x + 4 * u;
    g.save(); g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(bxx, cy - bh / 2, bw, bh); g.restore(); g.strokeRect(bxx, cy - bh / 2, bw, bh);
    g.textAlign = 'center'; g.font = `bold ${Math.round(17 * u)}px "Share Tech Mono", ui-monospace, monospace`; g.fillText(String(Math.round(value)), bxx + bw / 2, cy + 1);
    g.font = `${Math.round(13 * u)}px "Share Tech Mono", ui-monospace, monospace`; g.fillText(label, bxx + bw / 2, cy - h / 2 - 12 * u); g.fillText(sub, bxx + bw / 2, cy + h / 2 + 14 * u);
    g.font = `${Math.round(15 * u)}px "Share Tech Mono", ui-monospace, monospace`;
  }

  drawWeapons(g, S, cx, y, u) {
    const p = S.player, st = S.missileStatus;
    g.textAlign = 'center';
    const colr = { MOUNTED: this.theme, READY: '#ffcf3d', LOCKED: '#ff5348', LAUNCHED: '#7fdcff', EMPTY: '#8a8f94' }[st] || this.theme;
    if (S.fireHint) { g.save(); g.fillStyle = S.fireHint.includes('FIRE MISSILE') ? '#ff5348' : '#ffcf3d'; g.shadowColor = g.fillStyle; g.font = `${Math.round(14 * u)}px "Share Tech Mono", ui-monospace, monospace`; g.fillText(S.fireHint, cx, y - 56 * u); g.restore(); }
    g.save(); g.fillStyle = colr; g.shadowColor = colr; g.font = `bold ${Math.round(18 * u)}px "Share Tech Mono", ui-monospace, monospace`;
    const blink = st === 'LOCKED' && Math.floor(this.t * 6) % 2 === 0;
    g.globalAlpha = blink ? 0.55 : 1; g.fillText(`MISSILE STATUS: ${st}`, cx, y - 28 * u); g.restore();
    g.font = `${Math.round(15 * u)}px "Share Tech Mono", ui-monospace, monospace`;
    g.fillText(`GUN ${String(S.ammo).padStart(3, '0')}    AAM ${p.missilesLeft}    FLARES ${String(p.flaresLeft).padStart(2, '0')}`, cx, y);
    const hf = S.hpFrac; g.strokeRect(cx - 80 * u, y + 18 * u, 160 * u, 6 * u); g.save(); g.fillStyle = hf < 0.3 ? '#ff5348' : this.theme; g.fillRect(cx - 80 * u, y + 18 * u, 160 * u * hf, 6 * u); g.restore();
  }

  drawContacts(g, S, cam, nose, cx, cy, u, focal, minimal) {
    const pal = this.palette, radar = S.radar, sel = radar.selected, tmp = this.n4 || (this.n4 = {});
    g.textAlign = 'center';
    for (const c of radar.contacts) {
      const e = c.entity, isSel = e === sel; if (c.stale && !isSel && c.lastSeen > 1.4) continue;
      const pr = this.project(cam, e.pos, tmp);
      const colr = { hostile: pal.hostile, friendly: pal.friend, unknown: pal.unknown }[c.cls]; g.strokeStyle = colr; g.fillStyle = colr; g.shadowColor = colr;
      g.globalAlpha = c.stale ? 0.4 : clamp(0.35 + c.quality, 0.4, 1);
      const rpx = clamp((e.radius * 1.6 * focal) / Math.max(c.range, 50), 15 * u, 140 * u), jx = c.jx * W(this.W), jy = c.jy * W(this.W);
      let x = pr.x + jx, y = pr.y + jy;
      if (!pr.on) { if (!c.stale || isSel) this.edgeArrow(g, x, y, colr, u, isSel, c.range); continue; }
      if (!isSel) {
        if (minimal && c.range > 3500) continue;
        const s = 8 * u; g.beginPath();
        if (c.cls === 'hostile') { g.moveTo(x, y - s); g.lineTo(x + s, y); g.lineTo(x, y + s); g.lineTo(x - s, y); g.closePath(); } else if (c.cls === 'friendly') g.arc(x, y, s * 0.9, 0, 6.283); else g.rect(x - s * 0.8, y - s * 0.8, s * 1.6, s * 1.6);
        g.stroke(); g.font = `${Math.round(12 * u)}px "Share Tech Mono", ui-monospace, monospace`; g.fillText((c.range / 1000).toFixed(1), x, y + 22 * u);
        continue;
      }
      // selected target: brackets, label, lock + identify rings
      const r = rpx, L = r * 0.45; g.lineWidth = 2 * u;
      const locked = radar.locked; if (locked) { g.strokeStyle = '#ff5348'; g.fillStyle = '#ff5348'; }
      g.beginPath(); for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { g.moveTo(x + sx * r, y + sy * (r - L)); g.lineTo(x + sx * r, y + sy * r); g.lineTo(x + sx * (r - L), y + sy * r); } g.stroke();
      if (!locked && radar.lockProgress > 0) { g.beginPath(); g.arc(x, y, r * (1.9 - radar.lockProgress * 0.9), 0, 6.283); g.setLineDash([6 * u, 5 * u]); g.stroke(); g.setLineDash([]); }
      if (locked) { g.beginPath(); g.arc(x, y, r * 1.25, 0, 6.283); g.stroke(); g.font = `bold ${Math.round(15 * u)}px "Share Tech Mono", ui-monospace, monospace`; g.fillText('LOCK', x, y - r - 16 * u); }
      if (S.idProgress > 0 && S.idProgress < 1) { g.strokeStyle = pal.unknown; g.beginPath(); g.arc(x, y, r * 1.5, -1.57, -1.57 + 6.283 * S.idProgress); g.stroke(); }
      g.font = `${Math.round(14 * u)}px "Share Tech Mono", ui-monospace, monospace`;
      const cls = c.cls === 'unknown' ? (radar.severity > 0.12 ? 'UNKNOWN ?' : 'UNKNOWN') : c.cls.toUpperCase() + (e.identified ? '' : ' ?');
      g.textAlign = 'left'; const lx = x + r + 12 * u;
      g.fillText(`${e.identified ? e.callsign : cls}`, lx, y - 12 * u); g.fillText(`${(c.range / 1000).toFixed(1)} KM  ${c.closure > 0 ? '+' : ''}${Math.round(c.closure)} M/S`, lx, y + 8 * u);
      if (e.identified) g.fillText(`${c.cls.toUpperCase()} · IDENTIFIED`, lx, y + 28 * u);
      g.textAlign = 'center';
      // cannon lead pipper
      if (c.range < 1900 && S.player.hasCannon) {
        const tgo = c.range / 980; _v.copy(e.pos).addScaledVector(_w.copy(e.vel).sub(S.flight.vel), tgo);
        const lp = this.project(cam, _v, this.n5 || (this.n5 = {}));
        if (lp.front) { g.strokeStyle = this.theme; g.fillStyle = this.theme; g.beginPath(); g.arc(lp.x, lp.y, 15 * u, 0, 6.283); g.stroke(); g.beginPath(); g.arc(lp.x, lp.y, 2 * u, 0, 6.283); g.fill(); }
      }
      g.lineWidth = Math.max(1.4, 1.6 * u);
    }
    g.globalAlpha = 1; g.strokeStyle = this.theme; g.fillStyle = this.theme; g.shadowColor = this.theme;
  }
  drawMarkers(g, S, cam, u) {
    const tmp = this.n6 || (this.n6 = {}); g.save(); g.textAlign = 'center'; g.font = `${Math.round(12 * u)}px ui-monospace, monospace`;
    for (const m of S.markers || []) {
      _w.set(m.pos.x, m.pos.y, m.pos.z); const dist = S.player.pos.distanceTo(_w), pr = this.project(cam, _w, tmp);
      g.strokeStyle = m.color; g.fillStyle = m.color; g.shadowColor = m.color; g.lineWidth = Math.max(1.4, 1.6 * u);
      if (pr.on && pr.front) {
        const sz = 10 * u; g.beginPath(); g.moveTo(pr.x, pr.y - sz); g.lineTo(pr.x + sz, pr.y); g.lineTo(pr.x, pr.y + sz); g.lineTo(pr.x - sz, pr.y); g.closePath(); g.stroke();
        g.fillText(m.label, pr.x, pr.y - 18 * u); g.fillText((dist / 1000).toFixed(1) + ' KM', pr.x, pr.y + 24 * u);
      } else this.edgeArrow(g, pr.x, pr.y, m.color, u, false, dist);
    }
    g.restore();
  }
  edgeArrow(g, x, y, colr, u, sel, range) {
    const cx = this.W / 2, cy = this.H / 2, a = Math.atan2(y - cy, x - cx), r = Math.min(this.W, this.H) * 0.42, k = sel ? 1.3 : 0.9;
    g.save(); g.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r); g.rotate(a); g.beginPath(); g.moveTo(14 * u * k, 0); g.lineTo(-8 * u * k, -9 * u * k); g.lineTo(-8 * u * k, 9 * u * k); g.closePath(); g.fill(); g.rotate(-a); g.font = `${Math.round(11 * u)}px ui-monospace, monospace`; g.textAlign = 'center'; g.fillText((range / 1000).toFixed(1), 0, 20 * u); g.restore();
  }
  drawIncoming(g, S, cx, cy, u, threat) {
    const p = S.player; _q.copy(p.quat).invert();
    for (const m of S.incoming) {
      _v.copy(m.pos).sub(p.pos).applyQuaternion(_q); const az = Math.atan2(_v.x, -_v.z), dist = _v.length(), k = clamp(1 - dist / 6500, 0.1, 1);
      g.save(); g.translate(cx, cy); g.rotate(az); g.fillStyle = '#ff3b30'; g.strokeStyle = '#ff3b30'; g.shadowColor = '#ff3b30'; g.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(this.t * (5 + k * 12)));
      const r = 175 * u; g.beginPath(); g.moveTo(0, -r - 16 * u); g.lineTo(-11 * u, -r + 6 * u); g.lineTo(11 * u, -r + 6 * u); g.closePath(); g.fill(); g.font = `${Math.round(13 * u)}px ui-monospace, monospace`; g.textAlign = 'center'; g.rotate(-az);
      g.restore();
    }
  }

  // ---------------------------------------------------------------- radar scope
  drawRadar(S) {
    const g = this.rg, s = this.rs, dpr = this.dpr, c = s / 2, R = c - 8, radar = S.radar, u = s / 200, pal = this.palette;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, s, s);
    g.fillStyle = 'rgba(4,10,12,0.62)'; g.beginPath(); g.arc(c, c, R + 4, 0, 6.283); g.fill();
    g.strokeStyle = this.theme; g.fillStyle = this.theme; g.lineWidth = 1.2; g.shadowColor = this.theme; g.shadowBlur = 4;
    if (S.hudHidden) return;
    const range = clamp(Math.max(10000, ...radar.contacts.filter((k) => k.visible).map((k) => k.range * 1.1)), 10000, 30000) * (S.diff.hud.minimal ? 0.5 : 1);
    g.globalAlpha = 0.55; for (const k of [0.33, 0.66, 1]) { g.beginPath(); g.arc(c, c, R * k, 0, 6.283); g.stroke(); }
    g.beginPath(); g.moveTo(c, c - R); g.lineTo(c, c + R); g.moveTo(c - R, c); g.lineTo(c + R, c); g.stroke();
    // detection cone
    const ch = radar.coneHalf; g.globalAlpha = 0.9; g.beginPath(); g.moveTo(c, c); g.lineTo(c + Math.sin(-ch) * R, c - Math.cos(ch) * R); g.moveTo(c, c); g.lineTo(c + Math.sin(ch) * R, c - Math.cos(ch) * R); g.stroke();
    g.globalAlpha = 0.07; g.beginPath(); g.moveTo(c, c); g.arc(c, c, R, -Math.PI / 2 - ch, -Math.PI / 2 + ch); g.closePath(); g.fill();
    this.sweep = (this.sweep + 0.03) % 6.283; g.globalAlpha = 0.35; g.beginPath(); g.moveTo(c, c); g.lineTo(c + Math.sin(this.sweep) * R, c - Math.cos(this.sweep) * R); g.stroke();
    g.globalAlpha = 1; g.font = `${Math.round(10 * u)}px ui-monospace, monospace`; g.textAlign = 'center'; g.fillText(`${Math.round(range / 1000)} KM`, c, c + R * 0.66 + 11 * u);
    if (radar.severity > 0.1 || radar.disabled) { g.fillStyle = pal.unknown; g.fillText(radar.disabled ? 'NO RADAR' : 'SIGNAL DEGRADED', c, c - R * 0.5); g.fillStyle = this.theme; }
    if (!radar.disabled) for (const k of radar.contacts) {
      const rr = Math.min(1, k.range / range) * R, a = k.az + k.jx * 3; if (k.stale && k.lastSeen > 2.2) continue;
      const x = c + Math.sin(a) * rr, y = c - Math.cos(a) * rr, colr = { hostile: pal.hostile, friendly: pal.friend, unknown: pal.unknown }[k.cls];
      g.strokeStyle = colr; g.fillStyle = colr; g.shadowColor = colr; g.globalAlpha = k.stale ? 0.3 : clamp(0.4 + k.quality, 0.4, 1);
      const sz = 4.5 * u; g.beginPath();
      if (k.cls === 'hostile') { g.moveTo(x, y - sz); g.lineTo(x + sz, y); g.lineTo(x, y + sz); g.lineTo(x - sz, y); g.closePath(); g.fill(); } else if (k.cls === 'friendly') { g.arc(x, y, sz * 0.85, 0, 6.283); g.fill(); } else { g.rect(x - sz * 0.8, y - sz * 0.8, sz * 1.6, sz * 1.6); g.stroke(); }
      // heading tick
      _w.set(0, 0, -1).applyQuaternion(k.entity.quat); const rel = Math.atan2(_w.x, -_w.z) - S.flight.heading * DEG; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.sin(rel) * 9 * u, y - Math.cos(rel) * 9 * u); g.stroke();
      if (k.entity === radar.selected) { g.globalAlpha = 1; g.strokeStyle = '#fff'; g.strokeRect(x - 8 * u, y - 8 * u, 16 * u, 16 * u); }
    }
    // incoming missiles
    g.globalAlpha = 1; g.fillStyle = '#ff3b30'; g.strokeStyle = '#ff3b30';
    for (const m of S.incoming) { _v.copy(m.pos).sub(S.player.pos).applyQuaternion(_q.copy(S.player.quat).invert()); const rr = Math.min(1, _v.length() / range) * R, a = Math.atan2(_v.x, -_v.z); g.beginPath(); g.arc(c + Math.sin(a) * rr, c - Math.cos(a) * rr, 3 * u, 0, 6.283); g.fill(); }
    // waypoint
    if (S.waypoint) { const a = (S.waypoint.bearing - S.flight.heading) * DEG, rr = Math.min(1, S.waypoint.dist / range) * R, x = c + Math.sin(a) * rr, y = c - Math.cos(a) * rr; g.strokeStyle = '#ffcf3d'; g.beginPath(); g.moveTo(x, y - 6 * u); g.lineTo(x + 6 * u, y); g.lineTo(x, y + 6 * u); g.lineTo(x - 6 * u, y); g.closePath(); g.stroke(); }
    // own ship
    g.fillStyle = this.theme; g.strokeStyle = this.theme; g.beginPath(); g.moveTo(c, c - 7 * u); g.lineTo(c + 5 * u, c + 6 * u); g.lineTo(c - 5 * u, c + 6 * u); g.closePath(); g.fill();
    g.shadowBlur = 0; g.globalAlpha = 1;
  }
}
const W = (n) => n;
