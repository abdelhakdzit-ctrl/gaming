import * as THREE from 'three';
import { V, rnd, sstep } from './math.js';
import { IS_TOUCH, STATE, rec } from './state.js';
import { GROUND_Y, camera, renderer, scene } from './scene.js';
import { audio, noiseBuf } from './audio.js';
import { charVelW, toWorld, toWorldDir } from './locomotion.js';
import { W, fromGun, gunState, updateMags } from './weapons.js';
import { tmpM, tmpQ } from './character.js';
import { AI, ARENA, castWorld, killEnemy } from './ai.js';
import { game, hitMarker, playDing, popup } from './game.js';

// Rocket projectiles & ballistics
const ACTIVE_ROCKETS = [];
function createRocketMesh() {
  const g = new THREE.Group();
  const steelDark = new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.45, metalness: 0.8 });
  const oliveGreen = new THREE.MeshStandardMaterial({ color: 0x3b4d2e, roughness: 0.6, metalness: 0.15 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x5a5e66, roughness: 0.25, metalness: 0.95 });
  const cyl = (r1, r2, len, mat, z, seg = 14) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, seg), mat);
    m.rotation.x = Math.PI / 2; m.position.z = z; return m;
  };
  g.add(cyl(1.9, 1.9, 32, steelDark, -12));
  g.add(cyl(2.2, 4.4, 7.0, oliveGreen, 6));
  g.add(cyl(4.4, 4.4, 6.0, oliveGreen, 12.5));
  g.add(cyl(4.4, 1.2, 14.0, oliveGreen, 22.5));
  g.add(cyl(1.0, 0.4, 5.0, steelMat, 32));
  for (let a = 0; a < 4; a++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 5.0, 6.0), steelDark);
    fin.rotation.z = (a * Math.PI) / 2;
    fin.position.z = -24;
    g.add(fin);
  }
  return g;
}

export function launchRocket(pos, dir) {
  const m = createRocketMesh();
  m.position.copy(pos);
  m.quaternion.setFromUnitVectors(V(0, 0, 1), dir);
  scene.add(m);
  ACTIVE_ROCKETS.push({
    mesh: m,
    pos: pos.clone(),
    dir: dir.clone(),
    speed: 3800,
    life: 5.0,
    age: 0
  });
}

