import * as THREE from 'three';

// Procedural aircraft. Everything is built from named parts so a GLB can later replace the
// geometry: loadAircraftModel(url) swaps meshes by node name (fuselage, wing_l, aileron_l, ...).
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

/** Lofted solid: stations = [z, halfWidth, top, bottom]; superellipse cross-section keeps the hull smooth without giant polygons. */
function loft(stations, { n = 20, exp = 2.4, capFront = false, capBack = false } = {}) {
  const pos = [], idx = [];
  for (const [z, w, top, bot] of stations) {
    for (let i = 0; i < n; i++) {
      const th = (i / n) * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
      pos.push(w * Math.sign(c) * Math.pow(Math.abs(c), 2 / exp), (s >= 0 ? top : bot) * Math.sign(s) * Math.pow(Math.abs(s), 2 / exp), z);
    }
  }
  for (let r = 0; r < stations.length - 1; r++) for (let i = 0; i < n; i++) {
    const a0 = r * n + i, a1 = r * n + ((i + 1) % n), b0 = (r + 1) * n + i, b1 = (r + 1) * n + ((i + 1) % n);
    idx.push(a0, a1, b0, a1, b1, b0);
  }
  const cap = (row, z, flip) => { const ci = pos.length / 3; pos.push(0, (stations[row][2] - stations[row][3]) * 0.5 * 0, z); for (let i = 0; i < n; i++) { const a0 = row * n + i, a1 = row * n + ((i + 1) % n); flip ? idx.push(ci, a1, a0) : idx.push(ci, a0, a1); } };
  if (capFront) cap(0, stations[0][0], false);
  if (capBack) cap(stations.length - 1, stations[stations.length - 1][0], true);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
}
/** Flat plate from (x, z) outline, thickness along y, centred. */
function plate(pts, thick, pivotZ = 0) {
  const g = shapeGeo(pts.map(([x, z]) => [x, -(z)]), thick); if (pivotZ) g.translate(0, 0, -pivotZ); return g;
}
let glowTex;
const glowSprite = (color, size) => {
  if (!glowTex) { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.4)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gr; x.fillRect(0, 0, 64, 64); glowTex = new THREE.CanvasTexture(c); }
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.6 })); s.scale.setScalar(size); return s;
};

