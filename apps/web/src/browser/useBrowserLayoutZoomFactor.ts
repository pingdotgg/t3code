import { useSyncExternalStore } from "react";

import { resolveBrowserLayoutZoomFactor } from "./browserViewportLayout";

// Zooming the window changes its CSS viewport, so `resize` doubles as the
// zoom-changed signal; Electron has no dedicated renderer event for it.
const subscribeToWindowZoom = (onChange: () => void) => {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
};
const readWindowZoomFactor = () => window.desktopBridge?.getWindowZoomFactor?.() ?? 1;
const readServerWindowZoomFactor = () => 1;

/** Chromium zoom of the app window itself (View > Zoom In/Out); 1 outside the desktop shell. */
export function useWindowZoomFactor(): number {
  return useSyncExternalStore(
    subscribeToWindowZoom,
    readWindowZoomFactor,
    readServerWindowZoomFactor,
  );
}

/**
 * The zoom factor to lay a preview tab out with: host CSS pixels per guest CSS
 * pixel. See `resolveBrowserLayoutZoomFactor`.
 */
export function useBrowserLayoutZoomFactor(previewZoomFactor: number): number {
  return resolveBrowserLayoutZoomFactor(previewZoomFactor, useWindowZoomFactor());
}
