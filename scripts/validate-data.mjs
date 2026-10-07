// Cross-reference check for the JSON content (run: npm run validate).
import fs from 'fs';
const load = (f) => JSON.parse(fs.readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const dir = new URL('../data/missions/', import.meta.url);
const missions = fs.readdirSync(dir).filter((f) => /^m\d+\.json$/.test(f)).sort().map((f) => JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')));
const dialogue = load('dialogue.json'); dialogue.lines = { ...dialogue.lines, ...Object.assign({}, ...fs.readdirSync(new URL('../data/missions/', import.meta.url)).filter((f) => /^m\d+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(new URL('../data/missions/' + f, import.meta.url), 'utf8')).lines || {})) };
const { types } = load('enemies.json');
const aircraft = load('aircraft.json');
const errs = [];
const dots = (s) => [...String(s)].join('.');
const err = (m, what, v) => errs.push(`${m.id}: ${what} ${dots(v)}`);
for (const m of missions) {
  const gids = new Set(['player', 'wingman', ...m.groups.map((g) => g.id)]);
  const zids = new Set(m.zones.map((z) => z.id));
  const wids = new Set(m.waypoints.map((w) => w.id));
  for (const g of m.groups) if (!types[g.type]) err(m, 'group type', g.type);
  for (const k of ['primary', 'secondary', 'optional'])
    for (const o of m.objectives[k]) {
      const p = o.params || {};
      for (const t of [...(p.targets || []), ...(p.target ? [p.target] : [])]) if (!gids.has(t)) err(m, 'objective target', t);
      for (const w of p.waypoints || []) if (!wids.has(w)) err(m, 'waypoint', w);
      if (p.zone && !zids.has(p.zone)) err(m, 'zone', p.zone);
    }
  for (const e of m.events || []) {
    const w = e.when;
    for (const k of ['id', 'a', 'b']) if (w[k] && !gids.has(w[k]) && !(w.type === 'objective' && k === 'id')) err(m, 'event ref', w[k]);
    if (w.zone && !zids.has(w.zone)) err(m, 'event zone', w.zone);
    for (const a of e.do) {
      if (a.say && !dialogue.lines[a.say]) err(m, 'say', a.say);
      for (const sp of [].concat(a.spawn || [])) if (!gids.has(sp)) err(m, 'spawn', sp);
      if (a.cinematic && !m.cinematics[a.cinematic]) err(m, 'cinematic', a.cinematic);
    }
  }
  if (!aircraft.aircraft.length) err(m, 'aircraft', 'none');
}
for (const [id, l] of Object.entries(dialogue.lines)) {
  if (!dialogue.characters[l.speaker]) errs.push('speaker ' + dots(l.speaker));
  for (const lang of ['en', 'fr', 'ar']) if (!l.text[lang]) errs.push('missing ' + lang + ' ' + dots(id));
}
if (errs.length) { console.log(errs.join('\n')); process.exit(1); }
console.log('data OK:', missions.length, 'missions,', Object.keys(dialogue.lines).length, 'lines');
