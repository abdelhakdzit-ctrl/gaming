import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { IS_TOUCH, params } from './state.js';

// ---------- scene ----------
export const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
// Resolution adapts to the measured frame time (see perfGovernor); phones start at 1.5x.
const PERF = { prMax: Math.min(devicePixelRatio, IS_TOUCH ? 1.5 : 2), prMin: Math.min(devicePixelRatio, 1), pr: 1, ema: 1 / 60, t: 0, slow: 0 };
PERF.pr = PERF.prMax;
renderer.setPixelRatio(PERF.pr);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
document.getElementById('app').appendChild(renderer.domElement);

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1e23);
scene.fog = new THREE.Fog(0x1b1e23, 600, 1400);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;

export const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 1, 5000);
export const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.mouseButtons.RIGHT = null;   // Right-click is reserved for Aiming (ADS); middle-drag or Shift+Left-drag pans
controls.target.set(0, 95, 10);

scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3f47, 1.3));
export const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(180, 380, 220);
sun.castShadow = true;
sun.shadow.mapSize.set(IS_TOUCH ? 1024 : 2048, IS_TOUCH ? 1024 : 2048);
sun.shadow.bias = -0.0005;
Object.assign(sun.shadow.camera, { left: -200, right: 200, top: 250, bottom: -100, near: 10, far: 1000 });
scene.add(sun);
const rim = new THREE.DirectionalLight(0x9fc3ff, 1.0);
const SUN_STUDIO = new THREE.Color(0xffffff), SUN_DUSK = new THREE.Color(0xffe2bd);
rim.position.set(-250, 200, -250);
scene.add(rim);

export const charRoot = new THREE.Group();   // world placement of the character; identity while solving
scene.add(charRoot);
scene.add(sun.target);
export const GROUND_Y = 0;
export const ground = new THREE.Mesh(new THREE.CircleGeometry(9000, 96),
  new THREE.MeshStandardMaterial({ color: 0x5d7a80, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
export const grid = new THREE.GridHelper(800, 40, 0x7f9aa0, 0x6a8890);
grid.position.y = 0.05;
grid.material.opacity = 0.35; grid.material.transparent = true;
scene.add(grid);

// Lower the resolution while frames run slow (phones), raise it back when there is headroom.
export function perfGovernor(raw) {
  if (params.has('sim') || params.has('test') || params.has('harness')) return;
  PERF.ema += (Math.min(raw, 0.25) - PERF.ema) * 0.08; PERF.t += raw;
  if (PERF.t < 1.5) return;
  PERF.t = 0;
  let pr = PERF.pr;
  if (PERF.ema > 1 / 48) pr = Math.max(PERF.prMin, pr - 0.15);
  else if (PERF.ema < 1 / 57) pr = Math.min(PERF.prMax, pr + 0.1);
  if (Math.abs(pr - PERF.pr) > 0.01) { PERF.pr = pr; renderer.setPixelRatio(pr); renderer.setSize(innerWidth, innerHeight); }
  // Still slow at the lowest resolution: drop the sun shadow (one-time shader rebuild).
  if (IS_TOUCH && pr <= PERF.prMin + 0.01 && PERF.ema > 1 / 36 && sun.castShadow) { if (++PERF.slow >= 2) sun.castShadow = false; } else PERF.slow = 0;
}

// ---------- game atmosphere: dusk sky dome, matching fog and a warmer sun (studio look is restored on exit) ----------
const HORIZON = new THREE.Color(0x56697a), STUDIO_FOG = new THREE.Color(0x1b1e23);
const dome = new THREE.Mesh(new THREE.SphereGeometry(4600, 24, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { top: { value: new THREE.Color(0x172233) }, mid: { value: new THREE.Color(0x3d5266) }, hor: { value: HORIZON }, glow: { value: new THREE.Color(0xd8925a) } },
  vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform vec3 top, mid, hor, glow; varying vec3 vP; void main(){ float h = vP.y; vec3 c = mix(hor, mid, smoothstep(0.0, 0.25, h)); c = mix(c, top, smoothstep(0.2, 0.9, h));'
    + ' float s = max(dot(normalize(vP.xz + 1e-4), normalize(vec2(180.0, 220.0))), 0.0); c += glow * pow(s, 6.0) * (1.0 - smoothstep(0.0, 0.35, abs(h))) * 0.35;'
    + ' c = mix(c, hor, step(h, 0.0)); gl_FragColor = vec4(c, 1.0); }'
}));
dome.visible = false; dome.matrixAutoUpdate = false; dome.renderOrder = -10; dome.frustumCulled = false;
dome.onBeforeRender = (r, sc, cam) => { dome.matrixWorld.setPosition(cam.position); };   // follow the camera without a per-frame hook
scene.add(dome);
export function setAtmosphere(on) {
  dome.visible = on;
  scene.fog.color.copy(on ? HORIZON : STUDIO_FOG);
  scene.background.copy(on ? HORIZON : STUDIO_FOG);
  scene.fog.near = on ? 1400 : 600; scene.fog.far = on ? 5200 : 1400;
  sun.color.copy(on ? SUN_DUSK : SUN_STUDIO); sun.intensity = on ? 2.7 : 2.4;
  rim.intensity = on ? 1.3 : 1.0;
}
