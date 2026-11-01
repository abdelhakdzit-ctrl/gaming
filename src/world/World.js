import * as THREE from 'three';
import { clamp } from '../core/math.js';

// Arena geometry, collision, raycasting, navigation grid and cover points.
// Everything is axis-aligned boxes: simple, fast, and easy to extend (addBox / addPrefab).
export class World {
  constructor(scene, { half = 28, cell = 0.5 } = {}) {
    this.scene = scene; this.half = half; this.cell = cell;
    this.colliders = [];
    this.group = new THREE.Group(); scene.add(this.group);
    this.mats = {
      wall: this.mat('#6d7178', 0x6d7178), crate: this.mat('#8a6a3d', 0x8a6a3d, true), low: this.mat('#7e8a6a', 0x7e8a6a),
      concrete: this.mat('#9a9a96', 0x9a9a96), metal: this.mat('#4a5560', 0x4a5560),
    };
    this.buildGround();
    this.buildLevel();
    this.buildNav();
    this.buildCover();
  }
  mat(css, color, crate = false) {
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
    g.fillStyle = css; g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(${Math.random() < .5 ? '0,0,0' : '255,255,255'},${Math.random() * 0.07})`; g.fillRect(Math.random() * 128, Math.random() * 128, 2 + Math.random() * 8, 2 + Math.random() * 8); }
    g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 3;
    if (crate) { g.strokeRect(2, 2, 124, 124); g.beginPath(); g.moveTo(2, 2); g.lineTo(126, 126); g.moveTo(126, 2); g.lineTo(2, 126); g.stroke(); }
    else { for (let y = 0; y <= 128; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(128, y); g.stroke(); } }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.85 });
  }
  buildGround() {
    const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
    g.fillStyle = '#5b6155'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2500; i++) { g.fillStyle = `rgba(${Math.random() < .5 ? '0,0,0' : '255,255,255'},${Math.random() * 0.06})`; g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 5, 1 + Math.random() * 5); }
    g.strokeStyle = 'rgba(0,0,0,.25)'; g.strokeRect(0, 0, 256, 256);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(this.half * 2 / 4, this.half * 2 / 4); t.anisotropy = 8;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(this.half * 2 + 40, this.half * 2 + 40), new THREE.MeshStandardMaterial({ map: t, roughness: 1 }));
    t.repeat.set((this.half * 2 + 40) / 4, (this.half * 2 + 40) / 4);
    m.rotation.x = -Math.PI / 2; m.receiveShadow = true; this.group.add(m); this.ground = m;
  }
  // x,z = center; w,d = size; h = height. flags: cover (AI uses), vault (player can vault), wall
  addBox(x, z, w, d, h, { mat = 'wall', cover = true, vault = false, y0 = 0 } = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.mats[mat]);
    mesh.position.set(x, y0 + h / 2, z); mesh.castShadow = mesh.receiveShadow = true;
    const m = this.mats[mat].map; // scale texture to size
    mesh.material = this.mats[mat].clone(); mesh.material.map = m.clone(); mesh.material.map.needsUpdate = true; mesh.material.map.repeat.set(Math.max(1, Math.round(Math.max(w, d) / 2)), Math.max(1, Math.round(h / 2)));
    this.group.add(mesh);
    const col = { min: new THREE.Vector3(x - w / 2, y0, z - d / 2), max: new THREE.Vector3(x + w / 2, y0 + h, z + d / 2), mesh, cover, vault, h: y0 + h };
    this.colliders.push(col); return col;
  }
  buildLevel() {
    const H = this.half;
    // boundary
    this.addBox(0, -H - 0.5, H * 2 + 2, 1, 4, { mat: 'wall', cover: false });
    this.addBox(0, H + 0.5, H * 2 + 2, 1, 4, { mat: 'wall', cover: false });
    this.addBox(-H - 0.5, 0, 1, H * 2, 4, { mat: 'wall', cover: false });
    this.addBox(H + 0.5, 0, 1, H * 2, 4, { mat: 'wall', cover: false });
    // central compound with two entrances
    this.addBox(-6, 6, 8, 0.6, 3, { mat: 'concrete' }); this.addBox(6, 6, 8, 0.6, 3, { mat: 'concrete' });
    this.addBox(-10, 0, 0.6, 12, 3, { mat: 'concrete' }); this.addBox(10, 0, 0.6, 12, 3, { mat: 'concrete' });
    this.addBox(-7, -6, 6, 0.6, 3, { mat: 'concrete' }); this.addBox(7, -6, 6, 0.6, 3, { mat: 'concrete' });
    this.addBox(0, 0, 2.2, 2.2, 1.2, { mat: 'crate', vault: true });
    this.addBox(-4, -2, 1.2, 1.2, 1.0, { mat: 'crate', vault: true }); this.addBox(4, 2.5, 1.2, 1.2, 1.0, { mat: 'crate', vault: true });
    // low walls (vaultable half-cover)
    const lows = [[-16, 10, 6, 0.5], [16, 10, 6, 0.5], [-16, -10, 6, 0.5], [16, -10, 6, 0.5], [0, 16, 8, 0.5], [0, -16, 8, 0.5], [-20, 0, 0.5, 7], [20, 0, 0.5, 7]];
    for (const [x, z, w, d] of lows) this.addBox(x, z, w, d, 1.0, { mat: 'low', vault: true });
    // crate clusters
    const crates = [[-13, 18, 1.6], [-11.2, 18.2, 1.3], [12, 19, 1.8], [13.8, 18, 1.4], [-22, -18, 1.6], [-20, -19.5, 1.2], [21, -17, 1.7], [18, -21, 1.5], [-3, 21, 1.4], [8, -22, 1.6], [-8, -21, 1.5], [24, 2, 1.8], [-24, 8, 1.6]];
    for (const [x, z, s] of crates) this.addBox(x, z, s, s, s * 0.9 + 0.2, { mat: 'crate', vault: s * 0.9 + 0.2 < 1.3 });
    // tall pillars / tanks
    for (const [x, z] of [[-14, 0], [14, 0], [0, 11], [0, -11], [-22, 18], [22, 20]]) this.addBox(x, z, 1.4, 1.4, 3.2, { mat: 'metal' });
  }

  // ----- collision -----
  moveCircle(pos, dx, dz, r, ignore) {
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.2));
    for (let i = 0; i < steps; i++) { pos.x += dx / steps; pos.z += dz / steps; this.pushOut(pos, r, ignore); }
    const lim = this.half - r; pos.x = clamp(pos.x, -lim, lim); pos.z = clamp(pos.z, -lim, lim);
  }
  pushOut(pos, r, ignore) {
    for (const c of this.colliders) {
      if (ignore?.has(c) || c.h < 0.4 || pos.y > c.h) continue;
      const cx = clamp(pos.x, c.min.x, c.max.x), cz = clamp(pos.z, c.min.z, c.max.z);
      let ox = pos.x - cx, oz = pos.z - cz; const d2 = ox * ox + oz * oz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-8) { const d = Math.sqrt(d2), k = (r - d) / d; pos.x += ox * k; pos.z += oz * k; }
      else { // center inside box: exit by shortest axis
        const l = pos.x - c.min.x, rr = c.max.x - pos.x, t = pos.z - c.min.z, b = c.max.z - pos.z, m = Math.min(l, rr, t, b);
        if (m === l) pos.x = c.min.x - r; else if (m === rr) pos.x = c.max.x + r; else if (m === t) pos.z = c.min.z - r; else pos.z = c.max.z + r;
      }
    }
  }
  pointBlocked(x, z, r = 0.4, minH = 0.5) {
    for (const c of this.colliders) { if (c.h < minH) continue; const cx = clamp(x, c.min.x, c.max.x), cz = clamp(z, c.min.z, c.max.z); if ((x - cx) ** 2 + (z - cz) ** 2 < r * r) return true; }
    return Math.abs(x) > this.half - r || Math.abs(z) > this.half - r;
  }
  // Low obstacle directly ahead that can be vaulted.
  vaultTarget(pos, fwd) {
    const o = new THREE.Vector3(pos.x, 0.7, pos.z);
    const hit = this.raycast(o, fwd, 1.6, c => c.vault);
    if (!hit) return null;
    const c = hit.collider, depth = Math.abs(fwd.x) > Math.abs(fwd.z) ? c.max.x - c.min.x : c.max.z - c.min.z;
    if (depth > 3 || c.h > 1.4) return null;
    const far = hit.point.clone().addScaledVector(fwd, Math.min(depth, 2.4) + 0.9);
    if (this.pointBlocked(far.x, far.z, 0.35)) return null;
    return hit;
  }

  // ----- raycast (slab test) -----
  raycast(origin, dir, maxDist = 200, filter) {
    let best = null;
    for (const c of this.colliders) {
      if (filter && !filter(c)) continue;
      let tmin = 0, tmax = maxDist, n = null;
      for (const ax of ['x', 'y', 'z']) {
        const o = origin[ax], d = dir[ax];
        if (Math.abs(d) < 1e-9) { if (o < c.min[ax] || o > c.max[ax]) { tmax = -1; break; } continue; }
        let t1 = (c.min[ax] - o) / d, t2 = (c.max[ax] - o) / d, sign = -1;
        if (t1 > t2) { [t1, t2] = [t2, t1]; sign = 1; }
        if (t1 > tmin) { tmin = t1; n = [ax, sign]; }
        tmax = Math.min(tmax, t2); if (tmin > tmax) break;
      }
      if (tmax < tmin || tmax < 0) continue;
      if (!best || tmin < best.dist) best = { dist: tmin, collider: c, axis: n };
    }
    if (dir.y < 0) { const t = -origin.y / dir.y; if (t > 0 && t < maxDist && (!best || t < best.dist)) best = { dist: t, collider: null, axis: ['y', 1] }; }
    if (!best) return null;
    best.point = origin.clone().addScaledVector(dir, best.dist);
    const nrm = new THREE.Vector3();
    if (best.axis) nrm[best.axis[0]] = best.axis[1];
    best.normal = nrm;
    return best;
  }
  hasLOS(a, b) {
    const d = b.clone().sub(a), len = d.length(); if (len < 0.01) return true;
    d.divideScalar(len);
    const h = this.raycast(a, d, len - 0.05); return !h || !h.collider;
  }

  // ----- navigation -----
  buildNav() {
    const n = Math.ceil(this.half * 2 / this.cell); this.n = n; this.blocked = new Uint8Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const [x, z] = this.cellCenter(i, j); if (this.pointBlocked(x, z, 0.5)) this.blocked[j * n + i] = 1; }
  }
  cellCenter(i, j) { return [-this.half + (i + 0.5) * this.cell, -this.half + (j + 0.5) * this.cell]; }
  toCell(x, z) { return [clamp(Math.floor((x + this.half) / this.cell), 0, this.n - 1), clamp(Math.floor((z + this.half) / this.cell), 0, this.n - 1)]; }
  nearestFree(i, j) {
    if (!this.blocked[j * this.n + i]) return [i, j];
    for (let r = 1; r < 12; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue; const a = i + di, b = j + dj;
      if (a >= 0 && b >= 0 && a < this.n && b < this.n && !this.blocked[b * this.n + a]) return [a, b];
    }
    return [i, j];
  }
  findPath(from, to) {
    const n = this.n; let [si, sj] = this.nearestFree(...this.toCell(from.x, from.z)), [ti, tj] = this.nearestFree(...this.toCell(to.x, to.z));
    const idx = (i, j) => j * n + i, start = idx(si, sj), goal = idx(ti, tj);
    const g = new Float32Array(n * n).fill(1e9), prev = new Int32Array(n * n).fill(-1), closed = new Uint8Array(n * n);
    const heap = [[0, start]]; g[start] = 0;
    const push = it => { heap.push(it); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    const h = (i, j) => Math.hypot(i - ti, j - tj);
    let found = false, guard = 0;
    while (heap.length && guard++ < 6000) {
      const [, cur] = pop(); if (closed[cur]) continue; closed[cur] = 1;
      if (cur === goal) { found = true; break; }
      const ci = cur % n, cj = (cur / n) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue; const a = ci + di, b = cj + dj; if (a < 0 || b < 0 || a >= n || b >= n) continue;
        const k = idx(a, b); if (this.blocked[k] || closed[k]) continue;
        if (di && dj && (this.blocked[idx(ci + di, cj)] || this.blocked[idx(ci, cj + dj)])) continue;
        const ng = g[cur] + (di && dj ? 1.414 : 1); if (ng < g[k]) { g[k] = ng; prev[k] = cur; push([ng + h(a, b), k]); }
      }
    }
    if (!found) return null;
    const pts = []; for (let c = goal; c !== -1; c = prev[c]) { const [x, z] = this.cellCenter(c % n, (c / n) | 0); pts.push(new THREE.Vector3(x, 0, z)); }
    pts.reverse();
    // string-pull: skip waypoints reachable in a straight, clear line
    const out = [pts[0]]; let a = 0;
    while (a < pts.length - 1) { let b = pts.length - 1; while (b > a + 1 && !this.walkable(pts[a], pts[b])) b--; out.push(pts[b]); a = b; }
    out.shift(); return out;
  }
  walkable(a, b) {
    const d = b.clone().sub(a), len = d.length(), steps = Math.ceil(len / 0.25);
    for (let i = 1; i <= steps; i++) { const p = a.clone().addScaledVector(d, i / steps); const [ci, cj] = this.toCell(p.x, p.z); if (this.blocked[cj * this.n + ci]) return false; }
    return true;
  }

  // ----- cover points -----
  buildCover() {
    this.coverPoints = [];
    for (const c of this.colliders) {
      if (!c.cover) continue;
      const off = 0.8, step = 1.8;
      const w = c.max.x - c.min.x, d = c.max.z - c.min.z;
      const side = (fixed, from, to, horizontal, nx, nz) => {
        const len = to - from, n = Math.max(1, Math.floor(len / step));
        for (let i = 0; i < n; i++) {
          const t = from + (i + 0.5) * len / n;
          const x = horizontal ? t : fixed, z = horizontal ? fixed : t;
          if (!this.pointBlocked(x, z, 0.45)) this.coverPoints.push({ pos: new THREE.Vector3(x, 0, z), normal: new THREE.Vector3(nx, 0, nz), collider: c, low: c.h < 1.4, taken: null });
        }
      };
      side(c.min.z - off, c.min.x, c.max.x, true, 0, -1); side(c.max.z + off, c.min.x, c.max.x, true, 0, 1);
      side(c.min.x - off, c.min.z, c.max.z, false, -1, 0); side(c.max.x + off, c.min.z, c.max.z, false, 1, 0);
    }
  }
  // Is `p` hidden from `threat`? low covers hide a crouching body only.
  coverQuality(p, threat, crouchHeight = 0.75) {
    const eyeY = p.low ? crouchHeight : 1.55;
    const a = new THREE.Vector3(threat.x, 1.5, threat.z), b = new THREE.Vector3(p.pos.x, eyeY, p.pos.z);
    return this.hasLOS(a, b) ? 0 : 1;
  }
}
