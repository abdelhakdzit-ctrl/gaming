import aircraftData from '../data/aircraft.json';
import difficultyData from '../data/difficulty.json';
import { createRenderer } from './renderer.js';
import { AudioEngine } from './audio/audio.js';
import { Input } from './input/input.js';
import { TouchControls } from './input/touch.js';
import { Hud } from './ui/hud.js';
import { Comms } from './ui/comms.js';
import { MISSIONS } from './missions/registry.js';
import { Screens } from './ui/screens.js';
import { Hangar } from './world/hangar.js';
import { Game } from './game.js';
import { ReplaySession } from './replay/replay.js';
import { Save } from './save/save.js';
import { Settings } from './settings/settings.js';
import { scoreMission } from './missions/scoring.js';
import { rankInfo, newUnlocks, unlockedCameraSet } from './progression.js';
import { fmtTime } from './util/math.js';

const live = new Proxy({}, { get: (_, k) => Settings.s[k] });

class App {
  constructor() {
    this.canvas = document.getElementById('gl'); this.gl = createRenderer(this.canvas); this.renderer = this.gl.renderer;
    this.audio = new AudioEngine(() => Settings.s); this.input = new Input(this.canvas, live);
    const hudRoot = document.getElementById('hud-root'); this.hudRoot = hudRoot;
    this.input.touch = new TouchControls(document.getElementById('touch-ui'), { onFullscreen: () => this.toggleFullscreen() });
    this.hud = new Hud(hudRoot); this.comms = new Comms(hudRoot, this.audio); this.hangar = new Hangar();
    this.screens = new Screens(this, document.getElementById('screens'));
    this.game = null; this.replay = null; this.lastReplay = null; this.lastLaunch = null; this.unlockedCameras = unlockedCameraSet();
    this.last = performance.now();
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('resize', () => { this.gl.resize(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.game && !this.game.paused && !this.game.ended) this.togglePause(); });
  }
  boot() {
    const firstRun = !Save.has(); Save.load();
    if (firstRun && Settings.touchMode()) { Save.data.settings.quality = 'medium'; Save.commit(); }   // phones start on the lighter preset
    Settings.apply(); this.applySettings(); this.unlockedCameras = unlockedCameraSet();
    const q = new URLSearchParams(location.search);
    if (q.get('quick')) { this.audio.ensure(); this.launchMission(MISSIONS[0]); } else this.screens.show('title');
    requestAnimationFrame((t) => this.frame(t));
  }
  toast(text) {
    const d = document.createElement('div'); d.className = 'toast warn'; d.textContent = text; Object.assign(d.style, { position: 'fixed', top: '7%', left: '50%', transform: 'translateX(-50%)', zIndex: 50 });
    this.hudRoot.appendChild(d); setTimeout(() => d.classList.add('out'), 2200); setTimeout(() => d.remove(), 2800);
  }
  cameraName(id) { return (aircraftData.cameras.find((c) => c.id === id)?.name || id).toUpperCase() + ' CAMERA'; }
  applySettings() { const s = Settings.s; this.gl.setQuality(s.quality); this.gl.setDynamic(s.dynamicRes); this.audio.applyVolumes(); this.hud.resize(); }
  toggleFullscreen() {
    const d = document, el = d.documentElement;
    if (d.fullscreenElement) { d.exitFullscreen?.(); return; }
    el.requestFullscreen?.({ navigationUI: 'hide' }).then(() => screen.orientation?.lock?.('landscape').catch(() => {})).catch(() => {});
  }

