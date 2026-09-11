import { ipcRenderer } from "electron";
import { SNAP_SHOT_PERMISSION_HELPER_CHANNEL } from "./ipc/channels.ts";

// This preload belongs only to the static permission panel. No general desktop bridge is exposed.
window.addEventListener("DOMContentLoaded", () => {
  const send = (action: "drag" | "finder" | "check" | "close") =>
    ipcRenderer.send(SNAP_SHOT_PERMISSION_HELPER_CHANNEL, action);
  document.getElementById("app")?.addEventListener("dragstart", (event) => {
    event.preventDefault();
    send("drag");
  });
  document.getElementById("app")?.addEventListener("click", () => send("finder"));
  document.getElementById("finder")?.addEventListener("click", () => send("finder"));
  document.getElementById("check")?.addEventListener("click", () => send("check"));
  document.getElementById("close")?.addEventListener("click", () => send("close"));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") send("close");
  });
  ipcRenderer.on(SNAP_SHOT_PERMISSION_HELPER_CHANNEL, (_event, message: unknown) => {
    const status = document.getElementById("status");
    if (status && typeof message === "string") status.textContent = message;
  });
});
