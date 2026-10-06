import * as THREE from 'three';

// Procedural aircraft. Everything is built from named parts so a GLB can later replace the
// geometry: loadAircraftModel(url) swaps meshes by node name (fuselage, wing_l, aileron_l, ...).
const mats = new Map();
function std(color, o = {}) { return new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.5, ...o }); }

function lathe(profile, segs = 20) {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segs);
  g.rotateX(-Math.PI / 2); return g;
}
function shapeGeo(points, depth) {
  const s = new THREE.Shape(); s.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) s.lineTo(points[i][0], points[i][1]);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false });
  g.rotateX(-Math.PI / 2); g.translate(0, -depth / 2, 0); return g;
}
const additive = (color, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });

export function buildFighter(paint = { body: '#8f8a7a', accent: '#2f6b3a', trim: '#d9d4c3' }, { glow = [1, 0.55, 0.2] } = {}) {
  const g = new THREE.Group(); g.name = 'fighter';
  const body = std(paint.body), accent = std(paint.accent, { roughness: 0.6 }), trim = std(paint.trim, { roughness: 0.65 });
  const dark = std(0x16181b, { roughness: 0.7, metalness: 0.5 });
  const parts = { body, accent, trim };

  const fus = new THREE.Mesh(lathe([[0.001, -8], [0.7, -7.7], [0.95, -6.5], [1.12, -3.5], [1.15, 0], [1.02, 3], [0.72, 5.4], [0.38, 7.1], [0.05, 8.5]]), body);
  fus.geometry.scale(1, 0.78, 1); fus.name = 'fuselage'; g.add(fus);
  const nose = new THREE.Mesh(lathe([[0.001, 6.6], [0.3, 7.3], [0.05, 8.5]], 14), dark); nose.geometry.scale(1, 0.78, 1); g.add(nose);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12), new THREE.MeshStandardMaterial({ color: 0x0c1c28, metalness: 0.95, roughness: 0.05, transparent: true, opacity: 0.88 }));
  canopy.scale.set(0.58, 0.48, 2.3); canopy.position.set(0, 0.78, -2.7); canopy.name = 'canopy'; g.add(canopy);

  // wings (+ailerons)
  const wingGeo = shapeGeo([[0.9, 1.0], [7.6, -3.4], [7.6, -4.5], [0.9, -5.0]], 0.15);
  const ailGeo = new THREE.BoxGeometry(2.9, 0.09, 0.95); ailGeo.translate(0, 0, 0.47);
  const ail = {}, wings = {};
  for (const [side, sx] of [['r', 1], ['l', -1]]) {
    const w = new THREE.Mesh(wingGeo, body); w.material = body; w.scale.x = sx; w.position.set(0, -0.12, 1.2); w.name = 'wing_' + side;
    g.add(w); wings[side] = w;
    const a = new THREE.Group(); a.position.set(sx * 5.9, -0.12, 1.2 + 4.55); a.name = 'aileron_' + side;
    const am = new THREE.Mesh(ailGeo, accent); a.add(am); g.add(a); ail[side] = a;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), new THREE.MeshBasicMaterial({ color: sx > 0 ? 0x30ff60 : 0xff3030 }));
    tip.position.set(sx * 7.6, -0.1, 1.2 - 3.9); g.add(tip);
    // pylons + missiles (mounted state)
    for (const px of [3.0, 4.7]) {
      const pyl = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.42, 1.5), dark); pyl.position.set(sx * px, -0.38, 0.9); g.add(pyl);
    }
  }
  // stabilators
  const stabGeo = shapeGeo([[0, 0.9], [2.9, -0.9], [2.9, -1.6], [0, -1.6]], 0.1);
  const elev = {};
  for (const [side, sx] of [['r', 1], ['l', -1]]) {
    const e = new THREE.Group(); e.position.set(sx * 1.0, 0.05, 6.1); e.name = 'elevator_' + side;
    const m = new THREE.Mesh(stabGeo, trim); m.scale.x = sx; e.add(m); g.add(e); elev[side] = e;
  }
  // twin canted fins + rudders
  const finGeo = new THREE.BoxGeometry(0.11, 3.0, 2.5);
  finGeo.applyMatrix4(new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1)); finGeo.translate(0, 1.5, 0);
  const rudGeo = new THREE.BoxGeometry(0.08, 2.4, 0.9); rudGeo.translate(0, 1.2, 0.45);
  const rud = {};
  for (const [side, sx] of [['r', 1], ['l', -1]]) {
    const fg = new THREE.Group(); fg.position.set(sx * 1.55, 0.55, 5.1); fg.rotation.z = -sx * 0.24; fg.name = 'fin_' + side;
    fg.add(new THREE.Mesh(finGeo, body));
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.5, 1.6), accent); stripe.position.set(0, 2.0, 0.9); fg.add(stripe);
    const r = new THREE.Group(); r.position.set(0, 0.15, 1.7 + 0.2); r.name = 'rudder_' + side;
    r.add(new THREE.Mesh(rudGeo, accent)); fg.add(r); g.add(fg); rud[side] = r;
  }
  // intakes
  for (const sx of [-1, 1]) {
    const it = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.85, 3.4), body); it.position.set(sx * 1.05, -0.12, -0.4); it.rotation.y = sx * -0.04; g.add(it);
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.1), dark); mouth.position.set(sx * 1.05, -0.12, -2.14); g.add(mouth);
  }
  // engines
  const glowMeshes = [], nozzleGeo = new THREE.CylinderGeometry(0.46, 0.58, 1.3, 14, 1, true); nozzleGeo.rotateX(Math.PI / 2);
  for (const sx of [-1, 1]) {
    const n = new THREE.Mesh(nozzleGeo, dark); n.position.set(sx * 0.5, 0, 8.0); g.add(n);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.36, 2.6, 12, 1, true), additive(new THREE.Color(...glow), 0.85));
    cone.geometry.rotateX(Math.PI / 2); cone.geometry.translate(0, 0, 1.4); cone.position.set(sx * 0.5, 0, 8.5); g.add(cone);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), additive(new THREE.Color(1, 0.9, 0.7), 0.9)); core.position.set(sx * 0.5, 0, 8.45); g.add(core);
    glowMeshes.push({ cone, core });
  }
  // airbrake
  const brake = new THREE.Group(); brake.position.set(0, 0.78, 3.4);
  const bp = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.06, 1.9), accent); bp.position.z = 0.95; brake.add(bp); g.add(brake);

  // missiles
  const missiles = [], mslGeo = new THREE.CylinderGeometry(0.11, 0.11, 3.0, 8); mslGeo.rotateX(Math.PI / 2);
  const mslNose = new THREE.ConeGeometry(0.11, 0.5, 8); mslNose.rotateX(-Math.PI / 2); mslNose.translate(0, 0, -1.7);
  const mslMat = std(0xdcdcd0, { metalness: 0.2, roughness: 0.5 }), mslTip = std(0x303338);
  const mslFin = new THREE.BoxGeometry(0.6, 0.02, 0.4); mslFin.translate(0, 0, 1.2);
  for (const [sx, px] of [[-1, 3.0], [1, 3.0], [-1, 4.7], [1, 4.7]]) {
    const m = new THREE.Group(); m.position.set(sx * px, -0.78, 0.9);
    m.add(new THREE.Mesh(mslGeo, mslMat), new THREE.Mesh(mslNose, mslTip), new THREE.Mesh(mslFin, mslTip));
    const f2 = new THREE.Mesh(mslFin, mslTip); f2.rotation.z = Math.PI / 2; m.add(f2);
    g.add(m); missiles.push(m);
  }

  const api = {
    group: g, parts, missiles, kind: 'fighter',
    setControls({ pitch = 0, roll = 0, yaw = 0, brake: br = 0, throttle = 0.5 }, t = 0) {
      elev.r.rotation.x = elev.l.rotation.x = -pitch * 0.4;
      ail.r.rotation.x = -roll * 0.45; ail.l.rotation.x = roll * 0.45;
      rud.r.rotation.y = rud.l.rotation.y = -yaw * 0.45;
      brake.rotation.x = -br * 1.0;
      const k = 0.25 + throttle * 0.95, fl = 0.9 + Math.sin(t * 60) * 0.08;
      for (const { cone, core } of glowMeshes) { cone.scale.set(k * 0.7, k * 0.7, k * fl * (0.25 + throttle * 0.55)); cone.material.opacity = 0.12 + throttle * 0.28; core.scale.setScalar(0.4 + throttle * 0.45); core.material.opacity = 0.35 + throttle * 0.3; }
    },
    setMissilesMounted(n) { missiles.forEach((m, i) => { m.visible = i < n; }); },
    setPaint(p) { body.color.set(p.body); accent.color.set(p.accent); trim.color.set(p.trim); },
    setCockpitVisible(v) { fus.visible = v; canopy.visible = v; }
  };
  return api;
}

