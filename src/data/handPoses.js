// Hand / grip placement per weapon model. Tune here (no code changes needed).
//  right.pos/rot : weapon origin relative to hand_r bone (meters / degrees, in the bone's local frame)
//  left.rot      : extra rotation applied to the support hand on top of the weapon 'foregrip' marker frame
//  left.pos      : extra offset of the support hand from the foregrip marker (weapon-local meters)
//  fingers       : optional per-finger curl overrides [thumb,index,middle,ring,pinky] in degrees added to
//                  each of the 3 joints; the base finger shape comes from the pose clips (A_AR_Aim_Fwd, MF_Pistol_Idle_ADS)
export const HAND_POSES = {
  pistol:  { right: { pos: [0, 0, 0], rot: [0, 0, 0] }, left: { pos: [0, 0, 0], rot: [0, 0, 0] }, fingers: null },
  rifle:   { right: { pos: [0, 0, 0], rot: [0, 0, 0] }, left: { pos: [0, 0, 0], rot: [0, 0, 0] }, fingers: null },
  smg:     { right: { pos: [0, 0, 0], rot: [0, 0, 0] }, left: { pos: [0, 0, 0], rot: [0, 0, 0] }, fingers: null },
  shotgun: { right: { pos: [0, 0, 0], rot: [0, 0, 0] }, left: { pos: [0, 0, 0], rot: [0, 0, 0] }, fingers: null },
  sniper:  { right: { pos: [0, 0, 0], rot: [0, 0, 0] }, left: { pos: [0, 0, 0], rot: [0, 0, 0] }, fingers: null },
};
