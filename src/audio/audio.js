import { clamp } from '../util/math.js';

// Procedural WebAudio engine with eight buses: engine, weapons, missiles, warning, radio, ambience, music, ui.
// Everything is synthesised so the game ships without audio assets; drop files in assets/audio later and
// replace the recipes in play() without touching gameplay code.
export class AudioEngine {
  constructor(getSettings) {
    this.cfg = getSettings; this.ctx = null; this.bus = {}; this.warn = { lock: 0, missile: 0, pullup: 0, stall: 0 };
    this.musicState = 'IDLE'; this.musicTimer = null; this.nextBeat = 0; this.beat = 0; this.engineNodes = null; this.ambNodes = null;
  }
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return true; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false;
    const c = this.ctx = new AC(); const master = c.createGain(); const comp = c.createDynamicsCompressor(); master.connect(comp); comp.connect(c.destination);
    this.master = master;
    for (const k of ['engine', 'weapons', 'missiles', 'warning', 'radio', 'ambience', 'music', 'ui']) { const g = c.createGain(); g.connect(master); this.bus[k] = g; }
    const len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf; this.applyVolumes(); this.startMusicLoop(); return true;
  }
  applyVolumes() {
    if (!this.ctx) return; const s = this.cfg(), t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.master, t, 0.05);
    const fx = s.effects; for (const k of ['engine', 'weapons', 'missiles', 'ambience']) this.bus[k].gain.setTargetAtTime(fx, t, 0.05);
    this.bus.warning.gain.setTargetAtTime(Math.max(0.35, fx), t, 0.05); this.bus.ui.gain.setTargetAtTime(fx, t, 0.05);
    this.bus.radio.gain.setTargetAtTime(s.radio, t, 0.05); this.bus.music.gain.setTargetAtTime(s.music * 0.55, t, 0.05);
  }
  // ---- primitives
  burst(bus, { dur = 0.2, type = 'lowpass', freq = 2000, to = null, q = 1, gain = 0.5, delay = 0 }) {
    const c = this.ctx, t = c.currentTime + delay, src = c.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur); f.Q.value = q;
    const g = c.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f); f.connect(g); g.connect(this.bus[bus]); src.start(t, Math.random()); src.stop(t + dur + 0.05);
  }
  tone(bus, { freq = 440, to = null, dur = 0.15, type = 'sine', gain = 0.2, delay = 0 }) {
    const c = this.ctx, t = c.currentTime + delay, o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t); if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(this.bus[bus]); o.start(t); o.stop(t + dur + 0.05);
  }
  play(name, vol = 1) {
    if (!this.ctx || vol <= 0.01) return;
    switch (name) {
      case 'cannon': this.burst('weapons', { dur: 0.07, type: 'bandpass', freq: 900, q: 0.7, gain: 0.35 * vol }); this.tone('weapons', { freq: 130, to: 60, dur: 0.06, type: 'square', gain: 0.1 * vol }); break;
      case 'missile': this.burst('missiles', { dur: 1.4, type: 'lowpass', freq: 600, to: 3200, gain: 0.5 * vol }); this.tone('missiles', { freq: 90, to: 200, dur: 0.6, type: 'sawtooth', gain: 0.12 * vol }); break;
      case 'flare': this.burst('weapons', { dur: 0.35, type: 'highpass', freq: 2500, gain: 0.25 * vol }); break;
      case 'explosion': this.burst('missiles', { dur: 1.8, type: 'lowpass', freq: 1800, to: 80, gain: 0.9 * vol }); this.tone('missiles', { freq: 70, to: 25, dur: 1.2, type: 'sine', gain: 0.5 * vol }); break;
      case 'hit': this.burst('weapons', { dur: 0.25, type: 'bandpass', freq: 400, q: 1, gain: 0.7 * vol }); this.tone('weapons', { freq: 220, to: 70, dur: 0.2, type: 'square', gain: 0.18 * vol }); break;
      case 'click': this.tone('ui', { freq: 1200, to: 800, dur: 0.05, type: 'square', gain: 0.07 }); break;
      case 'hover': this.tone('ui', { freq: 700, dur: 0.03, type: 'sine', gain: 0.03 }); break;
      case 'confirm': this.tone('ui', { freq: 520, dur: 0.1, type: 'triangle', gain: 0.12 }); this.tone('ui', { freq: 780, dur: 0.14, type: 'triangle', gain: 0.12, delay: 0.08 }); break;
      case 'objective': this.tone('ui', { freq: 660, dur: 0.12, type: 'sine', gain: 0.14 }); this.tone('ui', { freq: 990, dur: 0.22, type: 'sine', gain: 0.14, delay: 0.1 }); break;
      case 'stamp': this.burst('ui', { dur: 0.5, type: 'lowpass', freq: 400, to: 60, gain: 0.8 }); break;
      case 'radio_on': this.burst('radio', { dur: 0.08, type: 'bandpass', freq: 2200, q: 2, gain: 0.5 }); this.tone('radio', { freq: 1400, dur: 0.05, type: 'square', gain: 0.05 }); break;
      case 'radio_off': this.burst('radio', { dur: 0.12, type: 'bandpass', freq: 1800, q: 2, gain: 0.4 }); this.tone('radio', { freq: 900, dur: 0.06, type: 'square', gain: 0.05 }); break;
      case 'lock': this.tone('warning', { freq: 1500, dur: 0.12, type: 'sine', gain: 0.18 }); break;
      case 'locked': this.tone('warning', { freq: 1800, dur: 0.5, type: 'square', gain: 0.08 }); break;
      case 'denied': this.tone('warning', { freq: 220, dur: 0.18, type: 'sawtooth', gain: 0.12 }); this.tone('warning', { freq: 180, dur: 0.18, type: 'sawtooth', gain: 0.12, delay: 0.2 }); break;
    }
  }

  // ---- persistent loops
  setEngine(on, thr = 0.5, speed = 200) {
    if (!this.ctx) return; const c = this.ctx, t = c.currentTime;
    if (!this.engineNodes) {
      const src = c.createBufferSource(); src.buffer = this.noise; src.loop = true; const bp = c.createBiquadFilter(); bp.type = 'lowpass'; const g = c.createGain(); g.gain.value = 0;
      const o1 = c.createOscillator(), o2 = c.createOscillator(); o1.type = 'sawtooth'; o2.type = 'sawtooth'; const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400; const og = c.createGain(); og.gain.value = 0;
      src.connect(bp); bp.connect(g); g.connect(this.bus.engine); o1.connect(lp); o2.connect(lp); lp.connect(og); og.connect(this.bus.engine); src.start(); o1.start(); o2.start();
      this.engineNodes = { bp, g, o1, o2, og, lp };
    }
    const n = this.engineNodes; const vol = on ? 1 : 0;
    n.g.gain.setTargetAtTime(vol * (0.12 + thr * 0.3), t, 0.15); n.bp.frequency.setTargetAtTime(300 + thr * 1400 + speed * 2, t, 0.1);
    n.o1.frequency.setTargetAtTime(48 + thr * 70, t, 0.15); n.o2.frequency.setTargetAtTime(51 + thr * 72, t, 0.15);
    n.og.gain.setTargetAtTime(vol * (0.05 + thr * 0.12), t, 0.15); n.lp.frequency.setTargetAtTime(250 + thr * 700, t, 0.15);
  }
  setAmbience(kind, level = 0.4) {
    if (!this.ctx) return; const c = this.ctx, t = c.currentTime;
    if (!this.ambNodes) {
      const src = c.createBufferSource(); src.buffer = this.noise; src.loop = true; const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.4; const g = c.createGain(); g.gain.value = 0;
      const hum = c.createOscillator(); hum.type = 'sine'; hum.frequency.value = 55; const hg = c.createGain(); hg.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(this.bus.ambience); hum.connect(hg); hg.connect(this.bus.ambience); src.start(); hum.start(); this.ambNodes = { f, g, hg };
    }
    const n = this.ambNodes;
    if (kind === 'hangar') { n.f.frequency.setTargetAtTime(220, t, 0.3); n.g.gain.setTargetAtTime(0.12, t, 0.3); n.hg.gain.setTargetAtTime(0.1, t, 0.3); }
    else if (kind === 'flight') { n.f.frequency.setTargetAtTime(500 + level * 900, t, 0.2); n.g.gain.setTargetAtTime(0.03 + level * 0.14, t, 0.2); n.hg.gain.setTargetAtTime(0, t, 0.3); }
    else { n.g.gain.setTargetAtTime(0, t, 0.3); n.hg.gain.setTargetAtTime(0, t, 0.3); }
  }
  /** Warning loops: call every frame with the current warning intensities (0..1). */
  warnings(dt, w) {
    if (!this.ctx) return; const W = this.warn;
    for (const k of Object.keys(W)) W[k] -= dt;
    if (w.missile > 0 && W.missile <= 0) { this.tone('warning', { freq: 1250, dur: 0.09, type: 'square', gain: 0.1 + w.missile * 0.12 }); this.tone('warning', { freq: 1650, dur: 0.09, type: 'square', gain: 0.1 + w.missile * 0.12, delay: 0.1 }); W.missile = 0.8 - w.missile * 0.62; }
    if (w.lock > 0 && W.lock <= 0) { this.tone('warning', { freq: 900, dur: 0.07, type: 'sine', gain: 0.1 }); W.lock = 0.6 - w.lock * 0.45; }
    if (w.pullup && W.pullup <= 0) { this.tone('warning', { freq: 800, to: 500, dur: 0.18, type: 'sawtooth', gain: 0.16 }); W.pullup = 0.32; }
    if (w.stall && W.stall <= 0) { this.tone('warning', { freq: 300, dur: 0.12, type: 'square', gain: 0.1 }); W.stall = 0.22; }
  }
  // ---- radio: slightly compressed / band-limited
  radioStart() {
    if (!this.ctx) return; this.play('radio_on');
    if (!this.radioNoise) { const c = this.ctx, src = c.createBufferSource(); src.buffer = this.noise; src.loop = true; const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1700; f.Q.value = 0.9; const g = c.createGain(); g.gain.value = 0; src.connect(f); f.connect(g); g.connect(this.bus.radio); src.start(); this.radioNoise = g; }
    this.radioNoise.gain.setTargetAtTime(0.035, this.ctx.currentTime, 0.02);
  }
  radioStop() { if (!this.ctx) return; this.play('radio_off'); this.radioNoise?.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05); }
  speak(text, lang, speaker) {
    if (!this.cfg().tts || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text); u.lang = { en: 'en-US', fr: 'fr-FR', ar: 'ar-SA' }[lang] || 'en-US'; u.rate = 1.05; u.volume = this.cfg().radio;
    u.pitch = { NADIA: 1.25, LEILA: 1.3, MOURAD: 0.7, GREY: 0.5, RIAD: 1.0, SALIM: 0.85, UNKNOWN: 0.4 }[speaker] || 1; window.speechSynthesis.speak(u);
  }
  // ---- state-driven music: IDLE -> BUILDUP -> COMBAT -> DANGER -> RESOLUTION
  setMusic(state) { this.musicState = state; }
  startMusicLoop() {
    const c = this.ctx; this.nextBeat = c.currentTime + 0.1; this.beat = 0;
    const chords = [[220, 261.6, 329.6], [174.6, 220, 261.6], [261.6, 329.6, 392], [196, 246.9, 293.7]];
    const states = { IDLE: { tempo: 60, pad: 0.5, pulse: 0, arp: 0, drone: 0 }, BUILDUP: { tempo: 84, pad: 0.6, pulse: 0.5, arp: 0, drone: 0 }, COMBAT: { tempo: 124, pad: 0.45, pulse: 0.8, arp: 0.6, drone: 0 }, DANGER: { tempo: 148, pad: 0.35, pulse: 1, arp: 0.9, drone: 1 }, RESOLUTION: { tempo: 56, pad: 0.7, pulse: 0, arp: 0.15, drone: 0 } };
    this.musicTimer = setInterval(() => {
      if (!this.ctx || this.ctx.state !== 'running') return;
      const st = states[this.musicState] || states.IDLE, spb = 60 / st.tempo / 2;
      while (this.nextBeat < c.currentTime + 0.25) {
        const t = this.nextBeat - c.currentTime, step = this.beat % 16, bar = Math.floor(this.beat / 16) % 4, ch = chords[bar].map((f) => (this.musicState === 'RESOLUTION' ? f * 1.122 : f));
        if (step === 0) { for (const f of ch) this.musicNote(f / 2, spb * 15, 'sawtooth', 0.045 * st.pad, t, 500); }
        if (st.pulse && step % 2 === 0) this.musicNote(ch[0] / 4, spb * 1.6, 'triangle', 0.16 * st.pulse, t, 300);
        if (st.pulse && step % 4 === 0) this.kick(0.1 * st.pulse, t);
        if (st.arp && step % 2 === 1) this.musicNote(ch[(step >> 1) % 3] * 2, spb * 0.9, 'square', 0.025 * st.arp, t, 2200);
        if (st.drone && step === 0) { this.musicNote(110, spb * 15, 'sawtooth', 0.05, t, 260); this.musicNote(116.5, spb * 15, 'sawtooth', 0.04, t, 260); }
        this.nextBeat += spb; this.beat++;
      }
    }, 100);
  }
  musicNote(freq, dur, type, gain, delay, cutoff) {
    const c = this.ctx, t = c.currentTime + Math.max(0, delay), o = c.createOscillator(); o.type = type; o.frequency.value = freq; const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff;
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + Math.min(0.3, dur * 0.3)); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(f); f.connect(g); g.connect(this.bus.music); o.start(t); o.stop(t + dur + 0.05);
  }
  kick(gain, delay) { const c = this.ctx, t = c.currentTime + Math.max(0, delay), src = c.createBufferSource(); src.buffer = this.noise; const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 160; const g = c.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18); src.connect(f); f.connect(g); g.connect(this.bus.music); src.start(t); src.stop(t + 0.2); }
}
