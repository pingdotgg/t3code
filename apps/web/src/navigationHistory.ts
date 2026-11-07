export type HistoryDirection = "back" | "forward";

export function canNavigateHistory(direction: HistoryDirection): boolean {
  return direction === "back" ? window.navigation.canGoBack : window.navigation.canGoForward;
}

export function navigateHistory(direction: HistoryDirection) {
  if (direction === "back") window.history.back();
  else window.history.forward();
}
