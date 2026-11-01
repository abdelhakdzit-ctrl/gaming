import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DEG, V, clamp, ease, lerp, sstep } from './math.js';
import { BLOCK, STATE, rec } from './state.js';
import { scene } from './scene.js';
import { audio, playSample, playShot } from './audio.js';
import { GRIP_R, _hp, _hq, _hs, bones, handFrame, handRel, orient, restWorldQ, rotateWorld, setWorldQuat, twoBoneIK, worldPos, worldQuat } from './skeleton.js';
import { ejectShell, flash, launchRocket, spawnMuzzleFX } from './fx.js';
import { RLT, startRlTimeline, stopRlTimeline } from './reload-timeline.js';
import { charPos, charVelW, toWorld, toWorldDir } from './locomotion.js';
import { playerAim, tmpM } from './character.js';
import { motionPreview } from './motion-studio.js';
import { AI, onPlayerGunshot } from './ai.js';
import { game, setAimStage, shootRay } from './game.js';
import { addTrauma, bloomKick, spreadMul } from './gameplay/juice.js';
import { capsuleMeshes, restAcross } from './main.js';

// ======================================================================
//  PISTOL — one side profile drives both the mesh and the collision SDF
//  Gun space: +Z muzzle, +Y up, +X = gun's left side, units cm.
// ======================================================================
const FRAME_OUT = [[-1.0, 0.5], [15.0, 0.5], [15.0, -0.9], [8.7, -0.9], [8.45, -2.8], [7.75, -3.45], [4.6, -3.45],
  [3.55, -3.0], [0.47, -11.46], [0.65, -11.5], [0.5, -12.05], [-4.55, -10.2], [-4.5, -9.62], [-4.32, -9.72],
  [-1.62, -2.3], [-2.45, -1.15], [-2.35, -0.35], [-1.6, 0.3]];
const FRAME_HOLE = [[4.85, -0.9], [8.05, -0.9], [7.85, -2.45], [7.35, -2.95], [4.75, -2.95], [4.2, -2.3]];
const TRIGGER = [[6.0, -0.9], [6.4, -0.9], [6.25, -1.7], [5.95, -2.55], [5.55, -2.55], [5.75, -1.7]];
export const TRIGGER_PIVOT = [6.2, -0.9];
export const PMAG_AXIS = V(0, 0.945, 0.326), PMAG_BASE = [-2.0, -11.25];   // grip axis (insert direction), baseplate centre [z, y]
export const TRIGGER_PULL = 18 * DEG;
const SLIDE_OUT = [[-2.0, 0.5], [16.4, 0.5], [16.4, 2.9], [15.9, 3.3], [-1.6, 3.3], [-2.0, 2.9]];
const FRAME_HW = 1.45, SLIDE_HW = 1.27, BEVEL = 0.2;
export const MUZZLE = V(0, 1.9, 16.45), EJECT_PORT = V(-0.7, 3.2, 5.6);
export const SLIDE_TRAVEL = 4.2;
const GUN_S = 1.15;   // the UE mannequin's hands are ~15% larger than a real hand

function sdPoly(px, py, pts) {
  let d = (px - pts[0][0]) ** 2 + (py - pts[0][1]) ** 2, s = 1;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const ex = pts[j][0] - pts[i][0], ey = pts[j][1] - pts[i][1];
    const wx = px - pts[i][0], wy = py - pts[i][1];
    const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    const bx = wx - ex * t, by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = py >= pts[i][1], c2 = py < pts[j][1], c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}
function sdExtrude(d2, x, hw) {
  const wx = d2, wy = Math.abs(x) - hw;
  return Math.min(Math.max(wx, wy), 0) + Math.hypot(Math.max(wx, 0), Math.max(wy, 0));
}
// Signed distance (cm) from a gun-space point to the pistol surface.
function gunSDF(p) {
  const frame = sdExtrude(Math.max(sdPoly(p.z, p.y, FRAME_OUT), -sdPoly(p.z, p.y, FRAME_HOLE)) - BEVEL, p.x, FRAME_HW);
  const slide = sdExtrude(sdPoly(p.z, p.y, SLIDE_OUT) - BEVEL, p.x, SLIDE_HW);
  const trig = sdExtrude(sdPoly(p.z, p.y, TRIGGER), p.x, 0.35);
  return Math.min(frame, slide, trig);
}

function extrudeSide(outline, holes, width, bevel, mat) {
  const s = new THREE.Shape(outline.map(([z, y]) => new THREE.Vector2(z, y)));
  (holes || []).forEach(h => s.holes.push(new THREE.Path(h.map(([z, y]) => new THREE.Vector2(z, y)))));
  const depth = width - 2 * bevel;
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 4 });
  g.rotateY(-Math.PI / 2); g.translate(depth / 2, 0, 0);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true;
  return m;
}
export function box(w, h, d, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.castShadow = true; return m;
}

export function makePistol() {
  const polymer = new THREE.MeshStandardMaterial({ color: 0x202226, roughness: 0.78, metalness: 0.0 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.32, metalness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0a0a0b, roughness: 0.6, metalness: 0.3 });
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x55585c, roughness: 0.25, metalness: 1.0 });

  const gun = new THREE.Group();
  gun.matrixAutoUpdate = false;
  gun.add(extrudeSide(FRAME_OUT, [FRAME_HOLE], FRAME_HW * 2, BEVEL, polymer));
  // grip texture panels
  for (const sx of [-1, 1]) {
    const p = box(0.05, 5.2, 3.6, dark, sx * (FRAME_HW + 0.01), -6.6, -0.7);
    p.rotation.x = 20 * DEG; gun.add(p);
  }
  // slide + details (moves as a unit)
  const slide = new THREE.Group();
  slide.add(extrudeSide(SLIDE_OUT, null, SLIDE_HW * 2, BEVEL, steel));
  slide.add(box(0.5, 0.55, 0.6, steel, 0, 3.55, 15.2));               // front sight
  slide.add(box(2.0, 0.6, 0.7, steel, 0, 3.58, -0.9));                // rear sight
  slide.add(box(0.5, 0.1, 0.1, new THREE.MeshBasicMaterial({ color: 0xffffff }), 0, 3.8, 15.5));
  for (let i = 0; i < 8; i++) for (const sx of [-1, 1])                 // rear serrations
    slide.add(box(0.06, 2.2, 0.18, dark, sx * (SLIDE_HW + 0.02), 1.95, -1.3 + i * 0.42));
  slide.add(box(1.5, 0.08, 3.6, dark, -0.35, 3.31, 5.6));             // ejection port
  slide.add(box(1.2, 0.1, 3.2, barrelMat, -0.35, 3.24, 5.6));          // barrel hood
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.1, 20), dark);
  crown.rotation.x = Math.PI / 2; crown.position.set(0, 1.9, 16.62); slide.add(crown);
  gun.add(slide);
  // trigger on its pivot
  const trigPivot = new THREE.Group();
  trigPivot.position.set(0, TRIGGER_PIVOT[1], TRIGGER_PIVOT[0]);
  const trig = extrudeSide(TRIGGER, null, 0.7, 0.08, polymer);
  trig.position.set(0, -TRIGGER_PIVOT[1], -TRIGGER_PIVOT[0]);
  trigPivot.add(trig); gun.add(trigPivot);
  gun.traverse(o => { if (o.isMesh) o.castShadow = true; });
  // Detachable magazine: body hidden inside the grip, baseplate just proud of the grip bottom.
  const mag = new THREE.Group();
  const A = [PMAG_AXIS.z, PMAG_AXIS.y], Pp = [A[1], -A[0]], B = PMAG_BASE;
  const pt = (u, w) => [B[0] + A[0] * u + Pp[0] * w, B[1] + A[1] * u + Pp[1] * w];
  mag.add(extrudeSide([pt(0, 1.75), pt(9.6, 1.6), pt(9.6, -1.6), pt(0, -1.75)], null, 2.1, 0.1, steel));
  mag.add(extrudeSide([pt(-0.55, 2.35), pt(0.3, 2.3), pt(0.3, -2.25), pt(-0.55, -2.35)], null, 2.6, 0.2, polymer));
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.9, 10), new THREE.MeshStandardMaterial({ color: 0xc8a250, roughness: 0.3, metalness: 1 }));
  const tp = pt(9.9, 0.2); top.position.set(0, tp[1], tp[0]); top.rotation.x = Math.PI / 2 - 0.33; mag.add(top);
  gun.add(mag);
  return { gun, slide, trigPivot, mag };
}

