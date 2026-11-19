import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { BoardBridge, EngineState } from "../src/connection/engineState";

const bridge: BoardBridge = {
  reportFirstPaint: (epochMs) => ipcRenderer.send("board:first-paint", epochMs),
  reportEngineConnected: (epochMs) => ipcRenderer.send("board:engine-connected", epochMs),
  engineState: () => ipcRenderer.invoke("board:engine-state"),
  onEngineState: (listener) => {
    const handler = (_event: IpcRendererEvent, state: EngineState) => listener(state);
    ipcRenderer.on("board:engine-state", handler);
    return () => void ipcRenderer.off("board:engine-state", handler);
  },
  engineToken: () => ipcRenderer.invoke("board:engine-token"),
  answerInstall: (accepted) => ipcRenderer.send("board:install-answer", accepted),
};

contextBridge.exposeInMainWorld("board", bridge);
