import { useSyncExternalStore } from "react";

export type HistoryDirection = "back" | "forward";

function subscribeToNavigationHistory(onChange: () => void): () => void {
  window.navigation.addEventListener("currententrychange", onChange);
  return () => window.navigation.removeEventListener("currententrychange", onChange);
}

export function canNavigateHistory(direction: HistoryDirection): boolean {
  return direction === "back" ? window.navigation.canGoBack : window.navigation.canGoForward;
}

export function navigateHistory(direction: HistoryDirection) {
  if (direction === "back") window.history.back();
  else window.history.forward();
}

/** Only for Electron: the Navigation API is Chromium-only. */
export function useCanNavigateHistory(direction: HistoryDirection): boolean {
  return useSyncExternalStore(subscribeToNavigationHistory, () => canNavigateHistory(direction));
}