// ======================================================================
//  M4 (GLB)  textured M4 + FPS hand animation pack (assets/glb/m4_fps.glb).
//  Weapon space = the pack's Main_j joint: cm, +Z muzzle, +Y up, -X = shooter's right.
// ======================================================================
export const RIFLE_MUZZLE = V(0.34, 1.78, 51.4), RIFLE_EJECT = V(-1.9, 2.1, 5.5), RIFLE_EYE = V(0.34, 8.8, -17);
export const RIFLE_TRIG = { piv: V(0.34, -3.4, -0.7), pad: V(0.34, -5.2, -0.4) };
// Left-hand reference frame used to key the pistol reload (knuckle socket + hand basis, gun space).
export const LREF_SOCK = V(-1.0, -3.8, 30), LREF_HAND = [V(-0.6, 0.6, 0.3), V(0, 0, -1)];
// 21 FPS-rig hand joints per side: wrist, then thumb / index / middle / ring / pinky 1..4.
const FPS_JOINTS = ['', ...['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].flatMap(f => [1, 2, 3, 4].map(i => f + i))];
const FPS_FINGER0 = { thumb: 1, index: 5, middle: 9, ring: 13, pinky: 17 };
export const M4 = {};
export async function loadM4() {
  const g = await new GLTFLoader().loadAsync('assets/glb/m4_fps.glb');
  const root = g.scene, nodes = [];
  root.traverse(o => nodes.push(o));
  const find = pre => nodes.find(o => o.name.startsWith(pre));
  const main = find('Main_j_'), magJ = find('Mag1_j_'), boltJ = find('Bolt_j_'), catchJ = find('BoltCatch_j_'), trigJ = find('Trigger_j_'), camJ = find('FPS_Camera_j_');
  const JR = FPS_JOINTS.map(k => find('RightHand' + k + '_')), JL = FPS_JOINTS.map(k => find('LeftHand' + k + '_'));
  const mixer = new THREE.AnimationMixer(root), inv = new THREE.Matrix4();
  const rel = o => o.matrixWorld.clone().premultiply(inv);
  const grab = () => {
    root.updateMatrixWorld(true); inv.copy(main.matrixWorld).invert();
    const P = js => js.map(j => V().setFromMatrixPosition(j.matrixWorld).applyMatrix4(inv));
    return { r: P(JR), l: P(JL), mag: rel(magJ), bolt: rel(boltJ), cat: rel(catchJ), cam: rel(camJ) };
  };
  // The pack keeps every take on one timeline; these windows hold the two reloads.
  const sample = (name, t0, t1) => {
    mixer.stopAllAction(); mixer.clipAction(g.animations.find(a => a.name === name)).play();
    const fr = []; for (let t = t0; t <= t1 + 1e-6; t += 1 / 60) { mixer.setTime(t); fr.push(grab()); }
    return fr;
  };
  M4.tac = clipEvents(sample('Reload', 0, 3.55), false);
  M4.empty = clipEvents(sample('Reload_Empty', 3.7, 7.45), true);
  M4.rest = sample('Fire', 0, 0)[0];
  for (const j of [magJ, boltJ, catchJ, trigJ]) { j.matrixAutoUpdate = false; j.matrix.copy(rel(j)); }
  const rest = { mag: magJ.matrix.clone(), bolt: boltJ.matrix.clone(), cat: catchJ.matrix.clone(), trig: trigJ.matrix.clone() };
  // Hang the pack so Main_j coincides with the holder (holder.matrix = weapon matrix, like the other guns).
  root.matrixAutoUpdate = false;
  root.matrix.copy(main.matrixWorld.clone().invert().multiply(root.matrix));
  const holder = new THREE.Group(); holder.matrixAutoUpdate = false; holder.add(root);
  const isPart = o => /^(Main|Mag1|Bolt|BoltCatch|Trigger|Safety)_M4/.test(o.name) || (o.name.startsWith('Bullet') && o.parent?.parent === magJ.children[0]);
  const mats = { Main: [0x2a2c30, 0.55, 0.5], Mag1: [0x232528, 0.4, 0.6], Bolt: [0x3b3d42, 0.9, 0.3], BoltCatch: [0x2a2c30, 0.6, 0.5],
    Trigger: [0x2a2c30, 0.6, 0.5], Safety: [0x2a2c30, 0.6, 0.5], Bullet: [0xc8a250, 1, 0.3] };
  root.traverse(o => {
    if (!o.isMesh) return;
    o.visible = isPart(o); o.castShadow = true; o.frustumCulled = false;
    const k = Object.keys(mats).find(k => o.name.startsWith(k));
    if (o.visible && k) { o.material = o.material.clone(); const [c, m, r] = mats[k]; o.material.color.setHex(c); o.material.metalness = m; o.material.roughness = r; }
  });
  Object.assign(M4, { holder, magJ, boltJ, catchJ, trigJ, restM: rest,
    setBolt(so, f) {
      boltJ.matrix.copy(f ? f.bolt : tmpM.makeTranslation(0, 0, -so).multiply(rest.bolt));
      catchJ.matrix.copy(f ? f.cat : rest.cat);
    },
    setTrig(tv) {
      const p = RIFLE_TRIG.piv;
      trigJ.matrix.makeTranslation(p.x, p.y, p.z).multiply(tmpM.makeRotationX(tv * TRIGGER_PULL)).multiply(_tm2.makeTranslation(-p.x, -p.y, -p.z)).multiply(rest.trig);
    } });
  return M4;
}
const _tm2 = new THREE.Matrix4();
// Reload timing from the magazine track: leaves the well, lowest point (pouch), seated again, bolt released.
function clipEvents(frames, empty) {
  const p0 = V().setFromMatrixPosition(frames[0].mag), n = frames.length;
  const d = frames.map(f => V().setFromMatrixPosition(f.mag).distanceTo(p0));
  const y = frames.map(f => f.mag.elements[13]);
  const release = d.findIndex(x => x > 0.6);
  let low = release; for (let i = release; i < n; i++) if (y[i] < y[low]) low = i;
  let seat = low; while (seat < n - 1 && d[seat] > 0.25) seat++;
  const bz = frames.map(f => f.bolt.elements[14]);
  let boltRel = -1; if (empty) for (let i = 1; i < n; i++) if (bz[i] - bz[0] > 3) { boltRel = i; break; }
  return { frames, empty, dur: n / 60, release: release / n, low: low / n, seat: seat / n, boltRel: boltRel / n };
}

// ---- retarget an FPS-rig hand (21 joint positions, weapon space) onto the mannequin hand ----
export const restLocalQ = {}, restLocalPos = {}, restLocalScale = {}, boneDir = {};
export function initHandRetarget() {
  for (const s of ['l', 'r']) for (const f of ['thumb', ...FINGERS]) {
    const ch = chainOf(f, s);
    ch.forEach((b, i) => {
      // Local direction toward the next joint; the last bone continues its parent's direction.
      boneDir[b.name] = (ch[i + 1] ? ch[i + 1].position.clone() : b.position.clone().applyQuaternion(restLocalQ[b.name].clone().invert())).normalize();
    });
  }
}
const _ba = V(), _bb = V(), _bq = new THREE.Quaternion();
function alignBone(b, localDir, target) {
  const q = worldQuat(b);
  _ba.copy(localDir).applyQuaternion(q).normalize();
  _bq.setFromUnitVectors(_ba, _bb.copy(target).normalize());
  setWorldQuat(b, q.premultiply(_bq));
}
// Places the middle knuckle on the rig's, matches the palm frame, IKs the arm, then aims each finger bone.
export function poseHandFrom(s, J, G, w = 1, fq = null, fqW = 1) {
  const P = J.map(p => p.clone().applyMatrix4(G));
  const up = bones['upperarm_' + s], lo = bones['lowerarm_' + s], hand = bones['hand_' + s];
  const p0 = worldPos(hand), q0 = worldQuat(hand);
  orient(hand, bones['middle_01_' + s], P[9].clone().sub(P[0]), restAcross[s], P[5].clone().sub(P[17]));
  const hq = worldQuat(hand), wrist = P[9].clone().sub(worldPos(bones['middle_01_' + s]).sub(worldPos(hand)));
  if (w < 1) { wrist.lerpVectors(p0, wrist, w); hq.copy(q0.slerp(hq, w)); }
  const pole = worldPos(lo).sub(worldPos(up));
  if (typeof STATE.NORMAL_W !== 'undefined' && STATE.NORMAL_W > 0.001) {
    const side = s === 'r' ? -1 : 1;
    pole.lerp(V(side * 12, -22, s === 'r' ? -12 : -4), 0.65 * STATE.NORMAL_W);
  }
  if (typeof rec !== 'undefined' && rec.elbow) {
    const eb = rec.elbow.x, side = s === 'r' ? -1 : 1;
    pole.x += side * eb * 1.35;
    pole.y -= eb * 0.85;
    pole.z -= eb * 1.65;
  }
  twoBoneIK(up, lo, hand, wrist, pole);
  setWorldQuat(hand, hq);
  for (const f of ['thumb', ...FINGERS]) {
    const ch = chainOf(f, s), j0 = FPS_FINGER0[f];
    ch.forEach((b, i) => { b.quaternion.copy(restLocalQ[b.name]); alignBone(b, boneDir[b.name], P[j0 + i + 1].clone().sub(P[j0 + i])); });
  }
  if (fq && fqW > 0) GRIP_FINGERS.forEach(([f], k) => chainOf(f, s).forEach((b, i) => b.quaternion.slerp(fq[k * 3 + i], fqW)));
}
const GRIP_FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'].map(f => [f]);
// The rig's hands are much bigger than the mannequin's: shrink the hand shape toward the part it holds,
// then close the fingers onto collision capsules. Returns the shape and the gripped finger rotations.
export function fitGrip(s, J, cols, k) {
  const A = cols[0].a, B = cols[0].b, pc = [0, 5, 9, 17].reduce((a, i) => a.add(J[i]), V()).multiplyScalar(0.25);
  const c = new THREE.Line3(A, B).closestPointToPoint(pc, true, V());
  const Js = J.map(p => p.clone().sub(c).multiplyScalar(k).add(c));
  poseHandFrom(s, Js, gunState.mat);
  const cw = cols.map(o => ({ type: 'cap', a: fromGun(o.a), b: fromGun(o.b), r: o.r }));
  for (const f of ['thumb', ...FINGERS]) {
    if (s === 'r' && f === 'index') continue;          // trigger finger is solved separately
    pushChainOut(f, s, cw, 80);
    if (f !== 'thumb') closeToContact(f, s, handFrame(s).curl, cw, 90);
    pushChainOut(f, s, cw, 80);
  }
  return { J: Js, fq: GRIP_FINGERS.flatMap(([f]) => chainOf(f, s).map(b => b.quaternion.clone())), scale: p => p.clone().sub(c).multiplyScalar(k).add(c) };
}
// Colliders (weapon space, cm): [0] is the held part's axis.
export const M4_COLS = { r: [{ a: V(0.34, -5.0, -5.0), b: V(0.34, -13.5, -9.5), r: 1.8 }, { a: V(0.34, -1.5, -14), b: V(0.34, -1.5, 8), r: 2.6 }],
  l: [{ a: V(0.34, 1.9, 11), b: V(0.34, 1.9, 33), r: 3.1 }] };
export const KAR_COLS = { r: [{ a: V(0, -2.4, -14.2), b: V(0, -7.6, -21.6), r: 2.0 }, { a: V(0, 0, -14), b: V(0, 0, 4), r: 1.6 }],
  l: [{ a: V(0, -1.9, 6), b: V(0, -1.9, 34), r: 2.6 }] };
// Rigidly re-place a hand shape: frame (axis A, forward F, origin C) -> another frame.
export function frameM(A, F, C) {
  const a = A.clone().normalize(), f = F.clone().addScaledVector(a, -F.dot(a)).normalize();
  return new THREE.Matrix4().makeBasis(a, f, new THREE.Vector3().crossVectors(a, f)).setPosition(C);
}
export function placeShape(J, from, to) { const M = to.clone().multiply(from.clone().invert()); return J.map(p => p.clone().applyMatrix4(M)); }
// The M4 pistol grip as a "fist around an axis": grip axis (down/back), forward, centre.
export const M4_GRIP_FRAME = frameM(V(0, -0.94, -0.34), V(0, -0.34, 0.94), V(0.34, -9.5, -8.5));

// ======================================================================
//  KAR98K  procedural, scoped.  Same weapon-space convention; bolt face at z = 0, bore on the Z axis.
// ======================================================================
// Butt ends at z = -43: ~7 cm in front of the right shoulder joint in the fitted pose (like the M4), so the
// stock sits in the shoulder pocket instead of poking out behind the shoulder.
const KAR_STOCK = [[-43, -2.2], [-42.3, -1.6], [-34.2, -1.2], [-27.4, -1.0], [-22, -2.4], [-15, -1.8], [-12, -1.4], [56, -0.9], [58, -1.6], [58, -3.8],
  [30, -4.8], [10, -5.6], [-2, -6.0], [-9, -6.2], [-15, -7.6], [-21, -9.4], [-27.4, -11.2], [-42.3, -16.0], [-43, -15.2]];
const KAR_TRIGGER = [[-4.0, -5.4], [-3.5, -5.4], [-3.7, -6.3], [-4.2, -7.3], [-4.6, -7.3], [-4.3, -6.3]];
export const KS_Y = 5.6, KAR_EYE = V(0, KS_Y, -24), KAR_MUZZLE = V(0, 0, 74.4);
export const KAR_TRIG = { piv: V(0, -5.4, -3.8), pad: V(0, -6.6, -4.0) };
const KAR_KNOB = V(-6.0, -3.0, -10.5), KAR_PULL = 10;
export const CLIP_GUIDE = V(0, 4.4, -7.2);          // stripper-clip centre seated in the charger guides
export const KAR_GRIP_FRAME = frameM(V(0, -0.57, -0.82), V(0, -0.82, 0.57), V(0, -4.7, -17.5));
export const KAR_L_SHIFT = V(0, -4.0, 4.0);
export const karCaseGeo = new THREE.CylinderGeometry(0.6, 0.6, 5.7, 14);
function woodTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 64;
  const g = c.getContext('2d'); g.fillStyle = '#6b3a1e'; g.fillRect(0, 0, 512, 64);
  for (let i = 0; i < 70; i++) {
    g.strokeStyle = Math.random() < 0.5 ? 'rgba(40,18,6,0.35)' : 'rgba(150,90,45,0.25)'; g.lineWidth = 0.5 + Math.random() * 2;
    const y = Math.random() * 64; g.beginPath(); g.moveTo(0, y);
    for (let x = 0; x <= 512; x += 32) g.lineTo(x, y + Math.sin(x * 0.02 + i) * 3 + (Math.random() - 0.5) * 2);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(0.02, 0.06);
  return t;
}
export function makeKar() {
  const wood = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.55, metalness: 0 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.35, metalness: 0.85 });
  const blued = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.3, metalness: 0.9 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1b2a3a, roughness: 0.05, metalness: 0.9, emissive: 0x060c14 });
  const brassM = new THREE.MeshStandardMaterial({ color: 0xc8a250, roughness: 0.3, metalness: 1 });
  const g = new THREE.Group(); g.matrixAutoUpdate = false;
  const cyl = (r1, r2, len, mat, x, y, z, seg = 18) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, seg), mat);
    m.rotation.x = Math.PI / 2; m.position.set(x, y, z); return m;
  };
  g.add(extrudeSide(KAR_STOCK, null, 4.2, 0.5, wood));
  g.add(box(2.4, 1.3, 30, wood, 0, 1.0, 34));                       // upper handguard
  g.add(box(4.5, 14.4, 0.5, steel, 0, -8.8, -43.2));               // butt plate
  g.add(cyl(0.75, 0.95, 74, steel, 0, 0, 37));                      // barrel
  g.add(cyl(0.8, 0.8, 1.2, steel, 0, 0, 73.8));
  g.add(cyl(1.55, 1.55, 20, blued, 0, 0, -2));                      // receiver
  g.add(cyl(1.75, 1.75, 5, blued, 0, 0, 6));                        // front ring
  for (const z of [38, 54]) { const b = cyl(2.7, 2.7, 1.2, steel, 0, -1.9, z, 20); b.scale.x = 0.85; g.add(b); }   // barrel bands
  g.add(box(1.8, 2.2, 2.2, blued, 0, 1.6, 70.5));                  // front sight hood
  g.add(box(2.2, 0.7, 5, blued, 0, 1.4, 12));                       // rear sight base
  g.add(box(2.7, 0.4, 9, steel, 0, -6.2, 2.5));                     // floorplate
  g.add(box(0.7, 0.4, 9, steel, 0, -7.6, -4.0));                    // trigger guard
  g.add(box(0.7, 2.2, 0.5, steel, 0, -6.6, -8.4)); g.add(box(0.7, 2.0, 0.5, steel, 0, -6.6, 0.4));
  // scope (high turret mount) + two rings
  g.add(cyl(1.3, 1.3, 28, blued, 0, KS_Y, 2));
  g.add(cyl(1.6, 2.0, 4, blued, 0, KS_Y, -14));
  g.add(cyl(2.3, 1.6, 4, blued, 0, KS_Y, 18));
  g.add(cyl(1.75, 1.75, 0.1, glass, 0, KS_Y, -16.05)); g.add(cyl(2.15, 2.15, 0.1, glass, 0, KS_Y, 20.05));
  const tur = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 1.8, 14), blued); tur.position.set(0, KS_Y + 1.9, 3); g.add(tur);
  for (const z of [-6, 9]) { g.add(box(1.6, KS_Y - 1.3, 1.8, blued, 0, (KS_Y + 1.3) / 2, z)); g.add(cyl(1.55, 1.55, 1.6, blued, 0, KS_Y, z)); }
  // bolt: turns about the bore (handle down-right -> up) and slides back
  const bolt = new THREE.Group(); g.add(bolt);
  bolt.add(cyl(0.95, 0.95, 17, steel, 0, 0, -4));
  bolt.add(cyl(1.2, 1.0, 4, blued, 0, 0, -14.2));
  const st = V(-0.6, -0.3, -9.6), len = KAR_KNOB.distanceTo(st);
  const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, len, 10), steel);
  stalk.position.copy(st).lerp(KAR_KNOB, 0.5); stalk.quaternion.setFromUnitVectors(V(0, 1, 0), KAR_KNOB.clone().sub(st).normalize()); bolt.add(stalk);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(1.05, 16, 12), steel); knob.position.copy(KAR_KNOB); bolt.add(knob);
  const trigPivot = new THREE.Group(); trigPivot.position.set(0, KAR_TRIG.piv.y, KAR_TRIG.piv.z);
  const tr = extrudeSide(KAR_TRIGGER, null, 0.6, 0.08, steel); tr.position.set(0, -KAR_TRIG.piv.y, -KAR_TRIG.piv.z); trigPivot.add(tr); g.add(trigPivot);
  // stripper clip with five 7.92 mm rounds (stacked vertically in the charger guides)
  const clip = new THREE.Group(); clip.visible = false; g.add(clip);
  clip.add(box(0.3, 6.2, 1.0, steel, 0, 0, 0));
  const rounds = [-2.2, -1.1, 0, 1.1, 2.2].map((y, i) => {
    const r = new THREE.Group(); r.position.set(i % 2 ? 0.18 : -0.18, y, 2.9);
    r.add(cyl(0.6, 0.6, 5.7, brassM, 0, 0, 0, 12));
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.42, 2.3, 12), new THREE.MeshStandardMaterial({ color: 0x8a6a3a, metalness: 0.8, roughness: 0.4 }));
    tip.rotation.x = Math.PI / 2; tip.position.z = 4.0; r.add(tip); r.userData.y0 = y; clip.add(r); return r;
  });
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return { gun: g, bolt, trigPivot, clip, rounds };
}

