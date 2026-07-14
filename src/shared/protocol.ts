export type TransportState = "stopped" | "playing" | "paused";

export interface SongSection {
  id: string;
  name: string;
  startsAtSeconds: number;
  endsAtSeconds?: number;
  loopable: boolean;
}

export interface TimedLyric {
  id: string;
  text: string;
  startsAtSeconds: number;
}

export interface Song {
  id: string;
  name: string;
  startsAtSeconds: number;
  endsAtSeconds: number;
  color?: string;
  notes?: string;
  lyrics?: string;
  timedLyrics: TimedLyric[];
  sections: SongSection[];
}

export interface ReaperSnapshot {
  projectName: string | null;
  transport: TransportState;
  positionSeconds: number;
  songs: Song[];
  updatedAt: string;
}

export interface BridgeStatus {
  mode: "local-file";
  snapshotPath: string;
  commandPath: string;
  connected: boolean;
  lastSeenAt: string | null;
}

export type ClientCommand =
  | { type: "transport.play" }
  | { type: "transport.pause" }
  | { type: "jump.next"; positionSeconds: number };

export type ServerEvent =
  | { type: "snapshot"; snapshot: ReaperSnapshot }
  | { type: "bridge.status"; status: BridgeStatus }
  | { type: "error"; message: string };