export function buildFighter(paint = { body: '#8f8a7a', accent: '#2f6b3a', trim: '#d9d4c3' }, { glow = [1, 0.55, 0.2] } = {}) {
  const g = new THREE.Group(); g.name = 'fighter';
  const body = std(paint.body, { metalness: 0.25, roughness: 0.55 }), accent = std(paint.accent, { roughness: 0.6 }), trim = std(paint.trim, { roughness: 0.65 });
  const dark = std(0x14171a, { roughness: 0.65, metalness: 0.5 });
  const parts = { body, accent, trim };

  // fuselage: pointed radome, cockpit hump, broad mid-section for the intakes/wing blend, tapered tail
  const fus = new THREE.Mesh(loft([[-9.2, 0.04, 0.04, 0.04], [-8.2, 0.34, 0.32, 0.28], [-6.6, 0.62, 0.55, 0.46], [-4.6, 0.86, 0.78, 0.62], [-2.4, 1.08, 0.86, 0.72], [0.4, 1.3, 0.8, 0.78], [3.6, 1.28, 0.78, 0.74], [6.4, 1.1, 0.7, 0.66], [8.4, 0.9, 0.6, 0.58], [8.9, 0.82, 0.54, 0.52]], { capBack: true }), body);
  fus.name = 'fuselage'; g.add(fus);
  const nose = new THREE.Mesh(loft([[-9.2, 0.04, 0.04, 0.04], [-8.6, 0.22, 0.2, 0.18], [-7.6, 0.45, 0.4, 0.34]], { n: 16 }), dark); g.add(nose);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshStandardMaterial({ color: 0x0b1a26, metalness: 0.95, roughness: 0.06, transparent: true, opacity: 0.9 }));
  canopy.scale.set(0.52, 0.5, 2.1); canopy.position.set(0, 0.86, -3.7); canopy.name = 'canopy'; g.add(canopy);
  const spine = new THREE.Mesh(loft([[-1.4, 0.05, 0.05, 0.05], [0, 0.45, 0.28, 0.1], [3.5, 0.5, 0.3, 0.1], [6.8, 0.3, 0.2, 0.1]], { n: 12 }), body); spine.position.y = 0.7; g.add(spine);

  // intake pods
  for (const sx of [-1, 1]) {
    const pod = new THREE.Mesh(loft([[-2.7, 0.5, 0.52, 0.42], [-1.6, 0.58, 0.58, 0.48], [1.2, 0.6, 0.58, 0.5], [3.4, 0.4, 0.4, 0.36]], { n: 16, exp: 2.8 }), body);
    pod.position.set(sx * 1.2, -0.3, 0); g.add(pod);
    const mouth = new THREE.Mesh(new THREE.CircleGeometry(0.45, 14), dark); mouth.scale.set(1, 0.95, 1); mouth.position.set(sx * 1.2, -0.3, -2.72); mouth.rotation.y = Math.PI; g.add(mouth);
  }

  // swept wings with leading-edge extensions
  const wingGeo = plate([[1.1, -0.6], [6.7, 3.6], [6.7, 4.9], [1.1, 6.4]], 0.16), lexGeo = plate([[0.9, -5.4], [1.9, -0.6], [0.9, -0.6]], 0.1);
  const ailGeo = new THREE.BoxGeometry(2.7, 0.07, 0.95); ailGeo.translate(0, 0, 0.47); ailGeo.applyMatrix4(new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, -0.268, 0, 1, 0, 0, 0, 0, 1));
  const ail = {};
  for (const [side, sx] of [['r', 1], ['l', -1]]) {
    const w = new THREE.Mesh(wingGeo, body); w.scale.x = sx; w.position.y = -0.1; w.name = 'wing_' + side; g.add(w);
    const lex = new THREE.Mesh(lexGeo, body); lex.scale.x = sx; lex.position.y = 0.02; g.add(lex);
    const stripe = new THREE.Mesh(plate([[5.6, 3.0], [6.7, 3.6], [6.7, 4.0], [5.5, 3.5]], 0.17), accent); stripe.scale.x = sx; stripe.position.y = -0.1; g.add(stripe);
    const a = new THREE.Group(); a.position.set(sx * 5.0, -0.1, 4.46); a.name = 'aileron_' + side; a.add(new THREE.Mesh(ailGeo, accent)); g.add(a); ail[side] = a;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshBasicMaterial({ color: sx > 0 ? 0x30ff60 : 0xff3030 })); tip.position.set(sx * 6.75, -0.1, 4.3); g.add(tip);
    for (const px of [3.0, 4.8]) { const pyl = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.4, 1.6), dark); pyl.position.set(sx * px, -0.38, 2.6 - (px - 3) * 0.3); g.add(pyl); }
  }
  // stabilators
  const stabGeo = plate([[0, 0.0], [2.9, 1.6], [2.9, 2.4], [0, 2.6]], 0.1, 0); const elev = {};
  for (const [side, sx] of [['r', 1], ['l', -1]]) { const e = new THREE.Group(); e.position.set(sx * 1.05, -0.05, 6.6); e.name = 'elevator_' + side; const m = new THREE.Mesh(stabGeo, trim); m.scale.x = sx; e.add(m); g.add(e); elev[side] = e; }
  // twin canted fins + rudders
  const finGeo = new THREE.ExtrudeGeometry((() => { const s = new THREE.Shape(); s.moveTo(0, 0); s.lineTo(3.0, 0); s.lineTo(2.55, 2.25); s.lineTo(1.35, 2.25); s.closePath(); return s; })(), { depth: 0.1, bevelEnabled: false });
  finGeo.rotateY(-Math.PI / 2); finGeo.translate(0.05, 0, 0);
  const rudGeo = new THREE.ExtrudeGeometry((() => { const s = new THREE.Shape(); s.moveTo(0, 0); s.lineTo(0.7, 0); s.lineTo(0.5, 2.0); s.lineTo(0, 2.0); s.closePath(); return s; })(), { depth: 0.08, bevelEnabled: false });
  rudGeo.rotateY(-Math.PI / 2); rudGeo.translate(0.04, 0, 0);
  const rud = {};
  for (const [side, sx] of [['r', 1], ['l', -1]]) {
    const fg = new THREE.Group(); fg.position.set(sx * 1.1, 0.5, 5.2); fg.rotation.z = -sx * 0.3; fg.name = 'fin_' + side;
    fg.add(new THREE.Mesh(finGeo, body));
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.3, 1.1), accent); band.position.set(0, 2.1, 1.9); fg.add(band);
    const r = new THREE.Group(); r.position.set(0, 0.05, 3.0); r.name = 'rudder_' + side; r.add(new THREE.Mesh(rudGeo, accent)); fg.add(r); g.add(fg); rud[side] = r;
  }
  // engines: nozzle, glow disc, thin flame
  const glowMeshes = [], nozzleGeo = new THREE.CylinderGeometry(0.5, 0.42, 1.3, 16, 1, true); nozzleGeo.rotateX(Math.PI / 2);
  for (const sx of [-1, 1]) {
    const n = new THREE.Mesh(nozzleGeo, dark); n.position.set(sx * 0.55, 0, 9.3); n.material = std(0x24282c, { metalness: 0.7, roughness: 0.4, side: THREE.DoubleSide }); g.add(n);
    const flame = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.02, 3.4, 10, 1, true), additive(new THREE.Color(...glow), 0.5)); flame.geometry.rotateX(Math.PI / 2); flame.geometry.translate(0, 0, 1.7); flame.position.set(sx * 0.55, 0, 9.95); g.add(flame);
    const core = glowSprite(0xffe2b0, 1.5); core.position.set(sx * 0.55, 0, 9.96); g.add(core);
    glowMeshes.push({ flame, core });
  }
  // airbrake
  const brake = new THREE.Group(); brake.position.set(0, 0.86, 4.2);
  const bp = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.05, 1.7), accent); bp.position.z = 0.85; brake.add(bp); g.add(brake);

  // missiles on the wing pylons
  const missiles = [], mslGeo = new THREE.CylinderGeometry(0.1, 0.1, 3.0, 8); mslGeo.rotateX(Math.PI / 2);
  const mslNose = new THREE.ConeGeometry(0.1, 0.5, 8); mslNose.rotateX(-Math.PI / 2); mslNose.translate(0, 0, -1.7);
  const mslMat = std(0xdcdcd0, { metalness: 0.2, roughness: 0.5 }), mslTip = std(0x303338);
  const mslFin = new THREE.BoxGeometry(0.55, 0.02, 0.36); mslFin.translate(0, 0, 1.2);
  for (const [sx, px] of [[-1, 3.0], [1, 3.0], [-1, 4.8], [1, 4.8]]) {
    const m = new THREE.Group(); m.position.set(sx * px, -0.8, 2.6 - (px - 3) * 0.3);
    m.add(new THREE.Mesh(mslGeo, mslMat), new THREE.Mesh(mslNose, mslTip), new THREE.Mesh(mslFin, mslTip));
    const cross = new THREE.Mesh(mslFin, mslTip); cross.rotation.z = Math.PI / 2; m.add(cross);
    g.add(m); missiles.push(m);
  }

  return {
    group: g, parts, missiles, kind: 'fighter',
    setControls({ pitch = 0, roll = 0, yaw = 0, brake: br = 0, throttle = 0.5 }, time = 0) {
      elev.r.rotation.x = elev.l.rotation.x = -pitch * 0.35;
      ail.r.rotation.x = -roll * 0.4; ail.l.rotation.x = roll * 0.4;
      rud.r.rotation.y = rud.l.rotation.y = -yaw * 0.4;
      brake.rotation.x = -br * 0.9;
      const flick = 0.92 + Math.sin(time * 55) * 0.06;
      for (const { flame, core } of glowMeshes) { flame.scale.set(0.8 + throttle * 0.3, 0.8 + throttle * 0.3, (0.15 + throttle * 0.85) * flick); flame.material.opacity = 0.1 + throttle * 0.4; core.material.opacity = 0.2 + throttle * 0.5; core.scale.setScalar(0.9 + throttle * 1.0); }
    },
    setMissilesMounted(count) { missiles.forEach((m, i) => { m.visible = i < count; }); },
    setPaint(p) { body.color.set(p.body); accent.color.set(p.accent); trim.color.set(p.trim); },
    setCockpitVisible(v) { fus.visible = v; canopy.visible = v; }
  };
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