// ======================================================================
//  SHOTGUN (12-Gauge Pump-Action) & RPG-7 (Rocket-Propelled Grenade Launcher)
// ======================================================================
export const SHOTGUN_MUZZLE = V(0, 1.3, 66), SHOTGUN_EYE = V(0, 4.2, -22);
export const SHOTGUN_TRIG = { piv: V(0, -2.4, -3.5), pad: V(0, -3.2, -3.5) };
export const shotgunCaseGeo = new THREE.CylinderGeometry(0.9, 0.9, 6.2, 12);

export function makeShotgun() {
  const steel = new THREE.MeshStandardMaterial({ color: 0x1f2124, roughness: 0.35, metalness: 0.85 });
  const darkSteel = new THREE.MeshStandardMaterial({ color: 0x151618, roughness: 0.45, metalness: 0.8 });
  const brightSteel = new THREE.MeshStandardMaterial({ color: 0x5a5e66, roughness: 0.2, metalness: 0.95 });
  const polymer = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.75, metalness: 0.1 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x111213, roughness: 0.9, metalness: 0.0 });
  const brassM = new THREE.MeshStandardMaterial({ color: 0xc8a250, roughness: 0.3, metalness: 1 });
  const shellRed = new THREE.MeshStandardMaterial({ color: 0xa81c1c, roughness: 0.4, metalness: 0.1 });

  const gun = new THREE.Group();
  gun.matrixAutoUpdate = false;

  const box = (w, h, d, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.castShadow = true; return m;
  };
  const cyl = (r1, r2, len, mat, x, y, z, seg = 16) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, seg), mat);
    m.rotation.x = Math.PI / 2; m.position.set(x, y, z); m.castShadow = true; return m;
  };

  // Receiver
  gun.add(box(3.4, 5.2, 22, steel, 0, 0, 0));
  gun.add(box(3.5, 0.4, 18, darkSteel, 0, 2.7, 0));
  const bolt = box(1.8, 1.8, 6.8, brightSteel, 1.55, 0.6, 1.5);
  gun.add(bolt);
  gun.add(box(1.2, 0.4, 6.0, darkSteel, 0, -2.65, 3.0));

  // Trigger group
  gun.add(box(0.8, 0.4, 7.5, steel, 0, -3.2, -3.0));
  gun.add(box(0.8, 1.8, 0.4, steel, 0, -2.3, -6.6));
  const trig = cyl(0.2, 0.2, 1.4, brightSteel, 0, -2.4, -3.5);
  trig.rotation.x = 0.4; gun.add(trig);

  // Stock
  gun.add(box(3.2, 8.5, 5.0, polymer, 0, -5.5, -9.0));
  gun.add(box(3.2, 4.2, 24, polymer, 0, -1.8, -20.0));
  gun.add(box(3.4, 12.0, 2.5, rubber, 0, -3.0, -32.0));

  // Barrel (12 gauge)
  gun.add(cyl(1.15, 1.15, 58, steel, 0, 1.3, 37));
  gun.add(cyl(0.88, 0.88, 0.4, darkSteel, 0, 1.3, 66.1));
  gun.add(box(0.4, 0.6, 0.8, brassM, 0, 2.7, 65.5));

  // Extended magazine tube
  gun.add(cyl(1.0, 1.0, 52, darkSteel, 0, -1.1, 34));
  gun.add(cyl(1.15, 1.15, 2.0, steel, 0, -1.1, 59));
  gun.add(box(1.2, 4.0, 1.4, steel, 0, 0.1, 54));

  // Moveable Pump forend slide (slides along the lower magazine tube at y = -1.1, z = 18..36, center z = 27)
  const pump = new THREE.Group();
  pump.add(cyl(2.1, 2.1, 18, polymer, 0, -1.1, 27, 20));
  for (let z = 19; z <= 35; z += 2.0) {
    pump.add(cyl(2.2, 2.2, 0.85, darkSteel, 0, -1.1, z, 20));
  }
  // Twin steel action bars connecting the pump slider back into the receiver
  pump.add(box(0.35, 0.65, 16, brightSteel, -1.25, -1.1, 12));
  pump.add(box(0.35, 0.65, 16, brightSteel,  1.25, -1.1, 12));
  gun.add(pump);

  // Side saddle with 4 shells on left side
  for (let i = 0; i < 4; i++) {
    const sz = -4 + i * 2.8;
    gun.add(cyl(0.9, 0.9, 5.8, shellRed, -2.4, 0.3, sz, 12));
    gun.add(cyl(0.92, 0.92, 1.4, brassM, -2.4, 0.3, sz - 2.2, 12));
  }

  gun.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return { gun, pump, bolt };
}

