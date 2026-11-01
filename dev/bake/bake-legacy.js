// Evaluated inside legacy-viewer's module scope (?harness). Captures, per weapon, the fully solved
// upper body (retargeted pose + fitted grip + finger contact fixes + support-hand placement), the gun
// in right-hand space, and animated weapon parts, for: aim loop, lowered pose, fire, reloads, bolt cycle.
(async () => {
  const { GLTFExporter } = await import('https://unpkg.com/three@0.186.1/examples/jsm/exporters/GLTFExporter.js');
  simFrozen = true; soundOn = false;
  ikFromJson({ foot: { l: [0, 0, 0], r: [0, 0, 0] }, footQ: { l: [0, 0, 0, 1], r: [0, 0, 0, 1] }, knee: { l: [0, 0, 0], r: [0, 0, 0] }, pelvis: [0, 0, 0], gun: [0, 0, 0], gunQ: [0, 0, 0, 1] });
  const UPPER = Object.keys(bones).filter(n => /^(spine_0[123]|neck_01|head|clavicle_|upperarm_|lowerarm_|hand_[lr]$|thumb_|index_|middle_|ring_|pinky_)/.test(n));
  const r4 = x => Math.round(x * 1e4) / 1e4, M = m => Array.from(m.elements, r4);
  const step = d => { simTime += d; updateCharacter(d); };
  const out = { fps: 30, bones: UPPER, weapons: {} }, glbs = {}, summary = {};
  const isFlash = o => { for (let p = o; p; p = p.parent) if (p === flash) return true; return false; };

  for (const id of ['pistol', 'rifle', 'kar']) {
    const w = W.list[id], cap = w.cap ?? 15;
    const reset = () => { RL.on = false; RL.pending = -1; KA.on = false; KA.pending = -1; W.swapT = -1; W.dip = 0; W.leftW = 1; trigStart = -1; w.locked = false; w.ammo = cap;
      if (w.mag) w.mag.visible = true; };
    reset(); equip(w); W.blend = w.long ? 1 : 0;
    for (let i = 0; i < 120; i++) step(1 / 60);
    const nodes = []; w.obj.traverse(o => { if (o !== w.obj && !isFlash(o)) nodes.push(o); });
    const raw = {};  // seq -> frames (body + all node states)
    const cap1 = (G) => {
      charRoot.updateMatrixWorld(true); w.obj.updateMatrixWorld(true);
      const gunW = G ? charRoot.matrixWorld.clone().multiply(G) : w.obj.matrixWorld.clone();
      const hr = bones.hand_r.matrixWorld, hl = bones.hand_l.matrixWorld;
      const s1 = new THREE.Quaternion().setFromRotationMatrix(charRoot.matrixWorld.clone().invert().multiply(bones.spine_01.matrixWorld));
      return { q: UPPER.flatMap(n => bones[n].quaternion.toArray().map(r4)), s1: s1.toArray().map(r4),
        gun: M(hr.clone().invert().multiply(gunW)), handL: M(gunW.clone().invert().multiply(hl)),
        nodes: nodes.map(o => [o.matrix.clone(), o.visible]) };
    };
    const record = (name, dur, fps, until) => {
      const fr = [cap1()];
      for (let t = 0; until ? until() : t < dur - 1e-6; t += 1 / fps) { step(1 / fps); fr.push(cap1()); if (fr.length > 400) break; }
      raw[name] = { fps, frames: fr };
    };
    // aim idle loop (pistol pose is an animated idle; long guns breathe)
    record('aim', Math.min(rt.dur, 4), 15);
    // lowered (sprint / low-ready): rotate the gun about its grip and re-solve both hands onto it
    {
      for (let i = 0; i < 30; i++) step(1 / 60);
      const piv = { pistol: V(0, -6, 0), rifle: V(0.34, -9.5, -8.5), kar: V(0, -4.7, -17.5) }[id];
      const [deg, down, back] = { pistol: [55, 18, 14], rifle: [38, 6, 4], kar: [38, 6, 4] }[id];
      const G = w.obj.matrix.clone().multiply(new THREE.Matrix4().makeTranslation(piv.x, piv.y, piv.z)).multiply(new THREE.Matrix4().makeRotationX(deg * DEG)).multiply(new THREE.Matrix4().makeTranslation(-piv.x, -piv.y, -piv.z));
      G.premultiply(new THREE.Matrix4().makeTranslation(0, -down, -back));
      setGunMatrix(G);
      if (w.J) { poseHandFrom('r', w.J.r, G, 1, w.fq.r, 1); poseHandFrom('l', w.J.l, G, 1, w.fq.l, 1); chainOf('index', 'r').forEach((b, i) => b.quaternion.copy(w.trig.rest[i])); }
      else { driveHand('r'); driveHand('l'); chainOf('index', 'r').forEach((b, i) => b.quaternion.copy(w.trig.rest[i])); }
      raw.low = { fps: 30, frames: [cap1(G)] };
    }
    reset(); for (let i = 0; i < 60; i++) step(1 / 60);
    // fire: weapon parts only (slide / bolt travel); body recoil is simulated in game
    fire(); record('fire', 0.3, 60); reset(); for (let i = 0; i < 90; i++) step(1 / 60);
    if (w.kar) {
      startKarAction('cycle'); record('cycle', 0, 30, () => KA.on); reset(); for (let i = 0; i < 60; i++) step(1 / 60);
      w.ammo = 0; startReload(); record('reloadEmpty', 0, 30, () => KA.on);
    } else {
      w.ammo = cap - 5; startReload(); record('reload', 0, 30, () => RL.on); reset(); for (let i = 0; i < 60; i++) step(1 / 60);
      w.ammo = 0; w.locked = true; startReload(); record('reloadEmpty', 0, 30, () => RL.on);
    }
    reset(); for (let i = 0; i < 60; i++) step(1 / 60);

    // Which nodes are exported (visible, or toggled at some point) and which animate.
    const N = nodes.length, toggled = new Array(N).fill(false), moving = new Array(N).fill(false);
    const first = raw.aim.frames[0].nodes;
    for (const s of Object.values(raw)) for (const f of s.frames) f.nodes.forEach(([m, v], k) => {
      if (v !== first[k][1]) toggled[k] = true;
      if (!m.equals(first[k][0])) { for (let e = 0; e < 16; e++) if (Math.abs(m.elements[e] - first[k][0].elements[e]) > 1e-4) { moving[k] = true; break; } }
    });
    const vis = o => { for (let p = o; p && p !== w.obj; p = p.parent) if (!p.visible && !toggled[nodes.indexOf(p)]) return false; return true; };
    const keep = nodes.map((o, k) => !isFlash(o) && vis(o));
    const names = nodes.map((o, k) => `${id}_n${k}`);
    const tracked = nodes.map((_, k) => k).filter(k => keep[k] && (moving[k] || toggled[k]));
    const seqs = {};
    for (const [name, s] of Object.entries(raw)) seqs[name] = { fps: s.fps, frames: s.frames.map(f => ({ q: f.q, s1: f.s1, gun: f.gun, handL: f.handL,
      parts: Object.fromEntries(tracked.map(k => [names[k], [...M(f.nodes[k][0]), f.nodes[k][1] ? 1 : 0]])) })) };

    // Export the model in its rest state (weapon space, cm).
    const saved = nodes.map(o => [o.name, o.visible, o.matrix.clone(), o.matrixAutoUpdate]);
    const objM = w.obj.matrix.clone(); w.obj.matrix.identity(); w.obj.matrixWorldNeedsUpdate = true;
    const fl = flash.parent; if (fl) fl.remove(flash);
    nodes.forEach((o, k) => { o.name = names[k]; o.matrix.copy(first[k][0]); o.matrix.decompose(o.position, o.quaternion, o.scale); if (toggled[k]) o.visible = true; });
    glbs[id] = await new GLTFExporter().parseAsync(w.obj, { binary: true, onlyVisible: true });
    nodes.forEach((o, k) => { const [n, v, m, au] = saved[k]; o.name = n; o.visible = v; o.matrix.copy(m); o.matrix.decompose(o.position, o.quaternion, o.scale); o.matrixAutoUpdate = au; });
    w.obj.matrix.copy(objM); if (fl) fl.add(flash);

    const meta = {};
    for (const [k, v] of Object.entries(w)) {
      if (v?.isVector3) meta[k] = v.toArray().map(r4);
      else if (['number', 'string', 'boolean'].includes(typeof v)) meta[k] = v;
      else if (k === 'kick' || k === 'rlDur') meta[k] = v;
    }
    meta.trig = { rest: w.trig.rest.map(q => q.toArray().map(r4)), pulled: w.trig.pulled.map(q => q.toArray().map(r4)) };
    meta.initialVisible = Object.fromEntries(tracked.map(k => [names[k], first[k][1] ? 1 : 0]));
    out.weapons[id] = { meta, seqs };
    summary[id] = { nodes: N, exported: keep.filter(Boolean).length, tracked: tracked.length, seqs: Object.fromEntries(Object.entries(seqs).map(([k, s]) => [k, s.frames.length])) };
  }
  return { json: out, glbs, summary };
})()
