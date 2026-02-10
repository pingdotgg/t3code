import { contextBridge, ipcRenderer } from "electron";

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const wsUrl = process.env.CODETHING_DESKTOP_WS_URL ?? null;

contextBridge.exposeInMainWorld("desktopBridge", {
  getWsUrl: () => wsUrl,
  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL) as Promise<string | null>,
});
