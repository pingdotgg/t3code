import { ipcRenderer } from "electron";
import { MAC_PERMISSION_HELPER_CHANNEL } from "./ipc/channels.ts";

// This preload belongs only to the static permission panel. No general desktop bridge is exposed.
window.addEventListener("DOMContentLoaded", () => {
  const send = (action: "drag" | "finder" | "close") =>
    ipcRenderer.send(MAC_PERMISSION_HELPER_CHANNEL, action);
  document.getElementById("app")?.addEventListener("dragstart", (event) => {
    event.preventDefault();
    send("drag");
  });
  document.getElementById("app")?.addEventListener("click", () => send("finder"));
  document.getElementById("close")?.addEventListener("click", () => send("close"));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") send("close");
  });
});
