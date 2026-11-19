import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("board", {
  reportFirstPaint: (epochMs: number) => ipcRenderer.send("board:first-paint", epochMs),
});
