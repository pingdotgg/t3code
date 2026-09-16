import { ipcRenderer } from "electron";
import { startDesignEditor } from "@t3tools/client-runtime/design/editor";
import { designPathFromUrl } from "./DesignDocument.ts";
import type { DesktopPreviewAnnotationTheme } from "@t3tools/contracts";
import {
  ANNOTATION_THEME_CHANNEL,
  DESIGN_CHANGED_CHANNEL,
  DESIGN_EDITING_CHANNEL,
} from "./GuestProtocol.ts";

let editor: ReturnType<typeof startDesignEditor> | undefined;
let theme: DesktopPreviewAnnotationTheme | null = null;
ipcRenderer.on(ANNOTATION_THEME_CHANNEL, (_event, next: DesktopPreviewAnnotationTheme) => {
  theme = next;
  editor?.setTheme(next);
});
ipcRenderer.on(DESIGN_EDITING_CHANNEL, (_event, active: unknown) => {
  if (typeof active === "boolean") editor?.setOpen(active);
});
const start = () => {
  if (!designPathFromUrl(location.href)) return;
  editor = startDesignEditor(window, {
    url: location.href,
    theme,
    onChange: async (payload) => ipcRenderer.send(DESIGN_CHANGED_CHANNEL, payload),
  });
};
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", start, { once: true });
} else start();
