import { contextBridge, ipcRenderer } from "electron";
import { installPasskeyShim, type PreviewPasskeyBridge } from "./preview/PasskeyShim.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Sandboxed preload cannot access the main-process Effect runtime.
if (process.platform === "darwin") {
  const bridge: PreviewPasskeyBridge = {
    available: () => ipcRenderer.invoke("preview:passkey-available"),
    request: (id, operation, options) =>
      ipcRenderer.invoke("preview:passkey-request", id, operation, options),
    cancel: (id) => ipcRenderer.send("preview:passkey-cancel", id),
  };
  if (process.contextIsolated) {
    contextBridge.exposeInMainWorld("__t3PreviewPasskeys", bridge);
    contextBridge.executeInMainWorld({ func: installPasskeyShim });
  } else {
    window.__t3PreviewPasskeys = bridge;
    installPasskeyShim();
  }
}
