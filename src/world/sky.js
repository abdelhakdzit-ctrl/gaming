import * as THREE from 'three';
import { BillboardBatch } from './billboards.js';
import { smoothstep, rand } from '../util/math.js';

const col = (r, g, b) => new THREE.Color(r, g, b);
export const TIMES = {
  night:  { elev: 38, az: 140, sun: col(0.5, 0.62, 1.0), sunI: 0.75, hemiSky: col(0.1, 0.14, 0.26), hemiGnd: col(0.04, 0.05, 0.07), hemiI: 1.1, top: col(0.004, 0.01, 0.035), horizon: col(0.05, 0.08, 0.16), fog: col(0.035, 0.055, 0.1), stars: 1, exposure: 1.25, sea: col(0.02, 0.05, 0.1), cloud: 0.18, lights: 1 },
  dawn:   { elev: 7, az: 100, sun: col(1, 0.62, 0.4), sunI: 2.4, hemiSky: col(0.42, 0.48, 0.7), hemiGnd: col(0.3, 0.24, 0.22), hemiI: 0.9, top: col(0.1, 0.2, 0.45), horizon: col(1.0, 0.58, 0.4), fog: col(0.72, 0.5, 0.45), stars: 0.15, exposure: 1.0, sea: col(0.1, 0.17, 0.26), cloud: 0.85, lights: 0.4 },
  day:    { elev: 55, az: 170, sun: col(1, 0.95, 0.86), sunI: 3.1, hemiSky: col(0.6, 0.75, 1), hemiGnd: col(0.42, 0.38, 0.32), hemiI: 1.15, top: col(0.1, 0.3, 0.72), horizon: col(0.62, 0.78, 0.93), fog: col(0.62, 0.74, 0.88), stars: 0, exposure: 0.95, sea: col(0.04, 0.2, 0.3), cloud: 1.0, lights: 0 },
  sunset: { elev: 5, az: 262, sun: col(1, 0.48, 0.22), sunI: 2.5, hemiSky: col(0.48, 0.42, 0.6), hemiGnd: col(0.3, 0.2, 0.17), hemiI: 0.9, top: col(0.08, 0.14, 0.36), horizon: col(1, 0.42, 0.18), fog: col(0.78, 0.46, 0.34), stars: 0.2, exposure: 1.0, sea: col(0.12, 0.13, 0.22), cloud: 0.9, lights: 0.5 }
};
export const WEATHERS = {
  clear:  { fog: 1, clouds: 0.25, dark: 0, tint: null, lightning: false },
  cloudy: { fog: 1.5, clouds: 0.8, dark: 0.3, tint: null, lightning: false },
  fog:    { fog: 6, clouds: 0.3, dark: 0.1, tint: col(0.75, 0.78, 0.8), lightning: false },
  storm:  { fog: 2.8, clouds: 1, dark: 0.75, tint: col(0.28, 0.3, 0.34), lightning: true },
  dust:   { fog: 3.6, clouds: 0.12, dark: 0.15, tint: col(0.82, 0.6, 0.34), lightning: false }
};

