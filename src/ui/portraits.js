// Lightweight "motion portraits": layered SVG busts with CSS parallax, breathing, blinking and radio
// interference. Replace by setting characters[x].image in data/dialogue.json (PNG/WebP) later - the
// same layers (bg / figure / glow / noise) are animated over either source.
export function portraitHTML(character, speaking = true) {
  const [bg, skin, suit] = character.palette;
  const look = character.look || 'pilot';
  const img = character.image ? `<img class="pt-img" src="${character.image}" alt="" />` : bust(skin, suit, look, bg);
  return `<div class="portrait-art ${speaking ? 'speaking' : ''}" style="--pt-bg:${bg};--pt-suit:${suit}">
    <div class="pt-layer pt-bg"><i></i><i></i><i></i></div>
    <div class="pt-layer pt-fig">${img}</div>
    <div class="pt-layer pt-glow"></div><div class="pt-layer pt-noise"></div><div class="pt-layer pt-scan"></div>
  </div>`;
}

function bust(skin, suit, look, bg) {
  const hair = look === 'headset' ? '#16100c' : look === 'engineer' ? '#2a1c14' : look === 'officer' ? '#1b1b1b' : '#201a14';
  const extra = {
    pilot: `<path d="M62 72 q38 -52 76 0 v22 h-76z" fill="#2b3036"/><rect x="66" y="84" width="68" height="14" rx="5" fill="#0c1218" opacity=".85"/><path d="M70 58 q30 -22 60 0" stroke="#6b737c" stroke-width="3" fill="none"/>`,
    headset: `<path d="M64 80 q4 -46 36 -46 q32 0 36 46 q-8 -26 -36 -26 q-28 0 -36 26z" fill="${hair}"/><path d="M62 82 q0 -52 38 -52 q38 0 38 52" stroke="#222" stroke-width="5" fill="none"/><rect x="56" y="80" width="10" height="22" rx="4" fill="#222"/><path d="M62 100 q6 22 30 22" stroke="#222" stroke-width="3" fill="none"/>`,
    officer: `<path d="M66 76 q34 -44 68 0 l-4 6 q-30 -26 -60 0z" fill="${hair}"/><path d="M70 66 q30 -26 60 0 v-8 q-30 -28 -60 0z" fill="#2c3a2c"/><rect x="82" y="58" width="36" height="6" fill="#b49a4a"/>`,
    engineer: `<path d="M64 84 q-4 -50 36 -50 q40 0 36 50 q-6 -30 -36 -30 q-30 0 -36 30z" fill="${hair}"/><path d="M130 84 q10 30 -6 46" stroke="${hair}" stroke-width="9" fill="none" stroke-linecap="round"/><circle cx="84" cy="94" r="9" fill="none" stroke="#7a4fa0" stroke-width="2.5"/><circle cx="116" cy="94" r="9" fill="none" stroke="#7a4fa0" stroke-width="2.5"/>`,
    visor: `<path d="M62 78 q38 -58 76 0 v26 h-76z" fill="#14161a"/><path d="M68 86 h64 v16 q-32 10 -64 0z" fill="#8fa1b2" opacity=".55"/><path d="M68 86 h64" stroke="#c8d4e0" stroke-width="1.5" opacity=".6"/>`,
    static: `<rect x="60" y="48" width="80" height="70" fill="#000" opacity=".55"/><path d="M60 70 h80 M60 90 h80 M60 108 h80" stroke="#aa3030" stroke-width="2" opacity=".6"/>`
  }[look];
  const face = look === 'static' ? '' : `<ellipse cx="100" cy="92" rx="30" ry="36" fill="${skin}"/><rect x="88" y="120" width="24" height="26" fill="${skin}"/>`;
  const eyes = look === 'visor' || look === 'static' ? '' : `<g class="pt-eyes"><ellipse cx="88" cy="92" rx="4" ry="2.6" fill="#10151a"/><ellipse cx="112" cy="92" rx="4" ry="2.6" fill="#10151a"/></g><path d="M82 85 q6 -4 12 0 M106 85 q6 -4 12 0" stroke="#1c1612" stroke-width="2" fill="none"/>`;
  const mouth = look === 'visor' || look === 'static' ? '' : `<ellipse class="pt-mouth" cx="100" cy="112" rx="8" ry="2" fill="#5a2a2a"/>`;
  return `<svg viewBox="0 0 200 200" preserveAspectRatio="xMidYMax slice">
    <path d="M10 200 q10 -62 90 -62 q80 0 90 62z" fill="${suit}"/><path d="M82 140 l18 22 l18 -22" stroke="#00000055" stroke-width="3" fill="none"/>
    ${face}${extra}${eyes}${mouth}</svg>`;
}
