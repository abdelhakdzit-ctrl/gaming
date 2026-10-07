import dialogue from '../../data/dialogue.json';
import { portraitHTML } from './portraits.js';
import { Settings } from '../settings/settings.js';

/** Radio dialogue: queued lines, subtitles (EN/FR/AR, RTL aware), motion portrait and filtered radio audio. */
export class Comms {
  constructor(root, audio) {
    this.audio = audio; this.queue = []; this.cur = null; this.t = 0; this.gap = 0; this.onLine = null;
    root.insertAdjacentHTML('beforeend', `<div class="portrait hidden" id="portrait"></div><div class="subs" id="subs" aria-live="polite"></div>`);
    this.portrait = root.querySelector('#portrait'); this.subs = root.querySelector('#subs');
  }
  /** Dynamic line (callouts): text = {en, fr, ar}. */
  sayRaw(speaker, text) { this.queue.push({ id: 'raw', speaker, voice: null, emotion: 'calm', text }); }
  get busy() { return !!this.cur || this.queue.length > 0; }
  say(id) {
    const l = dialogue.lines[id]; if (!l) { console.warn('missing dialogue', id); return; }
    this.queue.push({ id, ...l });
  }
  clear() { this.queue.length = 0; this.stop(); }
  stop() {
    if (this.cur) { this.audio.radioStop(); window.speechSynthesis?.cancel?.(); }
    this.cur = null; this.portrait.classList.add('hidden'); this.subs.innerHTML = ''; this.subs.classList.remove('on');
  }
  start(l) {
    this.cur = l; const lang = Settings.s.subtitleLang, text = l.text[lang] || l.text.en, ch = dialogue.characters[l.speaker];
    this.t = Math.max(2.6, text.length * (lang === 'ar' ? 0.07 : 0.056) + 1.1);
    this.audio.radioStart(); this.audio.speak(text, lang, l.speaker);
    this.portrait.innerHTML = `<div class="pt-frame">${portraitHTML(ch, true)}<div class="pt-meta"><b>${ch.name}</b><span>${ch.callsign} · ${ch.role}</span></div></div>`;
    this.portrait.classList.toggle('distorted', l.emotion === 'distorted'); this.portrait.classList.remove('hidden');
    const rtl = lang === 'ar';
    let html = `<div class="sub-line ${rtl ? 'rtl' : ''}" dir="${rtl ? 'rtl' : 'ltr'}"><span class="sub-who">${ch.callsign}</span> ${text}</div>`;
    if (Settings.s.bilingual && lang !== 'ar') html += `<div class="sub-line rtl alt" dir="rtl">${l.text.ar}</div>`;
    this.subs.innerHTML = html; this.subs.classList.add('on');
    this.onLine?.(l.id);
  }
  update(dt) {
    if (this.cur) { this.t -= dt; if (this.t <= 0) { this.stop(); this.gap = 0.7; } return; }
    if (this.gap > 0) { this.gap -= dt; return; }
    if (this.queue.length) this.start(this.queue.shift());
  }
}
