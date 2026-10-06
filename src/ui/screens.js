import { MISSIONS, FINAL_MISSION } from '../missions/registry.js';
import aircraftData from '../../data/aircraft.json';
import difficultyData from '../../data/difficulty.json';
import progression from '../../data/progression.json';
import challengeData from '../../data/challenges.json';
import dialogue from '../../data/dialogue.json';
import { Save } from '../save/save.js';
import { Settings } from '../settings/settings.js';
import { baseMapSVG, px, py, FULL_VIEW, regionFor, REGIONS } from '../briefing/algeriaMap.js';
import { Briefing } from '../briefing/briefing.js';
import { portraitHTML } from './portraits.js';
import { rankInfo, itemStatus, hasItem, buyItem, challengeUnlocked } from '../progression.js';
import { fmtTime } from '../util/math.js';

export { MISSIONS };
const DIFFS = Object.keys(difficultyData.levels);
const TIMES = ['dawn', 'day', 'sunset', 'night'], WEATHERS = ['clear', 'cloudy', 'fog', 'storm', 'dust'];
const BIOMES = [['coast', 'COAST'], ['atlas', 'ATLAS'], ['plateaus', 'HIGH PLATEAUS'], ['sahara', 'SAHARA'], ['southern', 'SOUTHERN ROCKS']];
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const seg = (act, opts, cur) => `<div class="seg">${opts.map(([v, l]) => `<button data-act="${act}" data-val="${v}" class="${String(cur) === String(v) ? 'sel' : ''}">${l}</button>`).join('')}</div>`;
const tog = (act, on) => `<button class="toggle ${on ? 'on' : ''}" data-act="${act}" aria-pressed="${!!on}"></button>`;
const slider = (act, val, min = 0, max = 1, step = 0.05) => `<input type="range" data-input="${act}" min="${min}" max="${max}" step="${step}" value="${val}" />`;

export const missionStatus = (m) => {
  const done = Save.data.campaign.completed;
  return done[m.id] ? 'completed' : !m.requires || done[m.requires] ? 'available' : 'locked';
};

/** All menu screens: DOM built from data, 3D hangar stays live behind them. */
export class Screens {
  constructor(app, root) { this.app = app; this.root = root; this.current = null; this.briefing = null; this.cleanup = null; root.addEventListener('click', (e) => this.onClick(e)); root.addEventListener('input', (e) => this.onInput(e)); root.addEventListener('mouseover', (e) => { if (e.target.closest?.('.btn,.card,.seg button') && e.target !== this._hov) { this._hov = e.target; this.app.audio.play('hover'); } }); }
  clear() { this.cleanup?.(); this.cleanup = null; this.briefing?.dispose(); this.briefing = null; this.root.innerHTML = ''; this.current = null; }
  show(name, props = {}) {
    this.clear(); this.current = name; this.props = props; this.app.hangar.setFocus(props.focus || ({ menu: 'menu', title: 'menu', missions: 'map', intel: 'dim', aircraft: 'aircraft', loadout: 'loadout' }[name] || 'dim'));
    const fn = this['s_' + name]; if (!fn) throw new Error('no screen ' + name); fn.call(this, props);
  }
  onClick(e) {
    const el = e.target.closest('[data-act]'); if (!el || el.disabled) return; this.app.audio.ensure(); this.app.audio.play('click');
    const act = el.dataset.act, val = el.dataset.val; const fn = this['a_' + act]; if (fn) fn.call(this, val, el, e); else console.warn('no action', act);
  }
  onInput(e) { const el = e.target.closest('[data-input]'); if (!el) return; const fn = this['i_' + el.dataset.input]; fn?.call(this, parseFloat(el.value), el); }
  go(name, props) { this.show(name, props); }

  // ------------------------------------------------------------------ title + main menu
  s_title() {
    this.root.innerHTML = `<div class="screen title-screen dim" data-act="start"><div class="kicker">A FICTIONAL AIR-COMBAT CAMPAIGN</div><h1 class="title">Shadow Line<small>SKY OF ALGERIA</small></h1><div class="tagline">“When the radar lies, the pilot must decide.”</div><div class="press">PRESS ANY KEY OR CLICK TO BEGIN</div></div>`;
    const go = () => { window.removeEventListener('keydown', go); this.app.audio.ensure(); this.app.audio.setAmbience('hangar'); this.go('menu'); };
    window.addEventListener('keydown', go, { once: true }); this.cleanup = () => window.removeEventListener('keydown', go);
  }
  a_start() { this.app.audio.ensure(); this.app.audio.setAmbience('hangar'); this.go('menu'); }
  s_menu() {
    const d = Save.data, ri = rankInfo(d.xp), has = Save.has() && d.campaign.started;
    const items = [['continue', 'CONTINUE', 'متابعة', !has], ['new', 'NEW CAMPAIGN', 'حملة جديدة'], ['missions', 'MISSIONS', 'المهام'], ['aircraft', 'AIRCRAFT', 'الطائرات'], ['freeflight', 'FREE FLIGHT', 'طيران حر'], ['challenges', 'CHALLENGES', 'التحديات'], ['replay', 'REPLAY', 'إعادة'], ['settings', 'SETTINGS', 'الإعدادات'], ['extras', 'EXTRAS', 'إضافات']];
    this.root.innerHTML = `<div class="screen menu-screen dim"><div class="menu-col"><div class="brand"><div class="kicker">PROTOTYPE · VERTICAL SLICE</div><h1 class="title">Shadow Line<small>SKY OF ALGERIA</small></h1></div>
      ${items.map(([a, l, ar, dis]) => `<button class="btn ${a === 'continue' && !dis ? 'primary' : a === 'new' && !has ? 'primary' : ''}" data-act="menu_${a}" ${dis ? 'disabled' : ''}>${l}<span class="ar">${ar}</span></button>`).join('')}</div>
      <div class="pilot-card panel"><div class="kicker">PILOT</div><div style="font-size:22px;letter-spacing:.12em">SALIM BEN YOUNES</div><div class="mut mono">${ri.rank} · ${d.xp} XP · ${d.tokens} TOKENS</div><div class="xpbar"><i style="width:${Math.round(ri.progress * 100)}%"></i></div></div>
      <div class="menu-foot">${has ? 'SAVE: ' + new Date(d.updated).toLocaleString() : 'NO SAVE FILE'} · ${Settings.s.difficulty}</div></div>`;
  }
  a_menu_continue() { const next = MISSIONS.find((m) => missionStatus(m) === 'available' && m.playable) || MISSIONS.find((m) => missionStatus(m) === 'available') || MISSIONS[0]; this.go('missions', { selected: next.id }); }
  a_menu_new() {
    if (Save.has() && Save.data.campaign.started && !confirm('Start a new campaign? Existing campaign progress will be overwritten (settings are kept).')) return;
    Save.newGame(); Settings.apply(); this.go('intel', { id: MISSIONS[0].id, fromNew: true });
  }
  a_menu_missions() { this.go('missions', {}); }
  a_menu_aircraft() { this.go('aircraft', { tab: 'aircraft' }); }
  a_menu_freeflight() { this.go('freeflight'); }
  a_menu_challenges() { this.go('challenges'); }
  a_menu_replay() { this.go('replay'); }
  a_menu_settings() { this.go('settings', { tab: 'gameplay', from: 'menu' }); }
  a_menu_extras() { this.go('extras', { tab: 'controls' }); }
  a_back() { this.go('menu'); }

