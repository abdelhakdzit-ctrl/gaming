import { STATE } from './state.js';

// ---------- synthesized gunshot ----------
export let actx = null, noiseBuf = null;
// Audio is unlocked only from a real user gesture. The recorded samples are fetched and
// decoded after that gesture, avoiding Chrome's autoplay AudioContext warning at page load.
const SFX = {}, SFX_NAMES = ['pistol_shot', 'rifle_shot', 'rifle_tail', 'kar_shot', 'mag_in', 'slide_rack', 'bolt'];
export let sfxBus = null, sfxLoadStarted = false;
export function audio() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  actx ||= new AudioCtx();
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  if (!sfxBus) { sfxBus = actx.createDynamicsCompressor(); sfxBus.threshold.value = -10; sfxBus.ratio.value = 3; sfxBus.connect(actx.destination); }
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
export function playSample(name, { rate = 1, gain = 1, delay = 0, pan = 0, lp = 0 } = {}) {
  if (!STATE.soundOn || !SFX[name]) return !!SFX[name];
  const ac = audio(); if (!ac) return false;
  const src = ac.createBufferSource(), g = ac.createGain();
  src.buffer = SFX[name]; src.playbackRate.value = rate; g.gain.value = gain;
  let node = src.connect(g);
  if (lp) { const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; node = node.connect(f); }   // distance muffling
  if (pan && ac.createStereoPanner) { const pn = ac.createStereoPanner(); pn.pan.value = Math.max(-1, Math.min(1, pan)); node = node.connect(pn); }
  node.connect(sfxBus); src.start(ac.currentTime + delay);
  return true;
}
export function playShot(rate, w) {
  if (!STATE.soundOn) return;
  if (w?.sfx && playSample(w.sfx, { rate: rate * (0.97 + Math.random() * 0.06), gain: 0.9 + Math.random() * 0.1 })) return;
  rate *= w?.pitch ?? 1;
  if (!audio()) return;
  if (!noiseBuf) {
    noiseBuf = actx.createBuffer(1, actx.sampleRate * 1.5, actx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = actx.currentTime, out = actx.createDynamicsCompressor(); out.connect(actx.destination);
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
