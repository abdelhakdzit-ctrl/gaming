import * as THREE from 'three';
import { fbm } from '../util/noise.js';

let detail;
function detailTexture() {
  if (detail) return detail;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); const img = g.createImageData(128, 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const v = 190 + 65 * (0.6 * fbm(x / 6, y / 6, 3, 1) + 0.4 * Math.random());
    const i = (y * 128 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  detail = new THREE.CanvasTexture(c); detail.wrapS = detail.wrapT = THREE.RepeatWrapping; detail.colorSpace = THREE.SRGBColorSpace;
  detail.anisotropy = 4;
  return detail;
}

/** Builds a heightfield mesh with vertex colours from a biome. skirt hides seams between LOD rings. */
export function buildTerrainMesh(biome, cx, cz, size, segs, { skirt = 0, yOffset = 0 } = {}) {
  const n = segs + 1, count = n * n;
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  const hs = new Float32Array(count);
  const step = size / segs, x0 = cx - size / 2, z0 = cz - size / 2;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i; hs[k] = biome.height(x0 + i * step, z0 + j * step);
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, x = x0 + i * step, z = z0 + j * step;
    let h = hs[k];
    const hx = hs[j * n + Math.min(i + 1, segs)] - hs[j * n + Math.max(i - 1, 0)];
    const hz = hs[Math.min(j + 1, segs) * n + i] - hs[Math.max(j - 1, 0) * n + i];
    const ny = 1 / Math.sqrt(1 + (hx * hx + hz * hz) / (4 * step * step));
    const c = biome.color(x, z, h, ny);
    col[k * 3] = c[0]; col[k * 3 + 1] = c[1]; col[k * 3 + 2] = c[2];
    if (skirt && (i === 0 || j === 0 || i === segs || j === segs)) h -= skirt;
    pos[k * 3] = x; pos[k * 3 + 1] = h + yOffset; pos[k * 3 + 2] = z;
    uv[k * 2] = x / 70; uv[k * 2 + 1] = z / 70;
  }
  const idx = new Uint32Array(segs * segs * 6); let p = 0;
  for (let j = 0; j < segs; j++) for (let i = 0; i < segs; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    idx[p++] = a; idx[p++] = c; idx[p++] = b; idx[p++] = b; idx[p++] = c; idx[p++] = d;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0, map: detailTexture() });
  const mesh = new THREE.Mesh(geo, mat);
  return mesh;
}
