import { Settings } from '../settings/settings.js';

// Fullscreen helper. Android/desktop browsers: Fullscreen API (+ landscape lock on touch devices).
// iPhone Safari has no Fullscreen API for pages: the button explains "Add to Home Screen" (the page ships the
// apple-mobile-web-app-capable meta and a manifest, so the installed app opens fullscreen and landscape).
const root = document.documentElement;
const req = () => root.requestFullscreen || root.webkitRequestFullscreen;
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// Installed app (Add to Home Screen): already chrome-less. The fullscreen display-mode also matches while the page is in API fullscreen, so exclude that.
export const standalone = () => !!(navigator.standalone || window.matchMedia?.('(display-mode: standalone)').matches || (window.matchMedia?.('(display-mode: fullscreen)').matches && !(document.fullscreenElement || document.webkitFullscreenElement)));
export const supported = () => !!req();
export const active = () => !!(document.fullscreenElement || document.webkitFullscreenElement) || standalone();

export async function enter() {
  const fn = req(); if (!fn || active()) return false;
  try {
    await fn.call(root, { navigationUI: 'hide' });
    if (Settings.touchMode()) await screen.orientation?.lock?.('landscape').catch(() => {});
    return true;
  } catch { return false; }
}
export function exit() { (document.exitFullscreen || document.webkitExitFullscreen)?.call(document); screen.orientation?.unlock?.(); }

/** Toggles fullscreen; returns false when the platform cannot do it (caller shows a hint). */
export async function toggle() {
  if (document.fullscreenElement || document.webkitFullscreenElement) { exit(); return true; }
  if (!supported()) return false;
  return enter();
}

/** Floating button (menus, pause, replay) + body class + resize on change. */
export function init(toast) {
  const btn = document.createElement('button'); btn.id = 'fs-btn'; btn.className = 'fs-btn'; btn.type = 'button'; btn.setAttribute('aria-label', 'Fullscreen'); btn.textContent = '⛶';
  document.getElementById('app').appendChild(btn);
  const refresh = () => {
    const on = active(); document.body.classList.toggle('is-fullscreen', on); btn.textContent = on && !standalone() ? '⤡' : '⛶';
    btn.style.display = standalone() || (!supported() && !isIOS()) ? 'none' : '';
  };
  const act = async (e) => { e.preventDefault(); e.stopPropagation(); if (!(await toggle())) toast?.(isIOS() ? 'iPHONE: SHARE → ADD TO HOME SCREEN FOR FULLSCREEN' : 'FULLSCREEN IS NOT AVAILABLE IN THIS BROWSER'); };
  btn.addEventListener('click', act);
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, () => { refresh(); window.dispatchEvent(new Event('resize')); });
  refresh();
}