function updateRockets(dt) {
  for (let i = ACTIVE_ROCKETS.length - 1; i >= 0; i--) {
    const r = ACTIVE_ROCKETS[i];
    r.age += dt;
    if (r.age >= r.life) {
      explodeRocket(r.pos, r.dir);
      scene.remove(r.mesh);
      ACTIVE_ROCKETS.splice(i, 1);
      continue;
    }
    const step = r.speed * dt;
    const nextPos = r.pos.clone().addScaledVector(r.dir, step);
    const hit = castWorld(r.pos, r.dir, step + 20);
    spawnSmoke(r.pos.clone().addScaledVector(r.dir, -15), V((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40), 10, 0.4, [0.85, 0.8, 0.7], 0.7);
    for (let k = 0; k < 2; k++) {
      const e = embers[emberIdx++ % NE];
      e.p.copy(r.pos);
      e.v.copy(r.dir).multiplyScalar(-300).add(V((Math.random() - 0.5) * 80, (Math.random() - 0.5) * 80, (Math.random() - 0.5) * 80));
      e.age = 0; e.life = 0.25;
    }
    if (hit && hit.kind !== 'none') {
      explodeRocket(hit.point, r.dir);
      scene.remove(r.mesh);
      ACTIVE_ROCKETS.splice(i, 1);
      continue;
    }
    r.pos.copy(nextPos);
    r.mesh.position.copy(r.pos);
  }
}

function playExplosionSound() {
  if (!STATE.soundOn) return;
  const ac = audio(); if (!ac) return;
  const t = ac.currentTime;
  const osc = ac.createOscillator(), og = ac.createGain();
  osc.frequency.setValueAtTime(120, t);
  osc.frequency.exponentialRampToValueAtTime(25, t + 0.45);
  og.gain.setValueAtTime(1.0, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
  osc.connect(og).connect(ac.destination);
  osc.start(t); osc.stop(t + 0.95);
  if (noiseBuf) {
    const boom = ac.createBufferSource();
    boom.buffer = noiseBuf;
    boom.playbackRate.value = 0.45;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(4500, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 0.8);
    const bg = ac.createGain();
    bg.gain.setValueAtTime(1.2, t);
    bg.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
    boom.connect(lp).connect(bg).connect(ac.destination);
    boom.start(t); boom.stop(t + 1.85);
  }
}

function explodeRocket(point, dir) {
  rec.cam.kick(2.4);
  rec.back.kick(3.2);
  rec.flip.kick(4.0);

  flashLight.position.copy(point);
  flashLight.intensity = 150000;
  glow = 2.0;

  burst(point, V(0, 1, 0), 0xff5500);
  burst(point, V(0, 1, 0), 0xffaa00);
  for (let i = 0; i < 12; i++) {
    const v = V(rnd(-180, 180), rnd(60, 240), rnd(-180, 180));
    spawnSmoke(point.clone().add(V(rnd(-20, 20), rnd(0, 30), rnd(-20, 20))), v, 32, 1.6, [0.22, 0.21, 0.21], 0.9);
  }
  for (let i = 0; i < 20; i++) {
    const e = embers[emberIdx++ % NE];
    e.p.copy(point);
    e.v.set(rnd(-500, 500), rnd(100, 600), rnd(-500, 500));
    e.age = 0; e.life = 0.6 + Math.random() * 0.8;
  }

  impactFX(point, dir.clone().negate(), 'concrete');
  playExplosionSound();

  const BLAST_R = 480;
  if (AI.on) {
    for (const e of AI.enemies) {
      if (!e.alive) continue;
      const d = e.pos.distanceTo(point);
      if (d < BLAST_R) {
        const falloff = 1 - d / BLAST_R;
        const blastDmg = Math.round(250 * falloff);
        e.hp -= blastDmg;
        e.flinch.kick(1.2 * falloff);
        e.suppress += 4.0;
        const blastDir = e.pos.clone().sub(point).normalize();
        if (blastDir.lengthSq() < 1e-4) blastDir.set(0, 0, 1);
        impactFX(e.pos.clone().add(V(0, 100, 0)), blastDir, 'blood');
        if (e.hp <= 0) {
          killEnemy(e, blastDir);
          game.score += 150;
          AI.kills++;
          hitMarker(true);
          popup('BLAST KILL +150', e.pos.clone().add(V(0, 130, 0)));
          playDing(0, 1200);
        } else {
          hitMarker(false);
        }
      }
    }
  }

  for (const t of (ARENA.targets || [])) {
    if (t.mesh && t.mesh.position.distanceTo(point) < BLAST_R) {
      if (t.kind === 'plate') { t.swing.kick(1.5); }
      else if (!t.down) {
        t.down = true; t.timer = 3.5; t.fall.target = -1.5; t.fall.kick(-1.2);
        game.score += 100;
        playDing(0.1, 520);
      }
    }
  }
}

// ---------- FX ----------
export function radialTexture(stops, size = 128) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach(([o, col]) => gr.addColorStop(o, col));
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}
const fxAdd = { blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false };
export const flash = new THREE.Group();   // muzzle anchor on the equipped gun
const flashLight = new THREE.PointLight(0xffa860, 0, 0, 2);   // inverse-square (world units are cm)
scene.add(flashLight);   // never hidden: changing the light count would recompile every lit material

// ---------- volumetric muzzle fire + smoke (ray-marched; from pistol-fire-3d.html) ----------
// Volume space: +X along the barrel, 1 unit = VOL_UNIT cm * weapon size.
const VOL_VS='varying vec3 vP;void main(){vP=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}';
const COMMON=`precision highp float;varying vec3 vP;uniform vec3 uRo,uB0,uB1;uniform float uAge,uT,uSeed,uGain;
float h3(vec3 p){p=fract(p*.3183099+.1);p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float vn3(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.-2.*f);
 return mix(mix(mix(h3(i),h3(i+vec3(1.,0.,0.)),f.x),mix(h3(i+vec3(0.,1.,0.)),h3(i+vec3(1.,1.,0.)),f.x),f.y),
            mix(mix(h3(i+vec3(0.,0.,1.)),h3(i+vec3(1.,0.,1.)),f.x),mix(h3(i+vec3(0.,1.,1.)),h3(i+vec3(1.,1.,1.)),f.x),f.y),f.z);}
float fbm3(vec3 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*vn3(p);p=p*2.03+vec3(1.7,9.2,3.1);a*=.5;}return v;}
float cone(vec2 q,float ang,float len,float wid){len=max(len,.001);float c=cos(ang),s=sin(ang);vec2 r=vec2(c*q.x+s*q.y,-s*q.x+c*q.y);float t=r.x/len;if(t<=0.||t>=1.)return 0.;float hw=wid*pow(sin(3.14159*pow(t,.55)),.9)+.001;return clamp(1.-abs(r.y)/hw,0.,1.);}
bool bx(vec3 ro,vec3 rd,out float t0,out float t1){vec3 a=(uB0-ro)/rd,b=(uB1-ro)/rd,mn=min(a,b),mx=max(a,b);t0=max(max(mn.x,mn.y),max(mn.z,0.));t1=min(min(mx.x,mx.y),mx.z);return t1>t0;}`;
const FIRE=COMMON+`
void main(){
 vec3 ro=uRo,rd=normalize(vP-ro);float t0,t1;if(!bx(ro,rd,t0,t1))discard;
 const int N=VOL_STEPS;float dt=(t1-t0)/float(N),t=t0+dt*h3(vec3(gl_FragCoord.xy,uT*60.));
 float a=uAge,grow=1.-pow(1.-clamp(a*9.,0.,1.),3.),I=pow(1.-smoothstep(.35,1.6,a),1.5),tt=uT*5.+uSeed,L=4.1*grow*(1.+.08*min(a,1.6));
 vec3 acc=vec3(0.);float k1=fract(sin(uSeed*12.9898)*43758.5453),k2=fract(sin(uSeed*78.233)*12345.6789),k3=fract(sin(uSeed*39.346)*24634.6345),k4=fract(sin(uSeed*11.135)*53758.1234);
 for(int i=0;i<N;i++){
  vec3 p=ro+rd*t;t+=dt;
  float x=p.x,r=length(p.yz);
  if(x<-.1||x>5.2||r>2.3)continue;
  float ph=atan(p.z,p.y);
  float nw=fbm3(p*1.5+vec3(-tt*.5,uSeed,3.)),m=smoothstep(0.,1.2,length(vec2(x,r)));
  vec2 q=vec2(x+(nw-.5)*.7*m,abs(r+(nw-.5)*.6*m));
  float tongue=cone(q,(k4-.5)*.18,L*(.85+.35*k1),.56+.2*k4);
  float blob=clamp(1.-length((q-vec2(.85*grow,0.))*vec2(.95,1.))/((.85+.25*k3)*grow+.001),0.,1.);
  float petal=.3+.7*pow(.5+.5*cos((3.+floor(k2*4.))*ph+uSeed*3.+nw*3.),2.);
  float sp=cone(q-vec2(.15,.1),.62+.34*k2,(1.7+.9*k3)*grow,.4+.14*k1)*petal;
  float b=pow(max(max(tongue,blob),sp),.55),e=b*(1.-b)*4.;
  float n=fbm3(p*3.4+vec3(-tt*1.1,uSeed*3.,0.)),n2=vn3(p*12.+vec3(-tt*2.,uSeed*5.,0.));
  float reach=smoothstep(0.,.25,b);
  float d=clamp(b*1.5+(n-.5)*reach*(.5+(1.-b)*.9)+(n2-.5)*.6*e-.1-a*.12,0.,1.)*reach*smoothstep(-.02,.18,x);
  float T=d*(1.-.5*min(a,1.6))+.6*exp(-length(vec2(x*.8,r*1.4))*1.2)*max(1.-a,0.);
  T*=1.-.4*smoothstep(1.6,4.2,x);
  vec3 col=vec3(.45,.05,.01);
  col=mix(col,vec3(1.,.32,.04),smoothstep(.12,.4,T));
  col=mix(col,vec3(1.,.66,.12),smoothstep(.35,.65,T));
  col=mix(col,vec3(1.,.93,.62),smoothstep(.6,.95,T));
  col=mix(col,vec3(1.,1.,.97),smoothstep(.95,1.4,T));
  acc+=col*d*dt*1.1;
 }
 gl_FragColor=vec4(acc*I*uGain,1.);
}`;
const SMOKE=COMMON+`
void main(){
 vec3 ro=uRo,rd=normalize(vP-ro);float t0,t1;if(!bx(ro,rd,t0,t1))discard;
 const int N=VOL_STEPS;float dt=(t1-t0)/float(N),t=t0+dt*h3(vec3(gl_FragCoord.xy,uT*60.));
 float sa=uAge,ex=1.-exp(-sa*4.5),c=.9+2.*ex+.15*sa,rx=1.+2.*ex+.2*sa,ry=.8+1.1*ex+.14*sa;
 float fade=smoothstep(0.,.06,sa)*(1.-smoothstep(.6,2.4,sa)),warm=1.-smoothstep(0.,.45,sa);
 vec3 C=vec3(0.);float Tr=1.;
 for(int i=0;i<N;i++){
  vec3 p=ro+rd*t;t+=dt;
  float x=p.x,r=length(p.yz);
  float nw=fbm3(p*1.2+vec3(uSeed,-sa*.4,1.));
  float env=1.-length(vec2((x-c)/rx,r/ry))+(nw-.5)*.9;
  if(env<-.5)continue;
  float sn=fbm3(p*2.6+vec3(-sa*.5,uSeed,0.));
  float d=smoothstep(0.,.55,env+(sn-.5)*.7)*fade*2.2;
  float al=1.-exp(-d*dt);
  vec3 lc=vec3(.62,.58,.55)*(.5+.5*sn)+vec3(.12,.12,.14)*clamp(p.y*.4+.5,0.,1.)+vec3(1.,.5,.15)*exp(-length(p-vec3(.8,0.,0.))*.6)*warm*1.4;
  C+=Tr*al*lc;Tr*=1.-al;
 }
 gl_FragColor=vec4(C,1.-Tr);
}`;
// Baked once at load: the volumes above are ray-marched into flipbook atlases (fire side / fire front / smoke,
// several seeds). At runtime every effect is an instanced billboard: fire, smoke, glow/sparks/tracers and dust
// share 4 draw calls and cost two texture reads per pixel, so full-auto fire no longer stalls phones.
function volMat(frag, B, smoke, steps) {
  const m = new THREE.ShaderMaterial({ vertexShader: VOL_VS, fragmentShader: '#define VOL_STEPS ' + steps + '\n' + frag,
    uniforms: { uRo: { value: V() }, uB0: { value: B[0] }, uB1: { value: B[1] }, uAge: { value: 2 }, uT: { value: 0 }, uSeed: { value: 0 }, uGain: { value: 1 } },
    transparent: true, depthWrite: false, depthTest: false, side: THREE.BackSide, toneMapped: false });
  if (smoke) { m.blending = THREE.CustomBlending; m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor; }
  else m.blending = THREE.AdditiveBlending;
  return m;
}
function volMesh(B, mat) {
  const sz = B[1].clone().sub(B[0]), c = B[1].clone().add(B[0]).multiplyScalar(0.5), g = new THREE.BoxGeometry(sz.x, sz.y, sz.z);
  g.translate(c.x, c.y, c.z);
  return new THREE.Mesh(g, mat);
}
const VOL_UNIT = 8;
const FIREB = [V(-.6, -2.3, -2.3), V(5.4, 2.3, 2.3)], SMKB = [V(-1, -3.3, -3.3), V(8.5, 3.3, 3.3)];
const FIRE_AGES = [0.04, 0.12, 0.25, 0.42, 0.65, 0.95, 1.3, 1.6], SMOKE_AGES = [0.05, 0.15, 0.3, 0.5, 0.8, 1.2, 1.7, 2.35];
// Atlas regions [x, y, cellW, cellH, seeds]; columns = ages.
const ATL = { S: 1024, side: [0, 0, 128, 96, 4], front: [0, 384, 96, 96, 4], smoke: [0, 768, 128, 96, 2] };
function bakeFX() {
  const rt = new THREE.WebGLRenderTarget(ATL.S, ATL.S, { depthBuffer: false });
  const bs = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000);
  const fire = volMesh(FIREB, volMat(FIRE, FIREB, false, 40)), smoke = volMesh(SMKB, volMat(SMOKE, SMKB, true, 40));
  bs.add(fire, smoke);
  const keep = { rt: renderer.getRenderTarget(), auto: renderer.autoClear, col: renderer.getClearColor(new THREE.Color()), a: renderer.getClearAlpha() };
  renderer.autoClear = false; renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(rt); renderer.clear();
  const cell = (mesh, B, front, R, col, row, age, seed) => {
    const c = B[0].clone().add(B[1]).multiplyScalar(0.5);
    // side: screen x = barrel (+X); front: looking back down the barrel from the muzzle side
    if (front) { cam.position.set(1000, c.y, c.z); cam.lookAt(0, c.y, c.z); cam.left = B[0].z - c.z; cam.right = B[1].z - c.z; }
    else { cam.position.set(c.x, c.y, 1000); cam.lookAt(c.x, c.y, 0); cam.left = B[0].x - c.x; cam.right = B[1].x - c.x; }
    cam.top = B[1].y - c.y; cam.bottom = B[0].y - c.y; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    const u = mesh.material.uniforms;
    u.uRo.value.copy(cam.position); u.uAge.value = age; u.uSeed.value = seed; u.uT.value = 0;
    const x = R[0] + col * R[2], y = R[1] + row * R[3];
    rt.viewport.set(x, y, R[2], R[3]); rt.scissor.set(x, y, R[2], R[3]); rt.scissorTest = true;
    renderer.setRenderTarget(rt);
    fire.visible = mesh === fire; smoke.visible = mesh === smoke;
    renderer.render(bs, cam);
  };
  const seeds = [2.7, 7.9, 13.3, 17.1];
  for (let r = 0; r < 4; r++) FIRE_AGES.forEach((a, c) => { cell(fire, FIREB, false, ATL.side, c, r, a, seeds[r]); cell(fire, FIREB, true, ATL.front, c, r, a, seeds[r]); });
  for (let r = 0; r < 2; r++) SMOKE_AGES.forEach((a, c) => cell(smoke, SMKB, false, ATL.smoke, c, r, a, seeds[r + 1]));
  rt.scissorTest = false; rt.viewport.set(0, 0, ATL.S, ATL.S);
  renderer.setRenderTarget(keep.rt); renderer.autoClear = keep.auto; renderer.setClearColor(keep.col, keep.a);
  for (const m of [fire, smoke]) { m.geometry.dispose(); m.material.dispose(); }
  return rt.texture;
}
const fxTex = bakeFX();
const cellUV = (R, col, row) => [(R[0] + col * R[2] + 0.5) / ATL.S, (R[1] + row * R[3] + 0.5) / ATL.S, (R[2] - 1) / ATL.S, (R[3] - 1) / ATL.S];
const UV = {}, UV_FULL = [0, 0, 1, 1];
for (const k of ['side', 'front', 'smoke']) {
  const R = ATL[k], ages = k === 'smoke' ? SMOKE_AGES : FIRE_AGES;
  UV[k] = []; for (let r = 0; r < R[4]; r++) UV[k].push(ages.map((_, c) => cellUV(R, c, r)));
}
function frameAt(ages, a) {
  if (a <= ages[0]) return [0, 0];
  for (let i = 0; i < ages.length - 1; i++) if (a < ages[i + 1]) return [i, (a - ages[i]) / (ages[i + 1] - ages[i])];
  return [ages.length - 2, 1];
}
// Instanced billboards. Mode 0: camera-facing, rotated. Mode 2: long axis = iAxis projected on screen and
// foreshortened (fire side view, smoke, tracers) so a flash seen down the barrel shrinks to its front view.
const QFX_VS = `attribute vec3 iPos; attribute vec4 iAxis; attribute vec2 iSize; attribute vec4 iUV0; attribute vec4 iUV1; attribute vec3 iFade; attribute vec3 iCol;
varying vec2 vA; varying vec2 vB; varying vec3 vF; varying vec3 vC;
void main() {
  vec3 toC = normalize(cameraPosition - iPos), R = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), U = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 X, Y; float sx = iSize.x;
  if (iFade.z > 1.5) {
    X = iAxis.xyz - dot(iAxis.xyz, toC) * toC; float l = length(X);
    X = l > 1e-4 ? X / l : R; Y = normalize(cross(toC, X)); sx = mix(iSize.y, iSize.x, min(l, 1.0));
  } else { float c = cos(iAxis.w), s = sin(iAxis.w); X = R * c + U * s; Y = U * c - R * s; }
  vec3 p = iPos + X * (position.x * sx) + Y * (position.y * iSize.y);
  vec2 uv = position.xy + 0.5;
  vA = iUV0.xy + uv * iUV0.zw; vB = iUV1.xy + uv * iUV1.zw; vF = iFade; vC = iCol;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const QFX_FS = `uniform sampler2D map; uniform float premul; varying vec2 vA; varying vec2 vB; varying vec3 vF; varying vec3 vC;