export const RPG_MUZZLE = V(0, 0, 52), RPG_EYE = V(3.8, 3.2, -14);
export const RPG_TRIG = { piv: V(0, -4.2, -4.8), pad: V(0, -5.2, -4.8) };

export function makeRPG7() {
  const steelDark = new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.45, metalness: 0.8 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x363a40, roughness: 0.35, metalness: 0.85 });
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x5a2d14, roughness: 0.6, metalness: 0.05 });
  const oliveGreen = new THREE.MeshStandardMaterial({ color: 0x3b4d2e, roughness: 0.6, metalness: 0.15 });
  const opticMat = new THREE.MeshStandardMaterial({ color: 0x1d2224, roughness: 0.3, metalness: 0.7 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x152830, roughness: 0.05, metalness: 0.95, emissive: 0x051015 });

  const gun = new THREE.Group();
  gun.matrixAutoUpdate = false;

  const box = (w, h, d, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.castShadow = true; return m;
  };
  const cyl = (r1, r2, len, mat, x, y, z, seg = 18) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, seg), mat);
    m.rotation.x = Math.PI / 2; m.position.set(x, y, z); m.castShadow = true; return m;
  };

  // Main tube (40mm bore)
  gun.add(cyl(2.1, 2.1, 95, steelDark, 0, 0, 10));

  // Wood heat-shield jacket in the middle
  gun.add(cyl(2.7, 2.7, 34, woodMat, 0, 0, -2, 24));
  gun.add(cyl(2.85, 2.85, 1.2, steelMat, 0, 0, 14.5));
  gun.add(cyl(2.85, 2.85, 1.2, steelMat, 0, 0, -18.5));

  // Rear flared exhaust venturi bell cone
  const cone = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 2.2, 14, 20), steelDark);
  cone.rotation.x = -Math.PI / 2; cone.position.set(0, 0, -43); cone.castShadow = true;
  gun.add(cone);
  gun.add(cyl(4.35, 4.35, 1.5, steelDark, 0, 0, -49));

  // Pistol grip (right hand)
  gun.add(box(2.2, 9.5, 4.0, woodMat, 0, -6.5, -6.0));
  gun.add(box(2.4, 0.4, 6.0, steelDark, 0, -11.0, -6.0));
  gun.add(box(0.6, 0.4, 5.0, steelDark, 0, -5.2, -4.5));
  gun.add(cyl(0.2, 0.2, 1.2, steelMat, 0, -4.2, -4.8));

  // Forward support grip (left hand)
  gun.add(box(2.2, 8.5, 3.6, woodMat, 0, -5.8, 16.0));

  // PGO-7 Optical Scope (mounted on left side)
  const scopeArm = box(3.2, 1.6, 1.6, steelDark, 2.2, 1.5, 0); gun.add(scopeArm);
  const scopeBody = cyl(1.5, 1.5, 18, opticMat, 3.8, 3.2, 0); gun.add(scopeBody);
  const objBell = cyl(2.1, 1.5, 4, opticMat, 3.8, 3.2, 8.5); gun.add(objBell);
  const eyecup = cyl(1.8, 1.6, 3, steelDark, 3.8, 3.2, -9.5); gun.add(eyecup);
  const lens = cyl(1.8, 1.8, 0.2, glass, 3.8, 3.2, 10.4); gun.add(lens);
  const turret = cyl(0.9, 0.9, 1.8, opticMat, 3.8, 5.0, 0); gun.add(turret);

  // Mechanical iron sights
  gun.add(box(0.6, 2.4, 0.8, steelMat, 0, 3.2, 48));
  gun.add(box(0.8, 3.2, 0.8, steelMat, 0, 3.6, 20));

  // PG-7V Rocket Warhead (loaded into front muzzle)
  const warhead = new THREE.Group();
  warhead.name = 'warhead';
  warhead.add(cyl(1.95, 1.95, 20, steelDark, 0, 0, 52));
  warhead.add(cyl(2.2, 4.4, 7.0, oliveGreen, 0, 0, 65));
  warhead.add(cyl(4.4, 4.4, 6.0, oliveGreen, 0, 0, 71.5));
  warhead.add(cyl(4.4, 1.2, 14.0, oliveGreen, 0, 0, 81.5));
  warhead.add(cyl(1.0, 0.4, 5.0, steelMat, 0, 0, 91.0));
  warhead.traverse(o => { if (o.isMesh) o.castShadow = true; });
  gun.add(warhead);

  gun.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return { gun, warhead };
}

// ======================================================================
//  COLLISION — capsules for fingers/palm, SDF for the pistol
// ======================================================================
export const gunState = { mat: new THREE.Matrix4(), inv: new THREE.Matrix4(), q: new THREE.Quaternion() };
export function setGunMatrix(m) {
  gunState.mat.copy(m); gunState.inv.copy(m).invert();
  const p = new THREE.Vector3(), s = new THREE.Vector3(); m.decompose(p, gunState.q, s);
}
export const toGun = p => p.clone().applyMatrix4(gunState.inv);
export const fromGun = p => p.clone().applyMatrix4(gunState.mat);

function closestOnSeg(p, a, b) {
  const ab = b.clone().sub(a), t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / ab.lengthSq()));
  return a.clone().add(ab.multiplyScalar(t));
}
// Clearance of a sphere (p, r) against a collider list; < 0 means penetration.
function clearance(p, r, colliders) {
  let best = Infinity, n = null;
  for (const c of colliders) {
    if (c.type === 'gun') {
      const d = gunSDF(toGun(p)) * GUN_S - r;
      if (d < best) { best = d; n = c; }
    } else {
      const d = p.distanceTo(closestOnSeg(p, c.a, c.b)) - c.r - r;
      if (d < best) { best = d; n = c; }
    }
  }
  return { d: best, c: n };
}
function pushDir(p, c) {
  if (c.type === 'gun') {
    const g = toGun(p), e = 0.05;
    const n = V(gunSDF(V(g.x + e, g.y, g.z)) - gunSDF(V(g.x - e, g.y, g.z)),
                gunSDF(V(g.x, g.y + e, g.z)) - gunSDF(V(g.x, g.y - e, g.z)),
                gunSDF(V(g.x, g.y, g.z + e)) - gunSDF(V(g.x, g.y, g.z - e))).normalize();
    return n.applyQuaternion(gunState.q);
  }
  return p.clone().sub(closestOnSeg(p, c.a, c.b)).normalize();
}

// Finger skin radii (cm) for proximal / middle / distal phalanges.
// Measured from the mannequin mesh (median vertex distance to the bone line).
const FINGER_R = { thumb: [1.5, 1.3, 1.1], index: [1.15, 0.95, 0.88], middle: [1.15, 0.92, 0.85], ring: [1.1, 0.9, 0.82], pinky: [1.02, 0.85, 0.78] };
export const FINGERS = ['index', 'middle', 'ring', 'pinky'];
export const tipLocal = {};
export function chainOf(f, s) { return [1, 2, 3].map(i => bones[`${f}_0${i}_${s}`]); }
export function chainPoints(f, s) {
  const ch = chainOf(f, s);
  const pts = ch.map(worldPos);
  ch[2].updateWorldMatrix(true, false);
  pts.push(ch[2].localToWorld(tipLocal[`${f}_${s}`].clone()));
  return pts;
}
function fingerCapsules(f, s) {
  const p = chainPoints(f, s), r = FINGER_R[f];
  return [0, 1, 2].map(i => ({ type: 'cap', a: p[i], b: p[i + 1], r: r[i], name: `${f}_0${i + 1}_${s}` }));
}
// Minimum clearance of finger segments >= from against colliders (5 samples per segment).
export function fingerClearance(f, s, from, colliders) {
  const p = chainPoints(f, s), r = FINGER_R[f];
  let min = Infinity, at = null, col = null;
  // The knuckle a joint pivots on doesn't block its own curl.
  for (let i = from; i < 3; i++) for (let k = i === from && from > 0 ? 1 : 0; k <= 4; k++) {
    const q = p[i].clone().lerp(p[i + 1], k / 4);
    const c = clearance(q, r[i], colliders);
    if (c.d < min) { min = c.d; at = q; col = c.c; }
  }
  return { d: min, p: at, c: col };
}

// CCD so the finger tip reaches a world target.
export function ccdReach(f, s, target, iters = 24) {
  const ch = chainOf(f, s);
  for (let it = 0; it < iters; it++) for (let i = 2; i >= 0; i--) {
    const P = worldPos(ch[i]), tip = chainPoints(f, s)[3];
    const q = new THREE.Quaternion().setFromUnitVectors(tip.sub(P).normalize(), target.clone().sub(P).normalize());
    q.slerp(new THREE.Quaternion(), 0.35);
    setWorldQuat(ch[i], q.multiply(worldQuat(ch[i])));
  }
}
// Curl a finger (proximal joint first) until it touches a collider, at most maxDeg per joint.
function closeToContact(f, s, axis, colliders, maxDeg) {
  const ch = chainOf(f, s);
  for (let i = 0; i < 3; i++) for (let a = 0; a < maxDeg; a++) {
    if (fingerClearance(f, s, i, colliders).d < 0.05) break;
    rotateWorld(ch[i], axis, 1 * DEG);
    if (fingerClearance(f, s, i, colliders).d < 0) { rotateWorld(ch[i], axis, -1 * DEG); break; }
  }
}
// Rotate joints away from contact until the whole chain is clear.
function pushChainOut(f, s, colliders, iters = 60) {
  const ch = chainOf(f, s);
  for (let it = 0; it < iters; it++) {
    const c = fingerClearance(f, s, 0, colliders);
    if (c.d >= 0.04) return;
    const n = pushDir(c.p, c.c);
    for (let i = 2; i >= 0; i--) {
      const P = worldPos(ch[i]), arm = c.p.clone().sub(P);
      if (arm.length() < 0.3) continue;
      const axis = new THREE.Vector3().crossVectors(arm, n);
      if (axis.lengthSq() < 1e-6) continue;
      rotateWorld(ch[i], axis, 1.5 * DEG);
    }
  }
}
function palmPoints(s) {
  const h = worldPos(bones['hand_' + s]), pts = [];
  for (const f of FINGERS) {
    const k = worldPos(bones[`${f}_01_${s}`]);
    pts.push(h.clone().lerp(k, 0.45), h.clone().lerp(k, 0.8));
  }
  return pts;
}
const PALM_R = 1.6;