  // ------------------------------------------------------------------ mission select (animated Algeria map)
  s_missions({ selected } = {}) {
    selected = selected || (MISSIONS.find((m) => missionStatus(m) === 'available') || MISSIONS[0]).id; this.sel = selected;
    const locked = {}; for (const k of Object.keys(REGIONS)) locked[k] = true; for (const m of MISSIONS) if (missionStatus(m) !== 'locked') locked[regionFor(m)] = false;
    const markers = MISSIONS.map((m) => { const st = missionStatus(m), x = px(m.map.lon), y = py(m.map.lat), col = st === 'locked' ? '#667' : st === 'completed' ? '#5dffa8' : '#ffcf3d'; return `<g class="mk" data-act="pick" data-val="${m.id}" transform="translate(${x} ${y})"><g class="mk-in"><circle class="pulse" r="14" fill="none" stroke="${col}" stroke-width="2" ${st === 'available' ? '' : 'opacity="0"'}/><circle r="9" fill="${col}" opacity="${st === 'locked' ? 0.5 : 1}" stroke="#000" stroke-width="2"/><text y="-16" text-anchor="middle" font-size="19" fill="#fff" font-family="monospace" paint-order="stroke" stroke="#000" stroke-width="4">${String(m.number).padStart(2, '0')}</text></g></g>`; }).join('');
    this.root.innerHTML = `<div class="screen dark"><div class="back-bar"><button class="btn small" data-act="back">◂ MENU</button></div><div class="split">
      <div class="map-wrap ui-block"><svg id="mapsvg" viewBox="${FULL_VIEW.x} ${FULL_VIEW.y} ${FULL_VIEW.w} ${FULL_VIEW.h}" preserveAspectRatio="xMidYMid meet">${baseMapSVG({ locked })}${markers}</svg>
        <div class="map-legend">● AVAILABLE &nbsp; <span style="color:#5dffa8">●</span> COMPLETED &nbsp; <span style="color:#889">●</span> LOCKED</div>
        <div class="map-tools"><button class="btn small" data-act="zoomin">+</button><button class="btn small" data-act="zoomout">−</button><button class="btn small" data-act="zoomsel" title="Zoom to mission">◎</button><button class="btn small" data-act="zoomall">⌂</button></div></div>
      <div class="side-col" id="mcard"></div></div></div>`;
    this.svg = this.root.querySelector('#mapsvg'); this.initMap(); this.renderCard(); this.zoomTo(this.sel, 1400);
  }
  setView(v) { this.svg.setAttribute('viewBox', v.join(' ')); this.svg.style.setProperty('--u', (v[2] / 110).toFixed(2)); }
  initMap() {
    const svg = this.svg; let drag = null;
    const vb = () => svg.getAttribute('viewBox').split(' ').map(Number);
    svg.addEventListener('wheel', (e) => { e.preventDefault(); const v = vb(), r = svg.getBoundingClientRect(), k = e.deltaY > 0 ? 1.15 : 1 / 1.15, mx = v[0] + ((e.clientX - r.left) / r.width) * v[2], my = v[1] + ((e.clientY - r.top) / r.height) * v[3]; const w = Math.min(FULL_VIEW.w * 1.4, Math.max(120, v[2] * k)), h = w * (v[3] / v[2]); this.setView([mx - (mx - v[0]) * (w / v[2]), my - (my - v[1]) * (h / v[3]), w, h]); }, { passive: false });
    svg.addEventListener('pointerdown', (e) => { if (e.target.closest('.mk')) return; drag = { x: e.clientX, y: e.clientY, v: vb() }; svg.classList.add('dragging'); svg.setPointerCapture(e.pointerId); });
    svg.addEventListener('pointermove', (e) => { if (!drag) return; const r = svg.getBoundingClientRect(), s = drag.v[2] / Math.max(r.width, r.height * (drag.v[2] / drag.v[3])); this.setView([drag.v[0] - (e.clientX - drag.x) * s, drag.v[1] - (e.clientY - drag.y) * s, drag.v[2], drag.v[3]]); });
    svg.addEventListener('pointerup', () => { drag = null; svg.classList.remove('dragging'); });
  }
  tween(to, ms = 900) {
    const svg = this.svg, from = svg.getAttribute('viewBox').split(' ').map(Number), t0 = performance.now(); const id = ++this._tw;
    const step = (now) => { if (id !== this._tw || !svg.isConnected) return; const k = Math.min(1, (now - t0) / ms), e = k * k * (3 - 2 * k); this.setView(from.map((v, i) => v + (to[i] - v) * e)); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  zoomTo(id, ms) { this._tw = this._tw || 0; const m = MISSIONS.find((x) => x.id === id), r = this.svg.getBoundingClientRect(), w = 520, h = w * (r.height / Math.max(r.width, 1)); this.tween([px(m.map.lon) - w / 2, py(m.map.lat) - h / 2, w, h], ms); }
  a_zoomin() { const v = this.svg.getAttribute('viewBox').split(' ').map(Number); this._tw = (this._tw || 0); this.tween([v[0] + v[2] * 0.15, v[1] + v[3] * 0.15, v[2] * 0.7, v[3] * 0.7], 300); }
  a_zoomout() { const v = this.svg.getAttribute('viewBox').split(' ').map(Number); this.tween([v[0] - v[2] * 0.2, v[1] - v[3] * 0.2, v[2] * 1.4, v[3] * 1.4], 300); }
  a_zoomsel() { this.zoomTo(this.sel, 800); }
  a_zoomall() { this.tween([FULL_VIEW.x, FULL_VIEW.y, FULL_VIEW.w, FULL_VIEW.h], 800); }
  a_pick(id) { this.sel = id; this.renderCard(); this.zoomTo(id, 900); }
  renderCard() {
    const m = MISSIONS.find((x) => x.id === this.sel), st = missionStatus(m), sc = Save.data.scores[m.id];
    const lst = (k, cls) => m.objectives[k].length ? `<ul class="obj-list ${cls}">${m.objectives[k].map((o) => `<li>${esc(o.label)}</li>`).join('')}</ul>` : '';
    this.root.querySelector('#mcard').innerHTML = `
      <div class="panel mission-card ui-block"><div class="kicker">MISSION ${String(m.number).padStart(2, '0')} · ${m.type}</div><h2>${m.title}</h2><div class="ar-title">${m.titleAr}</div>
        <div class="row"><span class="chip ${st === 'locked' ? 'low' : st === 'completed' ? 'high' : 'medium'}">${st}</span><span class="chip">${m.region}</span><span class="chip">${m.env.time} · ${m.env.weather}</span>${m.playable ? '' : '<span class="chip">INTEL ONLY IN THIS BUILD</span>'}</div>
        <div class="threat" title="Threat level">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= m.threatLevel ? 'on' : ''}"></i>`).join('')}<span class="mut" style="margin-left:8px;font-size:13px;letter-spacing:.16em">THREAT: ${m.threat}</span></div>
        <p style="margin:6px 0 10px;color:#c5d4d0;line-height:1.35">${esc(m.narrative)}</p>
        ${sc ? `<div class="row" style="margin-bottom:8px"><span class="grade-badge">${sc.grade}</span><span class="mono">SCORE ${sc.score} · BEST ${fmtTime(sc.time)}</span></div><div class="medals">${(sc.medals || []).map((x) => `<span class="medal">${(progression.medals.find((q) => q.id === x) || { name: x }).name}</span>`).join('')}</div>` : ''}
        <div class="kicker" style="margin-top:8px">PRIMARY</div>${lst('primary', '')}<div class="kicker" style="color:var(--amber)">SECONDARY</div>${lst('secondary', 'sec')}<div class="kicker" style="color:var(--mut)">OPTIONAL</div>${lst('optional', 'opt')}
        <div class="row" style="margin-top:12px"><button class="btn primary" data-act="intel" data-val="${m.id}" ${st === 'locked' ? 'disabled' : ''}>${st === 'locked' ? 'LOCKED' : m.playable ? 'INTEL & BRIEFING ▸' : 'VIEW INTEL ▸'}</button></div></div>`;
  }
  a_intel(id) { this.go('intel', { id: id }); }

  // ------------------------------------------------------------------ intelligence dossier
  s_intel({ id, fromNew }) {
    const m = MISSIONS.find((x) => x.id === id); this.mission = m;
    const br = dialogue.characters.NADIA;
    this.root.innerHTML = `<div class="screen dark"><div class="back-bar"><button class="btn small" data-act="to_missions">◂ MISSIONS</button></div>
      <div class="intel-grid"><div class="panel ui-block" style="position:relative"><div class="stamp">CLASSIFIED</div><div class="kicker">INTELLIGENCE · RENSEIGNEMENT · <span dir="rtl">استخبارات</span></div><h2 style="font-size:clamp(26px,3vw,44px)">${m.title}</h2>
        <div class="mut mono" style="margin-bottom:10px">${m.region} · ${m.clock} · ${m.weatherLabel}</div><p style="font-size:clamp(16px,1.4vw,20px);line-height:1.45">${esc(m.narrative)}</p>
        ${m.intel.map((it, i) => `<div class="intel-item" style="animation-delay:${0.2 + i * 0.25}s"><b>${it.label}</b> <span class="chip ${it.confidence.toLowerCase()}">CONFIDENCE ${it.confidence}</span><div>${esc(it.text)}</div></div>`).join('')}</div>
       <div class="panel ui-block"><div class="briefer">${portraitHTML(br, false)}<div><div class="kicker">BRIEFING OFFICER</div><div style="font-size:20px;letter-spacing:.1em">${br.name}</div><div class="mut">${br.role}</div></div></div>
        <div class="kicker">OBJECTIVES</div><ul class="obj-list">${m.objectives.primary.map((o) => `<li>${esc(o.label)}</li>`).join('')}</ul>
        <div class="kicker" style="color:var(--amber)">SECONDARY</div><ul class="obj-list sec">${m.objectives.secondary.map((o) => `<li>${esc(o.label)}</li>`).join('')}</ul>
        <div class="kicker" style="color:var(--mut)">OPTIONAL</div><ul class="obj-list opt">${m.objectives.optional.map((o) => `<li>${esc(o.label)}</li>`).join('')}</ul>
        <div class="row" style="margin-top:14px"><button class="btn primary" data-act="to_briefing">TACTICAL BRIEFING ▸</button></div></div></div></div>`;
  }
  a_to_missions() { this.go('missions', { selected: this.mission?.id }); }
  a_to_briefing() { this.go('briefing', { id: this.mission.id }); }

  // ------------------------------------------------------------------ animated tactical briefing
  s_briefing({ id }) {
    const m = MISSIONS.find((x) => x.id === id); this.mission = m; this.app.hangar.setFocus('loadout');
    this.briefing = new Briefing(this.root, m, { audio: this.app.audio, onDone: () => this.go('loadout', { id }) });
  }

  // ------------------------------------------------------------------ aircraft / loadout
  s_loadout({ id }) {
    const m = MISSIONS.find((x) => x.id === id); this.mission = m; const eq = Save.data.equipped;
    this.lo = this.lo || {}; this.lo.ac = eq.aircraft; this.lo.paint = eq.paint; this.lo.load = eq.loadout; this.lo.diff = Settings.s.difficulty;
    this.renderLoadout();
  }
  renderLoadout() {
    const m = this.mission, lo = this.lo, ac = aircraftData.aircraft.find((a) => a.id === lo.ac), ld = aircraftData.loadouts.find((l) => l.id === lo.load);
    const paint = aircraftData.paints.find((p) => p.id === lo.paint); this.app.hangar.setPaint(paint.colors);
    const s = ac.stats, bar = (l, v, max) => `<div class="statbar"><span>${l}</span><i><b style="width:${Math.round((v / max) * 100)}%"></b></i></div>`;
    const canLaunch = m.playable;
    this.root.innerHTML = `<div class="screen dim"><div class="back-bar"><button class="btn small" data-act="to_missions">◂ MISSIONS</button></div><div class="big-center" style="justify-content:center;max-width:1300px;margin:0;width:100%">
      <div class="kicker">AIRCRAFT / LOADOUT · MISSION ${String(m.number).padStart(2, '0')} · ${m.title}</div>
      <div class="loadout-grid scroll">
        <div class="panel ui-block"><h3>AIRCRAFT</h3><div class="cards">${aircraftData.aircraft.map((a) => { const stt = itemStatus('aircraft', a); const ok = stt === 'owned' || stt === 'rank'; return `<button class="card ${a.id === lo.ac ? 'sel' : ''} ${ok ? '' : 'locked'}" data-act="lo_ac" data-val="${a.id}"><h4>${a.name}</h4><p>${a.role}</p><p style="margin-top:4px">${ok ? 'AVAILABLE' : stt === 'locked' ? 'RANK: ' + a.unlockRank : 'TOKENS: ' + a.cost + ' (AIRCRAFT MENU)'}</p></button>`; }).join('')}</div>
          <h3 style="margin-top:14px">PAINT</h3><div>${aircraftData.paints.map((p) => `<span class="swatch ${p.id === lo.paint ? 'sel' : ''}" title="${p.name}${hasItem('paints', p) ? '' : ' (locked)'}" data-act="lo_paint" data-val="${p.id}" style="background:linear-gradient(135deg,${p.colors.body} 55%,${p.colors.accent} 55%);opacity:${hasItem('paints', p) ? 1 : 0.35}"></span>`).join('')}</div>
          <h3 style="margin-top:14px">WEAPONS LOADOUT</h3><div class="cards">${aircraftData.loadouts.map((l) => `<button class="card ${l.id === lo.load ? 'sel' : ''}" data-act="lo_load" data-val="${l.id}"><h4>${l.name}</h4><p>${l.desc}</p></button>`).join('')}</div></div>
        <div class="spacer"></div>
        <div class="panel ui-block"><h3>${ac.name}</h3><p class="mut" style="margin-top:-6px">${ac.desc}</p>${bar('SPEED', s.maxSpeed, 520)}${bar('AGILITY', s.rollRate * 20 + s.pitchRate * 25, 120)}${bar('STABILITY', 160 - s.stallSpeed, 110)}${bar('ARMOUR', s.hp, 150)}
          <div class="mono" style="margin:10px 0">AAM ${Math.max(1, ac.weapons.missiles + ld.missilesDelta)} · FLARES ${Math.max(0, ac.weapons.flares + ld.flaresDelta)} · GUN ${Math.round(ac.weapons.cannonRounds * ld.ammoMult)}</div>
          <h3>DIFFICULTY</h3>${seg('lo_diff', DIFFS.map((x) => [x, x]), lo.diff)}<p class="mut" style="font-size:14px">${difficultyData.levels[lo.diff].desc}</p>
          <div class="row" style="margin-top:14px"><button class="btn primary" data-act="launch" ${canLaunch ? '' : 'disabled'}>${canLaunch ? 'LAUNCH ▸' : 'NOT PLAYABLE IN THIS BUILD'}</button></div>${canLaunch ? '' : '<p class="mut" style="font-size:13px">Mission data for this operation is not available.</p>'}</div></div></div></div>`;
  }
  a_lo_ac(v) { const a = aircraftData.aircraft.find((x) => x.id === v); if (!hasItem('aircraft', a)) return this.app.toast('AIRCRAFT LOCKED'); this.lo.ac = v; this.renderLoadout(); }
  a_lo_paint(v) { const p = aircraftData.paints.find((x) => x.id === v); if (!hasItem('paints', p)) return this.app.toast('PAINT LOCKED'); this.lo.paint = v; this.renderLoadout(); }
  a_lo_load(v) { this.lo.load = v; this.renderLoadout(); }
  a_lo_diff(v) { this.lo.diff = v; this.renderLoadout(); }
  a_launch() { const e = Save.data.equipped; Object.assign(e, { aircraft: this.lo.ac, paint: this.lo.paint, loadout: this.lo.load }); Settings.set('difficulty', this.lo.diff); Save.commit(); this.app.launchMission(this.mission); }

  // ------------------------------------------------------------------ aircraft customisation (tokens / rank unlocks)
  s_aircraft({ tab = 'aircraft' } = {}) {
    this.tab = tab; const d = Save.data, eq = d.equipped, ri = rankInfo(d.xp);
    const kinds = { aircraft: ['aircraft', 'aircraft', 'AIRCRAFT'], paints: ['paints', 'paint', 'PAINT SCHEMES'], hudThemes: ['hudThemes', 'hudTheme', 'HUD THEMES'], cockpits: ['cockpits', 'cockpit', 'COCKPIT'] };
    const [kind, eqKey] = kinds[tab];
    this.app.hangar.setPaint(aircraftData.paints.find((p) => p.id === eq.paint).colors);
    const card = (it) => { const st = itemStatus(kind, it), on = eq[eqKey] === it.id; const sw = it.colors ? `<div style="height:8px;margin:6px 0;background:linear-gradient(90deg,${it.colors.body} 50%,${it.colors.accent} 50%)"></div>` : it.color ? `<div style="height:8px;margin:6px 0;background:${it.color}"></div>` : '';
      return `<button class="card ${on ? 'sel' : ''} ${st === 'locked' ? 'locked' : ''}" data-act="equip" data-val="${it.id}"><h4>${it.name}</h4>${sw}<p>${it.desc || it.role || ''}</p><p style="margin-top:6px;letter-spacing:.14em;color:${on ? 'var(--accent)' : 'var(--amber)'}">${on ? 'EQUIPPED' : st === 'owned' ? 'OWNED' : st === 'rank' ? 'UNLOCKED BY RANK' : st === 'buy' ? 'BUY · ' + it.cost + ' TOKEN' + (it.cost > 1 ? 'S' : '') : 'RANK: ' + it.unlockRank}</p></button>`; };
    this.root.innerHTML = `<div class="screen dim"><div class="back-bar"><button class="btn small" data-act="back">◂ MENU</button></div><div class="big-center" style="max-width:1100px;margin:0;justify-content:center">
      <div class="kicker">AIRCRAFT · HANGAR</div><div class="row mono"><span>RANK ${ri.rank}</span><span>XP ${d.xp}${ri.next ? ' / NEXT: ' + ri.next + ' IN ' + ri.xpToNext : ''}</span><span style="color:var(--amber)">TOKENS ${d.tokens}</span></div>
      <div class="tabs">${seg('ac_tab', [['aircraft', 'VARIANTS'], ['paints', 'PAINT'], ['hudThemes', 'HUD THEMES'], ['cockpits', 'COCKPIT']], tab)}</div>
      <div class="panel ui-block scroll" style="max-height:62vh"><div class="cards">${aircraftData[tab].map(card).join('')}</div><p class="mut" style="font-size:13px;margin-top:12px">No loot boxes, no pay-to-win: tokens are earned in missions and spent on fixed-price cosmetics and variants.</p></div></div></div>`;
  }
  a_ac_tab(v) { this.go('aircraft', { tab: v }); }
  a_equip(v) {
    const kinds = { aircraft: ['aircraft', 'aircraft'], paints: ['paints', 'paint'], hudThemes: ['hudThemes', 'hudTheme'], cockpits: ['cockpits', 'cockpit'] }, [kind, eqKey] = kinds[this.tab];
    const it = aircraftData[kind].find((x) => x.id === v), st = itemStatus(kind, it);
    if (st === 'locked') return this.app.toast('LOCKED — REACH RANK ' + it.unlockRank);
    if (st === 'buy') { if (!buyItem(kind, it)) return this.app.toast('NOT ENOUGH TOKENS'); this.app.toast('PURCHASED: ' + it.name); this.app.audio.play('confirm'); }
    Save.data.equipped[eqKey] = v; Save.commit(); this.go('aircraft', { tab: this.tab });
  }

  // ------------------------------------------------------------------ free flight
  s_freeflight() {
    this.ff = this.ff || { biome: 'coast', time: 'day', weather: 'clear', diff: Settings.s.difficulty, targets: 'off', ac: Save.data.equipped.aircraft };
    const f = this.ff, owned = aircraftData.aircraft.filter((a) => hasItem('aircraft', a));
    if (!owned.find((a) => a.id === f.ac)) f.ac = owned[0].id;
    this.root.innerHTML = `<div class="screen dim"><div class="back-bar"><button class="btn small" data-act="back">◂ MENU</button></div><div class="big-center" style="margin:0;justify-content:center"><div class="kicker">FREE FLIGHT · طيران حر</div><div class="panel ui-block"><div class="form">
      <label>Region</label>${seg('ff_biome', BIOMES, f.biome)}<label>Aircraft</label>${seg('ff_ac', owned.map((a) => [a.id, a.name]), f.ac)}<label>Time</label>${seg('ff_time', TIMES.map((x) => [x, x]), f.time)}<label>Weather</label>${seg('ff_weather', WEATHERS.map((x) => [x, x]), f.weather)}
      <label>Difficulty</label>${seg('ff_diff', DIFFS.map((x) => [x, x]), f.diff)}<label>Targets</label>${seg('ff_targets', [['off', 'NONE'], ['drones', 'DRONES'], ['fighters', 'FIGHTERS']], f.targets)}</div>
      <div class="row" style="margin-top:18px"><button class="btn primary" data-act="ff_go">TAKE OFF INTO THE SKY ▸</button></div></div></div></div>`;
  }
  a_ff_biome(v) { this.ff.biome = v; this.s_freeflight(); } a_ff_ac(v) { this.ff.ac = v; this.s_freeflight(); } a_ff_time(v) { this.ff.time = v; this.s_freeflight(); } a_ff_weather(v) { this.ff.weather = v; this.s_freeflight(); } a_ff_diff(v) { this.ff.diff = v; this.s_freeflight(); } a_ff_targets(v) { this.ff.targets = v; this.s_freeflight(); }
  a_ff_go() { Save.data.equipped.aircraft = this.ff.ac; Settings.set('difficulty', this.ff.diff); this.app.launchFreeFlight(this.ff); }

  // ------------------------------------------------------------------ challenges
  s_challenges() {
    const best = Save.data.challenges;
    this.root.innerHTML = `<div class="screen dim"><div class="back-bar"><button class="btn small" data-act="back">◂ MENU</button></div><div class="big-center" style="margin:0;justify-content:center;max-width:1200px"><div class="kicker">CHALLENGES · التحديات</div>
      <div class="cards scroll" style="grid-template-columns:repeat(auto-fill,minmax(250px,1fr));max-height:72vh">${challengeData.challenges.map((c) => { const ok = challengeUnlocked(c), b = best[c.id]; return `<button class="card ${ok ? '' : 'locked'}" data-act="challenge" data-val="${c.id}"><h4>${c.title}</h4><div class="mut" style="direction:rtl;text-align:left">${c.titleAr}</div><p style="margin:6px 0">${c.desc}</p><p style="color:${ok ? 'var(--accent)' : 'var(--amber)'};letter-spacing:.14em">${ok ? (b ? `BEST ${b.grade} · ${b.score}` : 'READY') : 'LOCKED · RANK ' + c.unlockRank}</p></button>`; }).join('')}</div></div></div>`;
  }
  a_challenge(v) { const c = challengeData.challenges.find((x) => x.id === v); if (!challengeUnlocked(c)) return this.app.toast('LOCKED — REACH RANK ' + c.unlockRank); this.app.launchChallenge(c); }

  // ------------------------------------------------------------------ replay
  s_replay() {
    const rep = this.app.lastReplay || Save.loadReplay();
    this.root.innerHTML = `<div class="screen dim"><div class="back-bar"><button class="btn small" data-act="back">◂ MENU</button></div><div class="big-center" style="margin:0;justify-content:center;max-width:760px"><div class="kicker">REPLAY · إعادة</div><div class="panel ui-block">
      ${rep ? `<h2>${esc(rep.title)}</h2><div class="mono mut">${new Date(rep.date).toLocaleString()} · ${fmtTime(rep.duration)} · ${rep.frames.length} frames · ${rep.events.length} events</div><p>Replay cameras: recorded, chase, cinematic, fly-by, tactical, free orbit.</p><div class="row"><button class="btn primary" data-act="play_replay">▶ WATCH REPLAY</button></div>` : `<h2>NO REPLAY YET</h2><p class="mut">Finish or fail any mission, free flight or challenge — the last flight is recorded automatically.</p>`}</div></div></div>`;
  }
  a_play_replay() { this.app.playReplay(this.app.lastReplay || Save.loadReplay()); }

  // ------------------------------------------------------------------ settings
  s_settings({ tab = 'gameplay', from = 'menu' } = {}) {
    this.tab = tab; this.from = from; const s = Settings.s;
    const rows = {
      gameplay: [['Difficulty', seg('set_difficulty', DIFFS.map((x) => [x, x]), s.difficulty)], ['Flight mode', seg('set_flightMode', [['ASSISTED', 'ASSISTED'], ['NORMAL', 'NORMAL'], ['EXPERT', 'EXPERT']], s.flightMode)], ['Assist level', slider('assistLevel', s.assistLevel)], ['Auto-level', tog('tog_autoLevel', s.autoLevel)], ['Target assist', tog('tog_targetAssist', s.targetAssist)]],
      controls: [['Sensitivity', slider('sensitivity', s.sensitivity, 0.4, 2.2, 0.05)], ['Invert Y', tog('tog_invertY', s.invertY)], ['Dead zone', slider('deadzone', s.deadzone, 0, 0.4, 0.01)], ['Mouse flight (M)', tog('tog_mouseFlight', s.mouseControl)]],
      audio: [['Master volume', slider('master', s.master)], ['Radio volume', slider('radio', s.radio)], ['Effects volume', slider('effects', s.effects)], ['Music volume', slider('music', s.music)], ['Radio voice (TTS)', tog('tog_tts', s.tts)]],
      accessibility: [['Subtitles', tog('tog_subtitles', s.subtitles)], ['Subtitle size', seg('set_subtitleSize', [['small', 'S'], ['medium', 'M'], ['large', 'L'], ['xlarge', 'XL']], s.subtitleSize)], ['Subtitle language', seg('set_subtitleLang', [['en', 'ENGLISH'], ['fr', 'FRANÇAIS'], ['ar', 'العربية']], s.subtitleLang)], ['Bilingual (AR)', tog('tog_bilingual', s.bilingual)], ['Colour-blind preset', seg('set_colorblind', [['none', 'OFF'], ['protanopia', 'PROTAN'], ['deuteranopia', 'DEUTAN'], ['tritanopia', 'TRITAN']], s.colorblind)], ['Reduced motion', tog('tog_reducedMotion', s.reducedMotion)], ['Camera shake', tog('tog_cameraShake', s.cameraShake)]],
      graphics: [['Quality', seg('set_quality', [['low', 'LOW'], ['medium', 'MEDIUM'], ['high', 'HIGH']], s.quality)], ['Dynamic resolution', tog('tog_dynamicRes', s.dynamicRes)], ['Show FPS', tog('tog_showFps', s.showFps)]]
    }[tab];
    this.root.innerHTML = `<div class="screen ${from === 'pause' ? 'pause' : 'dim'}"><div class="back-bar"><button class="btn small" data-act="settings_back">◂ BACK</button></div><div class="big-center" style="margin:0;justify-content:center;max-width:900px"><div class="kicker">SETTINGS · الإعدادات</div>
      <div class="tabs">${seg('set_tab', [['gameplay', 'GAMEPLAY'], ['controls', 'CONTROLS'], ['audio', 'AUDIO'], ['accessibility', 'ACCESSIBILITY'], ['graphics', 'GRAPHICS']], tab)}</div>
      <div class="panel ui-block scroll"><div class="form">${rows.map(([l, c]) => `<label>${l}</label><div>${c}</div>`).join('')}</div></div></div></div>`;
  }
  a_settings_back() { if (this.from === 'pause') { this.app.showPause(); } else this.go('menu'); }
  a_set_tab(v) { this.go('settings', { tab: v, from: this.from }); }
  _set(key, v) { Settings.set(key, v); this.app.applySettings(key); this.go('settings', { tab: this.tab, from: this.from }); }
  a_set_difficulty(v) { this._set('difficulty', v); } a_set_flightMode(v) { this._set('flightMode', v); } a_set_subtitleSize(v) { this._set('subtitleSize', v); } a_set_subtitleLang(v) { this._set('subtitleLang', v); }
  a_set_colorblind(v) { this._set('colorblind', v); } a_set_quality(v) { this._set('quality', v); }
  a_tog_autoLevel() { this._set('autoLevel', !Settings.s.autoLevel); } a_tog_targetAssist() { this._set('targetAssist', !Settings.s.targetAssist); } a_tog_invertY() { this._set('invertY', !Settings.s.invertY); }
  a_tog_mouseFlight() { this._set('mouseControl', !Settings.s.mouseControl); } a_tog_tts() { this._set('tts', !Settings.s.tts); } a_tog_subtitles() { this._set('subtitles', !Settings.s.subtitles); }
  a_tog_bilingual() { this._set('bilingual', !Settings.s.bilingual); } a_tog_reducedMotion() { this._set('reducedMotion', !Settings.s.reducedMotion); } a_tog_cameraShake() { this._set('cameraShake', !Settings.s.cameraShake); }
  a_tog_dynamicRes() { this._set('dynamicRes', !Settings.s.dynamicRes); } a_tog_showFps() { this._set('showFps', !Settings.s.showFps); }
  _slide(key, v) { Settings.set(key, v); this.app.applySettings(key); }
  i_assistLevel(v) { this._slide('assistLevel', v); } i_sensitivity(v) { this._slide('sensitivity', v); } i_deadzone(v) { this._slide('deadzone', v); }
  i_master(v) { this._slide('master', v); } i_radio(v) { this._slide('radio', v); } i_effects(v) { this._slide('effects', v); } i_music(v) { this._slide('music', v); }

  // ------------------------------------------------------------------ extras
  s_extras({ tab = 'controls' } = {}) {
    this.tab = tab; let body = '';
    if (tab === 'controls') body = `<div class="ctrl-table"><kbd>W / ↑</kbd><span>Nose up</span><kbd>S / ↓</kbd><span>Nose down (Settings → Invert Y flips both)</span><kbd>Mouse</kbd><span>Aim: the jet turns toward the on-screen cursor (cursor up = nose up)</span><kbd>A / D</kbd><span>Roll left / right</span><kbd>Q / E</kbd><span>Yaw (rudder)</span><kbd>Shift / Ctrl · wheel</kbd><span>Throttle up / down</span><kbd>Space · click</kbd><span>Cannon</span><kbd>T</kbd><span>Select / cycle radar target (hold target in radar cone to lock)</span><kbd>I (hold)</kbd><span>Identify selected contact (visual ID required before firing)</span><kbd>F · right-click</kbd><span>Fire missile (needs LOCK + identified hostile)</span><kbd>X</kbd><span>Flares</span><kbd>B</kbd><span>Airbrake</span><kbd>C / 1-8</kbd><span>Camera: chase · cockpit · close · missile · wing · tactical · cinematic · free</span><kbd>M</kbd><span>Toggle mouse flight</span><kbd>H</kbd><span>Toggle HUD</span><kbd>Esc / P</kbd><span>Pause</span></div><p class="mut">Gamepad: left stick pitch/roll · right stick yaw · RT cannon · LT airbrake · A missile · B flares · X target · Y identify · LB/RB camera · D-pad throttle · Start pause.</p>`;
    else if (tab === 'characters') body = `<div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">${Object.values(dialogue.characters).map((c) => `<div class="card" style="cursor:default">${portraitHTML(c, false)}<h4 style="margin-top:8px">${c.name}</h4><p>${c.callsign} · ${c.role}</p></div>`).join('')}</div>`;
    else if (tab === 'about') body = `<p style="line-height:1.5;max-width:800px">SHADOW LINE — SKY OF ALGERIA is a work of fiction. All organisations (VESPER), aircraft variants, units, characters and missions are invented; Algeria-inspired geography and atmosphere are used for setting only. No real operations, bases or classified information are depicted.</p><p class="mut">All fifteen missions of the campaign are playable, from “First Contact” to the finale “Shadow Line”. Every mission is its own data file in <span class="mono">data/missions/</span>. All art and audio are procedural placeholders with GLB / PNG / audio replacement paths.</p>`;
    else if (tab === 'ending') body = `<p>You finished the campaign. Watch the epilogue and credits again.</p><div class="row"><button class="btn primary" data-act="deb_ending">▶ PLAY EPILOGUE</button></div>`;
    else body = `<p>Save file: ${Save.has() ? 'present' : 'none'} · XP ${Save.data.xp} · Tokens ${Save.data.tokens} · Missions completed ${Object.keys(Save.data.campaign.completed).length}/${MISSIONS.length}</p><div class="row"><button class="btn danger" data-act="reset_save">RESET SAVE DATA</button></div>`;
    this.root.innerHTML = `<div class="screen dim"><div class="back-bar"><button class="btn small" data-act="back">◂ MENU</button></div><div class="big-center" style="margin:0;justify-content:center;max-width:1100px"><div class="kicker">EXTRAS · إضافات</div><div class="tabs">${seg('ex_tab', [['controls', 'CONTROLS'], ['characters', 'CHARACTERS'], ['about', 'ABOUT'], ['save', 'SAVE DATA'], ...(Save.data.campaign.finished ? [['ending', 'EPILOGUE']] : [])], tab)}</div><div class="panel ui-block scroll" style="max-height:66vh">${body}</div></div></div>`;
  }
  a_ex_tab(v) { this.go('extras', { tab: v }); }
  a_reset_save() { if (!confirm('Delete ALL save data (campaign, scores, unlocks, settings)?')) return; Save.reset(); Settings.apply(); this.app.applySettings(); this.app.lastReplay = null; this.go('menu'); this.app.toast('SAVE DATA RESET'); }

