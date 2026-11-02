// Navigation for enemy agents: visibility graph over padded cover corners, A*, string-pulling, circle-vs-OBB slide.
import { segBox2, insideBox2, cvWorld } from '../math.js';

export const AGENT_R = 34;        // collision radius (hard resolve)
export const NAV_PAD = 40;        // planning clearance, > AGENT_R so planned paths never graze a collider
const CORNER_PAD = NAV_PAD + 5;   // waypoint offset, outside the tested pad so segments touching it stay clear

let G = null;   // { covers, nodes: [{x,z}], adj: [[j,d]...] }

function clearSeg(ax, az, bx, bz, covers, pad = NAV_PAD) {
  for (const cv of covers) if (segBox2(ax, az, bx, bz, cv, pad) >= 0) return false;
  return true;
}
function blockedPoint(x, z, covers, pad = NAV_PAD) {
  for (const cv of covers) if (insideBox2(x, z, cv, pad)) return true;
  return false;
}
function build(covers) {
  const nodes = [];
  for (const cv of covers) for (const [sx, sz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
    const p = cvWorld(cv, sx * (cv.hx + CORNER_PAD), sz * (cv.hz + CORNER_PAD));
    if (!blockedPoint(p.x, p.z, covers)) nodes.push({ x: p.x, z: p.z });
  }
  const adj = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    if (!clearSeg(a.x, a.z, b.x, b.z, covers)) continue;
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    adj[i].push([j, d]); adj[j].push([i, d]);
  }
  return { covers, nodes, adj };
}
export function navInit(covers, pts = []) {
  if (G && G.covers === covers && G.n === covers.length) return G;
  G = build(covers); G.n = covers.length;
  for (const cp of pts) {   // cover spots sitting inside another box's footprint are unreachable
    cp.bad = blockedPoint(cp.pos.x, cp.pos.z, covers, AGENT_R + 2) || (cp.peek ? blockedPoint(cp.peek.x, cp.peek.z, covers, AGENT_R + 2) : false);
  }
  return G;
}

// Nearest point outside every padded footprint (used for start/goal that fall inside one).
export function pushOutPad(x, z, covers, pad = NAV_PAD + 1) {
  for (let it = 0; it < 4; it++) {
    let moved = false;
    for (const cv of covers) {
      const ox = x - cv.c.x, oz = z - cv.c.z, c = cv.cos, s = cv.sin;
      let lx = ox * c - oz * s, lz = ox * s + oz * c;
      const px = cv.hx + pad - Math.abs(lx), pz = cv.hz + pad - Math.abs(lz);
      if (px <= 0 || pz <= 0) continue;
      if (px < pz) lx = (lx < 0 ? -1 : 1) * (cv.hx + pad); else lz = (lz < 0 ? -1 : 1) * (cv.hz + pad);
      x = cv.c.x + lx * c + lz * s; z = cv.c.z - lx * s + lz * c; moved = true;
    }
    if (!moved) break;
  }
  return [x, z];
}