// Fit the pistol into the animated right-hand grip (gun-space GRIP_R), then push it out of the palm.
export function fitGunToHand() {
  // Barrel along the sight line (eye -> far target straight ahead); roll from the hand.
  const fr = handFrame('r');
  const ahead = V(fr.fwd.x, 0, fr.fwd.z).normalize();
  const eye = worldPos(bones.head).add(V(0, 7, 0)).addScaledVector(ahead, 9);
  const D = eye.clone().addScaledVector(ahead, 1500).sub(worldPos(bones.middle_01_r)).normalize();
  const up = fr.acr.clone().addScaledVector(D, -fr.acr.dot(D)).normalize();
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(up, D), up, D));
  const origin = worldPos(bones.middle_01_r).sub(GRIP_R.socket.clone().multiplyScalar(GUN_S).applyQuaternion(q));
  const S = V(GUN_S, GUN_S, GUN_S), gun = [{ type: 'gun' }];
  // Contact fit: slide the gun (gun-space x/y/z) so the grip sits inside the curled
  // fingers and against the palm. Gaps cost d², penetration costs 25·d².
  const samples = [];
  for (const f of ['middle', 'ring', 'pinky']) {
    const pts = chainPoints(f, 'r');
    for (let i = 0; i < 3; i++) for (let k = 1; k <= 3; k++) samples.push([pts[i].clone().lerp(pts[i + 1], k / 3), FINGER_R[f][i], 1]);
  }
  for (const p of palmPoints('r')) samples.push([p, PALM_R, 1.5]);
  const cost = o => {
    setGunMatrix(new THREE.Matrix4().compose(o, q, S));
    let c = 0;
    for (const [p, r, w] of samples) { const d = clearance(p, r, gun).d; c += w * (d > 0 ? d * d : 25 * d * d); }
    return c;
  };
  const axes = [V(1, 0, 0), V(0, 1, 0), V(0, 0, 1)].map(a => a.applyQuaternion(q));
  let best = cost(origin);
  for (const step of [2, 1, 0.5, 0.25, 0.1]) for (let moved = true, n = 0; moved && n < 40; n++) {
    moved = false;
    for (const a of axes) for (const sg of [1, -1]) {
      const o = origin.clone().addScaledVector(a, sg * step), c = cost(o);
      if (c < best) { best = c; origin.copy(o); moved = true; }
    }
  }
  setGunMatrix(new THREE.Matrix4().compose(origin, q, S));
  bones.hand_r.updateWorldMatrix(true, false);
  return bones.hand_r.matrixWorld.clone().invert().multiply(gunState.mat);   // gun in hand space
}

// Bind-time finger corrections: resolve finger/gun and finger/finger penetration once,
// stored as local deltas layered over the animation every frame.
export const fingerFix = [];
export function solveFingerFix() {
  const gun = [{ type: 'gun' }];
  const base = new Map();
  for (const s of ['r', 'l']) for (const f of ['thumb', ...FINGERS]) chainOf(f, s).forEach(b => base.set(b, b.quaternion.clone()));
  // Support thumb points forward along the frame's left side.
  ccdReach('thumb', 'l', fromGun(V(FRAME_HW + 1.1, -0.5, 7.5)));
  for (const s of ['r', 'l']) for (const f of ['thumb', ...FINGERS]) {
    if (s === 'r' && f === 'index') continue;   // trigger finger handled separately
    const ch = chainOf(f, s);
    const others = s === 'l' ? [...gun, ...['thumb', ...FINGERS].flatMap(f2 => fingerCapsules(f2, 'r'))] : gun;
    if (f !== 'thumb') closeToContact(f, s, handFrame(s).curl, others, s === 'l' ? 30 : 20);
    pushChainOut(f, s, others, 80);
    ch.forEach(b => fingerFix.push([b, b.quaternion.clone().multiply(base.get(b).clone().invert())]));
  }
}
export function gripReport() {
  const out = {}, gun = [{ type: 'gun' }], all = ['thumb', ...FINGERS];
  for (const s of ['r', 'l']) for (const f of all) {
    const others = [];
    for (const s2 of ['r', 'l']) for (const f2 of all)
      if (s2 !== s || Math.abs(all.indexOf(f2) - all.indexOf(f)) === 1) others.push(...fingerCapsules(f2, s2));
    out[`${f}_${s}`] = { gun: +fingerClearance(f, s, 0, gun).d.toFixed(2), fingers: +fingerClearance(f, s, 0, others).d.toFixed(2) };
  }
  return out;
}

export function buildCapsules() {
  const mat = new THREE.MeshBasicMaterial({ color: 0x35e07a, wireframe: true, transparent: true, opacity: 0.6, depthTest: false });
  for (const s of ['r', 'l']) for (const f of ['thumb', ...FINGERS]) {
    const pts = chainPoints(f, s), ch = chainOf(f, s);
    for (let i = 0; i < 3; i++) {
      const a = pts[i], b = pts[i + 1], len = a.distanceTo(b), r = FINGER_R[f][i];
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, len), 3, 8), mat);
      m.position.copy(a).lerp(b, 0.5);
      m.quaternion.setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize());
      m.renderOrder = 10; m.visible = false;
      scene.add(m); ch[i].attach(m); capsuleMeshes.push(m);
    }
  }
}

// ======================================================================
//  ANIMATION
// ======================================================================
/* simTime, timeScale, autoFire, nextAuto in STATE */
/* trigStart, fired, fireTime, ejected in STATE */
const TRIG_PRESS = 0.07, TRIG_HOLD = 0.06, TRIG_RELEASE = 0.12;

export const SG_PUMP = { on: false, t: 0, dur: 0.46, z: 0, ev: {} };
export function stepShotgunPump(dt) {
  const c = W.cur;
  if (!c?.pump) { SG_PUMP.on = false; SG_PUMP.z = 0; return; }
  if (RL.on) { SG_PUMP.on = false; SG_PUMP.z = 0; return; }
  if (!SG_PUMP.on) {
    SG_PUMP.z = 0;
    c.pump.position.z = 0;
    if (c.sgBolt) c.sgBolt.position.z = 1.5;
    return;
  }
  SG_PUMP.t += dt;
  const t = SG_PUMP.t, ev = SG_PUMP.ev;
  const at = (n, tm, fn) => { if (!ev[n] && t >= tm) { ev[n] = true; fn(); } };
  const travel = -7.2; // cm pump stroke along the magazine tube
  if (t < 0.11) {
    SG_PUMP.z = 0;
  } else if (t < 0.26) {
    SG_PUMP.z = travel * ease((t - 0.11) / 0.15);
  } else if (t < 0.30) {
    SG_PUMP.z = travel;
  } else if (t < 0.46) {
    SG_PUMP.z = travel * (1 - ease((t - 0.30) / 0.16));
  } else {
    SG_PUMP.z = 0;
    SG_PUMP.on = false;
    if (c.ammo === 0) scheduleReload(0.12);
  }
  at('pull', 0.12, () => {
    playSample('slide_rack', { rate: 1.05, gain: 0.78 }) || playClick(920, 0.06, 0.45);
    rec.back.kick(1.25); rec.flip.kick(-0.9); rec.roll.kick(-0.7);
    rec.shoulder.kick(1.8); rec.armBack.kick(1.6); rec.elbow.kick(2.2);
  });
  at('eject', 0.24, () => ejectShell());
  at('push', 0.32, () => {
    playClick(1350, 0.045, 0.38);
    rec.back.kick(-0.7); rec.flip.kick(0.5);
    rec.shoulder.kick(-1.1); rec.armBack.kick(-1.0);
  });
  c.pump.position.z = SG_PUMP.z;
  if (c.sgBolt) c.sgBolt.position.z = 1.5 + SG_PUMP.z * 0.75;
}
export function pullTrigger() { if (STATE.ready && STATE.trigStart < 0 && !W.cur.auto && W.swapT < 0 && !RL.on && !KA.on && !SG_PUMP.on) { STATE.trigStart = STATE.simTime; STATE.fired = false; } }
// Rifle: full auto while the trigger is held.
/* triggerHeld, nextShot, tvAuto, burstN in STATE */
export function weaponTrigger(dt) {
  if (!W.cur.auto) return triggerValue();
  if (STATE.autoFire && !game.active) STATE.triggerHeld = (STATE.simTime % 1.3) < 0.5;
  STATE.tvAuto += ((STATE.triggerHeld ? 1 : 0) - STATE.tvAuto) * Math.min(1, dt * 45);
  if (!STATE.triggerHeld && STATE.burstN) { if (STATE.burstN > 1) playSample('rifle_tail', { gain: 0.8 }); STATE.burstN = 0; }   // echo after a burst
  if (STATE.triggerHeld && STATE.tvAuto > 0.7 && STATE.simTime >= STATE.nextShot && W.swapT < 0 && !RL.on) { fire(); STATE.nextShot = STATE.simTime + 60 / W.cur.rpm; if (W.cur.ammo <= 0) STATE.triggerHeld = false; }
  return STATE.tvAuto;
}
export function pressFire() {
  if (!STATE.ready || motionPreview.active || W.swapT >= 0 || RL.on) return;
  playerAim.fireHoldT = 0.85;
  if (W.cur.auto) STATE.triggerHeld = true; else pullTrigger();
}
export function releaseFire() { STATE.triggerHeld = false; }