  // ------------------------------------------------------------------ launching
  normalize(def) {
    const m = JSON.parse(JSON.stringify(def));
    m.objectives = { primary: [], secondary: [], optional: [], ...(m.objectives || {}) }; m.groups = m.groups || []; m.events = m.events || []; m.cinematics = m.cinematics || {}; m.zones = m.zones || [];
    if (!m.zones.some((z) => z.type === 'boundary')) m.zones.push({ id: 'ops', type: 'boundary', pos: [0, 0, -12000], radius: 50000, label: 'OPERATIONS AREA' });
    m.waypoints = m.waypoints || []; m.spawn = { onRunway: false, heading: 0, speed: 230, ...m.spawn }; m.reward = m.reward || { xp: 100, tokens: 1 }; m.scoring = m.scoring || {};
    return m;
  }
  options() {
    const eq = Save.data.equipped, paint = aircraftData.paints.find((p) => p.id === eq.paint) || aircraftData.paints[0];
    return { aircraft: eq.aircraft, paint: paint.colors, loadout: aircraftData.loadouts.find((l) => l.id === eq.loadout) || aircraftData.loadouts[1], hudColor: (aircraftData.hudThemes.find((h) => h.id === eq.hudTheme) || aircraftData.hudThemes[0]).color, difficulty: Settings.s.difficulty };
  }
  start(def, kind, extra = {}) {
    this.endSession(); this.screens.clear(); this.lastLaunch = { def, kind, extra }; this.unlockedCameras = unlockedCameraSet();
    const m = this.normalize(def); m.kind = kind;
    try { this.game = new Game(this, m, { ...this.options(), ...extra }); } catch (e) { this.fatal(e); return; }
    this.input.enabled = true; this.input.pressed.clear(); this.audio.ensure(); this.audio.setAmbience('off'); this.audio.setMusic('IDLE');
    this.audio.play('confirm');
  }
  launchMission(def) { this.start(def, 'campaign'); }
  launchChallenge(c) { this.start({ ...c, id: 'ch_' + c.id, number: 0, type: 'CHALLENGE', challenge: true, region: 'CHALLENGE', base: null }, 'challenge'); }
  launchFreeFlight(f) {
    const groups = f.targets === 'off' ? [] : [0, 1, 2].map((i) => ({ id: 't' + i, type: f.targets === 'drones' ? 'drone' : 'fighter', side: 'hostile', name: 'TARGET ' + (i + 1), callsign: 'T' + (i + 1), spawn: 'start', pos: [(i - 1) * 2500, 2700 + i * 150, -6500 - i * 1500], heading: 180, speed: 190, identified: true, iffShown: 'hostile', route: [[(i - 1) * 3500, 2700, 0], [(i - 1) * -2000, 2900, -9000]] }));
    this.start({ id: 'free', title: 'FREE FLIGHT', number: 0, type: 'FREE FLIGHT', env: { biome: f.biome, time: f.time, weather: f.weather }, spawn: { pos: [0, 2600, 0], heading: 0, speed: 230 }, groups, noWingman: true, free: true, events: [{ id: 'ffw', when: { type: 'time', t: 2 }, do: [{ say: 'gen_ff_welcome' }] }], base: null, reward: { xp: 0, tokens: 0 } }, 'free', { difficulty: f.diff });
  }
  endSession() { if (this.game) { this.game.dispose(); this.game = null; } if (this.replay) { this.replay.dispose(); this.replay = null; } this.input.enabled = false; }

  // ------------------------------------------------------------------ mission outcome -> save -> debrief
  onMissionFinished(game) {
    const m = game.mission, snap = game.snapshot(), diff = difficultyData.levels[game.diffName];
    const score = scoreMission(m, snap, diff), rep = game.rec.export(); if (rep.frames.length > 3) { this.lastReplay = rep; Save.saveReplay(rep); }
    this.lastResult = { snap, score };
    const d = Save.data, kind = m.kind, good = snap.result === 'complete'; let saved = false, final = false;
    const beforeXp = d.xp, ri0 = rankInfo(beforeXp);
    if (kind === 'campaign') {
      if (good) { d.campaign.completed[m.id] = true; }
      const prev = d.scores[m.id]; if (good && (!prev || score.score > prev.score)) d.scores[m.id] = { grade: score.grade, score: score.score, time: score.time, medals: score.medals, accuracy: score.acc };
      if (good && (!d.bestTimes[m.id] || score.time < d.bestTimes[m.id])) d.bestTimes[m.id] = score.time;
      d.xp += score.xp; d.tokens += score.tokens; saved = true;
      if (good && m.number === MISSIONS.length) { d.campaign.finished = true; d.flags = { ...(d.flags || {}), campaignFinished: true }; d.tokens += 5; score.tokens += 5; final = true; }
    } else if (kind === 'challenge') {
      const cid = m.id.replace(/^ch_/, ''), prev = d.challenges[cid];
      if (good && (!prev || score.score > prev.score)) d.challenges[cid] = { grade: score.grade, score: score.score, time: score.time };
      if (good) { d.xp += score.xp; d.tokens += score.tokens; } saved = true;
    }
    const ri1 = rankInfo(d.xp); Save.commit(); this.unlockedCameras = unlockedCameraSet();
    const unlocks = newUnlocks(ri0.index, ri1.index);
    const idx = MISSIONS.findIndex((x) => x.id === m.id), next = kind === 'campaign' && good ? MISSIONS[idx + 1] : null;
    const launch = this.lastLaunch; game.dispose(); this.game = null; this.input.enabled = false; this.audio.setAmbience('hangar'); this.audio.setMusic('IDLE');
    const retry = m.oneLife && !good ? null : () => this.start(launch.def, launch.kind, launch.extra);
    this.screens.show('debrief', { result: snap.result, snap, score, rank: { before: ri0.index === ri1.index ? ri0.progress : ri0.progress, after: ri1.progress, name: ri1.rank, up: ri1.index > ri0.index }, unlocks: [...unlocks, ...(final ? ['PAINT: Shadow Line', 'HUD THEME: Crimson', 'CAMPAIGN COMPLETE: +5 TOKENS'] : [])], mission: m, saved, retry, next, final });
  }