const box = (w, h, d, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); return m; };
const cyl = (rt, rb, h, mat, x = 0, y = 0, z = 0, seg = 14) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat); m.position.set(x, y, z); return m; };
function blinkLight(color, size = 5) { const s = glowSprite(color, size); return s; }

export function buildHelicopter() {
  const g = new THREE.Group(), body = std(0xd8d2c0, { roughness: 0.6 }), red = std(0xb82a24), dark = std(0x1b1f23, { roughness: 0.7 });
  const fus = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), body); fus.scale.set(1.35, 1.35, 3.2); g.add(fus);
  const glass = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0b1a26, metalness: 0.9, roughness: 0.1 })); glass.scale.set(1.0, 0.9, 1.4); glass.position.set(0, 0.35, -2.2); g.add(glass);
  g.add(box(0.35, 0.4, 6.4, body, 0, 0.5, 5.4)); g.add(box(0.15, 1.8, 1.2, red, 0, 1.3, 8.4)); g.add(box(2.2, 0.12, 0.7, body, 0, 0.6, 8.0));
  for (const sx of [-1, 1]) { g.add(box(0.12, 0.12, 4.4, dark, sx * 1.3, -1.55, -0.4)); g.add(box(0.1, 0.9, 0.1, dark, sx * 1.2, -1.1, -1.8)); g.add(box(0.1, 0.9, 0.1, dark, sx * 1.2, -1.1, 1.0)); }
  g.add(cyl(0.18, 0.18, 0.7, dark, 0, 1.55, 0.2, 8));
  const rotor = new THREE.Group(); rotor.position.y = 1.95; for (let i = 0; i < 4; i++) { const b = box(9.5, 0.06, 0.4, dark, 0, 0, 0); b.position.x = 0; b.rotation.y = (i * Math.PI) / 2; b.geometry.translate(4.7, 0, 0); rotor.add(b); } g.add(rotor);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(9.6, 24), additive(0xffffff, 0.06)); disc.rotation.x = -Math.PI / 2; disc.position.y = 1.95; g.add(disc);
  const tail = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.06, 6, 14), dark); tail.position.set(0.3, 1.3, 8.6); tail.rotation.y = Math.PI / 2; g.add(tail);
  const strobe = blinkLight(0xff3030, 2.2); strobe.position.set(0, 2.3, 0); g.add(strobe);
  return { group: g, root: g, kind: 'helicopter', setControls(o, time = 0) { rotor.rotation.y = time * 38; tail.rotation.x = time * 40; strobe.visible = Math.sin(time * 5) > 0; }, setMissilesMounted() {}, setPaint() {} };
}

