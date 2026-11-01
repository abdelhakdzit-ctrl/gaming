// Central VS-AI difficulty curve. Pure data + functions (no DOM / three) so it can be printed from node.
// Keyframes are linearly interpolated by wave number; past the last keyframe the curve keeps growing gently.
const KEYS = [
  // wave count alive react sigma shooters detect aggr flank hp   dmg   nade speed stagger miss gap
  [1,  2,  2, 1.30, 0.060, 1, 0.55, 0.10, 0.00, 0.70, 0.55, 0,  0.82, 1.70, 4, 3.5],
  [2,  4,  2, 1.10, 0.052, 1, 0.65, 0.20, 0.05, 0.80, 0.65, 0,  0.86, 1.40, 3, 2.8],
  [4,  7,  3, 0.80, 0.040, 2, 0.80, 0.35, 0.25, 0.95, 0.80, 26, 0.95, 1.00, 3, 2.2],
  [6, 10,  4, 0.58, 0.030, 3, 1.00, 0.50, 0.40, 1.10, 0.95, 19, 1.00, 0.70, 2, 1.8],
  [9, 14,  5, 0.40, 0.021, 3, 1.15, 0.60, 0.50, 1.30, 1.05, 13, 1.05, 0.50, 1, 1.4],
  [12, 18, 5, 0.28, 0.015, 4, 1.30, 0.70, 0.60, 1.50, 1.15, 9,  1.10, 0.35, 1, 1.1],
];
const FIELDS = ['count', 'maxAlive', 'react', 'sigma', 'shooters', 'detectMul', 'advance', 'flank', 'hpMul', 'dmgMul', 'nadeEvery', 'speed', 'stagger', 'missShots', 'spawnGap'];
export const GRENADE_FROM = 4, RUSHER_FROM = 3, MARKSMAN_FROM = 5;

export function waveLabel(w) { return w <= 1 ? 'TRAINING' : w === 2 ? 'EASY' : w <= 4 ? 'NORMAL' : w <= 6 ? 'HARD' : w <= 9 ? 'VETERAN' : 'ELITE'; }

export function archetypeWeights(w) {
  const rusher = w < RUSHER_FROM ? 0 : Math.min(0.32, 0.18 + 0.03 * (w - RUSHER_FROM));
  const marksman = w < MARKSMAN_FROM ? 0 : Math.min(0.24, 0.12 + 0.02 * (w - MARKSMAN_FROM));
  return { rifleman: 1 - rusher - marksman, rusher, marksman };
}

export function difficultyFor(wave, touch = false) {
  const w = Math.max(1, wave | 0), last = KEYS[KEYS.length - 1];
  let a = KEYS[0], b = KEYS[0];
  for (let i = 0; i < KEYS.length; i++) { if (KEYS[i][0] <= w) a = b = KEYS[i]; if (KEYS[i][0] > w) { b = KEYS[i]; break; } }
  const t = a === b ? 0 : (w - a[0]) / (b[0] - a[0]), d = { wave: w };
  FIELDS.forEach((f, i) => { d[f] = a[i + 1] + (b[i + 1] - a[i + 1]) * t; });
  if (w > last[0]) {   // endless tail
    const x = w - last[0];
    d.count = last[1] + 1.5 * x; d.hpMul = Math.min(1.9, last[9] + 0.03 * x); d.react = Math.max(0.22, last[3] - 0.01 * x);
    d.sigma = Math.max(0.012, last[4] - 0.0005 * x); d.dmgMul = Math.min(1.35, last[10] + 0.02 * x);
  }
  d.count = Math.round(d.count); d.maxAlive = Math.round(d.maxAlive); d.shooters = Math.round(d.shooters); d.missShots = Math.round(d.missShots);
  d.grenade = w >= GRENADE_FROM ? Math.max(8, d.nadeEvery) : Infinity;
  d.campNeed = Math.max(3, 6.5 - 0.35 * (w - GRENADE_FROM));
  if (touch) { d.sigma *= 1.25; d.react *= 1.2; d.maxAlive = Math.min(d.maxAlive, 4); }
  d.toKill = d.count; d.mix = archetypeWeights(w); d.label = waveLabel(w);
  d.intro = w === RUSHER_FROM ? 'rusher' : w === MARKSMAN_FROM ? 'marksman' : null;
  return d;
}

// Weighted pick; the wave that introduces an archetype guarantees one as its second spawn.
export function pickArchetype(d, spawnIdx, seen, rnd = Math.random) {
  if (d.intro && !seen.has(d.intro) && spawnIdx >= 1) return d.intro;
  let r = rnd();
  for (const k of ['rusher', 'marksman']) { if ((r -= d.mix[k]) < 0) return k; }
  return 'rifleman';
}

export function difficultyTable(from = 1, to = 10) {
  const rows = [];
  for (let w = from; w <= to; w++) {
    const d = difficultyFor(w), m = d.mix;
    rows.push({ wave: w, label: d.label, enemies: d.count, alive: d.maxAlive, react: +d.react.toFixed(2), aimSigma: +d.sigma.toFixed(3), tokens: d.shooters,
      detect: +d.detectMul.toFixed(2), advance: +d.advance.toFixed(2), flank: +d.flank.toFixed(2), hp: Math.round(100 * d.hpMul), dmg: +d.dmgMul.toFixed(2),
      grenadeEvery: d.grenade === Infinity ? '-' : Math.round(d.grenade), mix: `${Math.round(m.rifleman * 100)}/${Math.round(m.rusher * 100)}/${Math.round(m.marksman * 100)}` });
  }
  return rows;
}
