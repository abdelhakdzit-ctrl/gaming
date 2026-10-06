import { clamp } from '../util/math.js';
import progression from '../../data/progression.json';

/** Mission score, grade and medals from the end-of-mission snapshot. */
export function scoreMission(mission, snap, diff) {
  const S = progression.score, objs = snap.objectives;
  const d = (k) => objs.filter((o) => o.kind === k), done = (k) => d(k).filter((o) => o.state === 'complete').length;
  const killsTotal = snap.targetsTotal, kills = snap.targetsDestroyed;
  const acc = snap.accuracy, dmg = clamp(snap.damageTaken / Math.max(1, snap.maxHp), 0, 1);
  const ally = snap.allies.length ? snap.allies.filter((a) => a.alive).length / snap.allies.length : 1;
  const par = mission.scoring?.parTime || 400, tScore = clamp(1 - (snap.time - par * 0.6) / (par * 1.2), 0, 1);
  let score = 0;
  score += killsTotal ? (kills / killsTotal) * S.perTarget * Math.max(1, killsTotal) * 0.6 : 0;
  score += d('primary').length ? (done('primary') / d('primary').length) * S.primaryObjective * d('primary').length * 0.8 : 0;
  score += done('secondary') * S.secondaryObjective + done('optional') * S.optionalObjective;
  score += acc * S.accuracyMax + (1 - dmg) * S.damageMax + ally * S.allySurvival + tScore * S.timeMax;
  score *= snap.result === 'complete' ? diff.scoreMult : 0.25;
  score = Math.round(score / 10) * 10;
  const grade = snap.result === 'complete' ? progression.grades.find((g) => score >= g.min).grade : 'D';
  const medals = [];
  if (snap.result === 'complete') {
    if (acc >= 0.45 && snap.shots > 20) medals.push('sharpshooter');
    if (snap.damageTaken < 0.5) medals.push('untouched');
    if (ally >= 1 && snap.allies.length) medals.push('wingman');
    if (snap.time <= par) medals.push('swift');
  }
  const xp = snap.result === 'complete' ? Math.round((mission.reward?.xp || 200) * (0.6 + { S: 0.8, A: 0.6, B: 0.4, C: 0.2, D: 0 }[grade] ) * (0.8 + 0.2 * diff.scoreMult)) : Math.round((mission.reward?.xp || 200) * 0.1);
  const tokens = snap.result === 'complete' ? (mission.reward?.tokens || 1) + (grade === 'S' ? 1 : 0) : 0;
  return { score, grade, medals, xp, tokens, acc, dmg, ally, kills, killsTotal, time: snap.time, objectives: objs };
}
export const rankFor = (xp) => { let r = progression.ranks[0]; for (const k of progression.ranks) if (xp >= k.xp) r = k; return r; };
export const rankIndex = (id) => progression.ranks.findIndex((r) => r.id === id);
