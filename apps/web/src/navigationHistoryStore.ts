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

function navigationPosition(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : fallback;
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
  let currentPosition = navigationPosition(history.location.state.__TSR_index, 0);
  let maximumPosition = Math.max(
    currentPosition,
    navigationPosition(options.initialMaximumPosition, 0),
  );
  let snapshot = snapshotFor(currentPosition, maximumPosition);
  let started = false;
  let traversalPending = false;
  const listeners = new Set<() => void>();

  const update = ({
    action,
    location,
  }: Parameters<Parameters<RouterHistory["subscribe"]>[0]>[0]) => {
    traversalPending = false;
    switch (action.type) {
      case "PUSH":
        currentPosition = navigationPosition(location.state.__TSR_index, currentPosition + 1);
        maximumPosition = currentPosition;
        break;
      case "BACK":
        currentPosition = navigationPosition(
          location.state.__TSR_index,
          Math.max(0, currentPosition - 1),
        );
        break;
      case "FORWARD":
        currentPosition = navigationPosition(
          location.state.__TSR_index,
          Math.min(maximumPosition, currentPosition + 1),
        );
        break;
      case "GO":
        currentPosition = navigationPosition(
          location.state.__TSR_index,
          Math.max(
            0,
            Math.min(
              maximumPosition,
              currentPosition + (Number.isInteger(action.index) ? action.index : 0),
            ),
          ),
        );
        break;
      case "REPLACE":
        currentPosition = navigationPosition(location.state.__TSR_index, currentPosition);
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
      if (!traversalPending && snapshot.canGoBack) {
        traversalPending = true;
        history.back();
      }
    },
    forward: () => {
      if (!traversalPending && snapshot.canGoForward) {
        traversalPending = true;
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
  const currentPosition = navigationPosition(history.location.state.__TSR_index, 0);
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
