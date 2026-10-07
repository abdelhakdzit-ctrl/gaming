import * as THREE from 'three';

// Renderer wrapper: WebGL2 (three default) with dynamic resolution scaling.
// WebGPU is intentionally not wired: three's WebGPURenderer needs node materials; the
// rest of the code only depends on the THREE.WebGLRenderer-compatible surface used here.
const QUALITY = { low: 0.65, medium: 0.85, high: 1.0 };

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const state = { quality: 'high', dynamic: true, scale: 1, frameAvg: 16.7, since: 0 };
  const maxDpr = Math.min(window.devicePixelRatio || 1, 2);

  function apply() {
    const pr = maxDpr * QUALITY[state.quality] * state.scale;
    renderer.setPixelRatio(pr);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
  window.addEventListener('resize', apply);
  apply();

  return {
    renderer,
    state,
    setQuality(q) { state.quality = QUALITY[q] ? q : 'high'; state.scale = 1; apply(); },
    setDynamic(v) { state.dynamic = !!v; if (!v) { state.scale = 1; apply(); } },
    /** Call once per frame with the frame time in ms; adapts resolution to hold ~50 fps. */
    adapt(dtMs) {
      state.frameAvg = state.frameAvg * 0.95 + dtMs * 0.05;
      state.since += dtMs;
      if (!state.dynamic || state.since < 1500) return;
      state.since = 0;
      if (state.frameAvg > 24 && state.scale > 0.55) { state.scale = Math.max(0.55, state.scale - 0.1); apply(); }
      else if (state.frameAvg < 15 && state.scale < 1) { state.scale = Math.min(1, state.scale + 0.05); apply(); }
    },
    resize: apply
  };
}