  // ------------------------------------------------------------------ pause
  s_pause() {
    this.root.innerHTML = `<div class="screen pause"><div class="panel ui-block"><div class="kicker">PAUSED</div><h2>${esc(this.app.game?.mission.title || '')}</h2>
      <button class="btn primary" data-act="resume">RESUME</button><button class="btn" data-act="restart">RESTART MISSION</button><button class="btn" data-act="pause_settings">SETTINGS</button><button class="btn" data-act="pause_controls">CONTROLS</button><button class="btn danger" data-act="abort">ABORT TO MENU</button></div></div>`;
  }
  a_resume() { this.app.togglePause(); } a_restart() { this.app.restartMission(); } a_abort() { this.app.abortToMenu(); }
  a_pause_settings() { this.go('settings', { tab: 'gameplay', from: 'pause' }); }
  a_pause_controls() { this.go('settings', { tab: 'controls', from: 'pause' }); }

  // ------------------------------------------------------------------ debrief
  s_debrief({ result, snap, score, rank, unlocks, mission, saved, retry, next, final }) {
    const good = snap.result === 'complete'; this.app.hangar.setFocus('dim');
    const pct = (v) => Math.round(v * 100) + '%';
    const rows = [['TARGETS DESTROYED', `${score.kills} / ${score.killsTotal}`], ['ACCURACY', pct(score.acc)], ['DAMAGE TAKEN', pct(score.dmg)], ['ALLY SURVIVAL', snap.allies.length ? (score.ally >= 1 ? 'ALL SURVIVED' : 'LOST') : 'N/A'], ['MISSION TIME', fmtTime(score.time)],
      ['OBJECTIVE COMPLETION', `${score.objectives.filter((o) => o.kind === 'primary' && o.state === 'complete').length} / ${score.objectives.filter((o) => o.kind === 'primary').length}`], ['SECONDARY OBJECTIVES', `${score.objectives.filter((o) => o.kind === 'secondary' && o.state === 'complete').length} / ${score.objectives.filter((o) => o.kind === 'secondary').length}`], ['PILOT SCORE', String(score.score)]];
    const oi = (kind) => score.objectives.filter((o) => o.kind === kind).map((o) => `<li class="${o.state}">${esc(o.label)}</li>`).join('');
    this.root.innerHTML = `<div class="screen dark debrief"><div class="debrief-card">
      <div class="panel ui-block"><div class="kicker">DEBRIEF · ${esc(mission.title)}</div><h2 class="result-head ${good ? 'good' : 'bad'}" style="font-size:clamp(26px,3vw,44px)">${good ? 'MISSION COMPLETE' : 'MISSION FAILED'}</h2>${good ? '' : `<div class="mut mono" style="margin-bottom:8px">${esc(snap.reason || '')}</div>`}
        ${rows.map(([k, v], i) => `<div class="stat-row" style="animation-delay:${0.4 + i * 0.35}s"><b>${k}</b><span data-count="${v}">${v}</span></div>`).join('')}
        <ul class="obj-res" style="padding:0;margin:10px 0 0"><li style="opacity:.6;letter-spacing:.2em">PRIMARY</li>${oi('primary')}<li style="opacity:.6;letter-spacing:.2em;margin-top:6px">SECONDARY</li>${oi('secondary')}<li style="opacity:.6;letter-spacing:.2em;margin-top:6px">OPTIONAL</li>${oi('optional')}</ul></div>
      <div class="panel ui-block"><div class="grade-stamp ${score.grade}">${score.grade}</div><div style="text-align:center;letter-spacing:.3em" class="mut">PILOT GRADE</div>
        <div class="medals" style="justify-content:center;margin:10px 0">${score.medals.map((x) => `<span class="medal">${(progression.medals.find((q) => q.id === x) || { name: x }).name}</span>`).join('')}</div>
        <div class="mono" style="margin-top:8px">+${score.xp} XP · +${score.tokens} TOKENS</div><div class="xpbar"><i id="xpfill" style="width:${Math.round(rank.before * 100)}%"></i></div><div class="mut mono" style="font-size:13px;margin-top:4px">${rank.name}${rank.up ? ' — RANK UP!' : ''}</div>
        ${unlocks.map((u, i) => `<div class="unlock-pop" style="animation-delay:${3.8 + i * 0.3}s">UNLOCKED · ${esc(u)}</div>`).join('')}
        <div class="mono mut" style="margin-top:10px">${saved ? '✔ PROGRESS SAVED' : ''}</div>
        <div class="row" style="margin-top:14px;flex-direction:column;align-items:stretch">${final ? `<button class="btn primary" data-act="deb_ending">EPILOGUE ▸</button>` : ''}${next ? `<button class="btn primary" data-act="deb_next">NEXT MISSION ▸</button>` : ''}${retry ? `<button class="btn ${next ? '' : 'primary'}" data-act="deb_retry">${good ? 'REPLAY MISSION' : 'RETRY'}</button>` : ''}<button class="btn" data-act="deb_replay">WATCH REPLAY</button><button class="btn" data-act="deb_map">MISSION SELECT</button><button class="btn" data-act="back">MAIN MENU</button></div></div></div></div>`;
    this.app.audio.play(good ? 'confirm' : 'denied'); setTimeout(() => { const f = this.root.querySelector('#xpfill'); if (f) f.style.width = Math.round(rank.after * 100) + '%'; }, 1800); setTimeout(() => this.app.audio.play('stamp'), 3500);
    this.deb = { mission, next, retry };
  }
  // ------------------------------------------------------------------ campaign ending: epilogue slides, then credits
  s_ending() {
    const ep = FINAL_MISSION.epilogue, lang = Settings.s.subtitleLang, rtl = lang === 'ar', root = this.root; let i = -1, timer = null, phase = 'slides';
    this.app.hangar.setFocus('dim'); this.app.audio.setMusic('RESOLUTION');
    const grades = { S: 4, A: 3, B: 2, C: 1, D: 0 }, sc = Object.values(Save.data.scores);
    const total = sc.reduce((a, q) => a + q.score, 0), medals = sc.reduce((a, q) => a + (q.medals || []).length, 0), avg = sc.length ? sc.reduce((a, q) => a + grades[q.grade], 0) / sc.length : 0;
    const grade = ['D', 'C', 'B', 'A', 'S'][Math.min(4, Math.round(avg))], best = sc.reduce((a, q) => a + q.time, 0);
    const credits = () => {
      phase = 'credits'; clearTimeout(timer);
      root.innerHTML = `<div class="screen dark ending"><div class="credits-roll"><div class="kicker">THE CAMPAIGN IS COMPLETE</div><h1 class="title">Shadow Line<small>SKY OF ALGERIA</small></h1><div class="tagline">“When the radar lies, the pilot must decide.”</div>
        <div class="end-stats"><div><b>${sc.length}/${MISSIONS.length}</b><span>MISSIONS</span></div><div><b>${grade}</b><span>CAMPAIGN GRADE</span></div><div><b>${total}</b><span>TOTAL SCORE</span></div><div><b>${medals}</b><span>MEDALS</span></div><div><b>${fmtTime(best)}</b><span>FLIGHT TIME</span></div></div>
        ${ep.credits.map(([k, v]) => `<div class="credit"><span>${k}</span><b>${v}</b></div>`).join('')}<p class="mut" style="margin-top:60px;letter-spacing:.2em">UNLOCKED: SHADOW LINE PAINT · CRIMSON HUD THEME</p></div><button class="btn primary end-menu" data-act="back">MAIN MENU</button></div>`;
    };
    const show = () => {
      i++; clearTimeout(timer); if (i >= ep.slides.length) return credits();
      const sl = ep.slides[i], ch = dialogue.characters[sl.speaker], text = sl.text[lang] || sl.text.en;
      root.innerHTML = `<div class="screen dark ending" data-act="ending_next"><div class="end-card">${portraitHTML(ch, true)}<div class="end-text" dir="${rtl ? 'rtl' : 'ltr'}"><div class="kicker">EPILOGUE · ${i + 1} / ${ep.slides.length}</div><h3>${ch.name}</h3><p>${esc(text)}</p>${Settings.s.bilingual && !rtl ? `<p class="alt" dir="rtl">${esc(sl.text.ar)}</p>` : ''}</div></div><div class="end-hint">CLICK OR PRESS SPACE TO CONTINUE · ESC TO SKIP</div></div>`;
      timer = setTimeout(show, Math.max(6500, text.length * 90));
    };
    const key = (e) => { if (phase !== 'slides') return; if (e.code === 'Escape') credits(); else if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); show(); } };
    window.addEventListener('keydown', key); this.endingNext = show; this.cleanup = () => { window.removeEventListener('keydown', key); clearTimeout(timer); };
    show();
  }
  a_ending_next() { this.endingNext?.(); }
  a_deb_ending() { this.go('ending'); }
  a_deb_next() { const n = this.deb.next; if (n.playable) this.go('intel', { id: n.id }); else this.go('missions', { selected: n.id }); }
  a_deb_retry() { this.deb.retry(); } a_deb_replay() { this.a_play_replay(); } a_deb_map() { this.go('missions', { selected: this.deb.mission.id }); }
}