/** Cheap far-LOD silhouette used beyond ~3 km. */
function lowPoly(color = 0x444444) {
  const g = new THREE.Group();
  const f = new THREE.Mesh(new THREE.ConeGeometry(1, 16, 5), std(color)); f.rotation.x = -Math.PI / 2; g.add(f);
  const w = new THREE.Mesh(new THREE.BoxGeometry(15, 0.2, 5), std(color)); w.position.z = 1.5; g.add(w);
  return g;
}

export function buildScout() {
  const g = new THREE.Group(); g.name = 'scout';
  const body = std(0x2a2e33, { metalness: 0.5, roughness: 0.45 }), red = std(0x7a1e1e);
  const wing = new THREE.Mesh(shapeGeo([[0, 4.2], [5.2, -2.4], [3, -3.0], [0, -2.2], [-3, -3.0], [-5.2, -2.4]], 0.22), body); g.add(wing);
  const fus = new THREE.Mesh(lathe([[0.001, -2.6], [0.6, -2], [0.75, 0], [0.5, 2.4], [0.04, 4.4]]), body); fus.geometry.scale(1, 0.7, 1); g.add(fus);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.5, 1.6), red); fin.position.set(0, 0.8, 1.8); g.add(fin);
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2a2a })); eye.position.set(0, 0.3, -3.4); g.add(eye);
  const glow = new THREE.Mesh(new THREE.ConeGeometry(0.3, 3, 10, 1, true), additive(0xff6a2a, 0.7)); glow.geometry.rotateX(Math.PI / 2); glow.geometry.translate(0, 0, 1.6); glow.position.set(0, 0, 3.0); g.add(glow);
  const api = { group: g, kind: 'scout', setControls({ throttle = 0.5 }, t = 0) { const k = 0.4 + throttle; glow.scale.set(k, k, k * (0.8 + Math.sin(t * 50) * 0.1)); }, setMissilesMounted() {}, setPaint() {} };
  return api;
}

