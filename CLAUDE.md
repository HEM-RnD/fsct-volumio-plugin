# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Volumio plugin (`plugin_type: user_interface`) that forwards Volumio playback state to FSCT-capable DACs (e.g. Ferrum Wandla). The plugin talks to a system-level `fsct-driver` daemon over a local IPC socket (`/run/fsct/fsct.sock` on Linux) via the `@hemspzoo/fsct-client` package — it does **not** touch USB directly. The driver is installed as a `.deb` by `install.sh` (see `FSCT_DRIVER_VERSION`, which must be kept in sync with the npm client version pinned in `package.json`). The whole plugin lives in a single file (`index.js`); there is no build step, no test suite, and no linter configured.

## Commands

- Install dependencies locally for editing: `npm install` (Node `>=20`).
- Install on a Volumio device: clone repo onto the device, then `volumio plugin install` from the repo root. `install.sh` will download and `dpkg -i` the matching `fsct-driver_${FSCT_DRIVER_VERSION}_${arch}.deb` from `https://github.com/HEM-RnD/fsct-host/releases`.
- Tail runtime logs on a Volumio device: `sudo journalctl -f -u volumio | grep fsct` — plugin log lines are prefixed with `[fsct]` via Volumio's standard logger. The driver itself logs separately under its own systemd unit (`fsct-driver`).
- For development off-device, the driver from the `fsct-host` repo can be run on Windows/macOS/Linux as a test target — the IPC protocol is the same regardless of host OS.
- `npm test` is a placeholder (`exit 1`); there are no tests to run.

## Architecture

Volumio's plugin manager instantiates `FerrumStreamingControlTechnology` (exported from `index.js`) and drives it through a fixed lifecycle:

1. `onVolumioStart` — loads `config.json` via `v-conf` and captures Volumio's logger into a module-level reference.
2. `onStart` — seeds `lastState` from `commandRouter.volumioGetState()`, then `connectAndRegister()`:
   - `FsctIpcClient.connect()` → connects to the driver IPC endpoint.
   - `registerPlayer(PLAYER_SELF_ID)` → driver returns a `playerId`.
   - `getDetectedDevices()` then `assignPlayerToDevice` for each — also re-assigns on every `'deviceChanged'` (`event: 'added'`) event so hot-plugged DACs pick up state immediately.
   - Pushes the seeded `lastState` so the DAC reflects current state before the first Volumio `pushState`.
3. `pushState(state)` — Volumio's per-state-change callback; the only hot path. Builds a `PlayerState` and calls `updatePlayerState(playerId, …)`.
4. `onStop` — `unregisterPlayer` + `disconnect`. Sets a `stopping` flag to suppress the reconnect timer.

The `'close'` event on the IPC client triggers a 2 s reconnect timer (`scheduleReconnect`) so the plugin survives a driver restart. `ipcClient`, `playerId`, `lastState`, and `pluginLogger` are module-level singletons — Volumio only ever loads one instance of a plugin, so they aren't put on `this`.

### State mapping (the core translation in `buildPlayerState`)

Volumio state object → FSCT `PlayerState`:
- `state.status` (`"play"`/`"pause"`/`"stop"`/other) → `'playing'`/`'paused'`/`'stopped'`/`'unknown'` (lowercase wire-format strings, not an enum).
- Timeline: `positionMs = state.seek` (Volumio already uses ms), `durationMs = Math.round(state.duration * 1000)` (Volumio uses **seconds** for duration — must be converted), `updateUnixMs = Date.now()`, `rate = 1.0` when playing else `0.0`. Returns `null` if `seek` or `duration` is missing, signalling "no timeline" to the driver.
- Texts: `{ title, artist, album, genre }` — Volumio supplies the first three, `genre` is always `null`.

When changing the mapping, double-check the unit asymmetry between `state.seek` (ms) and `state.duration` (s) — easy to break.

### Async style

Volumio's plugin lifecycle hooks (`onVolumioStart`, `onStart`, `onStop`, `getUIConfig`) return **kew** (`libQ`) promises — Volumio's plugin manager expects kew-compatible thenables (`.fail` instead of `.catch` on the i18n call is intentional). Don't substitute native Promises in those hooks. Internally (`connectAndRegister`, `assignToAllDevices`, `pushLastState`) we use native `async`/`await` against the `@hemspzoo/fsct-client` API and bridge to kew at the lifecycle boundary.

## Plugin packaging files

- `package.json` `volumio_info` block declares plugin metadata Volumio reads at install time — `prettyName`, `plugin_type`, `architectures` (`amd64`, `armhf`), `os` (`bookworm`). Bumping `version` here is what triggers an update in the store. The `@hemspzoo/fsct-client` dep is pinned exactly to the same version as `FSCT_DRIVER_VERSION` in `install.sh` — bump both together.
- `UIConfig.json` — currently empty (no user-configurable settings); `i18n/strings_*.json` provides translations. `getUIConfig` resolves localized strings against `strings_en.json` as fallback.
- `config.json` / `requiredConf.json` — empty placeholders required by Volumio's plugin scaffolding.
- `install.sh` / `uninstall.sh` — must print `plugininstallend` / `pluginuninstallend` respectively for Volumio to consider the step complete. `install.sh` downloads the driver `.deb` matching `dpkg --print-architecture`; `uninstall.sh` removes the `fsct-driver` package via `dpkg -r`.

## Constraints

- Target runtime is Volumio on Debian Bookworm, Node ≥ 20, on `amd64` or `armhf` boards. Don't introduce dependencies that don't ship prebuilt for armhf.
- The driver `.deb` must exist for the target architecture at `https://github.com/HEM-RnD/fsct-host/releases/download/v${FSCT_DRIVER_VERSION}/fsct-driver_${FSCT_DRIVER_VERSION}_${arch}.deb`. If a release is missing the `armhf` build, the install will fail at `curl`.
- Volumio must expose FSCT-capable DACs to user-space (proper udev rule). The README notes that DAC vendors implementing FSCT should submit a udev rule PR to Volumio OS.
- License: code is Apache-2.0, but FSCT itself is covered by the separate `LICENSE-FSCT.md` (Ferrum Streaming Control Technology™ License v1.0) — keep both headers intact on any new source files.