  // ------------------------------------------------------------------ pause
  onKey(e) {
    if (e.code === 'Escape' && this.game && this.game.paused) { if (this.screens.current === 'pause') this.togglePause(); else this.showPause(); }
    if (e.code === 'Escape' && this.replay) this.exitReplay();
  }
  togglePause() {
    const g = this.game; if (!g || g.ended && g.endTimer < 0.4) return; g.paused = !g.paused;
    if (g.paused) { this.audio.setEngine(false); this.audio.setAmbience('off'); this.showPause(); if (document.pointerLockElement) document.exitPointerLock(); }
    else { this.screens.clear(); this.input.pressed.clear(); this.input.keys.clear(); if (g.mouseFlight) this.input.setMouseFlight(true); }
  }
  showPause() { this.screens.show('pause'); }
  restartMission() { const l = this.lastLaunch; if (l) this.start(l.def, l.kind, l.extra); }
  abortToMenu() {
    if (this.game && this.game.rec.frames.length > 3) { this.lastReplay = this.game.rec.export(); Save.saveReplay(this.lastReplay); }
    this.endSession(); this.hud.show(false); this.comms.clear(); this.audio.setAmbience('hangar'); this.audio.setMusic('IDLE'); this.screens.show('menu');
  }

  // ------------------------------------------------------------------ replay viewer
  playReplay(rep) {
    if (!rep) return; this.endSession(); this.screens.clear(); this.replay = new ReplaySession(rep); this.input.enabled = true; this.audio.setAmbience('flight', 0.3);
    const root = document.getElementById('screens');
    root.innerHTML = `<div class="screen" style="padding:0;pointer-events:none"><div class="panel replay-bar ui-block"><button class="btn small" data-r="play">❚❚</button><span class="mono" data-r="time">00:00</span><input type="range" min="0" max="${rep.duration}" step="0.1" value="0" data-r="seek"/><button class="btn small" data-r="speed">1×</button><button class="btn small" data-r="cam">CAM: RECORDED</button><button class="btn small danger" data-r="exit">EXIT</button></div><div class="replay-line hidden" data-r="line"></div></div>`;
    const q = (n) => root.querySelector(`[data-r=${n}]`), R = this.replay;
    q('play').onclick = () => { R.playing = !R.playing; if (R.time >= rep.duration) { R.seek(0); R.playing = true; } q('play').textContent = R.playing ? '❚❚' : '▶'; };
    q('speed').onclick = () => { R.speed = R.speed === 1 ? 2 : R.speed === 2 ? 0.5 : 1; q('speed').textContent = R.speed + '×'; };
    q('cam').onclick = () => { R.nextCam(); q('cam').textContent = 'CAM: ' + R.camNames[R.camMode]; };
    q('seek').oninput = (e) => R.seek(parseFloat(e.target.value)); q('exit').onclick = () => this.exitReplay();
    this.replayUI = { q };
  }
  exitReplay() { if (!this.replay) return; this.replay.dispose(); this.replay = null; this.input.enabled = false; this.audio.setAmbience('hangar'); this.screens.show('replay'); }

  // ------------------------------------------------------------------ frame loop
  frame(now) {
    const dtMs = Math.min(100, now - this.last); this.last = now; const dt = dtMs / 1000; this.gl.adapt(dtMs);
    let scene, camera, exposure = 1;
    try {
      if (this.replay) {
        const look = this.input.poll(dt).look; this.replay.update(dt, look); scene = this.replay.scene; camera = this.replay.camera; exposure = this.replay.world.exposure;
        const u = this.replayUI.q; u('seek').value = this.replay.time; u('time').textContent = fmtTime(this.replay.time) + ' / ' + fmtTime(this.replay.rep.duration); const ln = u('line'); ln.classList.toggle('hidden', this.replay.lineT <= 0); ln.textContent = this.replay.line;
      } else if (this.game) {
        this.game.update(dt); scene = this.game.scene; camera = this.game.camera; exposure = this.game.exposure;
      } else { exposure = this.hangar.update(dt); scene = this.hangar.scene; camera = this.hangar.camera; }
      this.renderer.toneMappingExposure = exposure;
      if (scene) this.renderer.render(scene, camera);
    } catch (e) { this.fatal(e); return; }
    requestAnimationFrame((t) => this.frame(t));
  }
  fatal(e) {
    console.error(e); const el = document.getElementById('fatal'); el.classList.remove('hidden');
    el.innerHTML = `<div><h2>SHADOW LINE — RUNTIME ERROR</h2><pre>${String(e && e.stack || e).replace(/[<&]/g, '')}</pre><button class="btn" id="fatal-reload" style="pointer-events:auto">RELOAD</button></div>`;
    document.getElementById('fatal-reload').onclick = () => location.reload();
  }
}

const app = new App(); window.__app = app; window.addEventListener('error', (e) => app.fatal(e.error || e.message));
app.boot();
