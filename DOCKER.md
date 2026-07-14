# ReaperSet Docker

The Docker build runs ReaperSet as a web/backend service. It does not run the Electron desktop shell or REAPER.

## How It Works

- REAPER runs on the host machine.
- `ReaperSet_Bridge.lua` runs inside REAPER on the host.
- The bridge writes `snapshot.json` and reads `command.txt` in the host `~/.reaperset` folder.
- The container mounts that folder at `/data`.
- The container serves the UI and WebSocket backend on port `47391`.

## Build

```sh
docker build -t reaperset:local .
```

## Run

```sh
docker run --rm \
  -p 47391:47391 \
  -e REAPERSET_BRIDGE_DIR=/data \
  -v "$HOME/.reaperset:/data" \
  reaperset:local
```

Then open:

```text
http://localhost:47391
```

## Docker Compose

```sh
docker compose up --build
```

On Windows, run Docker Compose from PowerShell with the bridge folder set explicitly:

```powershell
$env:REAPERSET_BRIDGE_HOST_DIR="$env:USERPROFILE\.reaperset"
docker compose up --build
```

This must point to the same folder where `ReaperSet_Bridge.lua` writes `snapshot.json`.

## REAPER Setup

Keep using the same bridge script:

```text
reaper/ReaperSet_Bridge.lua
```

Reload the script in REAPER after bridge changes. The Docker container and REAPER must share the same `~/.reaperset` folder through the volume mount.

On Windows, the bridge usually writes to:

```text
C:\Users\<you>\.reaperset\snapshot.json
```

If the web UI says `snapshot missing`, the Docker volume is pointed at the wrong host folder. If it says `snapshot stale`, the folder is mounted but the REAPER bridge script is not actively updating `snapshot.json`.

## Limitations

- The container is web/backend only; it does not launch the Electron desktop window.
- REAPER still runs on the host.
- File-based bridge IPC depends on the mounted `~/.reaperset` volume.
