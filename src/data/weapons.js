// Weapon stats. Add a weapon = add an entry here + a model builder in WeaponModels.js.
// Units: meters, seconds, degrees. `spread` is the cone half-angle in degrees.
export const WEAPONS = {
  pistol: {
    name: 'M9 Pistol', slot: 2, model: 'pistol', pose: { hip: 'MF_Pistol_Idle_ADS', ads: 'MF_Pistol_Idle_ADS' },
    rpm: 420, auto: false, damage: 28, headMul: 2.5, range: 70, falloff: [18, 55], pellets: 1,
    mag: 15, reserve: 105, reload: 1.7, reloadStyle: 'mag',
    spread: { hip: 1.6, ads: 0.35, move: 1.4, crouch: 0.7 }, recoil: { pitch: 1.3, yaw: 0.45, recover: 11 },
    fov: 0.9, adsFov: 0.78, moveSpeed: 1, sfx: 'pistol_shot', vol: 0.8, noise: 38,
  },
  rifle: {
    name: 'M4 Carbine', slot: 1, model: 'rifle', pose: { hip: 'A_AR_AimWalkPose_Fwd', ads: 'A_AR_Aim_Fwd' },
    rpm: 760, auto: true, damage: 24, headMul: 2.2, range: 150, falloff: [35, 110], pellets: 1,
    mag: 30, reserve: 210, reload: 2.3, reloadStyle: 'mag',
    spread: { hip: 2.4, ads: 0.45, move: 2.2, crouch: 0.8 }, recoil: { pitch: 0.75, yaw: 0.4, recover: 8 },
    fov: 0.9, adsFov: 0.62, moveSpeed: 0.93, sfx: 'rifle_shot', vol: 1, noise: 70,
  },
  smg: {
    name: 'MP5 SMG', slot: 3, model: 'smg', pose: { hip: 'A_AR_AimWalkPose_Fwd', ads: 'A_AR_Aim_Fwd' },
    rpm: 900, auto: true, damage: 17, headMul: 2, range: 80, falloff: [15, 60], pellets: 1,
    mag: 32, reserve: 192, reload: 2.0, reloadStyle: 'mag',
    spread: { hip: 2.0, ads: 0.7, move: 2.0, crouch: 0.9 }, recoil: { pitch: 0.55, yaw: 0.5, recover: 10 },
    fov: 0.9, adsFov: 0.7, moveSpeed: 1, sfx: 'pistol_shot', pitch: 1.35, vol: 0.85, noise: 55,
  },
  shotgun: {
    name: 'M870 Shotgun', slot: 4, model: 'shotgun', pose: { hip: 'A_AR_AimWalkPose_Fwd', ads: 'A_AR_Aim_Fwd' },
    rpm: 75, auto: false, damage: 11, headMul: 1.6, range: 40, falloff: [6, 28], pellets: 9,
    mag: 6, reserve: 36, reload: 0.55, reloadStyle: 'shell', pump: 0.45,
    spread: { hip: 4.2, ads: 2.6, move: 4.6, crouch: 3.4 }, recoil: { pitch: 4.2, yaw: 1.0, recover: 6 },
    fov: 0.9, adsFov: 0.72, moveSpeed: 0.92, sfx: 'rifle_shot', pitch: 0.6, vol: 1.2, noise: 85,
  },
  sniper: {
    name: 'Kar98k', slot: 5, model: 'sniper', pose: { hip: 'A_AR_AimWalkPose_Fwd', ads: 'A_AR_Aim_Fwd' },
    rpm: 48, auto: false, damage: 105, headMul: 3, range: 400, falloff: [200, 380], pellets: 1,
    mag: 5, reserve: 30, reload: 0.7, reloadStyle: 'shell', bolt: 1.0,
    spread: { hip: 5, ads: 0.05, move: 6, crouch: 3 }, recoil: { pitch: 4.5, yaw: 0.8, recover: 5 },
    fov: 0.9, adsFov: 0.2, scope: true, moveSpeed: 0.85, sfx: 'kar_shot', vol: 1.3, noise: 110,
  },
};
export const SLOT_ORDER = ['rifle', 'pistol', 'smg', 'shotgun', 'sniper'];
