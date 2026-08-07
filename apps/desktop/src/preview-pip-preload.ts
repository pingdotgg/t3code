// @effect-diagnostics globalDate:off - This isolated Electron preload does not run inside an Effect runtime.
import type { DesktopPreviewRecordingFrame, DesktopThemePalette } from "@t3tools/contracts";
import { contextBridge, ipcRenderer } from "electron";

import {
  PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL,
  PREVIEW_PICTURE_IN_PICTURE_THEME_CHANNEL,
} from "./ipc/channels.ts";

type PreviewPictureInPictureTheme = Pick<DesktopThemePalette, "appearance" | "background">;

contextBridge.exposeInMainWorld("previewPictureInPicture", {
  onFrame: (listener: (frame: DesktopPreviewRecordingFrame) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, frame: unknown) => {
      if (typeof frame !== "object" || frame === null) return;
      listener(frame as DesktopPreviewRecordingFrame);
    };
    ipcRenderer.on(PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL, wrappedListener);
    return () =>
      ipcRenderer.removeListener(PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL, wrappedListener);
  },
  onTheme: (listener: (theme: PreviewPictureInPictureTheme) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, theme: unknown) => {
      if (typeof theme !== "object" || theme === null) return;
      if (!("appearance" in theme) || !("background" in theme)) return;
      if (theme.appearance !== "light" && theme.appearance !== "dark") return;
      if (typeof theme.background !== "string") return;
      listener({ appearance: theme.appearance, background: theme.background });
    };
    ipcRenderer.on(PREVIEW_PICTURE_IN_PICTURE_THEME_CHANNEL, wrappedListener);
    return () =>
      ipcRenderer.removeListener(PREVIEW_PICTURE_IN_PICTURE_THEME_CHANNEL, wrappedListener);
  },
});
