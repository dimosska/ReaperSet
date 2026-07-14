import { app, BrowserWindow } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type { BridgeStatus, ClientCommand, ReaperSnapshot, ServerEvent } from "../shared/protocol";

const APP_PORT = Number(process.env.REAPERSET_PORT ?? 47391);
const BRIDGE_DIR = join(homedir(), ".reaperset");
const SNAPSHOT_PATH = join(BRIDGE_DIR, "snapshot.json");
const COMMAND_PATH = join(BRIDGE_DIR, "command.txt");
const BRIDGE_TIMEOUT_MS = 3_000;

let mainWindow: BrowserWindow | null = null;

const initialSnapshot: ReaperSnapshot = {
  projectName: null,
  transport: "stopped",
  positionSeconds: 0,
  songs: [],
  updatedAt: new Date().toISOString()
};

let latestSnapshot = initialSnapshot;
let lastSnapshotPayload = "";
let lastSeenAt: string | null = null;
let bridgeConnected = false;

function broadcast(event: ServerEvent): void {
  const payload = JSON.stringify(event);
  for (const client of webSocketServer.clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

function getBridgeStatus(): BridgeStatus {
  return {
    mode: "local-file",
    snapshotPath: SNAPSHOT_PATH,
    commandPath: COMMAND_PATH,
    connected: bridgeConnected,
    lastSeenAt
  };
}

function broadcastBridgeStatus(): void {
  broadcast({ type: "bridge.status", status: getBridgeStatus() });
}

async function writeBridgeCommand(command: ClientCommand): Promise<void> {
  await mkdir(BRIDGE_DIR, { recursive: true });

  if (command.type === "transport.play") {
    await writeFile(COMMAND_PATH, "transport.play\n", "utf8");
    return;
  }

  if (command.type === "transport.pause") {
    await writeFile(COMMAND_PATH, "transport.pause\n", "utf8");
    return;
  }

  if (command.type === "jump.next") {
    await writeFile(COMMAND_PATH, `jump ${command.positionSeconds}\n`, "utf8");
  }
}

async function readBridgeSnapshot(): Promise<void> {
  if (!existsSync(SNAPSHOT_PATH)) {
    if (bridgeConnected) {
      bridgeConnected = false;
      broadcastBridgeStatus();
    }
    return;
  }

  try {
    const payload = await readFile(SNAPSHOT_PATH, "utf8");
    const snapshot = JSON.parse(payload) as ReaperSnapshot;

    lastSeenAt = snapshot.updatedAt;
    const nextBridgeConnected = Date.now() - Date.parse(snapshot.updatedAt) < BRIDGE_TIMEOUT_MS;

    if (payload !== lastSnapshotPayload) {
      lastSnapshotPayload = payload;
      latestSnapshot = snapshot;
      broadcast({ type: "snapshot", snapshot: latestSnapshot });
    }

    if (nextBridgeConnected !== bridgeConnected) {
      bridgeConnected = nextBridgeConnected;
      broadcastBridgeStatus();
    }
  } catch (error) {
    broadcast({
      type: "error",
      message: error instanceof Error ? error.message : "Failed to read REAPER bridge snapshot"
    });
  }
}

const httpServer = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, app: "ReaperSet" }));
    return;
  }

  if (request.url === "/snapshot") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(latestSnapshot));
    return;
  }

  if (request.url === "/bridge/status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(getBridgeStatus()));
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

const webSocketServer = new WebSocketServer({ server: httpServer });

webSocketServer.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "snapshot", snapshot: latestSnapshot } satisfies ServerEvent));
  socket.send(JSON.stringify({ type: "bridge.status", status: getBridgeStatus() } satisfies ServerEvent));

  socket.on("message", async (rawMessage) => {
    try {
      const message = JSON.parse(String(rawMessage)) as ClientCommand;

      await writeBridgeCommand(message);
    } catch (error) {
      socket.send(
        JSON.stringify({
          type: "error",
          message: error instanceof Error ? error.message : "Invalid client command"
        } satisfies ServerEvent)
      );
    }
  });
});

mkdir(BRIDGE_DIR, { recursive: true }).catch((error: unknown) => {
  console.error("Failed to initialize bridge directory", error);
});

const bridgePoll = setInterval(() => {
  readBridgeSnapshot().catch((error: unknown) => {
    console.error("Failed to poll bridge snapshot", error);
  });
}, 250);

httpServer.listen(APP_PORT, "0.0.0.0", () => {
  console.log(`ReaperSet server listening on http://localhost:${APP_PORT}`);
  console.log(`ReaperSet bridge snapshot: ${SNAPSHOT_PATH}`);
  console.log(`ReaperSet bridge command: ${COMMAND_PATH}`);
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    title: "ReaperSet",
    backgroundColor: "#101113",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  clearInterval(bridgePoll);
  webSocketServer.close();
  httpServer.close();
});
