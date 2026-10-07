# SHADOW LINE — SKY OF ALGERIA

*"When the radar lies, the pilot must decide."*

A browser-based 3D air-combat campaign (Three.js + Vite, ES modules, no framework): **15 playable missions** from *First Contact* to the finale *Shadow Line*, with epilogue and credits.
Fictional story, factions and aircraft; Algeria-inspired geography only.

## Run

```bash
npm install
npm run dev        # http://localhost:5173  (must be served over HTTP, not file://)
npm run check      # validate data + lint + production build
npm run sim        # headless regression: drives all 15 missions end to end (dev server running; set CHROME_PATH)
```

(Windows PowerShell 5: run `npm install` and `npm run dev` as two separate commands — `&&` is not supported.)

### Playing on a phone or tablet
Run `npm run dev` on your PC, then open `http://<your-PC-IP>:5173` in the phone's browser (same Wi-Fi; allow Node through the firewall if asked). Hold the device in landscape. Touch controls turn on automatically on touch devices (Settings → Controls to force on/off or switch to a left-handed layout). Menus scroll and re-flow for phones (landscape and portrait). The ⛶ button (corner of every menu, in the pause menu and Settings → Graphics) toggles fullscreen; on touch devices the first tap on the title screen enters fullscreen automatically (Settings → Graphics → *Auto fullscreen*). iPhone Safari has no fullscreen API for web pages: use *Share → Add to Home Screen* — the game ships a manifest (fullscreen, landscape) and icons, so Android can also *Install app*.

Dev shortcut: `http://localhost:5173/?quick=1` skips the menus and starts Mission 01.

## The campaign

| # | Mission | Type | Setting |
|---|---------|------|---------|
| 01 | First Contact | Intercept, visual ID | Coast, night, scramble from the runway |
| 02 | Guardian | Escort | Mediterranean, day |
| 03 | Red Vector | Dogfight | Coast, sunset |
| 04 | Eagle Eye | Recon (image 3 sites, SAM cover) | Atlas, fog, turbulence |
| 05 | Dust Route | Air support (protect a truck convoy) | High plateaus, dust |
| 06 | Broken Wing | Rescue (SAM suppression, helicopter pickup) | Atlas, gusts |
| 07 | No Signal | Navigation under total jamming | Sahara |
| 08 | Black Sand | Ground strike (SAMs, mast, fuel depot) | Deep Sahara, sunset |
| 09 | Mirage | High-speed pursuit (courier jet, Grey) | Southern rocks |
| 10 | Night Watch | Night base defence, scramble | Sahara base, night |
| 11 | Storm Line | Weather combat (protect the dam) | Atlas storm, heavy turbulence |
| 12 | Blind Sky | Radar blackout — fly by eye, bearing calls | Coast, dawn |
| 13 | False Flag | Identify & escort; the IFF lies both ways | Mediterranean, night |
| 14 | Grey | Ace duel across **three regions** | Coast → Atlas → Southern rocks |
| 15 | Shadow Line | Finale across **two regions**: destroy the command node, then stop the trigger flight | Sahara night → Coast dawn |

Flow: title → menu → animated Algeria map → intelligence → animated tactical briefing → loadout → mission → debrief (score, grade, XP/rank, unlocks, medals, autosave) → next mission. After Mission 15: epilogue slides (EN/FR/AR), credits and campaign statistics; unlocks the *Shadow Line* paint and *Crimson* HUD theme.
Also: Free Flight, 8 Challenges, Replay viewer (multi-region aware), Settings, Extras, Pause.

### Controls
`W/↑` nose up · `S/↓` nose down · `A/D` roll · `Q/E` yaw · `Shift/Ctrl` or wheel throttle · mouse = aim cursor (cursor up = nose up) ·
`Space`/click cannon · `T` select/cycle target (keep it in the radar cone to **LOCK**) · `I` (hold) identify · `F`/right-click missile · `X` flares · `B` airbrake ·
`C` or `1-8` cameras · `M` mouse flight · `H` HUD · `Esc`/`P` pause. Gamepad supported (Extras → Controls).
**Touch:** drag anywhere on the left half to steer (up = nose up, release = level flight) · FIRE (hold) · MSL / FLR / TGT (tap) · ID, BRK (hold) · slider = throttle · CAM, II (pause), ⛶ (fullscreen) top-left. Takeoff rotates automatically on touch devices.

