import * as THREE from 'three';

// Instanced camera-facing quads. One draw call for clouds, smoke, glows, sparks.
const vert = /* glsl */ `
attribute vec3 iPos; attribute float iSize; attribute vec4 iColor; attribute float iRot;
varying vec2 vUv; varying vec4 vColor; varying float vDepth;
void main(){
  vUv = uv; vColor = iColor;
  vec4 mv = viewMatrix * vec4(iPos, 1.0);
  float c = cos(iRot), s = sin(iRot);
  vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * iSize;
  mv.xy += p;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const frag = /* glsl */ `
uniform sampler2D map; uniform vec3 fogColor; uniform float fogDensity; uniform float useFog;
varying vec2 vUv; varying vec4 vColor; varying float vDepth;
void main(){
  vec4 t = texture2D(map, vUv);
  vec4 col = vec4(vColor.rgb * t.rgb, vColor.a * t.a);
  if (col.a < 0.004) discard;
  float f = 1.0 - exp(-fogDensity * fogDensity * vDepth * vDepth);
  col.rgb = mix(col.rgb, fogColor * (col.a > 0.0 ? 1.0 : 0.0), f * useFog);
  gl_FragColor = col;
}`;

let spriteTex;
export function softSpriteTexture() {
  if (spriteTex) return spriteTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  spriteTex = new THREE.CanvasTexture(c); spriteTex.colorSpace = THREE.SRGBColorSpace;
  return spriteTex;
}

export class BillboardBatch {
  constructor(capacity, { additive = false, texture = softSpriteTexture(), fog = true } = {}) {
    this.capacity = capacity; this.count = 0;
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index; geo.setAttribute('position', quad.attributes.position); geo.setAttribute('uv', quad.attributes.uv);
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.size = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.rot = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.pos); geo.setAttribute('iSize', this.size);
    geo.setAttribute('iColor', this.color); geo.setAttribute('iRot', this.rot);
    geo.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { map: { value: texture }, fogColor: { value: new THREE.Color(0x000000) }, fogDensity: { value: 0 }, useFog: { value: fog ? 1 : 0 } }
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 12 : 10;
    this.geo = geo;
  }
  begin() { this.count = 0; }
  push(x, y, z, size, r, g, b, a, rot = 0) {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    this.pos.setXYZ(i, x, y, z); this.size.setX(i, size);
    this.color.setXYZW(i, r, g, b, a); this.rot.setX(i, rot);
  }
  end() {
    this.geo.instanceCount = this.count;
    this.pos.needsUpdate = this.size.needsUpdate = this.color.needsUpdate = this.rot.needsUpdate = true;
  }
  setFog(color, density) { this.material.uniforms.fogColor.value.copy(color); this.material.uniforms.fogDensity.value = density; }
}
