import { STATE } from './state.js';

// ---------- synthesized gunshot ----------
export let actx = null, noiseBuf = null;
// Audio is unlocked only from a real user gesture. The recorded samples are fetched and
// decoded after that gesture, avoiding Chrome's autoplay AudioContext warning at page load.
const SFX = {}, SFX_NAMES = ['pistol_shot', 'rifle_shot', 'rifle_tail', 'kar_shot', 'mag_in', 'slide_rack', 'bolt'];
export let sfxBus = null, sfxLoadStarted = false, master = null, reverbSend = null;
// sfxBus -> master (low-pass for muffling) -> destination; reverbSend -> convolver -> master.
function buildBus(ac) {
  master = ac.createBiquadFilter(); master.type = 'lowpass'; master.frequency.value = 20000; master.Q.value = 0.4; master.connect(ac.destination);
  sfxBus = ac.createDynamicsCompressor(); sfxBus.threshold.value = -10; sfxBus.ratio.value = 3; sfxBus.connect(master);
  const len = Math.floor(ac.sampleRate * 1.7), ir = ac.createBuffer(2, len, ac.sampleRate);
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2); }
  const conv = ac.createConvolver(); conv.buffer = ir;
  const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3800;
  reverbSend = ac.createGain(); reverbSend.gain.value = 0.55;
  reverbSend.connect(lp).connect(conv).connect(master);
}
export function audio() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  actx ||= new AudioCtx();
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  if (!sfxBus) buildBus(actx);
  return actx;
}
function loadSfx(ac = audio()) {
  if (!ac || sfxLoadStarted) return;
  sfxLoadStarted = true;
  for (const n of SFX_NAMES) fetch(`assets/sfx/${n}.mp3`).then(r => { if (!r.ok) throw new Error(`${r.status} ${n}`); return r.arrayBuffer(); }).then(b => ac.decodeAudioData(b)).then(buf => (SFX[n] = buf)).catch(() => {});
}
function unlockAudio() { if (!STATE.soundOn) return; const ac = audio(); if (ac) loadSfx(ac); }
window.addEventListener('pointerdown', unlockAudio, { once: true, passive: true });
window.addEventListener('keydown', unlockAudio, { once: true });
export function playSample(name, { rate = 1, gain = 1, delay = 0, pan = 0, lp = 0, wet = 0 } = {}) {
  if (!STATE.soundOn || !SFX[name]) return !!SFX[name];
  const ac = audio(); if (!ac) return false;
  const src = ac.createBufferSource(), g = ac.createGain();
  src.buffer = SFX[name]; src.playbackRate.value = rate; g.gain.value = gain;
  let node = src.connect(g);
  if (lp) { const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; node = node.connect(f); }   // distance muffling
  if (pan && ac.createStereoPanner) { const pn = ac.createStereoPanner(); pn.pan.value = Math.max(-1, Math.min(1, pan)); node = node.connect(pn); }
  if (wet > 0) { const w = ac.createGain(); w.gain.value = wet; node.connect(w).connect(reverbSend); }
  node.connect(sfxBus); src.start(ac.currentTime + delay);
  return true;
}
export function playShot(rate, w) {
  if (!STATE.soundOn) return;
  if (w?.sfx && playSample(w.sfx, { rate: rate * (0.97 + Math.random() * 0.06), gain: 0.9 + Math.random() * 0.1, wet: 0.22 })) return;
  rate *= w?.pitch ?? 1;
  if (!audio()) return;
  if (!noiseBuf) {
    noiseBuf = actx.createBuffer(1, actx.sampleRate * 1.5, actx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = actx.currentTime, out = actx.createDynamicsCompressor(); out.connect(master); out.connect(reverbSend);
  const crack = actx.createBufferSource(); crack.buffer = noiseBuf; crack.playbackRate.value = rate;
  const lp = actx.createBiquadFilter(); lp.type = 'lowpass';
  lp.frequency.setValueAtTime(9000 * rate, t); lp.frequency.exponentialRampToValueAtTime(300, t + 0.3 / rate);
  const g = actx.createGain(); g.gain.setValueAtTime(1.0, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.45 / rate);
  crack.connect(lp).connect(g).connect(out); crack.start(t); crack.stop(t + 0.6 / rate);
  const osc = actx.createOscillator(), og = actx.createGain();
  osc.frequency.setValueAtTime(140 * rate, t); osc.frequency.exponentialRampToValueAtTime(40 * rate, t + 0.15 / rate);
  og.gain.setValueAtTime(0.9, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.2 / rate);
  osc.connect(og).connect(out); osc.start(t); osc.stop(t + 0.25 / rate);
  const tail = actx.createBufferSource(); tail.buffer = noiseBuf; tail.playbackRate.value = 0.5 * rate;
  const tl = actx.createBiquadFilter(); tl.type = 'lowpass'; tl.frequency.value = 700;
  const tg = actx.createGain(); tg.gain.setValueAtTime(0.0001, t); tg.gain.linearRampToValueAtTime(0.18, t + 0.06 / rate); tg.gain.exponentialRampToValueAtTime(0.001, t + 1.3 / rate);
  tail.connect(tl).connect(tg).connect(out); tail.start(t); tail.stop(t + 1.4 / rate);
}

// Distance-attenuated parameters for a world-space sound heard from the camera (cm, speed of sound 343 m/s).
export function spatial(pos, cam) {
  const dx = pos.x - cam.position.x, dz = pos.z - cam.position.z, dist = Math.hypot(dx, pos.y - cam.position.y, dz);
  const rx = Math.cos(cam.rotation.y), rz = -Math.sin(cam.rotation.y);   // camera right on the ground plane
  const pan = dist > 1 ? (dx * rx + dz * rz) / Math.hypot(dx, dz || 1e-3) : 0;
  return { delay: dist / 34300, gain: Math.max(0.15, Math.min(1, 1.15 - dist / 4500)), pan: pan * 0.8, lp: 2500 + 15000 * Math.max(0, 1 - dist / 4000), wet: Math.min(0.5, 0.1 + dist / 9000) };
}

// Low-pass the whole mix: 0 = clear, 1 = heavily muffled (low health).
export function setMuffle(a) {
  if (!actx || !master) return;
  master.frequency.setTargetAtTime(20000 * Math.pow(650 / 20000, Math.max(0, Math.min(1, a))), actx.currentTime, 0.12);
}

function tone(ac, type, f0, f1, dur, gain, t) {
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
  o.connect(g).connect(sfxBus); o.start(t); o.stop(t + dur + 0.03);
}
// Hit confirmation: 'hit' tick, 'head' bright ping, 'kill' thud + chime.
export function playHit(kind) {
  if (!STATE.soundOn) return;
  const ac = audio(); if (!ac) return;
  const t = ac.currentTime;
  if (kind === 'hit') tone(ac, 'triangle', 2400, 1800, 0.05, 0.16, t);
  else if (kind === 'head') { tone(ac, 'sine', 3100, 2900, 0.16, 0.22, t); tone(ac, 'triangle', 1500, 900, 0.07, 0.15, t); }
  else { tone(ac, 'sine', 150, 45, 0.22, 0.5, t); tone(ac, 'sine', 1180, 1180, 0.28, 0.14, t + 0.03); tone(ac, 'sine', 1770, 1770, 0.3, 0.1, t + 0.03); }
}
export function playPickup(kind) {
  if (!STATE.soundOn) return;
  const ac = audio(); if (!ac) return;
  const t = ac.currentTime, f = kind === 'health' ? [523, 659, 784] : [440, 554, 659];
  f.forEach((hz, i) => tone(ac, 'sine', hz, hz, 0.22, 0.16, t + i * 0.06));
}
export function playWaveHorn(up) {
  if (!STATE.soundOn) return;
  const ac = audio(); if (!ac) return;
  const t = ac.currentTime;
  tone(ac, 'sawtooth', up ? 110 : 165, up ? 98 : 220, 0.9, 0.12, t); tone(ac, 'sine', up ? 55 : 82, up ? 49 : 110, 1.0, 0.3, t);
}

// Heartbeat: call each frame with level 0..1; schedules lub-dub at a rate that rises with the level.
let hbT = 0;
export function stepHeartbeat(real, level) {
  if (level < 0.05 || !STATE.soundOn || !actx) { hbT = 0; return; }
  hbT -= real;
  if (hbT > 0) return;
  hbT = 60 / (66 + 70 * level);
  const t = actx.currentTime, g = 0.28 + 0.3 * level;
  tone(actx, 'sine', 72, 40, 0.16, g, t); tone(actx, 'sine', 62, 36, 0.18, g * 0.75, t + 0.17);
}

// Ambient bed: filtered wind noise with a slow swell plus a faint low drone.
let amb = null;
export function startAmbient() {
  if (amb || !STATE.soundOn) return;
  const ac = audio(); if (!ac) return;
  const len = ac.sampleRate * 4, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
  let last = 0; for (let i = 0; i < len; i++) { last = last * 0.985 + (Math.random() * 2 - 1) * 0.15; d[i] = last; }   // brown-ish noise
  const src = ac.createBufferSource(); src.buffer = buf; src.loop = true;
  const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 420; bp.Q.value = 0.5;
  const g = ac.createGain(); g.gain.value = 0.0001; g.gain.setTargetAtTime(0.5, ac.currentTime, 1.5);
  const lfo = ac.createOscillator(), lg = ac.createGain(); lfo.frequency.value = 0.09; lg.gain.value = 140; lfo.connect(lg).connect(bp.frequency);
  const drone = ac.createOscillator(), dg = ac.createGain(); drone.type = 'sine'; drone.frequency.value = 52; dg.gain.value = 0.025;
  src.connect(bp).connect(g).connect(sfxBus); drone.connect(dg).connect(sfxBus);
  src.start(); lfo.start(); drone.start();
  amb = { src, lfo, drone, g };
}
export function stopAmbient() {
  if (!amb) return;
  const a = amb; amb = null;
  a.g.gain.setTargetAtTime(0.0001, actx.currentTime, 0.2);
  setTimeout(() => { try { a.src.stop(); a.lfo.stop(); a.drone.stop(); } catch (e) { /* already stopped */ } }, 900);
}
