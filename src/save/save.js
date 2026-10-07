// localStorage persistence: campaign, scores, unlocks, settings. Versioned for future migration.
const KEY = 'shadowline.save.v1';
const REPLAY_KEY = 'shadowline.replay.v1';

export const DEFAULT_SETTINGS = {
  difficulty: 'PILOT', flightMode: 'NORMAL', assistLevel: 0.5, autoLevel: true, targetAssist: true,
  sensitivity: 1, invertY: false, deadzone: 0.08, mouseControl: true, touchControls: 'auto', touchLeft: false, autoFullscreen: true,
  subtitles: true, subtitleSize: 'medium', subtitleLang: 'en', bilingual: false, colorblind: 'none', reducedMotion: false, cameraShake: true,
  master: 0.8, radio: 0.9, effects: 0.8, music: 0.5, tts: false,
  quality: 'high', dynamicRes: true, showFps: false
};
const fresh = () => ({
  version: 1, created: Date.now(), updated: Date.now(),
  campaign: { completed: {}, started: false, finished: false }, flags: {},
  scores: {}, bestTimes: {}, challenges: {}, xp: 0, tokens: 0,
  owned: { aircraft: ['falcon-x1'], paints: ['sand'], hudThemes: ['emerald'], cockpits: ['standard'] },
  equipped: { aircraft: 'falcon-x1', paint: 'sand', hudTheme: 'emerald', cockpit: 'standard', loadout: 'balanced' },
  settings: { ...DEFAULT_SETTINGS }
});

class SaveStore {
  constructor() { this.data = fresh(); this.loaded = false; this.listeners = new Set(); }
  has() { try { return !!localStorage.getItem(KEY); } catch { return false; } }
  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) { const d = JSON.parse(raw); this.data = { ...fresh(), ...d, settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) }, owned: { ...fresh().owned, ...(d.owned || {}) }, equipped: { ...fresh().equipped, ...(d.equipped || {}) } }; }
    } catch (e) { console.warn('save load failed', e); this.data = fresh(); }
    this.loaded = true; return this.data;
  }
  commit() {
    this.data.updated = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch (e) { console.warn('save failed', e); return false; }
    this.listeners.forEach((fn) => fn(this.data)); return true;
  }
  /** Starts a new campaign but keeps the player's settings. */
  newGame() { const s = this.data.settings; this.data = fresh(); this.data.settings = { ...s }; this.data.campaign.started = true; this.commit(); }
  reset() { try { localStorage.removeItem(KEY); localStorage.removeItem(REPLAY_KEY); } catch { /* ignore */ } this.data = fresh(); this.commit(); }
  saveReplay(rep) { try { localStorage.setItem(REPLAY_KEY, JSON.stringify(rep)); return true; } catch { return false; } }
  loadReplay() { try { const r = localStorage.getItem(REPLAY_KEY); return r ? JSON.parse(r) : null; } catch { return null; } }
}
export const Save = new SaveStore();
