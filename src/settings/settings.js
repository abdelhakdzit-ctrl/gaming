import { Save } from '../save/save.js';

const PALETTES = {
  none: { hostile: '#ff5348', friend: '#4cc9ff', unknown: '#ffcf3d' },
  protanopia: { hostile: '#ffa31a', friend: '#3d9bff', unknown: '#ffffff' },
  deuteranopia: { hostile: '#ff9d0a', friend: '#4aa8ff', unknown: '#f4f4f4' },
  tritanopia: { hostile: '#ff3d6e', friend: '#2fe0c0', unknown: '#f2f2f2' }
};
export const SUBTITLE_SIZES = { small: 15, medium: 19, large: 25, xlarge: 31 };

/** Live settings (backed by the save) + application of visual/accessibility options to the DOM. */
export const Settings = {
  get s() { return Save.data.settings; },
  set(key, value) { Save.data.settings[key] = value; Save.commit(); this.apply(); this.onChange?.(key, value); },
  apply() {
    const s = this.s, root = document.documentElement, pal = PALETTES[s.colorblind] || PALETTES.none;
    root.style.setProperty('--c-hostile', pal.hostile); root.style.setProperty('--c-friend', pal.friend); root.style.setProperty('--c-unknown', pal.unknown);
    root.style.setProperty('--sub-size', SUBTITLE_SIZES[s.subtitleSize] + 'px');
    document.body.classList.toggle('reduced-motion', !!s.reducedMotion);
    document.body.classList.toggle('no-subs', !s.subtitles);
  },
  palette() { return PALETTES[this.s.colorblind] || PALETTES.none; }
};
