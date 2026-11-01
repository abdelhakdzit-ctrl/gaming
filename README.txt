MANNEQUIN VIEWER — ANIMATION FIX
================================

START HERE (Windows)
1. Extract this ZIP into a new folder (do not overwrite the older extracted copy).
2. Double-click start-windows.bat.
3. Keep the console window open. The viewer opens at http://127.0.0.1:8000/.
4. Use Ctrl+F5 once if Chrome cached an earlier copy of index.html.

The page must be served over HTTP. Do not open index.html directly with file://.
The viewer imports Three.js modules from unpkg.com, so the first launch requires
an internet connection.

WHAT CHANGED
------------
- Animation Studio opens automatically and starts the selected FBX motion, so the
  change is visible immediately instead of hiding the library behind another click.
- Eight Unreal FBX clips are included and load on selection:
    Handgun empty reload
    Rifle reload
    SMG reload
    SMG empty reload
    Shotgun bolt reload
    Sniper bolt reload
    Sniper insert reload
    Sniper crouch aim pose
- UE5 Manny bones are retargeted onto the included mannequin from the saved rest pose.
- The currently equipped weapon stays visible and follows the animated right hand in
  the preview.
- The handgun empty-reload FBX is also connected to the actual in-game pistol reload.
  The magazine drop, replacement, bolt/slide sound, and ammo refill are timed to the clip.
- The M4 keeps its weapon-specific reload animation from the supplied FPS animation pack;
  the Kar98k keeps its dedicated bolt/stripper-clip action.
- Added playback speed, pause, restart, looping and clip switching.
- AudioContext is created only after the first real click/key press (Chrome autoplay policy).
- Replaced deprecated THREE.Clock usage and removed the obsolete PCFSoftShadowMap setting.
- Added placeholder TGA files for unused legacy FBX references and removed the unsupported
  GLB specular-glossiness extension declaration. The viewer already assigns its own M4
  materials, so those legacy material blocks were not needed.
- Embedded a data favicon to avoid the default /favicon.ico 404.

HOW TO USE THE ANIMATIONS
-------------------------
- The Animation Studio starts with Handgun — Empty reload.
- Select any clip from the dropdown to preview it on the mannequin.
- Use 0.25x–2x playback, Pause, Restart and Loop.
- Close the panel with the X button to return to the regular weapon viewer.
- To test the in-game FBX pistol reload: close Animation Studio, fire the pistol until
  the magazine is empty, then press R. The imported Handgun Empty Reload clip drives
  the body and both hands while the pistol remains attached to the right hand.
- Rifle/M4 and Kar98k use their existing weapon-specific systems to preserve their
  correct magazine, bolt and hand synchronization.

CONTROLS
--------
- Drag: orbit camera
- WASD: move (in game)
- Shift: run
- Space / Fire: shoot
- R: reload
- 1 / 2 / 3: switch weapon
- Q / E: lean left / right (hold, in game; limited by walls beside you, slows movement)
- X: swap camera shoulder (in game)
- Esc: pause game

TROUBLESHOOTING
---------------
- If the old build still appears, press Ctrl+F5 or open the new folder's server URL.
- If port 8000 is already in use, close the older viewer window first.
- FBX Z-UP conversion notices can appear because the source files were exported from
  Unreal. They are loader notices, not missing-file errors.
- A first pointer click or key press unlocks audio in Chrome; before that the browser
  intentionally keeps sound suspended.