export function buildAirliner() {
  const g = new THREE.Group(), white = std(0xf1f1ec, { roughness: 0.5, metalness: 0.1 }), blue = std(0x2a5fa8), dark = std(0x555b60);
  const fus = new THREE.Mesh(lathe([[0.001, -22], [1.8, -20.5], [3.0, -15], [3.2, -2], [3.2, 12], [2.4, 20], [0.5, 25]], 20), white); g.add(fus);
  const stripe = new THREE.Mesh(lathe([[3.22, -14], [3.22, 14]], 20), blue); stripe.scale.set(1.002, 0.15, 1); stripe.position.y = -0.2; g.add(stripe);
  const wing = new THREE.Mesh(plate([[2.6, -2], [20, 7], [20, 9.4], [2.6, 7.5]], 0.5), white); wing.position.y = -1.5; g.add(wing); const wing2 = wing.clone(); wing2.scale.x = -1; g.add(wing2);
  const stab = new THREE.Mesh(plate([[0.8, 17], [8.5, 21.5], [8.5, 23.5], [0.8, 23]], 0.25), white); stab.position.y = 2.6; g.add(stab); const stab2 = stab.clone(); stab2.scale.x = -1; g.add(stab2);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7.5, 4.8), blue); fin.position.set(0, 6.2, 21); fin.rotation.x = -0.2; g.add(fin);
  for (const sx of [-1, 1]) { g.add(cyl(1.35, 1.2, 4.6, dark, sx * 8.5, -2.7, 0.5, 14)).rotation.x = Math.PI / 2; g.add(cyl(1.4, 1.4, 0.3, std(0x111111), sx * 8.5, -2.7, -1.9, 14)).rotation.x = Math.PI / 2; }
  const nav = blinkLight(0xffffff, 3); nav.position.set(0, 9.6, 22); g.add(nav);
  return { group: g, root: g, kind: 'airliner', setControls(o, time = 0) { nav.visible = Math.sin(time * 6) > 0.4; }, setMissilesMounted() {}, setPaint() {} };
}

