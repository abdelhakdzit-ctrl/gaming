// Weapon gameplay stats. `model` selects the baked grip/model set in src/data/grips.json +
// assets/weapons/<model>.glb (produced by dev/bake from legacy-viewer's grip solver), so the hand
// shape, finger contact and support-hand placement are exactly the hand-tuned ones.
// Reload / bolt durations come from the baked sequences. Units: meters, seconds, degrees.
// Adding a weapon: add its model + grip to legacy-viewer, re-run dev/bake, then add an entry here.
export const WEAPONS = {
  rifle: {
    name: 'M4 Carbine', slot: 1, model: 'rifle',
    rpm: 750, auto: true, damage: 26, headMul: 2.2, range: 150, falloff: [35, 110], pellets: 1,
    mag: 30, reserve: 210,
    spread: { hip: 2.2, ads: 0.4, move: 2.0, crouch: 0.8 }, recoil: { pitch: 0.75, yaw: 0.4, recover: 8 },
    fov: 0.9, adsFov: 0.62, moveSpeed: 0.95, sfx: 'rifle_shot', vol: 1, noise: 70,
  },
  pistol: {
    name: 'Pistol', slot: 2, model: 'pistol',
    rpm: 420, auto: false, damage: 30, headMul: 2.5, range: 70, falloff: [18, 55], pellets: 1,
    mag: 15, reserve: 105,
    spread: { hip: 1.5, ads: 0.35, move: 1.3, crouch: 0.7 }, recoil: { pitch: 1.3, yaw: 0.45, recover: 11 },
    fov: 0.9, adsFov: 0.78, moveSpeed: 1, sfx: 'pistol_shot', vol: 0.8, noise: 38,
  },
  sniper: {
    name: 'Kar98k', slot: 3, model: 'kar',
    rpm: 50, auto: false, damage: 120, headMul: 3, range: 400, falloff: [200, 380], pellets: 1,
    mag: 5, reserve: 30, bolt: true,
    spread: { hip: 5, ads: 0.05, move: 6, crouch: 3 }, recoil: { pitch: 4.5, yaw: 0.8, recover: 5 },
    fov: 0.9, adsFov: 0.2, scope: true, moveSpeed: 0.88, sfx: 'kar_shot', vol: 1.3, noise: 110,
  },
};
export const SLOT_ORDER = ['rifle', 'pistol', 'sniper'];
