// Stylised Algeria map: outline, regions, projection (SVG user units = kilometres).
export const OUTLINE = [[-2.2, 35.1], [-1.3, 35.75], [0.1, 36.2], [1.3, 36.55], [2.6, 36.8], [3.4, 36.9], [4.6, 36.9], [5.6, 36.85], [6.6, 37.05], [7.8, 36.95], [8.6, 36.9], [8.3, 36.2], [8.4, 35.5], [7.9, 34.7], [7.6, 34.2], [8.4, 33.5], [9.5, 32.5], [9.7, 30.3], [9.3, 30.1], [9.9, 26.6], [10.0, 25.2], [11.5, 24.4], [11.9, 23.5], [10.0, 22.3], [7.5, 21.9], [5.8, 19.5], [4.2, 19.15], [3.2, 19.1], [1.2, 20.7], [-0.5, 21.7], [-4.8, 24.9], [-8.7, 27.3], [-8.7, 28.7], [-7.5, 29.5], [-6.1, 29.8], [-4.8, 30.7], [-3.6, 30.9], [-1.7, 32.2], [-1.2, 32.9], [-1.8, 34.0], [-2.0, 34.7]];
export const REGIONS = {
  coast: { name: 'MEDITERRANEAN COAST', c: [3.6, 36.2], rx: 6.2, ry: 1.0 },
  atlas: { name: 'ATLAS MOUNTAINS', c: [3.2, 35.0], rx: 6, ry: 0.8 },
  plateaus: { name: 'HIGH PLATEAUS', c: [2.6, 34.0], rx: 5, ry: 0.8 },
  sahara: { name: 'SAHARA', c: [1.2, 31.2], rx: 7, ry: 2.6 },
  deep: { name: 'DEEP SAHARA', c: [3, 27], rx: 6.5, ry: 2.2 },
  south: { name: 'SOUTHERN ROCKS', c: [6, 22.8], rx: 4.5, ry: 2.6 }
};
export const BIOME_REGION = { coast: 'coast', atlas: 'atlas', plateaus: 'plateaus', sahara: 'sahara', southern: 'south' };
export const CITIES = [['ALGER', 3.06, 36.75], ['ORAN', -0.64, 35.7], ['CONSTANTINE', 6.6, 36.37], ['BÉCHAR', -1.2, 31.6], ['GHARDAÏA', 3.7, 32.5], ['OUARGLA', 5.3, 31.95], ['TAMANRASSET', 5.5, 22.8], ['TINDOUF', -8.1, 27.7]];
export const LON0 = 0, LAT0 = 28, KX = 96, KY = 111;
export const px = (lon) => (lon - LON0) * KX;
export const py = (lat) => -(lat - LAT0) * KY;
export const FULL_VIEW = { x: -880, y: -1020, w: 2080, h: 2060 };
export const regionFor = (m) => (m.env.biome === 'sahara' && m.map.lat < 29 ? 'deep' : BIOME_REGION[m.env.biome] || 'coast');
export const outlinePath = () => 'M' + OUTLINE.map(([lo, la]) => `${px(lo).toFixed(1)},${py(la).toFixed(1)}`).join(' L') + ' Z';

/** Static layers shared by mission select and the briefing. */
export function baseMapSVG({ locked = {}, hot = null, labels = true } = {}) {
  let s = `<defs><pattern id="gridp" width="100" height="100" patternUnits="userSpaceOnUse"><path d="M100 0H0V100" fill="none" stroke="rgba(93,255,168,.09)" stroke-width="1" vector-effect="non-scaling-stroke"/></pattern></defs>`;
  s += `<rect x="-3000" y="-3000" width="6000" height="6000" fill="url(#gridp)"/>`;
  s += `<path class="country" d="${outlinePath()}"/>`;
  for (const [k, r] of Object.entries(REGIONS)) s += `<ellipse class="region ${locked[k] ? 'locked' : ''} ${hot === k ? 'hot' : ''}" data-region="${k}" cx="${px(r.c[0])}" cy="${py(r.c[1])}" rx="${r.rx * KX}" ry="${r.ry * KY}"/>`;
  if (labels) {
    for (const [k, r] of Object.entries(REGIONS)) s += `<text class="map-label ${hot === k ? 'hot' : ''}" x="${px(r.c[0])}" y="${py(r.c[1]) + 4}" text-anchor="middle">${r.name}</text>`;
    for (const [n, lo, la] of CITIES) s += `<circle cx="${px(lo)}" cy="${py(la)}" r="4" fill="#9fb" opacity=".7"/><text class="map-label city" x="${px(lo) + 8}" y="${py(la) + 4}">${n}</text>`;
  }
  return s;
}
