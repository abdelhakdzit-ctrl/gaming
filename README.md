# SHADOW LINE — SKY OF ALGERIA

*"When the radar lies, the pilot must decide."*

A browser-based 3D air-combat vertical slice (Three.js + Vite, ES modules, no framework).
Fictional story, factions and aircraft; Algeria-inspired geography only.

## Run

```bash
npm install
npm run dev        # http://localhost:5173  (must be served over HTTP, not file://)
npm run build      # production bundle in dist/
npm run validate   # cross-checks data/*.json (dialogue ids, targets, zones, enemy types)
```

Dev shortcut: `http://localhost:5173/?quick=1` skips the menus and starts Mission 01.

## Playable loop (all functional)

Title → Main menu → Campaign / Mission select (animated Algeria map: zoom, pan, markers, medals) → Intelligence dossier →
animated Tactical Briefing (SVG + canvas + CSS, ends by diving into the 3D hangar) → Aircraft/Loadout (variant, paint, weapons, difficulty) →
Airbase → Cockpit → Takeoff → Mission 01 *First Contact* (radar uncertainty, visual ID, dogfight, Grey) → Mission result → animated Debrief
(score, grade, XP/rank, unlocks, medals, auto-save) → next mission / retry / replay.
Also: Free Flight (region, aircraft, time, weather, difficulty, targets), 8 Challenges, Replay viewer, Settings, Extras, Pause.

### Controls
`S/↓` pull up · `W/↑` push · `A/D` roll · `Q/E` yaw · `Shift/Ctrl` or wheel throttle · `Space`/click cannon ·
`T` select/cycle radar target (keep it in the radar cone to **LOCK**) · `I` hold to **identify** · `F`/right-click missile · `X` flares · `B` airbrake ·
`C` or `1-8` cameras · `M` mouse flight · `H` HUD · `Esc`/`P` pause. Gamepad is supported (see Extras → Controls).

Rules of engagement: a missile can only be launched at a **locked, identified hostile**. Radar classification is deliberately unreliable
(flicker/ghosting during disruption) until you identify a contact — in Mission 01 one of the "hostile" tracks is a friendly medical transport.

## Architecture

```
index.html, styles/main.css
src/main.js            App: screens, game session lifecycle, save/debrief, replay viewer, frame loop
src/game.js            Mission session (scene, entities, input→flight, weapons, cinematics, HUD data)
src/renderer.js        WebGL2 renderer, quality presets, dynamic resolution
src/physics/           SIMCADE flight model (energy/lift/stall/AoA/G, ASSISTED/NORMAL/EXPERT)
src/aircraft/          Procedural jet/scout/transport models with named parts (GLB hook), Entity
src/weapons/           Cannon, missiles (guidance, seeker, flare seduction, proximity fuse), flares, pooled particles
src/ai/                Pilot state machine PATROL→DETECT→IDENTIFY→INTERCEPT→ATTACK→EVADE→REPOSITION→REGROUP→DISENGAGE
src/radar/             Range/cone/noise/dropout/disruption, classification uncertainty, lock
src/missions/          Director (objectives + scripted events from JSON), scoring
src/world/             Biomes (coast, atlas, plateaus, sahara, southern rocks), terrain LOD, sky/weather/time, airbase, hangar
src/camera/            8 camera modes with blended transitions, shake, scripted overrides
src/ui/                HUD (flight/targeting/radar canvases + DOM layers), screens, comms (subtitles EN/FR/AR), motion portraits
src/briefing/          Algeria SVG map + animated briefing
src/audio/             WebAudio synth: 8 buses, radio filtering, state-driven music (IDLE→BUILDUP→COMBAT→DANGER→RESOLUTION)
src/save/, settings/   localStorage persistence + accessibility settings
src/replay/            Recorder + viewer
data/                  missions.json (15), aircraft.json, enemies.json, dialogue.json, difficulty.json, progression.json, challenges.json
assets/                Placeholder folders for GLB / PNG / audio replacements
```

Everything mission-specific lives in `data/missions.json` (spawn, zones, waypoints, enemy groups + routes, objectives, radio/radar/spawn/cinematic
events, rewards, briefing map data). Adding a mission means adding data; the renderer and Game contain no Mission 01 logic.
Missions 02–15 are fully defined as content skeletons but are flagged `playable: false` in this slice.

## Notes / known limits

- Three.js `WebGLRenderer` (WebGL2) is used; WebGPU is not wired in this build.
- All art/audio is procedural. Replace the aircraft with a GLB via `loadAircraftModel` (node names match the procedural parts),
  portraits via `characters[x].image` in `data/dialogue.json`, audio by swapping the recipes in `src/audio/audio.js`.
- Radio voice is optional browser TTS (Settings → Audio); lines are subtitled in English, French and Arabic (RTL).
- Verified in headless Chromium (software GL) by driving the game through the full Mission 01 loop with a scripted pilot; real-GPU
  performance and gamepad/pointer-lock feel have not been measured.
