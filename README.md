# ReaperSet

ReaperSet is a REAPER-focused live playback and setlist controller. It keeps REAPER as the source of truth for songs, markers, regions, notes, lyrics, cues, and playback, while providing a clean stage UI for performers on the local machine or local network.

The app is inspired by AbleSet-style live set control, but is built around REAPER projects and ReaScript automation.

## What It Does

- Reads REAPER song regions named with `@song:Song Name`
- Uses REAPER markers as song sections, cues, notes, and timed lyrics
- Shows the current song, song part, elapsed time, remaining time, and total set length
- Displays the next cue with bars/beats countdown data from REAPER's tempo map
- Provides Play, Pause, and Next controls back to REAPER
- Serves a browser-based stage UI through a local WebSocket backend
- Supports Electron desktop mode and Docker web/backend mode

## Architecture

- Desktop app: Electron
- Frontend: React
- Backend: Node.js HTTP/WebSocket service
- REAPER bridge: Lua ReaScript
- IPC: local files in `~/.reaperset`

REAPER runs the bridge script at:

```text
reaper/ReaperSet_Bridge.lua
```

The bridge writes live snapshots to:

```text
~/.reaperset/snapshot.json
```

The app writes commands for REAPER to:

```text
~/.reaperset/command.txt
```

## REAPER Marker Convention

- Song regions: `@song:Song Name`
- Section markers: `Verse 1`, `Chorus`, `Bridge`, `End`
- Timed lyric markers: `@lyric:Line text`
- Note markers: `@note:Line text`
- Optional section tags: `loop=true` or `[loop]`

Song order, notes, lyrics, click tracks, voice cues, and timing remain edited in REAPER.

## REAPER Bridge Setup

1. Open REAPER.
2. Open `Actions > Show action list...`.
3. Choose `ReaScript: Load...`.
4. Select `reaper/ReaperSet_Bridge.lua` from this repository.
5. Run `ReaperSet_Bridge.lua` from the action list.
6. Keep the script running while using ReaperSet.

Reload the bridge script after pulling ReaperSet updates that change `reaper/ReaperSet_Bridge.lua`.

The bridge creates `~/.reaperset` automatically. ReaperSet and REAPER must use the same folder so the app can read `snapshot.json` and write `command.txt`.

To use a tablet or another computer on the same network, start ReaperSet on the REAPER machine and open one of the `Local Network` URLs shown in the app status area. Firewalls must allow inbound connections to port `47391`.

When running Docker, set `REAPERSET_BRIDGE_HOST_DIR` to the same folder REAPER uses before starting Compose.

macOS/Linux:

```sh
export REAPERSET_BRIDGE_HOST_DIR="$HOME/.reaperset"
docker compose up --build
```

Windows PowerShell:

```powershell
$env:REAPERSET_BRIDGE_HOST_DIR="$env:USERPROFILE\.reaperset"
docker compose up --build
```

Compose intentionally fails if `REAPERSET_BRIDGE_HOST_DIR` is not set.

To show a friendly LAN URL instead of Docker's internal network address, set:

```env
REAPERSET_ACCESS_URL=http://band.local:47391
```

To also show the real host LAN IP after `band.local`, set:

```env
REAPERSET_HOST_LAN_IP=192.168.0.236
```

Your LAN must resolve `band.local` to the machine running Docker. `REAPERSET_HOST_LAN_IP` must be the Docker host IP, not the container IP.

## Development

Install dependencies:

```sh
npm install
```

Run the Electron app:

```sh
npm run dev
```

Type-check the project:

```sh
npm run typecheck
```

Build the app:

```sh
npm run build
```

Build the web/backend mode:

```sh
npm run build:web
```

## Docker

The Docker build runs only the web/backend service. REAPER and the bridge script still run on the host machine.

See [DOCKER.md](DOCKER.md) for setup details.

## License

ReaperSet is released under the MIT License. See [LICENSE](LICENSE).
