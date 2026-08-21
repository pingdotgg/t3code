import type { RouterHistory } from "@tanstack/react-router";

export interface NavigationHistorySnapshot {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface NavigationHistory {
  readonly back: () => void;
  readonly dispose: () => void;
  readonly forward: () => void;
  readonly getSnapshot: () => NavigationHistorySnapshot;
  readonly start: () => void;
  readonly subscribe: (listener: () => void) => () => void;
}

function snapshotFor(currentPosition: number, maximumPosition: number): NavigationHistorySnapshot {
  return {
    canGoBack: currentPosition > 0,
    canGoForward: currentPosition < maximumPosition,
  };
}

export function createNavigationHistory(history: RouterHistory): NavigationHistory {
  let currentPosition = 0;
  let maximumPosition = 0;
  let snapshot = snapshotFor(currentPosition, maximumPosition);
  let stopTracking: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const update = ({ action }: Parameters<Parameters<RouterHistory["subscribe"]>[0]>[0]) => {
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
    dispose: () => {
      stopTracking?.();
      stopTracking = null;
    },
    forward: () => {
      if (snapshot.canGoForward) {
        history.forward();
      }
    },
    getSnapshot: () => snapshot,
    start: () => {
      if (stopTracking) {
        return;
      }
      stopTracking = history.subscribe(update);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const navigationHistoryByRouterHistory = new WeakMap<RouterHistory, NavigationHistory>();

export function registerNavigationHistory(history: RouterHistory): NavigationHistory {
  const existing = navigationHistoryByRouterHistory.get(history);
  if (existing) {
    return existing;
  }
  const navigationHistory = createNavigationHistory(history);
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