// ======================================================================
//  RELOAD  keyframed left-hand path + gun cant, magazine drops with physics, new mag from the hip pouch
// ======================================================================
export const RL = { on: false, t: 0, dur: 1, empty: false, env: 0, rack: 0, ev: {}, pending: -1, mag: null, external: null, loading: false, loadToken: 0, externalEvents: null };
export const dropped = [];
function scheduleReload(delay) { if (!RL.on && RL.pending < 0) RL.pending = STATE.simTime + delay; }
export function startReload() {
  if (motionPreview.active) return;
  const c = W.cur;
  RL.pending = -1;
  if (!STATE.ready || RL.on || KA.on || W.swapT >= 0 || c.ammo >= c.cap + (c.name === 'pistol' ? 1 : 0)) return;   // pistol holds one in the chamber
  if (game.active) setAimStage(0);
  releaseFire(); STATE.trigStart = -1;
  if (c.kar) { startKarAction('reload'); return; }
  RL.empty = c.ammo === 0;
  RL.on = true; RL.t = 0; RL.ev = {}; RL.rack = 0; RL.frame = null;
  RL.rev = false; RL.fireAfter = false; RL.sprintStart = isSprinting(); RL.weapon = c; RL.hand = 0;
  if (c.rl) snapLeftFingers();
  RL.external = null; RL.loading = false; RL.externalEvents = null;
  RL.key = c.clips ? (RL.empty ? c.clips.empty : c.clips.tac) : (c.rl ? (RL.empty ? c.rl.empty : c.rl.tac) : null);
  RL.dur = c.clips ? RL.key.dur : (c.rl ? (RL.empty ? c.rlDur.empty : c.rlDur.tac) : (c.rlDur || 2.5));
  if (c.mag) c.mag.visible = true;
  if (c.warhead) c.warhead.visible = true;
}
export function playClick(f, dur, gain, delay = 0) {
  if (!STATE.soundOn) return;
  const ac = audio(); if (!ac) return;
  const t = ac.currentTime + delay, n = ac.createBufferSource(), len = Math.ceil(ac.sampleRate * dur);
  const b = ac.createBuffer(1, len, ac.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4);
  n.buffer = b;
  const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 3;
  const g = ac.createGain(); g.gain.value = gain;
  n.connect(bp).connect(g).connect(ac.destination); n.start(t);
}
// Magazine world matrix helpers (character space -> world).
const _wm = new THREE.Matrix4();
function charToWorldM(m) { return _wm.makeRotationY(STATE.charYaw).setPosition(charPos).multiply(m); }
// Throw a copy of a gun part (magazine, stripper clip) into the world; pivot at its centre so it tumbles believably.
function dropPart(src, mGun, ctr, vGun, spin = 1) {
  const m = new THREE.Group(), body = src.clone(true);
  body.matrixAutoUpdate = false; body.matrix.makeTranslation(-ctr.x, -ctr.y, -ctr.z); body.visible = true;
  m.add(body);
  charToWorldM(gunState.mat.clone().multiply(mGun).multiply(tmpM.makeTranslation(ctr.x, ctr.y, ctr.z))).decompose(m.position, m.quaternion, m.scale);
  scene.add(m);
  dropped.push({ m, v: toWorldDir(vGun.clone().applyQuaternion(gunState.q)).add(charVelW).add(V((Math.random() - 0.5) * 20, 0, (Math.random() - 0.5) * 20)),
    w: V((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 6).multiplyScalar(spin), rest: false, hit: false });
  if (dropped.length > 10) scene.remove(dropped.shift().m);
}
function dropMag(c) { dropPart(c.mag, c.mag.matrix, c.magCenter, c.magAxis.clone().multiplyScalar(-90)); }
export function updateMags(dt) {
  for (const d of dropped) {
    if (d.rest) continue;
    d.v.y -= 981 * dt; d.m.position.addScaledVector(d.v, dt);
    d.m.rotation.x += d.w.x * dt; d.m.rotation.y += d.w.y * dt; d.m.rotation.z += d.w.z * dt;
    d.m.updateMatrixWorld(true);
    const lowest = new THREE.Box3().setFromObject(d.m).min.y;
    if (lowest < 0) {
      d.m.position.y -= lowest;
      if (!d.hit) { d.hit = true; playClick(700, 0.08, 0.35); }
      if (Math.abs(d.v.y) < 60) { d.rest = true; continue; }
      d.v.y = -d.v.y * 0.25; d.v.x *= 0.5; d.v.z *= 0.5; d.w.multiplyScalar(0.5);
    }
  }
}
// Key poses for the left hand (character space), evaluated each frame because the gun moves.
const _p1 = V(), _p2 = V(), _rq1 = new THREE.Quaternion(), _rq2 = new THREE.Quaternion(), _sc = V();
function rlKey(name, c) {
  const G = gunState.mat;
  switch (name) {
    case 'grip': return G.clone().multiply(handRel.l);
    case 'well': return G.clone().multiply(c.wellRel);
    case 'wellOut': return G.clone().multiply(tmpM.makeTranslation(c.magAxis.clone().multiplyScalar(-c.magDepth))).multiply(c.wellRel);
    case 'rack': return G.clone().multiply(c.rackRel);
    case 'rackBack': return G.clone().multiply(tmpM.makeTranslation(0, 0, -(c.slide ? SLIDE_TRAVEL : 4.4) - 1)).multiply(c.rackRel);
    case 'pouch': {
      const m = G.clone().multiply(c.wellRel); m.decompose(_p1, _rq1, _sc);
      const hip = worldPos(bones.thigh_l).add(V(5, -2, 9));
      return m.compose(hip, _rq1, _sc);
    }
  }
}
// Each key: [t, pose, arc(cm, char-space dir)]; 'mag' events fire when the segment starting at t begins.
function lerpKey(A, B, u, arc) {
  A.decompose(_p1, _rq1, _sc); B.decompose(_p2, _rq2, _sc);
  const e = ease(u), p = _p1.lerp(_p2, e);
  if (arc) p.addScaledVector(arc, Math.sin(Math.PI * u));
  return new THREE.Matrix4().compose(p, _rq1.slerp(_rq2, e), V(1, 1, 1));
}
export function stepReload(dt) {
  if (RL.pending >= 0 && STATE.simTime >= RL.pending && !RL.on) startReload();
  if (!RL.on) { RL.env = 0; return; }
  const c = W.cur;
  RL.t = RLT.on ? RLT.u : Math.min(1, RL.t + dt / RL.dur);   // reload timeline scrubs the time by hand
  const u = RL.t, ev = RL.ev, K = RL.key;
  const at = (name, t, fn) => { if (RLT.on) return; if (!ev[name] && u >= t) { ev[name] = true; fn(); } };
  if (c.name === 'shotgun') {
    RL.env = sstep(0, 0.12, u) * (1 - sstep(0.88, 1, u));
    RL.D = null;
    const shOff = V();
    let pumpZ = 0, gripPump = false;
    if (u < 0.20) {
      shOff.lerpVectors(V(0, 0, 0), V(4, -22, -24), ease(u / 0.20));
    } else if (u < 0.42) {
      shOff.lerpVectors(V(4, -22, -24), V(0, -2.5, -24), ease((u - 0.20) / 0.22));
    } else if (u < 0.60) {
      shOff.lerpVectors(V(0, -2.5, -24), V(0, 0, 0), ease((u - 0.42) / 0.18));
    } else if (u < 0.78) {
      gripPump = true;
      pumpZ = -7.2 * ease((u - 0.60) / 0.18);
      shOff.set(0, 0, pumpZ);
    } else if (u < 0.82) {
      gripPump = true;
      pumpZ = -7.2;
      shOff.set(0, 0, pumpZ);
    } else {
      gripPump = true;
      pumpZ = -7.2 * (1 - ease((u - 0.82) / 0.18));
      shOff.set(0, 0, pumpZ);
    }
    if (c.pump) c.pump.position.z = pumpZ;
    if (c.sgBolt) c.sgBolt.position.z = 1.5 + pumpZ * 0.75;
    RL.gripPump = gripPump;
    RL.frame = { l: c.J.l.map(p => p.clone().add(shOff)) };
    at('load', 0.42, () => {
      playSample('mag_in', { rate: 1.1 }) || playClick(1400, 0.05, 0.4);
      rec.up.kick(0.5);
    });
    at('rackBack', 0.64, () => {
      playSample('slide_rack', { rate: 0.95, gain: 0.85 }) || playClick(950, 0.07, 0.55);
      rec.back.kick(1.2); rec.flip.kick(-0.8);
    });
    at('rackFwd', 0.84, () => {
      playClick(1350, 0.045, 0.4);
      rec.back.kick(-0.7);
    });
    if (u >= 1) {
      RL.on = false; RL.env = 0; RL.frame = null; RL.gripPump = false;
      if (c.pump) c.pump.position.z = 0;
      if (c.sgBolt) c.sgBolt.position.z = 1.5;
      c.ammo = c.cap;
    }
    return;
  }
  if (c.name === 'rpg7') {
    RL.env = sstep(0, 0.12, u) * (1 - sstep(0.88, 1, u));
    RL.D = null;
    const rOff = V();
    if (u < 0.25) rOff.lerpVectors(V(0, 0, 0), V(8, -28, -14), ease(u / 0.25));
    else if (u < 0.50) rOff.lerpVectors(V(8, -28, -14), V(0, 3.5, 42), ease((u - 0.25) / 0.25));
    else if (u < 0.68) rOff.lerpVectors(V(0, 3.5, 42), V(0, 3.5, 32), ease((u - 0.50) / 0.18));
    else rOff.lerpVectors(V(0, 3.5, 32), V(0, 0, 0), ease((u - 0.68) / 0.32));
    RL.frame = { l: c.J.l.map(p => p.clone().add(rOff)) };
    if (RLT.on && c.warhead) c.warhead.visible = (u >= 0.30 || u < 0.02);
    at('grab', 0.28, () => playClick(900, 0.06, 0.25));
    at('load', 0.55, () => {
      if (c.warhead) c.warhead.visible = true;
      playSample('mag_in', { rate: 0.78 }) || playClick(750, 0.1, 0.6);
      rec.back.kick(1.2);
    });
    if (u >= 1) { RL.on = false; RL.env = 0; RL.frame = null; if (c.warhead) c.warhead.visible = true; c.ammo = c.cap; }
    return;
  }
  if (K && K.frames) {   // M4: hands, magazine, bolt and gun motion come straight from the animation pack
    RL.env = sstep(0, 0.08, u) * (1 - sstep(0.9, 1, u));
    const n = K.frames.length, x = Math.min(n - 1.001, u * (n - 1)), i = Math.floor(x), w = x - i;
    RL.frame = lerpFrame(K.frames[i], K.frames[i + 1], w);
    // Weapon motion relative to the FPS camera -> gun motion in front of the face (scaled down: the head moves too).
    RL.D = lerpM(new THREE.Matrix4(), K.frames[0].cam.clone().multiply(RL.frame.cam.clone().invert()), 0.7);
    if (RLT.on) {
      c.mag.visible = K.empty ? !(u >= K.release && u < K.low) : true;
      c.locked = !!(K.empty && K.boltRel > 0 && u < K.boltRel);
    }
    if (K.empty) at('release', K.release, () => { playClick(2600, 0.025, 0.3); c.mag.matrix.copy(RL.frame.mag); dropMag(c); c.mag.visible = false; });
    else at('release', K.release, () => playClick(2600, 0.025, 0.3));
    at('low', K.low, () => { c.mag.visible = true; playClick(900, 0.05, 0.15); });
    at('seat', K.seat, () => { playSample('mag_in', { rate: 0.92 }) || playClick(1500, 0.05, 0.5); rec.up.kick(0.6); c.ammo = c.cap; });
    if (K.boltRel > 0) at('boltRel', K.boltRel, () => { c.locked = false; playSample('slide_rack', { rate: 0.85, gain: 0.9 }) || playClick(1200, 0.07, 0.6); rec.back.kick(1.0); });
    if (u >= 1) { RL.on = false; RL.frame = null; c.mag.visible = true; c.locked = false; c.ammo = c.cap + (K.empty ? 0 : 1); }
    return;
  }
  if (K) {
    RL.env = sstep(0, 0.13, u) * (1 - sstep(0.86, 1, u));
    if (RLT.on) {
      c.mag.visible = !(u >= K.release && u < K.grab);
      RL.mag = (u >= K.grab && u < K.seat) ? 'hand' : null;
      c.locked = !!(RL.empty && u < (K.slam || 0.86));
    }
    if (K.rackAt) at('rackS', K.rackAt, () => playSample('slide_rack') || playClick(1300, 0.06, 0.5));
    at('release', K.release, () => { playClick(2600, 0.025, 0.3); dropMag(c); c.mag.visible = false; });
    at('grab', K.grab, () => { c.mag.visible = true; RL.mag = 'hand'; playClick(900, 0.05, 0.15); });
    at('seat', K.seat, () => { RL.mag = null; playSample('mag_in') || playClick(1500, 0.05, 0.5); rec.up.kick(0.6); c.ammo = c.cap - (RL.empty ? 1 : 0); });
    if (K.slam) at('slam', K.slam, () => { c.locked = false; c.ammo = c.cap; if (!K.rackAt) playClick(1200, 0.07, 0.6); rec.back.kick(1.2); rec.flip.kick(1.5); });
    if (u >= 1) {
      RL.on = false; RL.mag = null; c.mag.visible = true; c.locked = false;
      if (!RL.empty) c.ammo = c.cap + (c.name === 'pistol' ? 1 : 0);
      else c.ammo = c.cap;
      return;
    }
  }
}
// Gun cant + lift during the reload (about the grip, so the right hand stays put).
export function lerpM(a, b, w) {
  const p = V(), q = new THREE.Quaternion(), sc = V(), p2 = V(), q2 = new THREE.Quaternion(), s2 = V();
  a.decompose(p, q, sc); b.decompose(p2, q2, s2);
  return new THREE.Matrix4().compose(p.lerp(p2, w), q.slerp(q2, w), sc.lerp(s2, w));
}
function lerpFrame(a, b, w) {
  const L = (A, B) => A.map((p, i) => p.clone().lerp(B[i], w));
  return { r: L(a.r, b.r), l: L(a.l, b.l), mag: lerpM(a.mag, b.mag, w), bolt: lerpM(a.bolt, b.bolt, w), cat: lerpM(a.cat, b.cat, w), cam: lerpM(a.cam, b.cam, w) };
}
export function reloadGunPose(gb) {
  if (KA.on) { karGunPose(gb); return; }
  if (!RL.on || RL.external || RL.loading) return;
  if (RL.frame && RL.D) { gb.multiply(RL.D); return; }
  const c = W.cur, e = RL.env, pv = c.gripPivot || V(0, -6, -4);
  if (!c.rlPose) return;
  const seatBump = RL.ev.seat && RL.key ? Math.max(0, 1 - (RL.t - RL.key.seat) * RL.dur / 0.12) : 0;
  const R = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-c.rlPose.pitch * e * DEG, c.rlPose.yaw * e * DEG, c.rlPose.cant * e * DEG, 'YXZ'));
  gb.multiply(tmpM.makeTranslation(pv.x, pv.y, pv.z)).multiply(R).multiply(tmpM.makeTranslation(-pv.x, -pv.y + seatBump * 1.2, -pv.z));
  const o = c.rlPose.off;
  gb.premultiply(tmpM.makeTranslation(o.x * e, o.y * e, o.z * e));
}
export function reloadLeftHand() {
  const c = W.cur, K = RL.key, u = RL.t, path = K.path;
  let i = 0; while (i < path.length - 2 && u >= path[i + 1][0]) i++;
  const [t0, k0, arc] = path[i], [t1, k1] = path[i + 1];
  const w = clamp((u - t0) / Math.max(1e-4, t1 - t0), 0, 1);
  const M = lerpKey(rlKey(k0, c), rlKey(k1, c), w, arc);
  // Racking: the slide/bolt follows the hand back, then snaps forward on release.
  RL.rack = 0;
  if (k0 === 'rack' && k1 === 'rackBack') RL.rack = ease(w) * (c.slide ? SLIDE_TRAVEL : 4.4);
  if (k0 === 'rackBack' && k1 === 'rackBack') RL.rack = c.slide ? SLIDE_TRAVEL : 4.4;
  M.decompose(_hp, _hq, _hs);
  const up = bones.upperarm_l, lo = bones.lowerarm_l, hand = bones.hand_l;
  twoBoneIK(up, lo, hand, _hp, worldPos(lo).sub(worldPos(up)));
  setWorldQuat(hand, _hq);
  RL.err = +worldPos(hand).distanceTo(_hp).toFixed(1); RL.seg = k0 + '>' + k1;
  if (RL.mag === 'hand') {   // new magazine rides in the left hand until it seats
    hand.updateWorldMatrix(true, false);
    c.mag.matrix.copy(gunState.inv.clone().multiply(hand.matrixWorld).multiply(c.magInHand));
    c.mag.matrixAutoUpdate = false; c.mag.matrixWorldNeedsUpdate = true;
  } else if (!c.mag.matrixAutoUpdate) { c.mag.matrix.identity(); c.mag.matrixWorldNeedsUpdate = true; }
}

