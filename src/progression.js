import progression from '../data/progression.json';
import aircraftData from '../data/aircraft.json';
import challengeData from '../data/challenges.json';
import { Save } from './save/save.js';

export const RANKS = progression.ranks;
export const rankIdx = (id) => RANKS.findIndex((r) => r.id === id);
export function rankInfo(xp) {
  let i = 0; RANKS.forEach((r, k) => { if (xp >= r.xp) i = k; });
  const cur = RANKS[i], next = RANKS[i + 1];
  return { index: i, rank: cur.id, next: next?.id || null, progress: next ? (xp - cur.xp) / (next.xp - cur.xp) : 1, xpToNext: next ? next.xp - xp : 0 };
}
export const currentRankIndex = () => rankInfo(Save.data.xp).index;

/** 'owned' | 'rank' (earned by rank) | 'buy' (token purchase) | 'locked' (needs rank). */
export function itemStatus(kind, item) {
  const d = Save.data, owned = d.owned[kind] || [];
  if (owned.includes(item.id)) return 'owned';
  if (item.unlockFlag) return d.flags?.[item.unlockFlag] ? 'rank' : 'locked';
  if (item.unlockRank && currentRankIndex() >= rankIdx(item.unlockRank)) return 'rank';
  if (item.unlockRank) return 'locked';
  if (item.cost === 0) return 'owned';
  return 'buy';
}
export const hasItem = (kind, item) => ['owned', 'rank'].includes(itemStatus(kind, item));
export function buyItem(kind, item) {
  const d = Save.data; if (itemStatus(kind, item) !== 'buy' || d.tokens < item.cost) return false;
  d.tokens -= item.cost; d.owned[kind].push(item.id); Save.commit(); return true;
}
export const unlockedCameraSet = () => new Set(aircraftData.cameras.filter((c) => !c.unlockRank || currentRankIndex() >= rankIdx(c.unlockRank)).map((c) => c.id));
export const challengeUnlocked = (c) => !c.unlockRank || currentRankIndex() >= rankIdx(c.unlockRank);
/** Items that became available when the rank rose from oldIdx to newIdx. */
export function newUnlocks(oldIdx, newIdx) {
  const out = []; if (newIdx <= oldIdx) return out;
  const hit = (u) => u && rankIdx(u) > oldIdx && rankIdx(u) <= newIdx;
  for (const [k, label] of [['aircraft', 'AIRCRAFT'], ['paints', 'PAINT'], ['hudThemes', 'HUD THEME'], ['cockpits', 'COCKPIT']]) for (const it of aircraftData[k]) if (hit(it.unlockRank)) out.push(`${label}: ${it.name}`);
  for (const it of aircraftData.cameras) if (hit(it.unlockRank)) out.push(`CAMERA: ${it.name}`);
  for (const c of challengeData.challenges) if (hit(c.unlockRank)) out.push(`CHALLENGE: ${c.title}`);
  return out;
}
