import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Upper-body + weapon poses baked from legacy-viewer's grip solver (dev/bake). Each weapon has sequences
// (aim loop, low, fire, reload, reloadEmpty, cycle); a frame holds:
//   q      local quaternions of the upper-body bones (incl. fitted fingers)
//   s1     spine_01 orientation in character space
//   gun    weapon transform in hand_r space (cm)
//   handL  support hand in weapon space (IK target)
//   parts  animated weapon nodes (slide, bolt, magazine, clip...) as local matrices + visibility
export class Pose {
  constructor(nb) {
    this.q = new Float32Array(nb * 4); this.s1 = new THREE.Quaternion();
    this.gunP = new THREE.Vector3(); this.gunQ = new THREE.Quaternion();
    this.hlP = new THREE.Vector3(); this.hlQ = new THREE.Quaternion();
    this.parts = new Map();
  }
  copy(o) {
    this.q.set(o.q); this.s1.copy(o.s1); this.gunP.copy(o.gunP); this.gunQ.copy(o.gunQ); this.hlP.copy(o.hlP); this.hlQ.copy(o.hlQ);
    for (const [k, v] of o.parts) this.part(k).copyFrom(v);
    return this;
  }
  part(k) { let p = this.parts.get(k); if (!p) { p = new Part(); this.parts.set(k, p); } return p; }
  // this = mix(this, o, w)
  mix(o, w) {
    if (w <= 0) return this; if (w >= 1) return this.copy(o);
    nlerpArr(this.q, this.q, o.q, w);
    this.s1.slerp(o.s1, w); this.gunP.lerp(o.gunP, w); this.gunQ.slerp(o.gunQ, w); this.hlP.lerp(o.hlP, w); this.hlQ.slerp(o.hlQ, w);
    for (const [k, v] of o.parts) { const p = this.part(k); p.p.lerp(v.p, w); p.q.slerp(v.q, w); if (w > 0.5) p.vis = v.vis; }
    return this;
  }
  gunMatrix(m) { return m.compose(this.gunP, this.gunQ, ONE); }
  handLMatrix(m) { return m.compose(this.hlP, this.hlQ, ONE); }
}
class Part {
  constructor() { this.p = new THREE.Vector3(); this.q = new THREE.Quaternion(); this.s = new THREE.Vector3(1, 1, 1); this.vis = true; }
  copyFrom(o) { this.p.copy(o.p); this.q.copy(o.q); this.s.copy(o.s); this.vis = o.vis; return this; }
}
const ONE = new THREE.Vector3(1, 1, 1);
function nlerpArr(out, a, b, w) {
  for (let i = 0; i < out.length; i += 4) {
    const d = a[i] * b[i] + a[i + 1] * b[i + 1] + a[i + 2] * b[i + 2] + a[i + 3] * b[i + 3], s = d < 0 ? -w : w;
    let x = a[i] * (1 - w) + b[i] * s, y = a[i + 1] * (1 - w) + b[i + 1] * s, z = a[i + 2] * (1 - w) + b[i + 2] * s, q = a[i + 3] * (1 - w) + b[i + 3] * s;
    const l = Math.hypot(x, y, z, q) || 1; out[i] = x / l; out[i + 1] = y / l; out[i + 2] = z / l; out[i + 3] = q / l;
  }
}

class Sequence {
  constructor(src, nb) {
    this.fps = src.fps; const m = new THREE.Matrix4(), s = new THREE.Vector3();
    this.frames = src.frames.map(f => {
      const p = new Pose(nb); p.q.set(f.q); p.s1.fromArray(f.s1);
      m.fromArray(f.gun).decompose(p.gunP, p.gunQ, s); m.fromArray(f.handL).decompose(p.hlP, p.hlQ, s);
      for (const [k, v] of Object.entries(f.parts)) { const pt = p.part(k); m.fromArray(v).decompose(pt.p, pt.q, pt.s); pt.vis = v[16] === 1; }
      return p;
    });
    this.duration = (this.frames.length - 1) / this.fps;
  }
  sample(t, out, loop = false) {
    const n = this.frames.length; if (n === 1) return out.copy(this.frames[0]);
    let x = t * this.fps; x = loop ? ((x % (n - 1)) + (n - 1)) % (n - 1) : Math.min(n - 1.0001, Math.max(0, x));
    const i = Math.floor(x); return out.copy(this.frames[i]).mix(this.frames[i + 1], x - i);
  }
}

export class GripLibrary {
  async load(base) {
    const data = await (await fetch(new URL('src/data/grips.json', base))).json();
    this.bones = data.bones; this.weapons = {};
    const loader = new GLTFLoader();
    await Promise.all(Object.entries(data.weapons).map(async ([id, w]) => {
      const gltf = await loader.loadAsync(new URL(`assets/weapons/${id}.glb`, base).href);
      const seqs = {}; for (const [k, s] of Object.entries(w.seqs)) seqs[k] = new Sequence(s, this.bones.length);
      this.weapons[id] = { id, meta: w.meta, seqs, scene: gltf.scene };
    }));
  }
  get(id) { return this.weapons[id]; }
  newPose() { return new Pose(this.bones.length); }
  // Weapon model instance (cm, weapon space) with its animated parts indexed by name and a muzzle marker.
  instance(id) {
    const w = this.weapons[id], root = w.scene.clone(true);
    root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    const parts = new Map();
    for (const name of Object.keys(w.meta.initialVisible)) {
      const o = root.getObjectByName(name); if (!o) continue;
      o.matrixAutoUpdate = false; o.updateMatrix(); parts.set(name, o);
    }
    const muzzle = new THREE.Object3D(); muzzle.position.fromArray(w.meta.muzzle); root.add(muzzle);
    root.userData = { id, parts, muzzle, meta: w.meta };
    return root;
  }
}
