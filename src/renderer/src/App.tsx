import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  BridgeStatus,
  ClientCommand,
  ReaperSnapshot,
  ServerEvent,
  Song,
  SongSection,
  TimedLyric
} from "../../shared/protocol";

declare global {
  interface Window {
    reaperSet?: {
      serverPort: number;
    };
  }
}

const fallbackSnapshot: ReaperSnapshot = {
  projectName: null,
  transport: "stopped",
  positionSeconds: 0,
  songs: [],
  updatedAt: new Date().toISOString()
};

type ConnectionState = "connecting" | "online" | "reconnecting" | "offline";
type WakeLockState = "active" | "unsupported" | "blocked";

function formatTime(totalSeconds: number): string {
  const safeSeconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = Math.floor(safeSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatBarsBeats(totalBeats: number, beatsPerBar: number): string {
  const safeBeatsPerBar = Math.max(1, Math.round(beatsPerBar));
  const wholeBeats = Math.max(0, Math.ceil(totalBeats - 0.01));
  const bars = Math.floor(wholeBeats / safeBeatsPerBar);
  const beats = wholeBeats % safeBeatsPerBar;

  return `${bars}.${beats}`;
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) {
    return "never";
  }

  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<ReaperSnapshot>(fallbackSnapshot);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [wakeLockState, setWakeLockState] = useState<WakeLockState>("unsupported");
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const socketUrl = window.reaperSet
    ? `ws://localhost:${window.reaperSet.serverPort}`
    : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;

  useEffect(() => {
    let cancelled = false;
    let reconnectDelay = 750;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    function scheduleReconnect() {
      if (cancelled) {
        return;
      }

      setConnectionState("reconnecting");
      clearReconnectTimer();
      reconnectTimerRef.current = window.setTimeout(() => {
        connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 5_000);
    }

    function connect() {
      clearReconnectTimer();
      setConnectionState((state) => (state === "reconnecting" || state === "offline" ? "reconnecting" : "connecting"));

      const socket = new WebSocket(socketUrl);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        reconnectDelay = 750;
        setConnectionState("online");
      });

      socket.addEventListener("close", () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        setConnectionState("offline");
        socket.close();
      });

      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data)) as ServerEvent;

          if (message.type === "snapshot") {
            setSnapshot(message.snapshot);
            return;
          }

          if (message.type === "bridge.status") {
            setBridgeStatus(message.status);
          }
        } catch {
          setConnectionState("offline");
        }
      });
    }

    connect();

    return () => {
      cancelled = true;
      clearReconnectTimer();
      const activeSocket = socketRef.current;
      socketRef.current = null;
      activeSocket?.close();
    };
  }, [socketUrl]);

  useEffect(() => {
    let cancelled = false;

    async function requestWakeLock(): Promise<void> {
      if (!navigator.wakeLock || document.visibilityState !== "visible") {
        setWakeLockState("unsupported");
        return;
      }

      try {
        const wakeLock = await navigator.wakeLock.request("screen");
        if (cancelled) {
          await wakeLock.release();
          return;
        }

        wakeLockRef.current = wakeLock;
        setWakeLockState("active");
        wakeLock.addEventListener("release", () => {
          if (wakeLockRef.current === wakeLock) {
            wakeLockRef.current = null;
          }
          if (!cancelled) {
            setWakeLockState("blocked");
          }
        });
      } catch {
        setWakeLockState("blocked");
      }
    }

    function handleVisibilityChange(): void {
      if (document.visibilityState === "visible" && wakeLockRef.current === null) {
        void requestWakeLock();
      }
    }

    void requestWakeLock();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      const wakeLock = wakeLockRef.current;
      wakeLockRef.current = null;
      void wakeLock?.release();
    };
  }, []);

  const sendCommand = useCallback((command: ClientCommand) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(command));
    }
  }, []);

  const totalDuration = useMemo(
    () => snapshot.songs.reduce((duration, song) => duration + Math.max(0, song.endsAtSeconds - song.startsAtSeconds), 0),
    [snapshot.songs]
  );

  const currentSong = useMemo<Song | null>(() => {
    return (
      snapshot.songs.find(
        (song) => snapshot.positionSeconds >= song.startsAtSeconds && snapshot.positionSeconds < song.endsAtSeconds
      ) ??
      snapshot.songs[0] ??
      null
    );
  }, [snapshot.positionSeconds, snapshot.songs]);

  const currentSection = useMemo<SongSection | null>(() => {
    if (currentSong === null || currentSong.sections.length === 0) {
      return null;
    }

    let activeSection: SongSection | null = null;
    for (const section of currentSong.sections) {
      if (section.startsAtSeconds <= snapshot.positionSeconds) {
        activeSection = section;
      }
    }

    return activeSection ?? currentSong.sections[0];
  }, [currentSong, snapshot.positionSeconds]);

  const nextSong = useMemo<Song | null>(() => {
    if (currentSong === null) {
      return snapshot.songs[0] ?? null;
    }

    const currentIndex = snapshot.songs.findIndex((song) => song.id === currentSong.id);
    return snapshot.songs[currentIndex + 1] ?? null;
  }, [currentSong, snapshot.songs]);

  const nextCue = useMemo<{ name: string; startsAtSeconds: number; startsAtBeats?: number } | null>(() => {
    if (currentSong === null) {
      return null;
    }

    const nextSection = currentSong.sections.find((section) => section.startsAtSeconds > snapshot.positionSeconds + 0.025);
    if (nextSection) {
      return {
        name: nextSection.name,
        startsAtSeconds: nextSection.startsAtSeconds,
        startsAtBeats: nextSection.startsAtBeats
      };
    }

    if (nextSong) {
      return {
        name: nextSong.name,
        startsAtSeconds: nextSong.startsAtSeconds,
        startsAtBeats: nextSong.startsAtBeats
      };
    }

    return {
      name: "Song end",
      startsAtSeconds: currentSong.endsAtSeconds,
      startsAtBeats: currentSong.endsAtBeats
    };
  }, [currentSong, nextSong, snapshot.positionSeconds]);

  const visibleLyrics = useMemo<Array<TimedLyric & { active: boolean }>>(() => {
    const timedLyrics = currentSong?.timedLyrics ?? [];
    if (timedLyrics.length === 0) {
      return [];
    }

    let activeIndex = -1;
    for (let index = timedLyrics.length - 1; index >= 0; index -= 1) {
      if (timedLyrics[index].startsAtSeconds <= snapshot.positionSeconds) {
        activeIndex = index;
        break;
      }
    }

    const firstIndex = Math.max(0, activeIndex - 1);
    const lastIndex = Math.min(timedLyrics.length, Math.max(activeIndex + 3, 3));

    return timedLyrics.slice(firstIndex, lastIndex).map((lyric, index) => ({
      ...lyric,
      active: firstIndex + index === activeIndex
    }));
  }, [currentSong?.timedLyrics, snapshot.positionSeconds]);

  const bridgeLabel = bridgeStatus?.connected ? "bridge online" : "bridge offline";
  const bridgeIsStale = bridgeStatus !== null && !bridgeStatus.connected;
  const bridgeOfflineReason =
    bridgeStatus === null
      ? "No bridge status yet."
      : !bridgeStatus.snapshotExists
        ? `No snapshot at ${bridgeStatus.snapshotPath}. Check the Docker volume mount.`
        : `Snapshot is stale: ${formatAge(bridgeStatus.snapshotAgeMs)}. Restart or reload ReaperSet_Bridge.lua in REAPER.`;
  const appIsOnline = connectionState === "online";
  const canSendCommands = appIsOnline && bridgeStatus?.connected === true;
  const canCuePlayback = canSendCommands && (snapshot.transport === "stopped" || snapshot.transport === "paused");
  const startWithPreroll = useCallback(
    (positionSeconds: number) => {
      if (canCuePlayback) {
        sendCommand({ type: "jump.play", positionSeconds });
      }
    },
    [canCuePlayback, sendCommand]
  );
  const stageAlert = !appIsOnline
    ? "Reconnecting to ReaperSet server..."
    : bridgeIsStale
      ? bridgeOfflineReason
      : null;
  const songPosition = currentSong ? snapshot.positionSeconds - currentSong.startsAtSeconds : 0;
  const songRemaining = currentSong ? currentSong.endsAtSeconds - snapshot.positionSeconds : 0;
  const nextSongCountdown = nextSong ? nextSong.startsAtSeconds - snapshot.positionSeconds : 0;
  const nextSongFirstSection = nextSong?.sections[0] ?? null;
  const beatsToNextCue =
    typeof snapshot.positionBeats === "number" && typeof nextCue?.startsAtBeats === "number"
      ? nextCue.startsAtBeats - snapshot.positionBeats
      : null;
  const barsBeatsToNextCue =
    typeof beatsToNextCue === "number" &&
    typeof snapshot.beatsPerBar === "number" &&
    beatsToNextCue < snapshot.beatsPerBar * 2
      ? formatBarsBeats(beatsToNextCue, snapshot.beatsPerBar)
      : null;
  const barsBeatsToNextSong =
    typeof snapshot.positionBeats === "number" &&
    typeof snapshot.beatsPerBar === "number" &&
    typeof nextSong?.startsAtBeats === "number"
      ? formatBarsBeats(nextSong.startsAtBeats - snapshot.positionBeats, snapshot.beatsPerBar)
      : null;

  return (
    <main className="app-shell">
      <aside className="control-rail">
        <div className="brand-block">
          <p className="eyebrow">ReaperSet</p>
          <strong>{snapshot.projectName ?? "No REAPER project"}</strong>
        </div>

        <div className="transport-card">
          <span className="label">Transport</span>
          <strong>{snapshot.transport}</strong>
          <div className="transport-row">
            <button type="button" disabled={!canSendCommands} onClick={() => sendCommand({ type: "transport.play" })}>
              Play
            </button>
            <button type="button" disabled={!canSendCommands} onClick={() => sendCommand({ type: "transport.pause" })}>
              Pause
            </button>
            <button
              type="button"
              disabled={!canSendCommands || nextSong === null}
              onClick={() => nextSong && sendCommand({ type: "jump.next", positionSeconds: nextSong.startsAtSeconds })}
            >
              Next
            </button>
          </div>
        </div>

        <section className="song-list">
          <div className="rail-heading">
            <span className="label">Songs</span>
            <strong>{snapshot.songs.length}</strong>
          </div>
          {snapshot.songs.length === 0 ? (
            <div className="empty-state compact">No songs loaded.</div>
          ) : (
            <ol>
              {snapshot.songs.map((song) => (
                <li key={song.id} className={song.id === currentSong?.id ? "active" : ""}>
                  <button
                    type="button"
                    className="song-cue-button"
                    aria-label={`Start ${song.name} one bar before`}
                    disabled={!canCuePlayback}
                    onClick={() => startWithPreroll(song.startsAtSeconds)}
                  >
                    {song.name}
                    {song.lyrics ? <small>lyrics</small> : null}
                  </button>
                  <span>{formatTime(song.endsAtSeconds - song.startsAtSeconds)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <div className="status-stack">
          <div className={`status-pill ${connectionState}`}>app {connectionState}</div>
          <div className={`status-pill ${bridgeStatus?.connected ? "online" : "offline"}`}>{bridgeLabel}</div>
          {bridgeStatus && !bridgeStatus.connected ? (
            <div className="bridge-diagnostic">
              <span className="label">Bridge Check</span>
              <span>{bridgeStatus.snapshotExists ? `snapshot ${formatAge(bridgeStatus.snapshotAgeMs)}` : "snapshot missing"}</span>
              <small>{bridgeStatus.snapshotPath}</small>
            </div>
          ) : null}
          <div className={`status-pill wake-${wakeLockState}`}>
            screen {wakeLockState === "active" ? "awake" : "sleep may occur"}
          </div>
          {bridgeStatus?.accessUrls && bridgeStatus.accessUrls.length > 0 ? (
            <div className="network-access">
              <span className="label">Local Network</span>
              {bridgeStatus.accessUrls.slice(0, 3).map((url) => (
                <a key={url} href={url}>
                  {url}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </aside>

      <section className="stage-panel">
        {stageAlert ? <div className="stage-alert">{stageAlert}</div> : null}
        <header className="song-header">
          <div>
            <span className="label">Song</span>
            {currentSong ? (
              <button
                type="button"
                className="headline-cue-button"
                aria-label={`Start ${currentSong.name} one bar before`}
                disabled={!canCuePlayback}
                onClick={() => startWithPreroll(currentSong.startsAtSeconds)}
              >
                {currentSong.name}
              </button>
            ) : (
              <h1>Waiting for song regions</h1>
            )}
          </div>
          <div className="song-metrics">
            <div>
              <span className="label">Position</span>
              <strong>{formatTime(songPosition)}</strong>
            </div>
            <div>
              <span className="label">Remaining</span>
              <strong>{formatTime(songRemaining)}</strong>
            </div>
            <div>
              <span className="label">Set Length</span>
              <strong>{formatTime(totalDuration)}</strong>
            </div>
          </div>
        </header>

        <section className="song-part">
          <span className="label">Song Part</span>
          <strong>{currentSection?.name ?? "No section marker"}</strong>
          <div className="next-cue-line">
            <span>Next cue</span>
            {barsBeatsToNextCue ? <strong>{barsBeatsToNextCue}</strong> : null}
            <em>{nextCue?.name ?? "No next cue"}</em>
          </div>
          {currentSong && currentSong.sections.length > 0 ? (
            <div className="section-strip">
              {currentSong.sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className={section.id === currentSection?.id ? "active" : ""}
                  aria-label={`Start ${section.name} one bar before`}
                  disabled={!canCuePlayback}
                  onClick={() => startWithPreroll(section.startsAtSeconds)}
                >
                  {section.name}
                </button>
              ))}
            </div>
          ) : null}
        </section>

        <section className="up-next-panel">
          <div>
            <span className="label">Up Next</span>
            <strong>{nextSong?.name ?? "End of set"}</strong>
            <small>{nextSongFirstSection ? `Starts with ${nextSongFirstSection.name}` : "No next song queued"}</small>
          </div>
          <div className="up-next-metrics">
            <div>
              <span className="label">In</span>
              <strong>{nextSong ? formatTime(nextSongCountdown) : "--"}</strong>
            </div>
            <div>
              <span className="label">Bars/Beats</span>
              <strong>{nextSong ? (barsBeatsToNextSong ?? "--") : "--"}</strong>
            </div>
          </div>
        </section>

        <section className="detail-window">
          <div className="detail-heading">
            <span className="label">Lyrics</span>
          </div>
          <div className="lyrics-panel">
            {visibleLyrics.length > 0 ? (
              <div className="synced-lyrics">
                {visibleLyrics.map((lyric) => (
                  <div key={lyric.id} className={lyric.active ? "active" : ""}>
                    <strong>{lyric.text}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">No lyrics items for this song.</div>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}