export function buildTransport() {
  const g = new THREE.Group(); g.name = 'transport';
  const white = std(0xe9e6dc, { metalness: 0.1, roughness: 0.6 }), grey = std(0x777b80);
  const fus = new THREE.Mesh(lathe([[0.001, -15], [1.4, -14], [2.3, -10], [2.4, 0], [2.2, 8], [1.2, 13], [0.3, 15]], 18), white); g.add(fus);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(36, 0.5, 5.2), white); wing.position.set(0, 1.9, 1); g.add(wing);
  const tailH = new THREE.Mesh(new THREE.BoxGeometry(11, 0.3, 2.6), white); tailH.position.set(0, 4.6, 12.5); g.add(tailH);
  const tailV = new THREE.Mesh(new THREE.BoxGeometry(0.4, 5.5, 4.2), white); tailV.position.set(0, 2.9, 12.8); g.add(tailV);
  // medical markings
  const decal = new THREE.CanvasTexture((() => { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 128, 128); x.fillStyle = '#d02020'; x.fillRect(48, 16, 32, 96); x.fillRect(16, 48, 96, 32); return c; })());
  for (const sx of [-1, 1]) { const d = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial({ map: decal })); d.position.set(sx * 2.45, 0.3, -4); d.rotation.y = sx * Math.PI / 2; g.add(d); const d2 = d.clone(); d2.scale.setScalar(0.8); d2.position.set(sx * 0.25, 3.6, 12.8); g.add(d2); }
  const props = [];
  for (const sx of [-1, 1]) {
    const nac = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.9, 4, 10), grey); nac.rotation.x = Math.PI / 2; nac.position.set(sx * 8, 1.0, -0.4); g.add(nac);
    const prop = new THREE.Mesh(new THREE.CircleGeometry(2.6, 16), additive(0xdddddd, 0.18)); prop.position.set(sx * 8, 1.0, -2.5); g.add(prop); props.push(prop);
  }
  const strobe = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff })); strobe.position.set(0, 5.9, 13); g.add(strobe);
  const api = { group: g, kind: 'transport', setControls(c, t = 0) { strobe.visible = Math.sin(t * 6) > 0.6; }, setMissilesMounted() {}, setPaint() {} };
  return api;
}

export function buildModel(kind, paintOverride) {
  let api;
  if (kind === 'scout') api = buildScout();
  else if (kind === 'transport') api = buildTransport();
  else if (kind === 'elite') api = buildFighter({ body: '#1d2024', accent: '#8d949c', trim: '#2b3036' }, { glow: [0.5, 0.65, 1] });
  else if (kind === 'fighter' || kind === 'hostileFighter') api = buildFighter({ body: '#4a4d52', accent: '#a82a24', trim: '#2d3034' });
  else api = buildFighter(paintOverride);
  if (kind === 'fighter' || kind === 'elite' || kind === 'scout' || kind === 'transport') {
    const lod = new THREE.LOD(); lod.addLevel(api.group, 0); lod.addLevel(lowPoly(kind === 'transport' ? 0xcccccc : 0x333333), 3500);
    api.root = lod;
  } else api.root = api.group;
  return api;
}

export function buildMissileMesh() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3.0, 8), std(0xe6e6dc, { roughness: 0.4 })); body.rotation.x = Math.PI / 2; g.add(body);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.5, 8), std(0x2a2d31)); nose.rotation.x = -Math.PI / 2; nose.position.z = -1.7; g.add(nose);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.02, 0.45), std(0x2a2d31)); fin.position.z = 1.2; g.add(fin);
  const fin2 = fin.clone(); fin2.rotation.z = Math.PI / 2; g.add(fin2);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.2, 3.5, 8, 1, true), additive(0xffb050, 0.9)); flame.geometry.rotateX(Math.PI / 2); flame.geometry.translate(0, 0, 1.75); flame.position.z = 1.6; g.add(flame);
  return g;
}

/** GLB hook: call with a GLTF scene to replace procedural parts by node name. */
export async function loadAircraftModel(url, onFallback) {
  try {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    return (await new GLTFLoader().loadAsync(url)).scene;
  } catch (e) { onFallback?.(e); return null; }
}
