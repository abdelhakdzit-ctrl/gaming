// VS-AI game loop layer: combo/streak scoring, kill medals, wave intros, pickups and the round summary.
// Observes ai.js state (AI.wave / AI.breakT / AI.hp) rather than modifying it.
import * as THREE from 'three';
import { clamp, rnd } from '../math.js';
import { STATE } from '../state.js';
import { scene } from '../scene.js';
import { AI, ARENA, pushOutOfCover } from '../ai.js';
import { charPos } from '../locomotion.js';
import { RL, W } from '../weapons.js';
import { addTrauma, hitStop, feel } from './juice.js';
import { playHit, playPickup, playWaveHorn } from '../audio.js';

const COMBO_WINDOW = 4, MAX_MULT = 5, PICK_R = 120, MAX_PICKUPS = 8;
const $ = id => document.getElementById(id);
const MEDALS = ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'QUAD KILL', 'RAMPAGE', 'UNSTOPPABLE'];

export const stats = {};
const D = { streak: 0, mult: 1, comboT: 0, lastWave: 0, lastBreak: false, introT: 0, hp: 100, flawless: true, lastKillT: -99 };
const pickups = [], timers = new Set();

function later(fn, ms) { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); }

// ---------- pickups ----------
const geo = { ammo: new THREE.BoxGeometry(22, 14, 14), health: new THREE.BoxGeometry(18, 18, 18), beam: new THREE.CylinderGeometry(5, 5, 110, 10, 1, true) };
const mat = {
  ammo: new THREE.MeshBasicMaterial({ color: 0xffc84a }), health: new THREE.MeshBasicMaterial({ color: 0x4dff88 }),
  beamAmmo: new THREE.MeshBasicMaterial({ color: 0xffc84a, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
  beamHealth: new THREE.MeshBasicMaterial({ color: 0x4dff88, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
};
const group = new THREE.Group(); scene.add(group);

export function spawnPickup(kind, x, z) {
  if (pickups.length >= MAX_PICKUPS) removePickup(0);
  const p = { x, z }; pushOutOfCover(p, 40);
  const g = new THREE.Group(), body = new THREE.Mesh(geo[kind], mat[kind]);
  const beam = new THREE.Mesh(geo.beam, kind === 'health' ? mat.beamHealth : mat.beamAmmo); beam.position.y = 65;
  g.add(body, beam); g.position.set(p.x, 0, p.z); group.add(g);
  pickups.push({ kind, g, body, t: 0, life: 28, ph: Math.random() * 6 });
}
function removePickup(i) { const p = pickups[i]; group.remove(p.g); pickups.splice(i, 1); }
function clearPickups() { while (pickups.length) removePickup(0); }

function dropFrom(x, z) {
  const needHp = AI.hp < 60, r = Math.random();
  if (r < (needHp ? 0.5 : 0.18)) spawnPickup('health', x, z);
  else if (r < (needHp ? 0.7 : 0.5)) spawnPickup('ammo', x + rnd(-30, 30), z + rnd(-30, 30));
}
function placeArenaPickups() {
  for (const kind of ['health', 'ammo']) {
    for (let k = 0; k < 8; k++) {
      const x = rnd(-1500, 1500), z = rnd(300, 2800);
      if (Math.hypot(x - charPos.x, z - charPos.z) > 500) { spawnPickup(kind, x, z); break; }
    }
  }
}
function collect(p) {
  if (p.kind === 'health') {
    if (AI.hp >= 99) return false;
    AI.hp = Math.min(100, AI.hp + 35); toast('+35 HEALTH', '#4dff88'); stats.healthPicked++;
  } else {
    if (W.cur.ammo >= W.cur.cap && Object.values(W.list).every(w => w.ammo >= w.cap)) return false;
    for (const w of Object.values(W.list)) if (w !== W.cur || !RL.on) w.ammo = Math.max(w.ammo, w.cap + (w.name === 'pistol' ? 1 : 0));
    toast('AMMO RESTOCKED', '#ffc84a'); stats.ammoPicked++;
  }
  playPickup(p.kind); return true;
}

// ---------- HUD helpers ----------
function toast(text, color = '#fff') {
  const t = $('toast'); if (!t) return;
  t.textContent = text; t.style.color = color; t.classList.remove('on'); void t.offsetWidth; t.classList.add('on');
}
function medal(text, sub = '') {
  const m = $('medal'); if (!m) return;
  m.innerHTML = `${text}<small>${sub}</small>`; m.classList.remove('on'); void m.offsetWidth; m.classList.add('on');
}
function waveIntro(main, sub, ms = 2400) {
  const w = $('waveIntro'); if (!w) return;
  $('wiMain').textContent = main; $('wiSub').textContent = sub;
  w.classList.add('on'); D.introT = ms / 1000;
}

// ---------- events ----------
export function resetDirector() {
  for (const id of timers) clearTimeout(id); timers.clear();
  clearPickups();
  Object.assign(D, { streak: 0, mult: 1, comboT: 0, lastWave: 0, lastBreak: false, introT: 0, hp: 100, flawless: true, lastKillT: -99 });
  Object.assign(stats, { bestStreak: 0, bestMult: 1, comboBonus: 0, ammoPicked: 0, healthPicked: 0, damage: 0, waveBonus: 0, medals: 0 });
  for (const id of ['combo', 'waveIntro', 'medal', 'toast']) $(id)?.classList.remove('on');
}

// Called by game.js when ai.js reports a kill (point = where the enemy was hit).
export function onKill(point, head, game) {
  D.streak = D.comboT > 0 ? D.streak + 1 : 1;
  D.lastKillT = STATE.simTime; D.comboT = COMBO_WINDOW;
  D.mult = Math.min(MAX_MULT, 1 + (D.streak - 1) * 0.5);
  const base = head ? 150 : 100, bonus = Math.round(base * (D.mult - 1));
  game.score += bonus; stats.comboBonus += bonus;
  stats.bestStreak = Math.max(stats.bestStreak, D.streak); stats.bestMult = Math.max(stats.bestMult, D.mult);
  hitStop(head ? 0.075 : 0.05, 0.08); addTrauma(head ? 0.32 : 0.2); feel.fovKick = Math.max(feel.fovKick, head ? 1 : 0.6);
  playHit(head ? 'head' : 'kill');
  const m = MEDALS[Math.min(D.streak, MEDALS.length - 1)];
  if (m) { medal(m, `x${D.mult} COMBO`); stats.medals++; } else if (head) medal('HEADSHOT', '');
  if (AI.on) dropFrom(point.x, point.z);
  return D.mult;
}

export function onPlayerDamaged(amount) {
  stats.damage += amount; D.flawless = false;
  D.comboT = Math.max(0, D.comboT - 1.2);
  addTrauma(clamp(0.18 + amount / 60, 0.2, 0.7));
}

// ---------- per frame (real seconds) ----------
export function updateDirector(real, game) {
  const t = STATE.simTime;
  // combo timer
  if (D.comboT > 0) {
    D.comboT -= real;
    if (D.comboT <= 0) { D.streak = 0; D.mult = 1; }
  }
  const combo = $('combo');
  if (combo) {
    combo.classList.toggle('on', D.comboT > 0 && D.streak > 1);
    if (D.comboT > 0) { $('cMult').textContent = 'x' + D.mult; $('cStreak').textContent = D.streak + ' STREAK'; $('cBar').style.transform = `scaleX(${clamp(D.comboT / COMBO_WINDOW, 0, 1)})`; }
  }
  // wave flow
  if (game.state === 'play') {
    if (AI.wave !== D.lastWave) {
      const first = D.lastWave === 0; D.lastWave = AI.wave; D.flawless = true;
      waveIntro(`WAVE ${AI.wave}`, `${AI.toKill} hostiles`); playWaveHorn(true);
      if (first) toast('Survive. Chain kills for a combo multiplier.', '#fff'); else placeArenaPickups();
    }
    const brk = AI.breakT > 0;
    if (brk && !D.lastBreak) {
      const bonus = 250 * AI.wave + (D.flawless ? 500 : 0);
      game.score += bonus; stats.waveBonus += bonus;
      waveIntro(`WAVE ${AI.wave} CLEARED`, (D.flawless ? 'FLAWLESS  ' : '') + `+${bonus}`, 3300); playWaveHorn(false);
      placeArenaPickups();
    }
    D.lastBreak = brk;
    if (brk && D.introT <= 0.01) $('wiSub').textContent = `Next wave in ${Math.ceil(AI.breakT)}`;
  }
  if (D.introT > 0 && (D.introT -= real) <= 0 && !(AI.breakT > 0)) $('waveIntro')?.classList.remove('on');
  // pickups
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i]; p.t += real;
    p.g.rotation.y += real * 2.2; p.body.position.y = 26 + Math.sin(p.t * 3 + p.ph) * 5;
    const blink = p.life - p.t < 5 ? (Math.sin(p.t * 16) > 0 ? 1 : 0.2) : 1; p.g.visible = blink > 0.5;
    if (p.t > p.life) { removePickup(i); continue; }
    if (game.state === 'play' && Math.hypot(p.g.position.x - charPos.x, p.g.position.z - charPos.z) < PICK_R && collect(p)) removePickup(i);
  }
}

// ---------- damage direction indicators (several at once, tracking the player's turn) ----------
const inds = [];
export function addDamageIndicator(from) { inds.push({ x: from.x, z: from.z, age: 0 }); if (inds.length > 6) inds.shift(); }
export function updateIndicators(real, yaw) {
  const host = $('dmgDirs'); if (!host) return;
  while (host.children.length < inds.length) { const d = document.createElement('div'); d.className = 'di'; d.appendChild(document.createElement('i')); host.appendChild(d); }
  for (let i = inds.length - 1; i >= 0; i--) if ((inds[i].age += real) > 1.6) inds.splice(i, 1);
  for (let i = 0; i < host.children.length; i++) {
    const el = host.children[i], d = inds[i];
    if (!d) { el.style.opacity = '0'; continue; }
    const dx = d.x - charPos.x, dz = d.z - charPos.z;
    const f = dx * Math.sin(yaw) + dz * Math.cos(yaw), r = -dx * Math.cos(yaw) + dz * Math.sin(yaw);
    el.style.transform = `rotate(${Math.atan2(r, f)}rad)`;
    el.style.opacity = (1 - d.age / 1.6).toFixed(3);
  }
}
export function clearIndicators() { inds.length = 0; }

export function summaryHTML(game, acc, timeStr) {
  const row = (k, v) => `<div><small>${k}</small><b>${v}</b></div>`;
  return row('TIME', timeStr) + row('WAVE', AI.wave) + row('KILLS', AI.kills) + row('HEADSHOTS', AI.heads) + row('ACCURACY', acc + '%')
    + row('BEST STREAK', stats.bestStreak) + row('MAX MULT', 'x' + stats.bestMult) + row('COMBO BONUS', '+' + stats.comboBonus)
    + row('WAVE BONUS', '+' + stats.waveBonus) + row('DAMAGE TAKEN', Math.round(stats.damage)) + row('PICKUPS', stats.ammoPicked + stats.healthPicked) + row('SCORE', game.score);
}
