# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Handy.ctrl is a static, no-build web app (plain HTML/CSS/JS, no package.json) that lets two people play games together over the internet using [PeerJS](https://peerjs.com/) (WebRTC), where the outcome of the game controls the speed/position of a Handy device via the official Handy API.

There is no build, lint, or test tooling. Develop by serving the static files and opening two browser tabs/devices:

```
python -m http.server 8765
```

Then open:
- `http://localhost:8765/?input=camera` — the **passive** device (shares its camera, generates a room code)
- `http://localhost:8765/?input=control&room=XXX-XXX&code=<ConnectionKey>&apikey=<ApiKey>` — the **controller** device

Deployment is via GitHub Pages (see "Trigger Pages rebuild" commits) — pushing to `main` is effectively the deploy step.

## Architecture

### Two roles, one codebase

The same `index.html`/JS bundle serves both roles, switched via URL query params handled in `js/core.js`'s `window.addEventListener('load', ...)`:

- `?input=camera` → `initCameraMode()`: gets the device camera, generates a room code, creates a PeerJS peer (`camPeer`) waiting for a connection.
- `?input=control&room=...&code=...&apikey=...` → fetches a V3 token (if `apikey` given), then `initControlMode(roomCode)`: connects to the camera peer (`ctrlPeer`/`ctrlCall`) for the video stream, and opens a reliable PeerJS data connection.

### PeerJS data channels

There are two data connections, one per direction, both used bidirectionally with `.send()` / `.on('data', handlePeerData)`:

- `camConn` — lives on the **passive** side, receives the connection initiated by the controller.
- `gameDataConn` — lives on the **controller** side, the connection it opens to the passive peer.

All game messages are JSON `{type: '...', ...}` and routed through the central dispatcher `handlePeerData(data)` in `js/core.js`. When `camConn` closes (controller disconnected/reloaded), the passive side calls `resetAllGames()` to reset every mode's state and hide all overlays.

### Handy control API

`js/core.js` defines `V2`/`V3` base URLs, `ck` (Connection Key), `ak` (Application/API Key), `token`, and `useV3`. Two control schemes exist:

- **BASIC mode**: direct stroke control via the V2 "stroke engine" (`addStrokePoint`/`enqueueStroke`/`runStrokeQueue`, `/hdsp/xpt`).
- **HAMP (game modes)**: ALWAYS use the **V3** API with `Authorization: Bearer <token>`, never V2 — even for stop/start. The standard launch sequence (see `shellLaunchHamp`/`gameLaunchHamp`/`rallyLaunchHamp` for examples) is:
  1. `PUT /mode {mode:0}`, wait 400ms
  2. `PUT /mode {mode:2}`, wait 400ms
  3. `PUT /hamp/start`, wait 250ms
  4. `PUT /hamp/velocity {velocity:v}` (velocity clamped to `[0.05, 1]`)

### "Start paused, launch on first event" convention

Every game mode starts with the Handy idle (`xxxHampRunning=false`, HUD shows "Speed: pause"). HAMP is only actually started on the **first scoring/miss event**, via a per-mode `xxxLaunchHamp()` that runs the sequence above and then calls `xxxSetVelocity(speed)`. Subsequent events just call `xxxSetVelocity()` directly. Always follow this pattern for new modes.

### Per-mode file convention

Each game mode has its own `js/{mode}.js` + `css/{mode}.css`, with all globals/functions prefixed by mode (e.g. `shell*`, `gh*`, `wheel*`, `game*` for TARGET, `rally*` for RALLY). `index.html` links every mode's CSS/JS file and contains that mode's overlay markup (body-level `#xxxOverlay`, shown/hidden via an `active` class).

Mode selection happens in `#gameModeSelect` (`.mode-cards` / `.mode-card`, each with `onclick="startXxxMode()"`). WHEEL has an intermediate setup overlay (`#wheelSetup`) before the actual game overlay.

### Adding a new game mode — checklist

1. New `js/{mode}.js` + `css/{mode}.css`, linked from `index.html`.
2. A `.mode-card` in `#gameModeSelect` calling `startXxxMode()`.
3. A body-level `#xxxOverlay` (+ HUD) following the transparent-overlay pattern (camera stays visible underneath).
4. Controller (`xxxIsCtrl=true`) sends an `xxx_init` message via `gameDataConn`; passive responds via a `xxxPassiveStart()` handler.
5. Add new message types to `handlePeerData()` in `js/core.js` (controller and passive sides each react to the messages relevant to their role).
6. Add the mode's reset logic (cancel timers/`requestAnimationFrame`, hide overlay, reset flags) to `resetAllGames()` in `js/core.js`.
7. Implement `xxxLaunchHamp()` / `xxxSetVelocity()` following the V3-only, "start paused" convention above, and a `stopXxxMode()` that calls `/hamp/stop` (V3) only if HAMP was actually running.

### Real-time state sync (RALLY example)

For modes needing the controller to see live gameplay running on the passive side, the passive is authoritative: it runs the physics tick (`requestAnimationFrame`), broadcasts state (`rally_state`) to the controller at ~20Hz (throttled) over `camConn`, and the controller just renders the received state (`rallyApplyState`). Coordinates are canonical percentages of the play area, shared as-is between both sides.
