import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { Retargeter } from './Retarget.js';
import { CLIPS } from '../data/clips.js';

export const asset = p => new URL('../../assets/' + p, import.meta.url).href;

// Loads the Mannequin, bakes animation clips onto it, and extracts static pose sources.
export class Assets {
  constructor() {
    this.loader = new FBXLoader();
    this.clips = new Map(); this.poses = new Map(); this.pending = new Map();
  }
  async init(onProgress = () => {}) {
    const warn = console.warn;
    console.warn = (...a) => { if (!String(a[0]).includes('TGA')) warn(...a); };
    try { this.template = await this.loader.loadAsync(asset('model/Mannequin.FBX')); }
    finally { console.warn = warn; }
    this.template.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
    this.retarget = new Retargeter(this.template);
    const names = Object.keys(CLIPS).filter(n => CLIPS[n].preload !== false && n !== 'idle');
    await this.getClip('idle'); // first: fixes the source->target pelvis scale
    let done = 0;
    await Promise.all(names.map(async n => { await this.getClip(n); onProgress(++done / names.length); }));
  }
  async getClip(name) {
    if (this.clips.has(name)) return this.clips.get(name);
    if (this.pending.has(name)) return this.pending.get(name);
    const def = CLIPS[name]; if (!def) throw new Error('Unknown clip ' + name);
    const p = this.loader.loadAsync(asset(`animations/${def.file}.fbx`)).then(src => {
      const clip = this.retarget.bake(src, name, { loop: !!def.loop });
      this.clips.set(name, clip); return clip;
    });
    this.pending.set(name, p); return p;
  }
  // Static pose (first-frame quaternions per bone) from a UE-skeleton FBX such as A_AR_Aim_Fwd.
  async getPose(file) {
    if (this.poses.has(file)) return this.poses.get(file);
    const src = await this.loader.loadAsync(asset(`anim/${file}.FBX`));
    const pose = new Map();
    for (const tr of src.animations[0].tracks) {
      const [bone, prop] = tr.name.split('.');
      if (prop === 'quaternion') pose.set(bone, new THREE.Quaternion().fromArray(tr.values, 0));
    }
    this.poses.set(file, pose); return pose;
  }
}
