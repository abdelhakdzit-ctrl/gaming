import * as THREE from 'three';

// DOM HUD. Keeps the game logic free of markup: Game calls banner()/hitMarker()/damaged()/...
export class Hud {
  constructor(game) {
    this.g = game; const $ = id => document.getElementById(id); this.$ = $;
    this.el = { load: $('loading'), bar: $('loadbar'), start: $('start'), hp: $('hpfill'), hpText: $('hptext'), ammo: $('ammo'), wname: $('wname'), wlist: $('wlist'),
      xh: $('xh'), hit: $('hit'), banner: $('banner'), wave: $('wave'), vig: $('vig'), scope: $('scope'), kills: $('kills'), over: $('over'), dmg: $('dmgdir'), feed: $('feed'), labels: $('labels'), state: $('wstate') };
    this.hitT = 0; this.vigT = 0; this.bannerT = 0; this.labels = new Map(); this.debug = game.params.has('debug');
    addEventListener('keydown', e => { if (e.code === 'F3') { this.debug = !this.debug; e.preventDefault(); } });
    this.el.start.addEventListener('click', async () => { game.audio.init().catch(() => {}); game.audio.resume(); game.input.lock(); this.el.start.classList.add('hidden'); });
    game.input.onLockChange = l => { if (!l && game.state === 'play') { this.el.start.classList.remove('hidden'); this.el.start.querySelector('h2').textContent = 'PAUSED'; } };
    this.el.over.addEventListener('click', () => game.restart());
  }
  loading(p) { this.el.bar.style.width = `${(p * 100).toFixed(0)}%`; }
  ready() {
    this.el.load.classList.add('hidden');
    const p = this.g.params;
    if (p.has('autostart')) { this.el.start.classList.add('hidden'); this.g.audio.init().catch(() => {}); }
    this.el.wlist.innerHTML = this.g.player.weapons.slots.map((s, i) => `<div data-i="${i}"><b>${i + 1}</b> ${s.def.name}</div>`).join('');
  }
  banner(t, sub = '') { this.el.banner.innerHTML = `<h1>${t}</h1><p>${sub}</p>`; this.bannerT = 2.6; this.el.banner.style.opacity = 1; }
  hitMarker(head, kill) { this.hitT = 0.18; this.el.hit.className = (head ? 'head ' : '') + (kill ? 'kill' : ''); this.el.hit.style.opacity = 1; }
  suppress(a) { this.vigT = Math.min(1, this.vigT + a); }
  damaged(from, amount) {
    this.vigT = Math.min(1, this.vigT + 0.3 + amount / 50);
    if (from) { this.dmgFrom = from.clone(); this.dmgT = 1.2; }
  }
  kill(target, head) { const d = document.createElement('div'); d.textContent = `${head ? '◎ ' : '✕ '}${target.name}`; this.el.feed.prepend(d); setTimeout(() => d.remove(), 4000); }
  gameOver(game) { this.el.over.classList.remove('hidden'); this.el.over.querySelector('p').textContent = `Wave ${game.wave} · ${game.kills} kills · score ${game.score} — click to restart`; document.exitPointerLock?.(); }
  addLabel(ai) { const d = document.createElement('div'); d.className = 'lbl'; this.el.labels.append(d); this.labels.set(ai, d); }
  removeLabel(ai) { this.labels.get(ai)?.remove(); this.labels.delete(ai); }

  update(dt) {
    const g = this.g, P = g.player, w = P.weapons, d = w.def;
    this.el.hp.style.width = `${(P.health / P.maxHealth) * 100}%`; this.el.hpText.textContent = Math.ceil(P.health);
    this.el.hp.style.background = P.health < 30 ? '#d33' : '#6c6';
    this.el.ammo.textContent = w.ammoText; this.el.wname.textContent = d.name;
    this.el.state.textContent = w.state === 'reload' ? 'RELOADING' : w.state === 'cycle' ? (d.pump ? 'PUMP' : 'BOLT') : w.slot.mag === 0 ? 'EMPTY — R' : '';
    [...this.el.wlist.children].forEach((c, i) => c.classList.toggle('on', i === w.index));
    this.el.wave.textContent = `WAVE ${g.wave}  ·  HOSTILES ${g.ais.filter(a => !a.c.dead).length}`;
    this.el.kills.textContent = `${g.score}  ·  ${g.kills} kills`;
    // crosshair gap from current spread
    const px = Math.tan(THREE.MathUtils.degToRad(w.currentSpread())) * innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(g.camera.fov / 2)));
    this.el.xh.style.setProperty('--s', `${Math.max(4, px).toFixed(1)}px`);
    const scoped = g.ctl.scoped; this.el.scope.style.opacity = scoped ? 1 : 0; this.el.xh.style.opacity = scoped || P.intent.drawn === false ? 0 : 1;
    this.hitT -= dt; if (this.hitT <= 0) this.el.hit.style.opacity = 0;
    this.vigT = Math.max(0, this.vigT - dt * 0.7); this.el.vig.style.opacity = this.vigT;
    this.bannerT -= dt; if (this.bannerT < 0) this.el.banner.style.opacity = 0;
    if (this.dmgT > 0 && this.dmgFrom) {
      this.dmgT -= dt; const rel = this.dmgFrom.clone().sub(P.pos), a = Math.atan2(rel.x, rel.z) - g.ctl.yaw;
      this.el.dmg.style.opacity = Math.min(1, this.dmgT); this.el.dmg.style.transform = `rotate(${-a * 180 / Math.PI + 180}deg)`;
    } else this.el.dmg.style.opacity = 0;
    this.el.labels.style.display = this.debug ? 'block' : 'none';
    if (this.debug) for (const [ai, el] of this.labels) {
      const p = ai.c.pos.clone(); p.y += 2.1; p.project(g.camera);
      const vis = p.z < 1 && !ai.c.dead; el.style.display = vis ? 'block' : 'none';
      if (vis) { el.style.left = `${(p.x * 0.5 + 0.5) * innerWidth}px`; el.style.top = `${(-p.y * 0.5 + 0.5) * innerHeight}px`; el.textContent = `${ai.type.name} · ${ai.debug} · ${ai.role}${ai.mem.visible ? ' ◉' : ''}`; }
    }
  }
}