Rules of engagement: a missile can only be launched at a **locked, identified hostile**. Radar classification is deliberately unreliable (flicker, ghosting, forged IFF) until you identify a contact. With the radar jammed or dead (missions 07, 12) only eyeball/heat-seeker lock works and Overwatch calls bandits by bearing.

## Architecture

```
index.html, styles/main.css
src/main.js            App: screens, session lifecycle, save/debrief/ending, replay viewer, frame loop
src/game.js            Mission session (scene, entities, input→flight, weapons, phases, cinematics, HUD data)
src/physics/           SIMCADE flight model (energy/lift/stall/AoA/G, ASSISTED/NORMAL/EXPERT)
src/aircraft/          Procedural models: lofted jet fuselage, helicopter, airliner, ground installations; Entity
src/weapons/           Cannon, missiles (guidance, seeker, flare seduction, fuse), flares, pooled particles
src/ai/                Pilot state machine (+ courier, helicopter, asset roles) and GroundUnit (SAM sites, convoy trucks)
src/radar/             Range/cone/noise/dropout/disruption, forged IFF, eyeball detection, lock
src/missions/          registry (loads data/missions/*.json), Director (objectives + scripted events), scoring
src/world/             Biomes (coast, atlas, plateaus, sahara, southern), terrain, sky/weather/time, airbase, hangar
src/camera/ src/ui/    8 camera modes; HUD (flight/targeting/radar/markers), screens, comms (EN/FR/AR), portraits
src/briefing/          Algeria SVG map + animated briefing (auto-derived from mission data)
src/audio/ save/ settings/ replay/
data/missions/*.json   One file per mission: spawn, zones, waypoints, groups+routes, objectives, events, cinematics, radio lines
data/                  aircraft, enemies (incl. ground units), dialogue (characters + shared lines), difficulty, progression, challenges
scripts/validate-data.mjs   Cross-checks every reference in the JSON content
```

### Data-driven missions
Objective types: `reach_area` (sequence), `identify`, `destroy`, `protect`, `protect_group`, `entity_at`, `hold_area`, `recon_site`, `prevent_arrival`, `avoid_friendly_fire`, `survive`, `manual`, plus constraints (`max_damage`, `time_limit`, ...).
Event conditions: `time`, `objective`, `range`, `identified`, `destroyed`, `all_destroyed`, `hp_below`, `in_area`, `entity_in_area`, `state`, `damaged`, `outside`, ...
Event actions: `say`, `music`, `spawn` (incl. `near` the player), `order` (go/engage/flee/land/activate), `callout` (live bearing call), `radar`, `retag`, `reveal`, `travel` (change region mid-mission), `show`, `complete`, `fail`, `evidence`, `cinematic`, `repair`, `endMission`.
Adding a mission means adding `data/missions/mNN.json` — the registry, map, briefing and scoring pick it up.

## Quality checks
`npm run check` validates the data, lints the source (0 warnings) and builds. All 15 missions are also driven end to end in headless Chromium by `npm run sim` (`scripts/sim-check.mjs`) (objective chains, phase changes, SAM fire, helicopter rescue, convoy, courier), and Mission 01 was flown by a scripted pilot. Not measured: real-GPU performance, gamepad feel, audio by ear.

## Known limits
- WebGL2 renderer (WebGPU not wired). All art/audio are procedural placeholders; GLB/PNG/audio replacement hooks exist (`loadAircraftModel`, `characters[x].image`, `src/audio/audio.js`).
- Radio voice is optional browser TTS; lines are always subtitled in English, French and Arabic (RTL).
