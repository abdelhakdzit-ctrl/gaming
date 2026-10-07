import { baseMapSVG, px, py, FULL_VIEW, regionFor, REGIONS } from './algeriaMap.js';
import { Settings } from '../settings/settings.js';

const PLANE = 'M0,-10 L6,8 L0,4 L-6,8 Z';

/**
 * Animated tactical briefing built from mission JSON: SVG map + canvas FX + CSS animation.
 * Sequence: dark Algeria -> region highlight -> zoom -> flight path -> enemy routes -> threat zones ->
 * radar coverage -> friendly aircraft -> objectives -> weather/time/threat -> dive into the 3D world.
 */
export class Briefing {
  constructor(root, mission, { onDone, audio }) {
    this.m = mission; this.onDone = onDone; this.audio = audio; this.timers = []; this.raf = 0; this.done = false; this.movers = []; this.root = root;
    const b = mission.briefing, region = regionFor(mission), contacts = (mission.groups || []).filter((g) => g.spawn !== 'event').length;
    const origin = { x: px(mission.map.lon), y: py(mission.map.lat) };
    const P = (pt) => `${(origin.x + pt[0]).toFixed(1)},${(origin.y - pt[1]).toFixed(1)}`, path = (pts) => 'M' + pts.map(P).join(' L');
    this.paths = {};
    const svgLocal = `
      <g id="L-radar" opacity="0"><circle class="radar-cov" cx="${origin.x + b.radar.pos[0]}" cy="${origin.y - b.radar.pos[1]}" r="${b.radar.r}"/><path class="radar-sweep" transform="translate(${origin.x + b.radar.pos[0]} ${origin.y - b.radar.pos[1]})" d="M0,0 L${b.radar.r},0 A${b.radar.r},${b.radar.r} 0 0 0 ${(b.radar.r * Math.cos(0.7)).toFixed(1)},${(-b.radar.r * Math.sin(0.7)).toFixed(1)} Z"/></g>
      <g id="L-zones" opacity="0">${b.threatZones.map((z) => `<circle class="zone-threat" cx="${origin.x + z.pos[0]}" cy="${origin.y - z.pos[1]}" r="${z.r}"/><text class="obj-label" x="${origin.x + z.pos[0]}" y="${origin.y - z.pos[1] - z.r - 6}" text-anchor="middle">${z.label}</text>`).join('')}
        ${(b.objectives || []).filter((o) => o.civil).map((o) => `<circle class="zone-civil" cx="${origin.x + o.pos[0]}" cy="${origin.y - o.pos[1]}" r="32"/>`).join('')}</g>
      <path id="L-player" class="path-player" d="${path(b.playerPath)}"/>
      <g id="L-enemy" opacity="0">${b.enemyRoutes.map((r, i) => `<path id="er${i}" class="path-enemy ${r.unknown ? 'unk' : ''}" d="${path(r.points)}"/><text class="obj-label" x="${origin.x + r.points[0][0]}" y="${origin.y - r.points[0][1] - 12}" text-anchor="middle">${r.label}</text>`).join('')}</g>
      <g id="L-icons"></g>
      <g id="L-obj" opacity="0">${(b.objectives || []).map((o) => `<path d="M${origin.x + o.pos[0]},${origin.y - o.pos[1] - 9} l9,9 l-9,9 l-9,-9 Z" fill="none" stroke="${o.civil ? '#4cc9ff' : '#ffcf3d'}" stroke-width="2"/><text class="obj-label" x="${origin.x + o.pos[0] + 16}" y="${origin.y - o.pos[1] + 4}">${o.label}</text>`).join('')}
        <path d="M${origin.x - 8},${origin.y} h16 M${origin.x},${origin.y - 8} v16" stroke="#5dffa8" stroke-width="2"/><text class="obj-label" x="${origin.x + 12}" y="${origin.y + 20}">${mission.base?.name || 'BASE'}</text></g>`;
    const info = [['REGION', mission.region], ['THREAT', mission.threat], ['WEATHER', mission.weatherLabel], ['TIME', mission.clock], ['CONTACTS', String(contacts).padStart(2, '0')], ['MISSION', mission.type]];
    root.innerHTML = `
      <div class="screen brief" id="brief">
        <div class="brief-stage" id="bstage">
          <svg id="bsvg" viewBox="${FULL_VIEW.x} ${FULL_VIEW.y} ${FULL_VIEW.w} ${FULL_VIEW.h}" preserveAspectRatio="xMidYMid slice">${baseMapSVG({ hot: null })}${svgLocal}</svg>
          <canvas class="fx" id="bfx"></canvas><div class="scan"></div>
        </div>
        <div class="brief-title">TACTICAL BRIEFING · BRIEFING TACTIQUE · <span dir="rtl">إحاطة تكتيكية</span></div>
        <div class="brief-info">${info.map(([k, v]) => `<div class="line"><b>${k}</b><span>${v}</span></div>`).join('')}<div class="line"><b>THREAT LEVEL</b><span class="threat-meter">${[1, 2, 3, 4, 5].map((i) => `<i data-i="${i}"></i>`).join('')}</span></div></div>
        <div class="stamp" style="display:none">CLASSIFIED</div>
        <div class="brief-log" id="blog">INITIALISING TACTICAL DISPLAY…</div>
        <button class="btn small brief-skip" data-act="skip">SKIP ▸▸</button><div class="flash" id="bflash"></div>
      </div>`;
    this.el = root.querySelector('#brief'); this.svg = root.querySelector('#bsvg'); this.stage = root.querySelector('#bstage'); this.log = root.querySelector('#blog'); this.flash = root.querySelector('#bflash');
    this.lines = [...root.querySelectorAll('.brief-info .line')]; this.canvas = root.querySelector('#bfx'); this.origin = origin; this.region = region; this.b = b;
    root.querySelector('[data-act=skip]').onclick = () => this.finish();
    this.speed = Settings.s.reducedMotion ? 0.55 : 1; this.setView([FULL_VIEW.x, FULL_VIEW.y, FULL_VIEW.w, FULL_VIEW.h]); this.script(); this.loop();
  }
  at(ms, fn) { this.timers.push(setTimeout(() => { if (!this.done) fn(); }, ms * this.speed)); }
  say(t) { this.log.textContent = t; }
  show(id) { const el = this.svg.querySelector('#' + id); if (el) { el.style.transition = 'opacity 0.8s'; el.setAttribute('opacity', '1'); } }
  line(i) { this.lines[i]?.classList.add('on'); this.audio?.play('hover'); }
  setView(v) { this.svg.setAttribute('viewBox', v.join(' ')); this.svg.style.setProperty('--u', (v[2] / 110).toFixed(2)); }
  tweenView(to, ms) {
    const from = this.svg.getAttribute('viewBox').split(' ').map(Number), t0 = performance.now();
    const step = (now) => { if (this.done) return; const k = Math.min(1, (now - t0) / (ms * this.speed)), e = k * k * (3 - 2 * k); this.setView(from.map((v, i) => v + (to[i] - v) * e)); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  script() {
    const { b, m } = this, R = REGIONS[this.region];
    this.at(600, () => { this.stage.querySelector('.country').style.opacity = 1; this.say('ALGERIA — NATIONAL AIRSPACE'); this.root.querySelector('.stamp').style.display = 'block'; this.audio?.play('stamp'); });
    this.at(1500, () => { this.svg.querySelector(`.region[data-region=${this.region}]`)?.classList.add('hot'); this.svg.querySelectorAll('.map-label').forEach((l) => { if (l.textContent === R.name) l.classList.add('hot'); }); this.say(`REGION: ${m.region}`); this.line(0); });
    this.at(2400, () => { this.line(1); this.line(5); });
    this.at(3000, () => { const w = b.zoomKm * 1.9, h = w * (innerHeight / innerWidth); this.tweenView([px(b.center.lon) - w / 2, py(b.center.lat) - h / 2, w, h], 2600); this.say('ZOOMING TO OPERATIONAL AREA'); });
    this.at(5800, () => { const p = this.svg.querySelector('#L-player'); const len = p.getTotalLength(); p.style.strokeDasharray = len; p.style.strokeDashoffset = len; p.getBoundingClientRect(); p.style.transition = 'stroke-dashoffset 2.4s linear'; p.style.strokeDashoffset = 0; this.say('FLIGHT PATH — FALCON FLIGHT'); this.line(4); });
    this.at(7200, () => { this.show('L-enemy'); this.setupMovers('enemy'); this.say('CONTACTS — ROUTES UNVERIFIED'); this.audio?.play('lock'); });
    this.at(8400, () => { this.show('L-zones'); this.say('THREAT ZONES'); });
    this.at(9200, () => { this.show('L-radar'); this.say('RADAR COVERAGE — COASTAL SECTOR'); });
    this.at(10000, () => { this.setupMovers('friendly'); this.say('FRIENDLY AIRCRAFT — FALCON ONE / TWO'); });
    this.at(10800, () => { this.show('L-obj'); this.say('OBJECTIVES'); });
    this.at(11400, () => { this.line(2); });
    this.at(12000, () => { this.line(3); });
    this.at(12600, () => { this.line(6); const lvl = m.threatLevel; this.root.querySelectorAll('.threat-meter i').forEach((i) => { if (+i.dataset.i <= lvl) setTimeout(() => i.classList.add('on'), +i.dataset.i * 160); }); this.say(`THREAT LEVEL ${lvl}/5 — ${m.threat}`); });
    this.at(14600, () => { this.say('ENTERING THE 3D WORLD…'); this.stage.classList.add('dive'); this.audio?.play('confirm'); });
    this.at(16600, () => { this.flash.classList.add('on'); });
    this.at(17000, () => this.finish());
  }
  setupMovers(kind) {
    const { b, origin } = this, g = this.svg.querySelector('#L-icons');
    const defs = kind === 'enemy' ? b.enemyRoutes.map((r, i) => ({ pts: this.svg.querySelector('#er' + i), color: r.unknown ? '#ffcf3d' : '#ff5348', off: i * 0.12 })) : b.friendly.map((f, i) => {
      const d = 'M' + f.path.map((pt) => `${(origin.x + pt[0]).toFixed(1)},${(origin.y - pt[1]).toFixed(1)}`).join(' L'); const el = document.createElementNS('http://www.w3.org/2000/svg', 'path'); el.setAttribute('d', d); return { pts: el, color: '#4cc9ff', off: i * 0.06 };
    });
    for (const d of defs) {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'path'); el.setAttribute('d', PLANE); el.setAttribute('fill', d.color); el.setAttribute('stroke', '#000'); el.setAttribute('stroke-width', '1'); g.appendChild(el);
      this.movers.push({ el, path: d.pts, len: d.pts.getTotalLength(), t: d.off, kind });
    }
  }
  loop() {
    const ctx = this.canvas.getContext('2d'); let t = 0;
    const draw = () => {
      if (this.done) return; t += 0.016; const w = (this.canvas.width = innerWidth), h = (this.canvas.height = innerHeight); ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(93,255,168,0.12)'; ctx.lineWidth = 1; const cx = w * 0.62, cy = h * 0.55; for (let r = 1; r < 5; r++) { ctx.beginPath(); ctx.arc(cx, cy, r * Math.min(w, h) * 0.17, 0, 6.283); ctx.stroke(); }
      const a = t * 1.3; const g = ctx.createLinearGradient(cx, cy, cx + Math.cos(a) * w, cy + Math.sin(a) * w); g.addColorStop(0, 'rgba(93,255,168,0.16)'); g.addColorStop(1, 'rgba(93,255,168,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, w, a - 0.28, a); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(190,255,230,0.35)'; for (let i = 0; i < 70; i++) ctx.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
      ctx.fillStyle = 'rgba(93,255,168,0.55)'; ctx.font = '12px ui-monospace, monospace'; for (let i = 0; i < 6; i++) ctx.fillText(`${(36.9 - i * 0.31).toFixed(2)}°N`, w - 78, h * (0.15 + i * 0.13)); for (let i = 0; i < 6; i++) ctx.fillText(`${(3.1 + i * 0.6).toFixed(1)}°E`, w * (0.22 + i * 0.12), h - 12);
      for (const mv of this.movers) { mv.t = (mv.t + 0.0035 * (mv.kind === 'enemy' ? 1 : 1.3)) % 1; const p = mv.path.getPointAtLength(mv.t * mv.len), q = mv.path.getPointAtLength(Math.min(mv.len, mv.t * mv.len + 4)); mv.el.setAttribute('transform', `translate(${p.x} ${p.y}) rotate(${(Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI + 90}) scale(${this.svgScale()})`); }
      this.raf = requestAnimationFrame(draw);
    };
    draw();
  }
  svgScale() { const vb = this.svg.getAttribute('viewBox').split(' ').map(Number); return Math.min(1.2, Math.max(0.05, (vb[2] / 900) * 0.5)); }
  finish() { if (this.done) return; this.done = true; this.timers.forEach(clearTimeout); cancelAnimationFrame(this.raf); this.onDone?.(); }
  dispose() { this.done = true; this.timers.forEach(clearTimeout); cancelAnimationFrame(this.raf); }
}
