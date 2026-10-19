import { useSyncExternalStore } from "react";

import { resolveBrowserLayoutZoomFactor } from "./browserViewportLayout";

// App zoom changes the CSS viewport, so resize also signals zoom changes.
const subscribeToWindowZoom = (onChange: () => void) => {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
};
const readWindowZoomFactor = () => window.desktopBridge?.getWindowZoomFactor?.() ?? 1;

export function useBrowserLayoutZoomFactor(previewZoomFactor: number) {
  const windowZoomFactor = useSyncExternalStore(subscribeToWindowZoom, readWindowZoomFactor);
  return resolveBrowserLayoutZoomFactor(previewZoomFactor, windowZoomFactor);
}
