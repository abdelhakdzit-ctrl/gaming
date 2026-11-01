// Enemy archetypes. Add one here and spawn it by id from the wave table in Game.js.
//  acc: aim error in degrees at 20m (lower = better) · react: seconds to engage after first sighting
//  turn: aim turn rate deg/s · aggr: 0..1 appetite to advance/flank · range: preferred engagement [min,max] m
export const ENEMY_TYPES = {
  rifleman: { name: 'Rifleman', weapon: ['rifle', 'pistol'], hp: 90, acc: 3.2, react: 0.55, turn: 240, aggr: 0.5, range: [12, 38], tint: 0xb85c4a, burst: [3, 7] },
  rusher:   { name: 'Rusher',   weapon: ['smg', 'pistol'],   hp: 80, acc: 4.4, react: 0.4,  turn: 300, aggr: 0.9, range: [4, 16],  tint: 0xc9873c, burst: [4, 10] },
  breacher: { name: 'Breacher', weapon: ['shotgun', 'pistol'], hp: 130, acc: 2.5, react: 0.5, turn: 220, aggr: 0.95, range: [2, 10], tint: 0x8a4a68, burst: [1, 1] },
  marksman: { name: 'Marksman', weapon: ['sniper', 'pistol'], hp: 70, acc: 1.2, react: 0.9, turn: 160, aggr: 0.1, range: [25, 70], tint: 0x5c7a54, burst: [1, 1] },
};
export const DIFFICULTY = { easy: { acc: 1.5, react: 1.4, dmg: 0.6 }, normal: { acc: 1, react: 1, dmg: 1 }, hard: { acc: 0.65, react: 0.7, dmg: 1.25 } };
