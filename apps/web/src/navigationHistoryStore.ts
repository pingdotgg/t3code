import type { RouterHistory } from "@tanstack/react-router";

export interface NavigationHistorySnapshot {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

const NAVIGATION_HISTORY_STORAGE_KEY = "t3.navigation-history";

interface PersistedNavigationHistory {
  readonly key: string;
  readonly maximumPosition: number;
}

function snapshotFor(currentPosition: number, maximumPosition: number): NavigationHistorySnapshot {
  return {
    canGoBack: currentPosition > 0,
    canGoForward: currentPosition < maximumPosition,
  };
}

export function createNavigationHistory(
  history: RouterHistory,
  options: {
    readonly initialMaximumPosition?: number;
    readonly onPositionChange?: (
      location: RouterHistory["location"],
      maximumPosition: number,
    ) => void;
  } = {},
) {
  let currentPosition = history.location.state.__TSR_index ?? 0;
  let maximumPosition = Math.max(currentPosition, options.initialMaximumPosition ?? 0);
  let snapshot = snapshotFor(currentPosition, maximumPosition);
  let started = false;
  const listeners = new Set<() => void>();

  const update = ({
    action,
    location,
  }: Parameters<Parameters<RouterHistory["subscribe"]>[0]>[0]) => {
    switch (action.type) {
      case "PUSH":
        currentPosition += 1;
        maximumPosition = currentPosition;
        break;
      case "BACK":
        currentPosition = Math.max(0, currentPosition - 1);
        break;
      case "FORWARD":
        currentPosition = Math.min(maximumPosition, currentPosition + 1);
        break;
      case "GO":
        currentPosition = Math.max(0, Math.min(maximumPosition, currentPosition + action.index));
        break;
      case "REPLACE":
        break;
    }

    options.onPositionChange?.(location, maximumPosition);

    const nextSnapshot = snapshotFor(currentPosition, maximumPosition);
    if (
      nextSnapshot.canGoBack === snapshot.canGoBack &&
      nextSnapshot.canGoForward === snapshot.canGoForward
    ) {
      return;
    }

    snapshot = nextSnapshot;
    listeners.forEach((listener) => listener());
  };

  return {
    back: () => {
      if (snapshot.canGoBack) {
        history.back();
      }
    },
    forward: () => {
      if (snapshot.canGoForward) {
        history.forward();
      }
    },
    getSnapshot: () => snapshot,
    start: () => {
      if (started) {
        return;
      }
      started = true;
      history.subscribe(update);
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type NavigationHistory = ReturnType<typeof createNavigationHistory>;

const navigationHistoryByRouterHistory = new WeakMap<RouterHistory, NavigationHistory>();

function readPersistedMaximumPosition(history: RouterHistory): number | undefined {
  if (typeof sessionStorage === "undefined") return undefined;

  try {
    const value = sessionStorage.getItem(NAVIGATION_HISTORY_STORAGE_KEY);
    if (!value) return undefined;
    const persisted = JSON.parse(value) as Partial<PersistedNavigationHistory>;
    const currentKey = history.location.state.__TSR_key;
    if (
      !currentKey ||
      persisted.key !== currentKey ||
      typeof persisted.maximumPosition !== "number" ||
      !Number.isInteger(persisted.maximumPosition) ||
      persisted.maximumPosition < 0
    ) {
      return undefined;
    }
    return persisted.maximumPosition;
  } catch {
    return undefined;
  }
}

function persistMaximumPosition(
  location: RouterHistory["location"],
  maximumPosition: number,
): void {
  if (typeof sessionStorage === "undefined") return;
  const key = location.state.__TSR_key;
  if (!key) return;

  try {
    sessionStorage.setItem(
      NAVIGATION_HISTORY_STORAGE_KEY,
      JSON.stringify({ key, maximumPosition } satisfies PersistedNavigationHistory),
    );
  } catch {
    // History controls still work for this document when storage is unavailable.
  }
}

export function registerNavigationHistory(history: RouterHistory): NavigationHistory {
  const existing = navigationHistoryByRouterHistory.get(history);
  if (existing) {
    return existing;
  }
  const currentPosition = history.location.state.__TSR_index ?? 0;
  const initialMaximumPosition = readPersistedMaximumPosition(history);
  const maximumPosition = Math.max(currentPosition, initialMaximumPosition ?? 0);
  const navigationHistory = createNavigationHistory(history, {
    initialMaximumPosition: maximumPosition,
    onPositionChange: persistMaximumPosition,
  });
  persistMaximumPosition(history.location, maximumPosition);
  navigationHistory.start();
  navigationHistoryByRouterHistory.set(history, navigationHistory);
  return navigationHistory;
}

export function navigationHistoryFor(history: RouterHistory): NavigationHistory {
  const navigationHistory = navigationHistoryByRouterHistory.get(history);
  if (!navigationHistory) {
    throw new Error("Navigation history was not registered for this router");
  }
  return navigationHistory;
}
