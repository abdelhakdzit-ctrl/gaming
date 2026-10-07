// Headless regression harness: drives one mission (or all) to completion through the real game loop.
// Usage (dev server running):  CHROME_PATH=/path/to/chrome node scripts/sim-check.mjs [missionIndex|all] [maxSimSeconds]
// An "oracle" teleports to waypoints, identifies and destroys targets and keeps the player alive, so it verifies mission SCRIPTS
// (objective chains, events, phase changes, AI roles, SAM fire, convoys, helicopters) rather than piloting skill.
import puppeteer from 'puppeteer-core';
import { spawnSync } from 'node:child_process';
const URL_ = process.env.GAME_URL || 'http://localhost:5173/';
if ((process.argv[2] || 'all') === 'all' && !process.env.SIM_CHILD) {
  let failed = 0;
  for (let i = 0; i < 15; i++) { const r = spawnSync(process.execPath, [process.argv[1], String(i), process.argv[3] || '900'], { env: { ...process.env, SIM_CHILD: '1' }, encoding: 'utf8' }); const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT')) || 'RESULT ' + i + ' no-output'; console.log(line); if (!line.includes('complete')) failed++; }
  process.exit(failed ? 1 : 0);
}
const idx = +process.argv[2]; const maxSim = +(process.argv[3] || 700);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox','--disable-gpu-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--window-size=1280,720'] });
const p = await browser.newPage(); await p.setViewport({ width: 1280, height: 720 });
const logs = []; p.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e.stack || e).slice(0, 500))); p.on('console', (m) => { if (m.type() === 'error') logs.push('console.error ' + m.text().slice(0, 300)); });
await p.goto(URL_, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 1500));
const res = await p.evaluate(async (idx, maxSim) => {
  const { MISSIONS } = await import('/src/missions/registry.js'); const app = window.__app;
  const def = MISSIONS[idx]; app.audio.ensure = () => true; app.launchMission(def);
  const g = app.game; if (!g) return { error: 'no game' };
  const fast = !window.__keepHud; if (fast) g.hud.update = () => {};
  const out = { id: def.id, title: def.title, errors: [], log: [] }; let tt = 0, last = '';
  const V = g.player.pos.constructor;
  const place = (x, y, z, hdg) => { g.flight.reset(new V(x, y, z), hdg, 230, false); g.player.airborne = true; if (g.state === 'takeoff' || g.state === 'intro') { g.state = 'flight'; g.endCinematic?.(); } };
  while (tt < maxSim && !(app.screens.current === 'debrief')) {
    const gg = app.game; if (!gg) break;
    try {
      for (let i = 0; i < 10; i++) { gg.player.hp = gg.player.maxHp; gg.ammo = 500; gg.player.flaresLeft = 30; gg.player.missilesLeft = 4; gg.update(1 / 20); tt += 1 / 20; if (app.screens.current === 'debrief') break; }
      if (!app.game) break;
      const dir = gg.director; if (dir.result) continue;
      if (gg.state === 'intro') { gg.endCinematic(); }
      if (gg.state === 'takeoff') place(gg.flight.pos.x, gg.world.baseAlt + 800, gg.flight.pos.z - 800, 0);
      let acted = false;
      for (const e of gg.entities) { if (!e.alive || e.isPlayer || e.isGround || e.side !== 'hostile') continue; e.t0 = e.t0 ?? gg.missionTime; if (/^grey/.test(e.id) || e.id === 'warden') e.keep = true; { const tgt = { grey1: 0.7, grey2: 0.44 }[e.id]; if (tgt && e.hp / e.maxHp > tgt) e.hp = e.maxHp * tgt; } if (gg.missionTime - e.t0 > (window.__killAfter || 25) && !e.keep) { e.identified = true; gg.damage(e, 99999, gg.player, 'cannon'); } }
      for (const o of dir.primaries) {
        if (o.state !== 'active') continue; const P = o.params || {};
        if (o.type === 'reach_area') { const w = (P.waypoints || []).find((q) => !o.hit.has(q)); const z = w && dir.waypoint(w); if (z) place(z.pos[0], z.pos[1], z.pos[2] + 400, 0); }
        else if (o.type === 'identify') for (const id of P.targets || []) { const e = gg.byId.get(id); if (e && e.alive) gg.identify(e); }
        else if (o.type === 'destroy') for (const id of P.targets || []) { const e = gg.byId.get(id); if (e && e.alive && !e.landed) { if (!e.identified) e.identified = true; gg.damage(e, 99999, gg.player, 'cannon'); } }
        else if (o.type === 'recon_site') { const t = dir.targetPos(P.target); if (t) { const hd = 0; gg.flight.reset(new V(t.x, t.y + 1800, t.z + 2800), hd, 230, false); gg.player.airborne = true; } }
        else if (o.type === 'hold_area') { const z = dir.waypoint(P.waypoint); if (z) place(z.pos[0], z.pos[1], z.pos[2] + 300, 0); }
        else continue;
        acted = true; break;
      }
      if (!acted && gg.state === 'flight' && gg.flight.pos.distanceTo(gg.mission.spawn.onRunway ? new V(0, gg.flight.pos.y, 1500) : new V(...gg.mission.spawn.pos)) > 14000) { const sp = gg.mission.spawn.pos; if (gg.mission.spawn.onRunway) place(0, gg.world.baseAlt + 800, 1500, 0); else place(sp[0], sp[1], sp[2], sp.heading || 0); }
      const key = dir.objectives.map((o) => o.id + '=' + o.state[0]).join(' '); if (key !== last) { out.log.push(tt.toFixed(0) + 's ' + key); last = key; }
    } catch (e) { out.errors.push(String(e.stack || e).slice(0, 600)); break; }
  }
  const r = app.lastResult; out.sim = Math.round(tt); out.screen = app.screens.current;
  if (r) out.result = { r: r.snap.result, why: r.snap.reason, grade: r.score.grade, score: r.score.score, obj: r.snap.objectives.map((o) => o.id + '=' + o.state[0]).join(' ') };
  return out;
}, idx, maxSim);
const ok = res.result && res.result.r === 'complete' && !res.errors.length && !logs.length;
console.log('RESULT M' + String(idx + 1).padStart(2, '0') + ' ' + res.title + ' sim=' + res.sim + 's ' + (res.result ? res.result.r + ' grade=' + res.result.grade : 'NO RESULT') + (res.errors.length ? ' ERRORS ' + res.errors[0] : '') + (logs.length ? ' PAGE-ERRORS ' + logs[0] : ''));
if (!ok) process.exitCode = 1;
await browser.close();
