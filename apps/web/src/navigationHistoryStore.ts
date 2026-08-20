import type { RouterHistory } from "@tanstack/react-router";

export interface NavigationHistorySnapshot {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface NavigationHistory {
  readonly back: () => void;
  readonly forward: () => void;
  readonly getSnapshot: () => NavigationHistorySnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}

function snapshotFor(history: RouterHistory, maximumIndex: number): NavigationHistorySnapshot {
  return {
    canGoBack: history.canGoBack(),
    canGoForward: history.location.state.__TSR_index < maximumIndex,
  };
}

export function createNavigationHistory(history: RouterHistory): NavigationHistory {
  let maximumIndex = history.location.state.__TSR_index;
  let snapshot = snapshotFor(history, maximumIndex);
  let stopTracking: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const update = ({
    action,
    location,
  }: Parameters<Parameters<RouterHistory["subscribe"]>[0]>[0]) => {
    if (action.type === "PUSH") {
      maximumIndex = location.state.__TSR_index;
    } else {
      maximumIndex = Math.max(maximumIndex, location.state.__TSR_index);
    }

    const nextSnapshot = snapshotFor(history, maximumIndex);
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
    subscribe: (listener) => {
      listeners.add(listener);
      stopTracking ??= history.subscribe(update);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stopTracking?.();
          stopTracking = null;
        }
      };
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