/** Ground installations: SAM battery, relay mast, fuel depot, radar site, command node, power plant, truck. */
export function buildGround(kind) {
  const g = new THREE.Group(), sand = std(0xb9ae94, { roughness: 0.9 }), conc = std(0x8d8f8b, { roughness: 0.9 }), dark = std(0x202428, { roughness: 0.7, metalness: 0.4 }), olive = std(0x5d6340, { roughness: 0.8 }), steel = std(0x9aa1a7, { roughness: 0.4, metalness: 0.6 });
  const spinners = []; const blink = [];
  if (kind === 'sam') {
    g.add(box(10, 0.8, 12, olive, 0, 0.4, 0));
    for (let i = 0; i < 4; i++) { const t = box(0.9, 0.9, 7, dark, (i - 1.5) * 1.8, 3.2, 0); t.rotation.x = 0.9; g.add(t); const tip = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.2, 8), std(0xd8d4c4)); tip.position.set((i - 1.5) * 1.8, 5.9, -3.8); tip.rotation.x = -0.9 - Math.PI / 2 + Math.PI; g.add(tip); }
    const dish = new THREE.Group(); dish.position.set(-3.6, 4, 4); dish.add(cyl(0.2, 0.3, 4, dark, 0, -1, 0, 8)); const d = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 0.4, 0.4, 16), steel); d.rotation.x = Math.PI / 2; d.position.set(0, 1.2, -0.4); dish.add(d); g.add(dish); spinners.push(dish);
    g.add(box(3, 2.4, 4, olive, 3.5, 1.6, 4.5)); g.add(cyl(0.12, 0.12, 6, dark, 4.5, 4, 5.5, 6));
  } else if (kind === 'relay') {
    g.add(box(9, 3.5, 7, conc, -8, 1.75, 6)); g.add(box(4, 2.6, 4, sand, -3, 1.3, 10));
    const mast = cyl(0.5, 0.9, 46, steel, 0, 23, 0, 8); g.add(mast);
    for (let i = 0; i < 4; i++) { const arm = box(7, 0.18, 0.18, steel, 0, 12 + i * 8, 0); arm.rotation.y = i * 0.8; g.add(arm); }
    for (const [y, s] of [[38, 3.2], [30, 2.6]]) { const dsh = new THREE.Mesh(new THREE.CylinderGeometry(s, 0.3, 0.5, 18), std(0xdadada)); dsh.rotation.z = Math.PI / 2.2; dsh.position.set(s * 0.9, y, 0); g.add(dsh); }
    const l = blinkLight(0xff2a2a, 7); l.position.y = 47; g.add(l); blink.push(l);
  } else if (kind === 'depot') {
    for (let i = 0; i < 4; i++) g.add(cyl(7, 7, 9, std(0xcfcab8, { roughness: 0.6 }), (i % 2) * 17 - 8.5, 4.5, Math.floor(i / 2) * 17 - 8.5, 20));
    g.add(box(14, 4, 8, conc, 0, 2, 20)); g.add(box(0.6, 0.6, 36, dark, 0, 1, 0)).rotation.y = 0.8;
  } else if (kind === 'radar_site') {
    g.add(box(8, 4, 8, conc, 0, 2, 0)); g.add(cyl(0.7, 1.1, 14, steel, 0, 9, 0, 8));
    const arm = new THREE.Group(); arm.position.y = 17; const ant = box(14, 5, 0.6, steel, 0, 0, 0); arm.add(ant); arm.add(box(0.5, 0.5, 2, dark, 0, -2.4, 0)); g.add(arm); spinners.push(arm);
    g.add(box(4, 2.6, 5, sand, 8, 1.3, 3)); const l = blinkLight(0xff2a2a, 5); l.position.y = 19.5; g.add(l); blink.push(l);
  } else if (kind === 'node') {
    g.add(box(30, 7, 22, conc, 0, 3.5, 0)); g.add(box(22, 3, 16, std(0x6e716d, { roughness: 0.9 }), 0, 8.5, 0));
    g.add(cyl(0.9, 1.4, 60, steel, -9, 30, 0, 8)); for (const [x, z] of [[8, -4], [8, 5]]) { const dsh = new THREE.Mesh(new THREE.CylinderGeometry(5, 0.5, 0.8, 22), std(0xe8e8e8)); dsh.rotation.x = Math.PI / 2.4; dsh.position.set(x, 14, z); g.add(dsh); spinners.push(dsh); }
    g.add(box(8, 3, 6, olive, 22, 1.5, 6)); g.add(box(8, 3, 6, olive, 22, 1.5, -6)); const l = blinkLight(0xff2a2a, 9); l.position.set(-9, 61, 0); g.add(l); blink.push(l);
  } else if (kind === 'plant') {
    g.add(box(34, 12, 18, conc, 0, 6, 0)); for (const x of [-12, 0, 12]) g.add(cyl(5, 7, 24, std(0xc8c6c0, { roughness: 0.8 }), x, 24, -14, 18));
    g.add(box(60, 8, 4, std(0x9a9d98, { roughness: 0.9 }), 0, 4, 18)); g.add(cyl(0.5, 0.5, 30, steel, 18, 15, 4, 6)); const l = blinkLight(0xffffff, 6); l.position.set(18, 31, 4); g.add(l); blink.push(l);
  } else { // truck
    g.add(box(2.8, 0.5, 8, dark, 0, 0.7, 0)); g.add(box(2.7, 2.4, 5, olive, 0, 2.1, 1.3)); g.add(box(2.6, 2.1, 2.1, olive, 0, 1.95, -3)); g.add(box(2.4, 0.9, 0.12, std(0x0b1a26, { metalness: 0.9, roughness: 0.1 }), 0, 2.5, -4.08));
    for (const sx of [-1, 1]) for (const z of [-2.8, 0.4, 3.1]) { const w = cyl(0.62, 0.62, 0.5, dark, sx * 1.4, 0.62, z, 12); w.rotation.z = Math.PI / 2; g.add(w); }
  }
  return { group: g, root: g, kind, setControls(o, time = 0) { for (const s of spinners) s.rotation.y = time * 1.4; for (const l of blink) l.visible = Math.sin(time * 3) > -0.2; }, setMissilesMounted() {}, setPaint() {} };
}