// ======================================================================
//  KAR98K ACTIONS  right hand works the bolt (lift, back, forward, down); reload = stripper clip
// ======================================================================
export const KA = { on: false, kind: '', t: 0, dur: 1, ev: {}, env: 0, lift: 0, pull: 0, press: 0, pending: -1, clipState: 'none' };
export const KA_DEF = {
  cycle: { dur: 1.05, pose: { cant: 7, pitch: -2, yaw: 2, off: V(0, -1, -1.5) },
    hand: [[0, 'grip'], [0.16, 'knob'], [0.70, 'knob'], [0.92, 'grip'], [1, 'grip']],
    lift: [[0, 0], [0.17, 0], [0.29, 1], [0.60, 1], [0.70, 0], [1, 0]],
    pull: [[0, 0], [0.30, 0], [0.45, 1], [0.47, 1], [0.60, 0], [1, 0]] },
  reload: { dur: 3.4, pose: { cant: 24, pitch: 12, yaw: -12, off: V(-3, -9, -12) },
    hand: [[0, 'grip'], [0.06, 'knob'], [0.20, 'knob'], [0.34, 'pouch'], [0.38, 'pouch'], [0.52, 'guide'], [0.56, 'guide'], [0.66, 'press'],
           [0.70, 'press'], [0.75, 'knob'], [0.86, 'knob'], [0.97, 'grip'], [1, 'grip']],
    lift: [[0, 0], [0.07, 0], [0.12, 1], [0.80, 1], [0.86, 0], [1, 0]],
    pull: [[0, 0], [0.12, 0], [0.19, 1], [0.76, 1], [0.80, 0], [1, 0]],
    press: [[0, 0], [0.56, 0], [0.66, 1], [1, 1]] },
};
function track(T, u) {
  let i = 0; while (i < T.length - 2 && u >= T[i + 1][0]) i++;
  const [t0, a] = T[i], [t1, b] = T[i + 1];
  return lerp(a, b, ease(clamp((u - t0) / Math.max(1e-4, t1 - t0), 0, 1)));
}
export function startKarAction(kind) {
  if (KA.on) return;
  Object.assign(KA, { on: true, kind, t: 0, ev: {}, pending: -1, dur: KA_DEF[kind].dur });
  releaseFire(); STATE.trigStart = -1;
}
function karKnob(lift, pull) { return KAR_KNOB.clone().applyAxisAngle(V(0, 0, 1), -lift * Math.PI / 2).add(V(0, 0, -pull * KAR_PULL)); }
// Right-hand shapes (gun space): the grip "fist" re-placed around the bolt knob, the hip pouch, the clip.
function karShape(name) {
  const c = W.list.kar, inv = gunState.inv, rq = new THREE.Quaternion().setFromRotationMatrix(inv);
  switch (name) {
    case 'grip': return { J: c.J.r, C: KAR_GRIP_FRAME.elements.slice(12, 15) };
    case 'knob': { const C = karKnob(KA.lift, KA.pull).add(V(-0.6, 0.4, -0.4));
      return { J: placeShape(c.J.r, KAR_GRIP_FRAME, frameM(V(-0.15, -1, -0.25), V(0.3, 0, 1), C)), C: C.toArray() }; }
    case 'pouch': { const C = V(-15, 98, 12).applyMatrix4(inv);
      return { J: placeShape(c.J.r, KAR_GRIP_FRAME, frameM(V(0, -1, 0.2).applyQuaternion(rq), V(0, 0, 1).applyQuaternion(rq), C)), C: C.toArray() }; }
    case 'guide': case 'press': { const C = CLIP_GUIDE.clone().add(V(-0.8, name === 'press' ? -0.4 : 3.6, -0.6));
      return { J: placeShape(c.J.r, KAR_GRIP_FRAME, frameM(V(0.1, -1, 0.1), V(0, 0.1, 1), C)), C: C.toArray() }; }
  }
}
export function karHandR() {
  const T = KA_DEF[KA.kind].hand, u = KA.t;
  let i = 0; while (i < T.length - 2 && u >= T[i + 1][0]) i++;
  const [t0, a] = T[i], [t1, b] = T[i + 1], w = ease(clamp((u - t0) / Math.max(1e-4, t1 - t0), 0, 1));
  const A = karShape(a), B = a === b ? A : karShape(b);
  const lift = a !== b && (a === 'pouch' || b === 'pouch') ? 5 * Math.sin(Math.PI * w) : 0;   // arc out from the body
  KA.anchor = V(...A.C).lerp(V(...B.C), w);
  return A.J.map((p, k) => p.clone().lerp(B.J[k], w).add(V(-lift * 0.6, lift, 0)));
}
export function stepKar(dt) {
  const c = W.cur;
  if (!c?.kar) return;
  if (!KA.on && KA.pending >= 0 && STATE.simTime >= KA.pending) { KA.pending = -1; startKarAction('cycle'); }
  if (!KA.on) { KA.env = 0; KA.lift = KA.pull = 0; return; }
  const D = KA_DEF[KA.kind];
  KA.t = (RLT.on && KA.kind === 'reload') ? RLT.u : Math.min(1, KA.t + dt / D.dur);
  const u = KA.t, ev = KA.ev, at = (n, t, fn) => { if (RLT.on) return; if (!ev[n] && u >= t) { ev[n] = true; fn(); } };
  KA.env = sstep(0, 0.14, u) * (1 - sstep(0.85, 1, u));
  KA.lift = track(D.lift, u); KA.pull = track(D.pull, u); KA.press = D.press ? track(D.press, u) : 0;
  if (KA.kind === 'cycle') {
    at('open', 0.2, () => { playSample('bolt', { rate: 1.1 }) || playClick(900, 0.05, 0.4); rec.shoulder.kick(1.2); rec.elbow.kick(1.5); });
    at('eject', 0.43, () => { ejectShell(); rec.armBack.kick(1.1); });
    at('close', 0.58, () => { playSample('slide_rack', { rate: 0.7, gain: 0.7 }) || playClick(1300, 0.05, 0.4); rec.shoulder.kick(-0.9); rec.armBack.kick(-0.8); });
    at('lock', 0.70, () => playClick(1600, 0.03, 0.35));
  } else {
    if (RLT.on) KA.clipState = (u < 0.36 || u >= 0.79) ? 'none' : u < 0.52 ? 'hand' : 'guide';
    at('open', 0.09, () => playSample('bolt', { rate: 1.1 }) || playClick(900, 0.05, 0.4));
    at('grab', 0.36, () => { KA.clipState = 'hand'; playClick(1100, 0.04, 0.2); });
    at('insert', 0.52, () => { KA.clipState = 'guide'; playSample('mag_in', { rate: 1.45 }) || playClick(1700, 0.04, 0.4); });
    at('rounds', 0.64, () => { c.ammo = c.cap; playClick(1300, 0.06, 0.35); });
    at('close', 0.78, () => { playSample('slide_rack', { rate: 0.7, gain: 0.7 }) || playClick(1300, 0.05, 0.4); });
    at('clipOut', 0.79, () => {   // closing the bolt kicks the empty clip out of the guides
      KA.clipState = 'none'; STATE.kar.clip.visible = false;
      dropPart(STATE.kar.clip, STATE.kar.clip.matrix, V(), V(-60, 160, 10), 2);
    });
    at('lock', 0.86, () => playClick(1600, 0.03, 0.35));
  }
  if (u >= 1) { KA.on = false; KA.lift = KA.pull = 0; }
}
function karGunPose(gb) {
  const P = KA_DEF[KA.kind].pose, e = KA.env, pv = V(0, -4, -18);
  const R = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-P.pitch * e * DEG, P.yaw * e * DEG, P.cant * e * DEG, 'YXZ'));
  gb.multiply(tmpM.makeTranslation(pv.x, pv.y, pv.z)).multiply(R).multiply(tmpM.makeTranslation(-pv.x, -pv.y, -pv.z));
  gb.premultiply(tmpM.makeTranslation(P.off.x * e, P.off.y * e, P.off.z * e));
}
export function updateKarParts() {
  STATE.kar.bolt.rotation.z = -KA.lift * Math.PI / 2; STATE.kar.bolt.position.z = -KA.pull * KAR_PULL;
  const clip = STATE.kar.clip;
  clip.visible = KA.on && KA.kind === 'reload' && KA.clipState !== 'none';
  if (!clip.visible) return;
  // In the hand the clip rides with the knuckles; seated it sits in the guides while the thumb strips the rounds down.
  const guideHand = karShape('guide').C, off = CLIP_GUIDE.clone().sub(V(...guideHand));
  clip.position.copy(KA.clipState === 'hand' ? KA.anchor.clone().add(off) : CLIP_GUIDE);
  clip.quaternion.identity(); clip.updateMatrix();
  for (const r of STATE.kar.rounds) { const y = r.userData.y0 - KA.press * 4.8; r.position.y = y; r.visible = y > -1.6; }
}

