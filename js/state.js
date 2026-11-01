import * as THREE from 'three';
import { Spring, V } from './math.js';

export const STATE = {
  soundOn: true,
  NORMAL_W: 0,
  ANKLE_H: 13.5,
  HIP_HALF: 11,
  BALL_LEN: 12,
  LEG_MAX: 85,
  IDLE: null,
  charYaw: 0,
  demoOn: false,
  testInput: null,
  ready: false,
  mannequinRoot: null,
  pistol: undefined,
  kar: undefined,
  gunBase: new THREE.Matrix4(),
  gunInHand: null,
  simTime: 0,
  timeScale: 1,
  autoFire: false,
  nextAuto: 0,
  trigStart: -1,
  fired: false,
  fireTime: -10,
  ejected: true,
  triggerHeld: false,
  nextShot: 0,
  tvAuto: 0,
  burstN: 0,
  ikProfiles: {},
  ikDefaults: {},
  simFrozen: false,
  previousFrameTime: performance.now(),
  frozenDone: false,
  initDone: false,
  statusT: 0
};
export const params = new URLSearchParams(location.search);
export const IS_TOUCH = params.has('touch') || matchMedia('(pointer: coarse)').matches;

export const rec = {
  flip: new Spring(5.0, 0.48),   // muzzle rise (deg)
  back: new Spring(7.5, 0.55),   // rearward travel (cm)
  up: new Spring(5.0, 0.5),      // upward travel (cm)
  yaw: new Spring(5.5, 0.5), roll: new Spring(5.5, 0.5),
  spine: new Spring(3.0, 0.38),  // upper body absorbs, lags the gun
  shrug: new Spring(3.6, 0.45),
  shoulder: new Spring(3.2, 0.38), // secondary backward kick of shoulders (clavicle_r/l + torso twist)
  armBack: new Spring(3.6, 0.40),  // secondary rearward compression of both arms & hands
  elbow: new Spring(4.0, 0.36),    // secondary outward/backward elbow flex absorbing heavy shots
  hips: new Spring(3.2, 0.5),    // pelvis sinks/back: the shot travels down through hips, knees and ankles
  cam: new Spring(6.0, 0.5),     // game camera kick (deg)
  hx: new Spring(11, 0.32), hy: new Spring(9, 0.3), hz: new Spring(10, 0.3),   // rifle full-auto head buzz (deg)
  head: new Spring(6.0, 0.6),    // head counter-stabilises
};
export const RECOIL_PIVOT = V(0, -3.5, -3.0);   // near the wrist/web of the hand
