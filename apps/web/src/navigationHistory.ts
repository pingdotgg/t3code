import { useRouter, type RouterHistory } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

// Browsers expose how far back history goes (TanStack's `__TSR_index`) but not
// how far forward it goes. Each history remembers the furthest entry reached
// since its latest push, so the Forward control knows whether it has anywhere
// to go. Start tracking before the first navigation with `trackNavigationHistory`.
const furthestIndexByHistory = new WeakMap<RouterHistory, { furthest: number }>();

function currentIndex(history: RouterHistory): number | null {
  const index = history.location.state.__TSR_index;
  return Number.isInteger(index) ? index : null;
}

export function trackNavigationHistory(history: RouterHistory) {
  if (furthestIndexByHistory.has(history)) return;
  const tracked = { furthest: currentIndex(history) ?? 0 };
  furthestIndexByHistory.set(history, tracked);
  history.subscribe(({ action }) => {
    const index = currentIndex(history);
    if (index === null) return;
    tracked.furthest = action.type === "PUSH" ? index : Math.max(tracked.furthest, index);
  });
}

export function canGoForward(history: RouterHistory): boolean {
  const tracked = furthestIndexByHistory.get(history);
  const index = currentIndex(history);
  return tracked !== undefined && index !== null && index < tracked.furthest;
}

export function useCanGoForward(): boolean {
  const { history } = useRouter();
  return useSyncExternalStore(history.subscribe, () => canGoForward(history));
}
