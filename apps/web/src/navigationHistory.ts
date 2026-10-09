import { useRouter, type RouterHistory } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

// Browsers expose how far back history goes (TanStack's `__TSR_index`) but not
// how far forward it goes. Each history remembers the furthest entry reached
// since its latest push, so the Forward control knows whether it has anywhere
// to go. Start tracking before the first navigation with `trackNavigationHistory`.
// The position lives in sessionStorage because a reload keeps the window's
// forward entries.
const FURTHEST_INDEX_KEY = "t3code:navigation-furthest-index";

const furthestIndexByHistory = new WeakMap<RouterHistory, { furthest: number }>();

function currentIndex(history: RouterHistory): number | null {
  const index = history.location.state.__TSR_index;
  return Number.isInteger(index) ? index : null;
}

// Stored with the current entry's key, so only a reload of that same entry reuses it.
function readStoredIndex(history: RouterHistory, getStorage: () => Storage): number | null {
  try {
    const stored = JSON.parse(getStorage().getItem(FURTHEST_INDEX_KEY) ?? "{}") as {
      key?: unknown;
      furthest?: unknown;
    };
    const { key, furthest } = stored;
    return key === history.location.state.__TSR_key && Number.isInteger(furthest)
      ? Number(furthest)
      : null;
  } catch {
    return null;
  }
}

function storeIndex(history: RouterHistory, getStorage: () => Storage, furthest: number) {
  try {
    const key = history.location.state.__TSR_key;
    getStorage().setItem(FURTHEST_INDEX_KEY, JSON.stringify({ key, furthest }));
  } catch {
    // Without storage, Forward still works until the next reload.
  }
}

export function trackNavigationHistory(
  history: RouterHistory,
  getStorage: () => Storage = () => window.sessionStorage,
) {
  if (furthestIndexByHistory.has(history)) return;
  const index = currentIndex(history) ?? 0;
  const tracked = { furthest: Math.max(index, readStoredIndex(history, getStorage) ?? index) };
  furthestIndexByHistory.set(history, tracked);
  history.subscribe(({ action }) => {
    const index = currentIndex(history);
    if (index === null) return;
    tracked.furthest = action.type === "PUSH" ? index : Math.max(tracked.furthest, index);
    storeIndex(history, getStorage, tracked.furthest);
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
