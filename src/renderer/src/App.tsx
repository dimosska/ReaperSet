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
  const barLabel = bars === 1 ? "bar" : "bars";
  const beatLabel = beats === 1 ? "beat" : "beats";

  return `${bars} ${barLabel} ${beats} ${beatLabel}`;
}

export function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<ReaperSnapshot>(fallbackSnapshot);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [activeTab, setActiveTab] = useState<"lyrics" | "notes">("lyrics");
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

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
  const appIsOnline = connectionState === "online";
  const canSendCommands = appIsOnline && bridgeStatus?.connected === true;
  const stageAlert = !appIsOnline
    ? "Reconnecting to ReaperSet server..."
    : bridgeIsStale
      ? "Waiting for REAPER bridge updates..."
      : null;
  const songPosition = currentSong ? snapshot.positionSeconds - currentSong.startsAtSeconds : 0;
  const songRemaining = currentSong ? currentSong.endsAtSeconds - snapshot.positionSeconds : 0;
  const barsBeatsToNextCue =
    typeof snapshot.positionBeats === "number" &&
    typeof snapshot.beatsPerBar === "number" &&
    typeof nextCue?.startsAtBeats === "number"
      ? formatBarsBeats(nextCue.startsAtBeats - snapshot.positionBeats, snapshot.beatsPerBar)
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
                  <span>
                    {song.name}
                    {song.notes || song.lyrics ? <small>details</small> : null}
                  </span>
                  <span>{formatTime(song.endsAtSeconds - song.startsAtSeconds)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <div className="status-stack">
          <div className={`status-pill ${connectionState}`}>app {connectionState}</div>
          <div className={`status-pill ${bridgeStatus?.connected ? "online" : "offline"}`}>{bridgeLabel}</div>
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
            <h1>{currentSong?.name ?? "Waiting for @song regions"}</h1>
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
            <strong>{barsBeatsToNextCue ?? "--"}</strong>
            <em>{nextCue?.name ?? "No next cue"}</em>
          </div>
          {currentSong && currentSong.sections.length > 0 ? (
            <div className="section-strip">
              {currentSong.sections.map((section) => (
                <span key={section.id} className={section.id === currentSection?.id ? "active" : ""}>
                  {section.name}
                </span>
              ))}
            </div>
          ) : null}
        </section>

        <section className="detail-window">
          <div className="tabs" role="tablist" aria-label="Song detail view">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "lyrics"}
              className={activeTab === "lyrics" ? "active" : ""}
              onClick={() => setActiveTab("lyrics")}
            >
              Lyrics
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "notes"}
              className={activeTab === "notes" ? "active" : ""}
              onClick={() => setActiveTab("notes")}
            >
              Notes
            </button>
          </div>

          {activeTab === "lyrics" ? (
            <div className="tab-panel lyrics-tab" role="tabpanel">
              {visibleLyrics.length > 0 ? (
                <div className="synced-lyrics">
                  {visibleLyrics.map((lyric) => (
                    <div key={lyric.id} className={lyric.active ? "active" : ""}>
                      <span>{formatTime(lyric.startsAtSeconds - (currentSong?.startsAtSeconds ?? 0))}</span>
                      <strong>{lyric.text}</strong>
                    </div>
                  ))}
                </div>
              ) : null}
              <pre>{currentSong?.lyrics?.trim() ? currentSong.lyrics : "No REAPER @lyric markers for this song."}</pre>
            </div>
          ) : (
            <div className="tab-panel" role="tabpanel">
              <pre>{currentSong?.notes?.trim() ? currentSong.notes : "No REAPER @note markers for this song."}</pre>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
