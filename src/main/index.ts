import { app, BrowserWindow } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { homedir, networkInterfaces } from "node:os";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type { BridgeStatus, ClientCommand, ReaperSnapshot, ServerEvent } from "../shared/protocol";

const APP_PORT = Number(process.env.REAPERSET_PORT ?? 47391);
const APP_HOST = process.env.REAPERSET_HOST ?? "0.0.0.0";
const HOST_LAN_IP = process.env.REAPERSET_HOST_LAN_IP?.trim() ?? "";
const ACCESS_URLS = (process.env.REAPERSET_ACCESS_URLS ?? process.env.REAPERSET_ACCESS_URL ?? "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const BRIDGE_DIR = join(homedir(), ".reaperset");
const SNAPSHOT_PATH = join(BRIDGE_DIR, "snapshot.json");
const COMMAND_PATH = join(BRIDGE_DIR, "command.txt");
const BRIDGE_TIMEOUT_MS = 3_000;
const STATIC_ROOT = normalize(join(__dirname, "../renderer"));

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

function getAccessUrls(): string[] {
  const urls = new Set<string>(ACCESS_URLS);

  if (HOST_LAN_IP) {
    urls.add(`http://${HOST_LAN_IP}:${APP_PORT}`);
  }

  if (urls.size > 0) {
    return Array.from(urls);
  }

  for (const interfaces of Object.values(networkInterfaces())) {
    for (const networkInterface of interfaces ?? []) {
      if (networkInterface.family === "IPv4" && !networkInterface.internal) {
        urls.add(`http://${networkInterface.address}:${APP_PORT}`);
      }
    }
  }

  return urls.size > 0 ? Array.from(urls) : [`http://localhost:${APP_PORT}`];
}

function contentType(pathname: string): string {
  const extension = extname(pathname);

  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }

  if (extension === ".js") {
    return "text/javascript; charset=utf-8";
  }

  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }

  if (extension === ".svg") {
    return "image/svg+xml";
  }

  return "application/octet-stream";
}

function broadcast(event: ServerEvent): void {
  const payload = JSON.stringify(event);
  for (const client of webSocketServer.clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

function getBridgeStatus(): BridgeStatus {
  const snapshotAgeMs = lastSeenAt === null ? null : Math.max(0, Date.now() - Date.parse(lastSeenAt));

  return {
    mode: "local-file",
    snapshotPath: SNAPSHOT_PATH,
    commandPath: COMMAND_PATH,
    accessUrls: getAccessUrls(),
    connected: bridgeConnected,
    snapshotExists: existsSync(SNAPSHOT_PATH),
    snapshotAgeMs,
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

async function serveStatic(pathname: string): Promise<{ body: Buffer; type: string } | null> {
  const decodedPath = decodeURIComponent(pathname);
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const filePath = normalize(join(STATIC_ROOT, relativePath));

  if (!filePath.startsWith(STATIC_ROOT)) {
    return null;
  }

  try {
    return {
      body: await readFile(filePath),
      type: contentType(filePath)
    };
  } catch {
    if (!relativePath.includes(".")) {
      return {
        body: await readFile(join(STATIC_ROOT, "index.html")),
        type: "text/html; charset=utf-8"
      };
    }

    return null;
  }
}

const httpServer = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, app: "ReaperSet" }));
    return;
  }

  if (url.pathname === "/snapshot") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(latestSnapshot));
    return;
  }

  if (url.pathname === "/bridge/status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(getBridgeStatus()));
    return;
  }

  serveStatic(url.pathname)
    .then((result) => {
      if (result === null) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      response.writeHead(200, { "content-type": result.type });
      response.end(result.body);
    })
    .catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "server_error" }));
    });
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

httpServer.listen(APP_PORT, APP_HOST, () => {
  console.log(`ReaperSet server listening on http://${APP_HOST}:${APP_PORT}`);
  console.log(`ReaperSet local URL: http://localhost:${APP_PORT}`);
  console.log(`ReaperSet local network URLs: ${getAccessUrls().join(", ")}`);
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