// ---------- weapons ----------
export const W = { list: {}, cur: null, next: null, swapT: -1, blend: 0, dip: 0, leftW: 1 };
export function equip(w) {
  if (W.cur) W.cur.obj.visible = false;
  W.cur = w; w.obj.visible = true;
  w.obj.add(flash); flash.position.copy(w.muzzle);
  const b = document.getElementById('weap'); if (b) b.textContent = w.label + ' ⇄';
  if (w.kar) STATE.kar.clip.visible = false;
}
const W_ORDER = ['pistol', 'rifle', 'shotgun', 'kar', 'rpg7'];
export function nextWeapon() { switchWeapon(W_ORDER[(W_ORDER.indexOf(W.cur.name) + 1) % W_ORDER.length]); }
export function switchWeapon(name) {
  if (!STATE.ready || W.swapT >= 0 || W.cur.name === name) return;
  if (game.active) setAimStage(0);
  if (RLT.on) {
    stopRlTimeline(true);
    equip(W.list[name]); W.blend = W.cur.long ? 1 : 0; W.swapT = -1; W.dip = 0; W.leftW = 1;
    startRlTimeline();
    return;
  }
  if (RL.on || KA.on) return;
  releaseFire(); W.next = W.list[name]; W.from = W.blend; W.swapT = 0;
}
// Lower the weapon, swap at the bottom of the dip, raise the new one; the upper-body pose crossfades.
export function stepSwap(dt) {
  if (W.swapT < 0) return;
  W.swapT = Math.min(1, W.swapT + dt / 0.8);
  const u = W.swapT, to = W.next.long ? 1 : 0;
  W.blend = lerp(W.from, to, sstep(0.2, 0.8, u));
  W.dip = Math.sin(Math.PI * u);
  W.leftW = clamp(Math.abs(1 - 2 * u) * 1.8 - 0.3, 0, 1);
  if (u >= 0.5 && W.cur !== W.next) equip(W.next);
  if (u >= 1) { W.swapT = -1; W.dip = 0; W.leftW = 1; W.blend = to; }
}
// Fit a long gun to the rifle pose: level bore along the right->left hand line, sight line through the right eye / shoulder pocket.
export function eyePos() { return worldPos(bones.head).add(V(-4.2, 4.8, 14.5).applyQuaternion(worldQuat(bones.head).multiply(restWorldQ.head.clone().invert()))); }
export function fitLong(eye) {
  const a = worldPos(bones.middle_01_r), b = worldPos(bones.middle_01_l);
  const D = b.clone().sub(a); D.y = 0; D.normalize();
  const up = V(0, 1, 0);
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(up, D), up, D));
  const origin = eyePos().sub(eye.clone().applyQuaternion(q));
  setGunMatrix(new THREE.Matrix4().compose(origin, q, V(1, 1, 1)));
  bones.hand_r.updateWorldMatrix(true, false);
  return bones.hand_r.matrixWorld.clone().invert().multiply(gunState.mat);
}
export function fire() {
  if (KA.on || SG_PUMP.on) return;
  if (game.active && BLOCK.w > 0.7) { playClick(900, 0.03, 0.2); return; }   // muzzle against a wall: weapon is raised, no shot
  if (W.cur.ammo <= 0 || RL.on) { if (!RL.on) { playClick(1800, 0.03, 0.25); scheduleReload(0.25); } return; }
  STATE.fireTime = STATE.simTime; STATE.ejected = false;
  const v = () => 0.85 + Math.random() * 0.3, cur = W.cur, k = cur.kick;
  cur.ammo--;
  if (cur.kar) { STATE.ejected = true; if (cur.ammo > 0) KA.pending = STATE.simTime + 0.3; else scheduleReload(0.45); }
  else if (cur.isRocket) {
    STATE.ejected = true;
    if (cur.warhead) cur.warhead.visible = false;
    scheduleReload(0.4);
  }
  else if (cur.pellets) {
    STATE.ejected = true; // Ejected when the left hand racks the pump slider back in stepShotgunPump
    SG_PUMP.on = true; SG_PUMP.t = 0; SG_PUMP.z = 0; SG_PUMP.ev = {};
  }
  else if (cur.ammo === 0) { cur.locked = true; scheduleReload(0.35); }
  rec.flip.kick(k.flip * v()); rec.back.kick(k.back * v()); rec.up.kick(k.up * v());
  rec.yaw.kick((Math.random() - 0.5) * k.yaw); rec.roll.kick(k.roll[0] + Math.random() * k.roll[1]);
  rec.cam.kick(k.cam * v());
  const shK = cur.shK ?? 0.4;
  rec.shoulder.kick(k.back * shK * 1.35 * v());
  rec.armBack.kick(k.back * shK * 1.15 * v());
  rec.elbow.kick(k.back * shK * 1.45 * v());
  const muzzleW = toWorld(fromGun(cur.muzzle)), fwd = toWorldDir(V(0, 0, 1).applyQuaternion(gunState.q));
  const spread = cur.spread * (game.active ? spreadMul() : 1);
  if (game.active) { addTrauma(cur.isRocket ? 0.55 : Math.min(0.3, 0.03 + 0.04 * (k.cam || 0))); bloomKick(cur.pellets ? 0.35 : cur.auto ? 0.07 : 0.2); }
  spawnMuzzleFX(muzzleW, new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), STATE.charYaw).multiply(gunState.q), fwd, cur.flashS * (0.9 + Math.random() * 0.2));
  if (cur.isRocket) {
    launchRocket(muzzleW, fwd);
    playSample('rifle_tail', { gain: 1.2, rate: 0.6 });
  } else if (cur.pellets) {
    if (game.active) {
      for (let p = 0; p < cur.pellets; p++) {
        const spreadVec = V((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread);
        shootRay(muzzleW, fwd.clone().add(spreadVec).normalize(), cur.dmg);
      }
    }
  } else {
    if (cur.auto) for (const k of ['hx', 'hy', 'hz']) rec[k].kick((Math.random() - 0.5) * (k === 'hx' ? 9 : 6));
    if (game.active) shootRay(muzzleW, fwd.clone().add(V(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(spread)).normalize(), cur.dmg);
  }
  playShot(STATE.timeScale < 1 ? 0.55 : 1, cur);
  if (AI.on) onPlayerGunshot();
  if (cur.auto) STATE.burstN++;
}
export function slideOffset(t) {
  if (t < 0 || t > 0.06) return 0;
  if (t < 0.012) { const u = t / 0.012; return SLIDE_TRAVEL * (1 - (1 - u) * (1 - u)); }
  if (t < 0.016) return SLIDE_TRAVEL;
  if (t < 0.046) { const u = (t - 0.016) / 0.03; return SLIDE_TRAVEL * (1 - u * u); }
  return -0.12 * Math.sin(((t - 0.046) / 0.014) * Math.PI); // battery bounce
}
function triggerValue() {
  if (STATE.trigStart < 0) return 0;
  const t = STATE.simTime - STATE.trigStart;
  if (t < TRIG_PRESS) return (t / TRIG_PRESS) ** 2;
  if (!STATE.fired) { STATE.fired = true; fire(); }
  if (t < TRIG_PRESS + TRIG_HOLD) return 1;
  if (t < TRIG_PRESS + TRIG_HOLD + TRIG_RELEASE) return 1 - (t - TRIG_PRESS - TRIG_HOLD) / TRIG_RELEASE;
  STATE.trigStart = -1; return 0;
}