// Returns waypoints [{x,z}] from `from` (excluded) to `to` (included). Falls back to the straight line if no route.
export function findPath(fx, fz, tx, tz, covers) {
  const g = navInit(covers);
  [fx, fz] = pushOutPad(fx, fz, covers);
  const goalFree = pushOutPad(tx, tz, covers, NAV_PAD - 4);
  const gx = goalFree[0], gz = goalFree[1];
  if (clearSeg(fx, fz, gx, gz, covers, NAV_PAD - 2)) return [{ x: gx, z: gz }];
  const n = g.nodes.length, S = n, T = n + 1;
  const px = i => i === S ? fx : i === T ? gx : g.nodes[i].x, pz = i => i === S ? fz : i === T ? gz : g.nodes[i].z;
  const dist = new Float64Array(n + 2).fill(Infinity), prev = new Int32Array(n + 2).fill(-1), done = new Uint8Array(n + 2);
  const startVis = [], goalVis = new Map();
  for (let i = 0; i < n; i++) {
    if (clearSeg(fx, fz, g.nodes[i].x, g.nodes[i].z, covers)) startVis.push(i);
    if (clearSeg(g.nodes[i].x, g.nodes[i].z, gx, gz, covers)) goalVis.set(i, Math.hypot(g.nodes[i].x - gx, g.nodes[i].z - gz));
  }
  const h = i => Math.hypot(px(i) - gx, pz(i) - gz);
  dist[S] = 0;
  const open = [[h(S), S]];
  while (open.length) {
    let bi = 0; for (let k = 1; k < open.length; k++) if (open[k][0] < open[bi][0]) bi = k;
    const [, u] = open.splice(bi, 1)[0];
    if (done[u]) continue; done[u] = 1;
    if (u === T) break;
    const relax = (v, w) => { const nd = dist[u] + w; if (nd < dist[v]) { dist[v] = nd; prev[v] = u; open.push([nd + h(v), v]); } };
    if (u === S) for (const i of startVis) relax(i, Math.hypot(g.nodes[i].x - fx, g.nodes[i].z - fz));
    else { for (const [v, w] of g.adj[u]) relax(v, w); const gw = goalVis.get(u); if (gw !== undefined) relax(T, gw); }
  }
  if (prev[T] < 0) return [{ x: gx, z: gz }];
  const ids = []; for (let i = T; i >= 0; i = prev[i]) ids.push(i);
  ids.reverse();
  // string-pulling: drop any waypoint the agent can already see past
  const pts = ids.map(i => ({ x: px(i), z: pz(i) })), out = [];
  let cur = 0;
  while (cur < pts.length - 1) {
    let nx = cur + 1;
    for (let k = pts.length - 1; k > cur + 1; k--) if (clearSeg(pts[cur].x, pts[cur].z, pts[k].x, pts[k].z, covers, NAV_PAD - 2)) { nx = k; break; }
    out.push(pts[nx]); cur = nx;
  }
  return out;
}
export const pathClear = (ax, az, bx, bz, covers, pad = NAV_PAD - 2) => clearSeg(ax, az, bx, bz, covers, pad);

// Circle (radius r) vs oriented boxes: push out along the true contact normal (rounded corners) and
// strip the inward velocity component so the agent slides along the wall. Returns true if any contact.
export function resolveCircle(pos, vel, covers, r = AGENT_R) {
  let hit = false;
  for (let pass = 0; pass < 2; pass++) {
    let any = false;
    for (const cv of covers) {
      const ox = pos.x - cv.c.x, oz = pos.z - cv.c.z, c = cv.cos, s = cv.sin;
      const lx = ox * c - oz * s, lz = ox * s + oz * c;
      const cx = lx < -cv.hx ? -cv.hx : lx > cv.hx ? cv.hx : lx, cz = lz < -cv.hz ? -cv.hz : lz > cv.hz ? cv.hz : lz;
      let dx = lx - cx, dz = lz - cz, d = Math.hypot(dx, dz), nx, nz, push;
      if (d > 1e-6) { if (d >= r) continue; nx = dx / d; nz = dz / d; push = r - d; }
      else {   // centre inside the box: exit through the nearest face
        const ex = cv.hx - Math.abs(lx), ez = cv.hz - Math.abs(lz);
        if (ex < ez) { nx = lx < 0 ? -1 : 1; nz = 0; push = ex + r; } else { nx = 0; nz = lz < 0 ? -1 : 1; push = ez + r; }
      }
      const wnx = nx * c + nz * s, wnz = -nx * s + nz * c;
      pos.x += wnx * push; pos.z += wnz * push;
      if (vel) { const vn = vel.x * wnx + vel.z * wnz; if (vn < 0) { vel.x -= vn * wnx; vel.z -= vn * wnz; } }
      any = hit = true;
    }
    if (!any) break;
  }
  return hit;
}
