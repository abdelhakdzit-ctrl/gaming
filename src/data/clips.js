// Animation registry. Add a file to assets/animations and a line here to make it available:
//   character.anim.playOnce('my_clip')
// `loop` clips cycle (a single gait cycle is extracted automatically; root travel becomes clip speed),
// others are one-shots whose root motion drives the character. `range: [start, end]` (s) trims the
// usable part of a one-shot (many source clips include a standing lead-in / run-up).
// `reverse` plays the source backwards. `preload:false` clips load lazily on first use.
export const CLIPS = {
  idle:            { file: 'idle_neutral', loop: true },
  idle_alert:      { file: 'idle_alert', loop: true },
  idle_look:       { file: 'idle_looking_around', loop: true },
  idle_relaxed:    { file: 'idle_relaxed_weight_shift', loop: true },
  walk_f:          { file: 'walk_forward', loop: true },
  walk_b:          { file: 'walk_backward', loop: true },
  walk_l:          { file: 'walk_strafe_left', loop: true },
  walk_r:          { file: 'walk_strafe_right', loop: true },
  walk_cautious:   { file: 'walk_cautious', loop: true, preload: false },
  walk_tired:      { file: 'walk_tired', loop: true, preload: false },
  walk_confident:  { file: 'walk_confident', loop: true, preload: false },
  walk_heavy:      { file: 'walk_carrying_heavy', loop: true, preload: false },
  tiptoe:          { file: 'tiptoe_walk', loop: true, preload: false },
  run_f:           { file: 'run_jog', loop: true },
  run_b:           { file: 'run_backward', loop: true },
  run_l:           { file: 'run_strafe_left', loop: true },
  run_r:           { file: 'run_strafe_right', loop: true },
  run_panic:       { file: 'run_panic', loop: true, preload: false },
  sprint:          { file: 'run_sprint', loop: true },
  crouch_idle:     { file: 'crouch_idle', loop: true },
  crouch_f:        { file: 'crouch_walk_forward', loop: true },
  // crouch_walk_backward.fbx is not actually crouched: backwards crouch = crouch_walk_forward reversed
  crouch_b:        { file: 'crouch_walk_forward', loop: true, reverse: true },
  crawl:           { file: 'crawl_forward', loop: true, preload: false },
  army_crawl:      { file: 'army_crawl', loop: true, preload: false },
  jump:            { file: 'jump_standing', range: [0.8, 2.9] },
  jump_run:        { file: 'jump_running', range: [1.9, 3.5] },
  jump_long:       { file: 'jump_long_distance', preload: false },
  land_soft:       { file: 'land_soft' },
  land_roll:       { file: 'land_hard_roll' },
  roll:            { file: 'roll_forward', range: [0.45, 2.4] },
  vault:           { file: 'vault_obstacle', range: [2.2, 3.7] },
  step_over:       { file: 'step_over_obstacle', preload: false },
  climb_ledge:     { file: 'climb_ledge', preload: false },
  stairs_up:       { file: 'climb_stairs_up', loop: true, preload: false },
  stairs_down:     { file: 'climb_stairs_down', loop: true, preload: false },
  dodge:           { file: 'sidestep_dodge', preload: false },
  stumble:         { file: 'stumble_recover' },
  turn_180:        { file: 'turn_180', preload: false },
  turn_l90:        { file: 'turn_left_90', preload: false },
  turn_r90:        { file: 'turn_right_90', preload: false },
  start_sprint:    { file: 'start_sprint', preload: false },
  stop_run:        { file: 'stop_from_run', preload: false },
  direction_change:{ file: 'direction_change_sharp', preload: false },
  cover_wall:      { file: 'back_to_wall', loop: true, preload: false },
  crouch_rise:     { file: 'crouch_rise_up', preload: false },
};

// Locomotion sets: gait -> 4-way clip set. The AnimController blends by movement direction
// relative to facing and scales playback speed to the clip's measured stride speed.
export const LOCOMOTION = {
  stand: {
    idle: 'idle',
    gaits: {
      walk:   { f: 'walk_f', b: 'walk_b', l: 'walk_l', r: 'walk_r' },
      run:    { f: 'run_f',  b: 'run_b',  l: 'run_l',  r: 'run_r' },
      sprint: { f: 'sprint', b: 'run_b',  l: 'run_l',  r: 'run_r' },
    },
  },
  // Only forward/back crouch clips exist: sideways movement twists the legs (AnimController.hipYaw).
  crouch: {
    idle: 'crouch_idle',
    gaits: { walk: { f: 'crouch_f', b: 'crouch_b' } },
  },
};

// Source rig bone -> Mannequin bone.
export const BONE_MAP = (() => {
  const m = { Hips: 'pelvis', Spine1: 'spine_01', Spine2: 'spine_02', Chest: 'spine_03', Neck1: 'neck_01', Head: 'head' };
  for (const [S, s] of [['Left', 'l'], ['Right', 'r']]) {
    Object.assign(m, { [`${S}Shoulder`]: `clavicle_${s}`, [`${S}Arm`]: `upperarm_${s}`, [`${S}ForeArm`]: `lowerarm_${s}`, [`${S}Hand`]: `hand_${s}`,
      [`${S}Leg`]: `thigh_${s}`, [`${S}Shin`]: `calf_${s}`, [`${S}Foot`]: `foot_${s}`, [`${S}ToeBase`]: `ball_${s}` });
    for (const [F, f] of [['Thumb', 'thumb'], ['Index', 'index'], ['Middle', 'middle'], ['Ring', 'ring'], ['Pinky', 'pinky']])
      for (let i = 1; i <= 3; i++) m[`${S}Hand${F}${i}`] = `${f}_0${i}_${s}`;
  }
  return m;
})();