const skyVert = `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`;
const skyFrag = `
uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunColor; uniform float stars; uniform float flash; uniform vec3 below;
varying vec3 vDir;
float hash(vec3 p){ p = fract(p * 0.3183099 + .1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main(){
  vec3 d = normalize(vDir); float h = d.y;
  vec3 c = mix(horizon, top, pow(clamp(h, 0.0, 1.0), 0.45));
  c = mix(c, below, smoothstep(0.0, -0.12, h));
  float sd = max(dot(d, sunDir), 0.0);
  c += sunColor * (pow(sd, 6.0) * 0.28 + pow(sd, 64.0) * 0.5 + smoothstep(0.9993, 0.9997, sd) * 6.0);
  vec3 sc = d * 220.0; vec3 sp = floor(sc); float rnd = hash(sp);
  float star = step(0.9972, rnd) * smoothstep(0.42, 0.0, length(fract(sc) - 0.5)) * stars * smoothstep(0.02, 0.3, h);
  c += vec3(star) * (0.4 + 0.9 * hash(sp + 3.1));
  c += vec3(0.7, 0.75, 1.0) * flash;
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function cloudTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  for (let i = 0; i < 22; i++) {
    const x = 64 + (Math.random() - 0.5) * 60, y = 64 + (Math.random() - 0.5) * 36, r = 18 + Math.random() * 26;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class Sky {
  constructor(scene) {
    this.scene = scene;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: skyVert, fragmentShader: skyFrag, side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color() }, stars: { value: 0 }, flash: { value: 0 }, below: { value: new THREE.Color() } }
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.mat);
    this.dome.scale.setScalar(80000); this.dome.frustumCulled = false; this.dome.renderOrder = -10;
    scene.add(this.dome);
    this.sun = new THREE.DirectionalLight(0xffffff, 1); this.sun.position.set(0, 1, 0);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    scene.add(this.sun, this.sun.target, this.hemi);
    scene.fog = new THREE.FogExp2(0x88aacc, 0.00004);
    this.clouds = new BillboardBatch(520, { texture: cloudTexture() });
    scene.add(this.clouds.mesh);
    this.cloudData = [];
    this.flashT = 0; this.nextFlash = 5; this.lightning = false;
    this.cfg = null; this.time = 'day'; this.sunDirV = new THREE.Vector3();
  }

  /** Apply a time-of-day + weather preset. */
  set({ time = 'day', weather = 'clear', fogTint = [1, 1, 1] }) {
    const T = TIMES[time] || TIMES.day, W = WEATHERS[weather] || WEATHERS.clear;
    this.time = time; this.weather = weather; this.T = T; this.W = W;
    const el = (T.elev * Math.PI) / 180, az = (T.az * Math.PI) / 180;
    this.sunDirV.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    const u = this.mat.uniforms;
    const tint = W.tint;
    const horizon = T.horizon.clone(), top = T.top.clone(), fog = T.fog.clone();
    fog.r *= fogTint[0]; fog.g *= fogTint[1]; fog.b *= fogTint[2];
    if (tint) {
      const k = Math.max(0.12, T.cloud * 0.8);
      const tc = tint.clone().multiplyScalar(k);
      const amt = weather === 'dust' ? 0.75 : 0.65;
      horizon.lerp(tc, amt); top.lerp(tc, amt * 0.8); fog.lerp(tc, amt);
    }
    u.top.value.copy(top); u.horizon.value.copy(horizon); u.below.value.copy(fog).multiplyScalar(0.8);
    u.sunDir.value.copy(this.sunDirV); u.sunColor.value.copy(T.sun); u.stars.value = T.stars * (weather === 'storm' ? 0 : 1);
    this.sun.color.copy(T.sun); this.sun.intensity = T.sunI * (1 - W.dark * 0.65);
    this.hemi.color.copy(T.hemiSky); this.hemi.groundColor.copy(T.hemiGnd); this.hemi.intensity = T.hemiI;
    this.fogColor = fog;
    this.scene.fog.color.copy(fog); this.baseDensity = 0.000036 * W.fog * (time === 'night' ? 1.2 : 1);
    this.scene.fog.density = this.baseDensity;
    this.exposure = T.exposure; this.lightning = W.lightning;
    this.seaColor = T.sea.clone(); this.lightsAmount = T.lights;
    // clouds
    const n = Math.floor(120 * W.clouds + 10);
    this.cloudData.length = 0;
    const cc = T.sun.clone().lerp(horizon, 0.5).multiplyScalar(Math.max(0.1, T.cloud) * (1 - W.dark * 0.65));
    if (T.cloud < 0.3) cc.copy(horizon).multiplyScalar(0.7).addScalar(0.02);
    this.cloudColor = cc;
    for (let i = 0; i < n; i++) {
      const cx = rand(-28000, 28000), cz = rand(-28000, 28000), cy = rand(1400, 4600) * (weather === 'storm' ? 0.75 : 1);
      const k = 3 + Math.floor(Math.random() * 3);
      for (let j = 0; j < k; j++) this.cloudData.push({ x: cx + rand(-700, 700), y: cy + rand(-120, 120), z: cz + rand(-700, 700), s: rand(900, 2400), a: rand(0.45, 0.9), r: rand(0, 6.28) });
    }
  }

  update(dt, camPos, particlesFog) {
    this.dome.position.copy(camPos);
    // lightning
    let flash = 0;
    if (this.lightning) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) { this.flashT = 0.35; this.nextFlash = rand(3.5, 9); }
      if (this.flashT > 0) { this.flashT -= dt; flash = Math.max(0, Math.sin(this.flashT * 30)) * this.flashT * 1.2; }
    }
    this.mat.uniforms.flash.value = flash * 0.8;
    this.hemi.intensity = this.T.hemiI + flash * 3;
    this.scene.fog.density = this.baseDensity;
    // clouds wrap around the camera
    const L = 28000, cb = this.clouds; cb.begin();
    const c = this.cloudColor, lf = 1 + flash * 4;
    for (const q of this.cloudData) {
      let dx = q.x - camPos.x, dz = q.z - camPos.z;
      dx = ((dx + L) % (2 * L) + 2 * L) % (2 * L) - L; dz = ((dz + L) % (2 * L) + 2 * L) % (2 * L) - L;
      const dy = q.y - camPos.y, dist = Math.hypot(dx, dy, dz);
      const near = smoothstep(350, 1500, dist), far = 1 - smoothstep(18000, 27000, Math.hypot(dx, dz));
      cb.push(camPos.x + dx, q.y, camPos.z + dz, q.s, c.r * lf, c.g * lf, c.b * lf, q.a * near * far, q.r);
    }
    cb.end();
    cb.setFog(this.scene.fog.color, this.scene.fog.density * 0.5);
    return this.exposure;
  }
}
