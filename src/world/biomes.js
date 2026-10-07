import { clamp, lerp, smoothstep } from '../util/math.js';
import { fbm, ridged, noise2 } from '../util/noise.js';

// Data-driven biome definitions. A biome supplies a pure height function and a colour
// function; terrain, collision, AI and vegetation all sample the same functions.
export const BASE_ALT = 9;
const coastZ = (x) => -1600 + 900 * Math.sin(x * 0.00045 + 1) + 400 * Math.sin(x * 0.0017 + 2);
const C = (r, g, b) => [r, g, b];
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

export const BIOMES = {
  coast: {
    label: 'COAST', sea: true, fogTint: [0.9, 1, 1.05],
    height(x, z) {
      const d = z - coastZ(x);
      const inland = clamp(d / 14000, 0, 1);
      let land = 10 + 45 * fbm(x / 1800, z / 1800, 4, 3) + Math.pow(inland, 1.4) * 1300 * ridged(x / 7000, z / 7000, 5, 9);
      const bd = Math.hypot(x, (z - 1500) * 0.8);
      land = lerp(land, BASE_ALT, 1 - smoothstep(1800, 3600, bd));
      const seaFloor = -90 + 70 * smoothstep(-2600, -300, d);
      return lerp(seaFloor, land, smoothstep(-350, 150, d));
    },
    color(x, z, h, ny) {
      const d = z - coastZ(x);
      const n = fbm(x / 300, z / 300, 3, 5);
      if (h < 0) return mix(C(0.1, 0.2, 0.28), C(0.2, 0.32, 0.36), smoothstep(-60, 0, h));
      const sand = C(0.62, 0.56, 0.42), scrub = C(0.27, 0.3, 0.17), dry = C(0.42, 0.38, 0.27), rock = C(0.4, 0.38, 0.35), snow = C(0.58, 0.58, 0.56);
      let c = mix(scrub, dry, n);
      c = mix(sand, c, smoothstep(40, 420, d));
      c = mix(c, rock, clamp((1 - ny) * 2.4 + smoothstep(500, 1100, h) * 0.6, 0, 1));
      return mix(c, snow, smoothstep(1300, 1700, h) * 0.5);
    },
    vegetation: { kind: 'cypress', density: 0.5, minH: 6, maxH: 450, minD: 700 }
  },
  atlas: {
    label: 'ATLAS MOUNTAINS', sea: false, fogTint: [0.95, 1, 1.05],
    height(x, z) {
      const r = ridged(x / 8000, z / 8000, 6, 4);
      const valley = fbm(x / 5000 + 20, z / 5000, 3, 2);
      return 350 + Math.pow(r, 1.15) * 2300 * (0.55 + valley * 0.7) + 60 * fbm(x / 400, z / 400, 3, 8);
    },
    color(x, z, h, ny) {
      const n = fbm(x / 250, z / 250, 3, 6);
      const green = C(0.2, 0.26, 0.15), rock = C(0.38, 0.36, 0.33), snow = C(0.78, 0.8, 0.82);
      let c = mix(green, rock, clamp(smoothstep(500, 1500, h) + (1 - ny) * 2, 0, 1));
      c = mix(c, [c[0] * 1.2, c[1] * 1.15, c[2]], n * 0.4);
      return mix(c, snow, smoothstep(1900, 2400, h) * (ny > 0.6 ? 1 : 0.3));
    },
    vegetation: { kind: 'cypress', density: 0.35, minH: 300, maxH: 1300, minD: 0 }
  },
  plateaus: {
    label: 'HIGH PLATEAUS', sea: false, fogTint: [1.05, 1, 0.92],
    height(x, z) {
      const wadi = ridged(x / 3500 + 4, z / 3500, 4, 12);
      return 900 + 90 * fbm(x / 2500, z / 2500, 5, 7) - 70 * Math.pow(wadi, 3) + 480 * smoothstep(0.62, 0.78, fbm(x / 9000 + 3, z / 9000, 3, 1)) + 15 * noise2(x / 120, z / 120, 3);
    },
    color(x, z, h, ny) {
      const n = fbm(x / 400, z / 400, 3, 11);
      const dry = C(0.5, 0.42, 0.28), pale = C(0.62, 0.55, 0.4), rock = C(0.45, 0.4, 0.34), green = C(0.34, 0.34, 0.2);
      let c = mix(dry, pale, n);
      c = mix(c, green, smoothstep(0.62, 0.8, fbm(x / 700 + 9, z / 700, 3, 4)) * 0.6);
      c = mix(c, rock, clamp((1 - ny) * 3, 0, 1));
      const road = Math.abs(x - 900 * Math.sin(z / 4200) - 300);
      if (road < 38) c = mix(c, C(0.28, 0.27, 0.26), 1 - road / 38);
      return c;
    },
    vegetation: { kind: 'shrub', density: 0.25, minH: 0, maxH: 5000, minD: 0 }
  },
  sahara: {
    label: 'SAHARA', sea: false, fogTint: [1.1, 1, 0.85],
    height(x, z) {
      const warp = 6 * fbm(x / 4000, z / 4000, 3, 5);
      const dunes = Math.pow(0.5 + 0.5 * Math.sin(x * 0.0016 + z * 0.0007 + warp), 1.6) * 120;
      const mesa = smoothstep(0.64, 0.68, fbm(x / 11000 + 7, z / 11000, 4, 6)) * (260 + 60 * fbm(x / 300, z / 300, 2, 1));
      return 280 + dunes * (1 - mesa / 320) + mesa + 18 * fbm(x / 500, z / 500, 3, 14) + 40 * smoothstep(0.7, 0.9, fbm(x / 7000, z / 7000 + 3, 3, 2)) * 5;
    },
    color(x, z, h, ny) {
      const n = fbm(x / 200, z / 200, 3, 3);
      const sand = C(0.7, 0.55, 0.33), orange = C(0.72, 0.42, 0.2), rock = C(0.38, 0.3, 0.25);
      let c = mix(sand, orange, n * 0.7 + 0.15 * Math.sin(x * 0.0016 + z * 0.0007));
      return mix(c, rock, clamp((1 - ny) * 2.6 + smoothstep(380, 560, h) * 0.5, 0, 1));
    },
    vegetation: { kind: 'palm', density: 0.0, minH: 0, maxH: 400, minD: 0, oasis: [[-3500, -2500], [5200, 3000]] }
  },
  southern: {
    label: 'SOUTHERN ROCK FORMATIONS', sea: false, fogTint: [1.1, 0.95, 0.85],
    height(x, z) {
      const r = ridged(x / 6000, z / 6000, 5, 2);
      let h = 600 + Math.pow(r, 2.2) * 2300 + 30 * fbm(x / 300, z / 300, 3, 9);
      const terr = Math.floor(h / 140) * 140;
      return lerp(h, terr + 140 * smoothstep(0, 1, (h - terr) / 140) * 0.1, 0.55 * smoothstep(0.35, 0.8, r));
    },
    color(x, z, h, ny) {
      const n = fbm(x / 160, z / 160, 3, 8);
      const red = C(0.48, 0.2, 0.12), ochre = C(0.62, 0.38, 0.2), dark = C(0.22, 0.14, 0.12), sand = C(0.66, 0.5, 0.32);
      let c = mix(ochre, red, n);
      c = mix(c, dark, clamp((1 - ny) * 2.8, 0, 1) * 0.8);
      return mix(sand, c, smoothstep(650, 900, h));
    },
    vegetation: { kind: 'shrub', density: 0.08, minH: 0, maxH: 900, minD: 0 }
  }
};
export const getBiome = (id) => BIOMES[id] || BIOMES.coast;
export { coastZ };