export function buildModel(kind, paintOverride) {
  let api, lodKind = null;
  switch (kind) {
    case 'scout': api = buildScout(); lodKind = 0x333333; break;
    case 'transport': api = buildTransport(); lodKind = 0xcccccc; break;
    case 'elite': api = buildFighter({ body: '#1d2024', accent: '#8d949c', trim: '#2b3036' }, { glow: [0.5, 0.65, 1] }); lodKind = 0x222222; break;
    case 'bomber': api = buildFighter({ body: '#4b3a34', accent: '#a82a24', trim: '#2d2623' }); api.group.scale.setScalar(1.12); lodKind = 0x333333; break;
    case 'courier': api = buildFighter({ body: '#d9dde2', accent: '#2a5fa8', trim: '#9aa5b0' }, { glow: [0.5, 0.75, 1] }); lodKind = 0xdddddd; break;
    case 'fighter': case 'hostileFighter': api = buildFighter({ body: '#4a4d52', accent: '#a82a24', trim: '#2d3034' }); lodKind = 0x333333; break;
    case 'helicopter': return finishRoot(buildHelicopter());
    case 'airliner': api = buildAirliner(); lodKind = 0xeeeeee; break;
    case 'sam': case 'relay': case 'depot': case 'radar_site': case 'node': case 'plant': case 'truck': return finishRoot(buildGround(kind));
    default: api = buildFighter(paintOverride);
  }
  if (lodKind !== null) { const lod = new THREE.LOD(); lod.addLevel(api.group, 0); lod.addLevel(lowPoly(lodKind), kind === 'airliner' ? 6000 : 3500); api.root = lod; } else api.root = api.group;
  return api;
}
const finishRoot = (api) => { api.root = api.group; return api; };

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