void main() {
  vec4 c = mix(texture2D(map, vA), texture2D(map, vB), vF.y);
  if (premul > 0.5) c.rgb *= c.a;
  c *= vF.x; c.rgb *= vC;
  gl_FragColor = c;
}`;
class QuadFX {
  constructor(max, map, mode, order, premul = 0) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-.5, -.5, 0, .5, -.5, 0, .5, .5, 0, -.5, .5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.at = {}; this.max = max; this.n = 0; this.g = g;
    for (const [k, n] of [['iPos', 3], ['iAxis', 4], ['iSize', 2], ['iUV0', 4], ['iUV1', 4], ['iFade', 3], ['iCol', 3]]) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(max * n), n); a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(k, a); this.at[k] = a;
    }
    g.instanceCount = 0;
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: QFX_VS, fragmentShader: QFX_FS,
      uniforms: { map: { value: map }, premul: { value: premul } }, transparent: true, depthWrite: false, toneMapped: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor,
      blendDst: mode === 'add' ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = order;
    scene.add(this.mesh);
  }
  push(p, ax, rot, sx, sy, uv0, uv1, mix, alpha, mode, r = 1, gr = 1, b = 1) {
    if (this.n >= this.max || alpha <= 0.003) return;
    const i = this.n++, A = this.at;
    A.iPos.setXYZ(i, p.x, p.y, p.z); A.iAxis.setXYZW(i, ax ? ax.x : 0, ax ? ax.y : 0, ax ? ax.z : 0, rot);
    A.iSize.setXY(i, sx, sy); A.iUV0.setXYZW(i, uv0[0], uv0[1], uv0[2], uv0[3]); A.iUV1.setXYZW(i, uv1[0], uv1[1], uv1[2], uv1[3]);
    A.iFade.setXYZ(i, alpha, mix, mode); A.iCol.setXYZ(i, r, gr, b);
  }
  flush() {
    this.g.instanceCount = this.n;
    for (const k in this.at) { const a = this.at[k]; a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, this.n) * a.itemSize); a.needsUpdate = true; }
    this.n = 0;
  }
}
const smokeFX = new QuadFX(48, fxTex, 'premul', 21), fireFX = new QuadFX(64, fxTex, 'add', 22);
const glowTex = radialTexture([[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']], 64);
const glowFX = new QuadFX(200, glowTex, 'add', 23, 1);
const smokeTex = radialTexture([[0, 'rgba(255,255,255,0.55)'], [0.5, 'rgba(255,255,255,0.18)'], [1, 'rgba(255,255,255,0)']]);
const puffFX = new QuadFX(72, smokeTex, 'premul', 20, 1);
const fxMuz = [], fxPuffs = [], fxSparks = [], fxTracers = [];
let glow = 0;
const NE = IS_TOUCH ? 50 : 90, ePos = new Float32Array(NE * 6), eCol = new Float32Array(NE * 6), embers = [];
for (let i = 0; i < NE; i++) embers.push({ p: V(0, -999, 0), v: V(), age: 9, life: 1 });
const eGeo = new THREE.BufferGeometry();
eGeo.setAttribute('position', new THREE.BufferAttribute(ePos, 3)); eGeo.setAttribute('color', new THREE.BufferAttribute(eCol, 3));
const eLines = new THREE.LineSegments(eGeo, new THREE.LineBasicMaterial({ vertexColors: true, ...fxAdd }));
eLines.frustumCulled = false; scene.add(eLines);
let emberIdx = 0;
// Any shooter: fire (side + front views), glow, smoke.
export function muzzleFlashAt(p, d, size) {
  fxMuz.push({ p: p.clone(), d: d.clone().normalize(), s: size, age: 0.012, seed: Math.random() * 4 | 0, rot: Math.random() * 6.283, drift: V(), sm: 0.75 + Math.random() * 0.25 });
  if (fxMuz.length > 24) fxMuz.shift();
}
// Player shot: + muzzle light and embers.
export function spawnMuzzleFX(mz, gunQW, dir, size) {
  muzzleFlashAt(mz, dir, size);
  glow = 1; flashLight.position.copy(mz).addScaledVector(dir, 6);
  for (let i = 0; i < NE * 0.45; i++) {
    const e = embers[emberIdx++ % NE], sp = Math.random() < 0.7 ? 0.5 : 1.2;
    e.v.copy(dir).add(V((Math.random() - 0.5) * sp, (Math.random() - 0.5) * sp, (Math.random() - 0.5) * sp)).normalize()
      .multiplyScalar((40 + Math.random() ** 2 * 240) * size);
    e.p.copy(mz).addScaledVector(dir, Math.random() * 6 * size); e.age = 0; e.life = 0.3 + Math.random() * 0.9;
  }
}
function updateMuzzleFX(dt) {
  for (let i = fxMuz.length - 1; i >= 0; i--) { const m = fxMuz[i]; m.age += dt; m.drift.y += 8 * dt; if (m.age > 2.4) fxMuz.splice(i, 1); }
  glow = Math.max(0, glow - dt * 9);
  flashLight.intensity = glow * glow * 30000;   // the reference video's flash lights up the body and floor
  for (let i = 0; i < NE; i++) {
    const e = embers[i], o = i * 6;
    if (e.age < e.life) {
      e.age += dt; e.v.y -= 70 * dt; e.v.multiplyScalar(Math.pow(0.3, dt)); e.p.addScaledVector(e.v, dt);
      const k = Math.max(0, 1 - e.age / e.life) * (0.6 + 0.4 * Math.random());
      ePos[o] = e.p.x; ePos[o + 1] = e.p.y; ePos[o + 2] = e.p.z;
      ePos[o + 3] = e.p.x - e.v.x * 0.04; ePos[o + 4] = e.p.y - e.v.y * 0.04; ePos[o + 5] = e.p.z - e.v.z * 0.04;
      eCol[o] = k; eCol[o + 1] = 0.78 * k; eCol[o + 2] = 0.35 * k; eCol[o + 3] = 0.5 * k; eCol[o + 4] = 0.14 * k; eCol[o + 5] = 0;
    } else if (ePos[o + 1] !== -999) { ePos[o + 1] = ePos[o + 4] = -999; eCol.fill(0, o, o + 6); }
  }
  eGeo.attributes.position.needsUpdate = eGeo.attributes.color.needsUpdate = true;
  for (let i = fxPuffs.length - 1; i >= 0; i--) {
    const f = fxPuffs[i]; f.age += dt;
    if (f.age >= f.life) { fxPuffs.splice(i, 1); continue; }
    f.v.multiplyScalar(Math.exp(-2.5 * dt)); f.v.y += f.lift * dt; f.p.addScaledVector(f.v, dt); f.rot += f.spin * dt;
  }
  for (let i = fxSparks.length - 1; i >= 0; i--) {
    const sp = fxSparks[i]; sp.age += dt;
    if (sp.age >= sp.life) { fxSparks.splice(i, 1); continue; }
    sp.v.y -= sp.g * dt; sp.p.addScaledVector(sp.v, dt);
  }
  for (let i = fxTracers.length - 1; i >= 0; i--) { fxTracers[i].age += dt; if (fxTracers[i].age >= fxTracers[i].life) fxTracers.splice(i, 1); }
}
// Built right before rendering, with the final camera (view-dependent side/front fade).
const _fxP = V(), _fxQ = V();
export function prepMuzzleFX() {
  const cp = camera.position;
  for (const m of fxMuz) {
    const u = VOL_UNIT * m.s, al = Math.abs(_fxQ.copy(cp).sub(m.p).normalize().dot(m.d)), a = m.age / 0.14;
    if (a < 1.6) {
      const [i, f] = frameAt(FIRE_AGES, a), wF = sstep(0.5, 0.92, al), wS = 1 - 0.85 * sstep(0.72, 0.98, al);
      fireFX.push(_fxP.copy(m.p).addScaledVector(m.d, 2.4 * u), m.d, 0, 6 * u, 4.6 * u, UV.side[m.seed][i], UV.side[m.seed][i + 1], f, wS, 2);
      fireFX.push(_fxP.copy(m.p).addScaledVector(m.d, 1.1 * u), null, m.rot, 4.6 * u, 4.6 * u, UV.front[m.seed][i], UV.front[m.seed][i + 1], f, wF, 0);
    }
    const g = 1 - m.age * 9, gs = (40 + 30 * g) * m.s;
    if (g > 0) glowFX.push(_fxP.copy(m.p).addScaledVector(m.d, 9 * m.s), null, m.rot, gs, gs, UV_FULL, UV_FULL, 0, Math.min(0.4, g * 0.5), 0, 1, 0.72, 0.42);
    const [j, h] = frameAt(SMOKE_AGES, m.age);
    smokeFX.push(_fxP.copy(m.p).addScaledVector(m.d, 3.75 * u).add(m.drift), m.d, 0, 9.5 * u, 6.6 * u, UV.smoke[m.seed & 1][j], UV.smoke[m.seed & 1][j + 1], h, m.sm, 2);
  }
  for (const f of fxPuffs) {
    const k = f.age / f.life, sz = f.s * (1 + k * f.grow);
    puffFX.push(f.p, null, f.rot, sz, sz, UV_FULL, UV_FULL, 0, f.a * (1 - k) * Math.min(1, f.age * 20), 0, f.c[0], f.c[1], f.c[2]);
  }
  for (const sp of fxSparks) glowFX.push(sp.p, null, 0, sp.s, sp.s, UV_FULL, UV_FULL, 0, 1 - sp.age / sp.life, 0, sp.c[0], sp.c[1], sp.c[2]);
  for (const t of fxTracers) {   // short bright streak travelling from the muzzle to the impact
    const L = t.a.distanceTo(t.b), k = Math.min(1, t.age / t.life), len = Math.min(L, t.len);
    const dir = _fxQ.copy(t.b).sub(t.a).divideScalar(L || 1);
    glowFX.push(_fxP.copy(t.a).lerp(t.b, k).addScaledVector(dir, -len / 2), dir, 0, len, t.w, UV_FULL, UV_FULL, 0, t.alpha * (1 - 0.5 * k), 2, 1, 0.85, 0.55);
  }
  smokeFX.flush(); fireFX.flush(); glowFX.flush(); puffFX.flush();
}
function spawnSmoke(pos, vel, size, life, col = [0.72, 0.74, 0.76], a = 0.5) {
  fxPuffs.push({ p: pos.clone(), v: vel.clone(), s: size * 2, grow: 4, age: 0, life, rot: Math.random() * 6.28, spin: (Math.random() - 0.5) * 1.5, c: col, a, lift: 12 });
  if (fxPuffs.length > 64) fxPuffs.shift();
}
export function burst(p, n, color, count = 9, speed = 1) {
  const c = new THREE.Color(color);
  for (let i = 0; i < count; i++) {
    const v = n.clone().multiplyScalar((150 + Math.random() * 250) * speed).add(V(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).multiplyScalar(300 * speed));
    fxSparks.push({ p: p.clone(), v, age: 0, life: 0.1 + Math.random() * 0.12, s: 1.6 + Math.random() * 1.5, c: [c.r, c.g, c.b], g: 600 });
  }
  while (fxSparks.length > 160) fxSparks.shift();
}
export function tracerFX(a, b, player) {
  fxTracers.push({ a: a.clone(), b: b.clone(), age: 0, life: a.distanceTo(b) / 80000 + 0.03, len: 220, w: player ? 2.2 : 3.4, alpha: player ? 0.85 : 1 });
  if (fxTracers.length > 40) fxTracers.shift();
}
export function impactFX(p, n, kind) {
  if (kind === 'ground') { spawnSmoke(p, V(0, 30, 0).addScaledVector(n, 20), 5, 0.9, [0.78, 0.74, 0.66]); burst(p, n, 0xc8b8a0, 6); }
  else if (kind === 'concrete') { spawnSmoke(p, n.clone().multiplyScalar(60), 5, 0.8, [0.76, 0.76, 0.75]); burst(p, n, 0xfff0d0, 7); }
  else if (kind === 'wood') { spawnSmoke(p, n.clone().multiplyScalar(50), 4, 0.6, [0.62, 0.5, 0.36]); burst(p, n, 0xd0a070, 5, 0.7); }
  else if (kind === 'blood') { spawnSmoke(p, n.clone().multiplyScalar(45), 3.5, 0.45, [0.42, 0.05, 0.04], 0.75); spawnSmoke(p, n.clone().multiplyScalar(90).add(V(0, 40, 0)), 2, 0.35, [0.5, 0.06, 0.05], 0.8); }
  else burst(p, n, 0xffffff);
}

// Shells: one instanced draw call (unit cylinder scaled per calibre).
const brass = new THREE.MeshStandardMaterial({ color: 0xc8a250, roughness: 0.28, metalness: 1.0 });
export const caseGeo = new THREE.CylinderGeometry(0.49, 0.49, 1.92, 14);
export const rifleCaseGeo = new THREE.CylinderGeometry(0.48, 0.48, 4.5, 14);
const SHELL_MAX = 48, shellIM = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 10), brass, SHELL_MAX);
shellIM.count = 0; shellIM.frustumCulled = false; shellIM.castShadow = !IS_TOUCH; scene.add(shellIM);
const shells = [];
let shellNext = 0;
export function ejectShell() {
  const gp = W.cur.shellGeo.parameters;
  const s = { p: toWorld(fromGun(W.cur.eject)), rest: false, sc: V(gp.radiusTop, gp.height, gp.radiusTop),
    q: new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), STATE.charYaw).multiply(gunState.q).multiply(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), Math.PI / 2)),
    v: toWorldDir(W.cur.ejectV.clone().add(V(-Math.random() * 90, Math.random() * 80, Math.random() * 50 - 25)).applyQuaternion(gunState.q)).add(charVelW),
    w: V((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 20, 25 + Math.random() * 20) };
  if (shells.length < SHELL_MAX) shells.push(s); else { shells[shellNext] = s; shellNext = (shellNext + 1) % SHELL_MAX; }
}

export function updateFX(dt) {
  updateMuzzleFX(dt); updateMags(dt); updateRockets(dt);
  for (let i = 0; i < shells.length; i++) {
    const s = shells[i];
    if (!s.rest) {
      s.v.y -= 981 * dt;
      s.p.addScaledVector(s.v, dt);
      const ang = s.w.length();
      if (ang > 0) s.q.premultiply(tmpQ.setFromAxisAngle(_fxQ.copy(s.w).normalize(), ang * dt));
      const r = s.sc.x;
      if (s.p.y < GROUND_Y + r) {
        s.p.y = GROUND_Y + r;
        s.v.y = -s.v.y * 0.32; s.v.x *= 0.55; s.v.z *= 0.55; s.w.multiplyScalar(0.6);
        if (Math.abs(s.v.y) < 25) {
          s.v.y = 0; s.v.x *= 0.9; s.v.z *= 0.9;
          // lie on its side once it stops bouncing
          const axis = V(0, 1, 0).applyQuaternion(s.q); axis.y = 0;
          if (s.v.length() < 5) { s.rest = true; s.q.setFromUnitVectors(V(0, 1, 0), axis.lengthSq() > 1e-4 ? axis.normalize() : V(1, 0, 0)); }
        }
      }
    }
    shellIM.setMatrixAt(i, tmpM.compose(s.p, s.q, s.sc));
  }
  shellIM.count = shells.length; shellIM.instanceMatrix.needsUpdate = true;
}
