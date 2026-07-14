# ReaperSet Progress

## Goal

Build a REAPER-focused live playback and setlist controller inspired by AbleSet.

The app should let performers view songs, sections, lyrics, cues, and playback state from a local browser UI while keeping REAPER as the editor and playback engine.

## Current Status

Status: Read-only stage view with REAPER-authored content

The Electron and React scaffold is in place. The first local REAPER bridge uses file-based IPC in `~/.reaperset`.

## MVP Scope

- [x] Choose desktop app stack
- [x] Scaffold app shell
- [x] Create REAPER bridge proof of concept
- [x] Read REAPER markers and regions
- [x] Convert regions into songs
- [x] Convert markers into song sections
- [x] Sync REAPER playback state to app
- [x] Send play, pause, and next commands to REAPER
- [x] Serve browser UI on local network
- [x] Build performance view
- [x] View REAPER timeline song order
- [x] Remove app-side setlist editing
- [x] Add basic lyrics support
- [x] Add time-synced REAPER lyric items
- [ ] Add chords support
- [ ] Add MIDI or OSC control mapping
- [x] Package as Docker container

## Recommended Architecture

- Desktop host app: Electron
- Backend: local Node.js HTTP/WebSocket service
- REAPER integration: Lua ReaScript bridge using local file IPC
- Browser UI: React touch-friendly web app for computer, tablet, and phone
- State sync: WebSocket between host, REAPER bridge, and clients

## Local Development Setup

Current setup:

- REAPER and ReaperSet run on the same machine
- REAPER bridge writes snapshots to `~/.reaperset/snapshot.json`
- ReaperSet writes commands to `~/.reaperset/command.txt`
- Browser clients connect to the Electron app's local WebSocket backend

## REAPER Metadata Convention

Proposed convention:

- Song regions: `Song Name`
- Section markers: `Verse 1`, `Chorus`, `Bridge`, `End`
- Timed lyric items: media items on a track named `Lyrics`; use item notes or the item/take name as the lyric line
- Optional marker tags: `loop=true`, `skip=false`, `color=#RRGGBB`
- Song order and lyrics: edited only in REAPER
- Freeform lyrics/chords: use dedicated REAPER tracks or items, not app-side editing
- Click track: manually prepared REAPER track/items per song for now
- Voice cues: manually pasted REAPER audio items per song for now

## Milestones

### 1. REAPER Bridge Prototype

- [x] Create Lua bridge script
- [x] Run bridge as deferred ReaScript
- [x] Detect active project
- [x] Read regions and markers
- [x] Report transport state
- [x] Accept basic transport commands

### 2. Core App Prototype

- [x] Scaffold Electron app
- [x] Scaffold React frontend
- [x] Add backend state store
- [x] Connect backend to REAPER bridge
- [x] Render current project setlist
- [x] Control Play, Pause, and Next from UI

### 3. Stage UI

- [ ] Add large current song display
- [x] Add next song display
- [x] Add elapsed and remaining time
- [x] Add read-only section display
- [x] Add tablet-friendly layout
- [x] Add reconnect and offline indicators

### 4. Setlist Management

- [x] Use REAPER region order as setlist order
- [x] Remove named app setlists
- [x] Display total show duration
- [ ] Add colors per song

### 5. Performance Features

- [ ] Add section looping
- [x] Add lyrics display
- [x] Add time-synced lyric display from REAPER items
- [ ] Add chords display
- [ ] Document click track preparation workflow
- [ ] Document manual voice cue preparation workflow
- [ ] Add MIDI mapping
- [ ] Add OSC input/output
- [ ] Add timed cue events

### 6. Packaging

- [ ] Add Electron installer/build workflow
- [ ] Add REAPER bridge installer
- [x] Document setup process
- [ ] Create demo REAPER project

### 7. Containerization

- [x] Add Dockerfile for web/backend mode
- [x] Add docker-compose example
- [x] Document host volume for `~/.reaperset`
- [x] Document local REAPER bridge limitations with containers

## Open Decisions

- [x] Tauri vs Electron: Electron selected
- [x] React vs Svelte vs another frontend: React selected
- [x] WebSocket protocol shape: app UI uses WebSocket to backend
- [x] Bridge app host configuration UX: skipped for local-only file bridge
- [x] Lyrics source format: media items on a REAPER track named `Lyrics`
- [ ] Chords source format
- [x] Whether to support multi-project setlists in MVP: no app-side setlists for MVP
- [ ] Whether to require SWS/ReaPack or stay pure REAPER Lua

## Risks

- REAPER bridge reliability during live playback
- Network reconnect behavior for stage devices
- Marker naming conventions becoming too strict or too vague
- Multi-project support increasing MVP complexity
- MIDI/OSC mapping UX becoming too broad too early

## Notes

- Prioritize reliability over feature breadth.
- Keep the MVP local-first and usable without internet.
- Treat REAPER as the playback source of truth.
- Treat the app as a read-only stage surface with Play, Pause, and Next controls.
- Treat REAPER as the only editor for song order, lyrics, click tracks, and voice cues.
