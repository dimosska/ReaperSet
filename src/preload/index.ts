import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("reaperSet", {
  serverPort: Number(process.env.REAPERSET_PORT ?? 47391)
});
