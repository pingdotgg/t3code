import type { RouterHistory } from "@tanstack/react-router";
import { useRouter } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

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
  const listeners = new Set<() => void>();

  history.subscribe(({ action, location }) => {
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
  });

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
      return () => listeners.delete(listener);
    },
  };
}

const navigationHistoryByRouterHistory = new WeakMap<RouterHistory, NavigationHistory>();

function navigationHistoryFor(history: RouterHistory): NavigationHistory {
  const existing = navigationHistoryByRouterHistory.get(history);
  if (existing) {
    return existing;
  }
  const navigationHistory = createNavigationHistory(history);
  navigationHistoryByRouterHistory.set(history, navigationHistory);
  return navigationHistory;
}

export function useNavigationHistory(): NavigationHistorySnapshot &
  Pick<NavigationHistory, "back" | "forward"> {
  const router = useRouter();
  const history = navigationHistoryFor(router.history);
  const snapshot = useSyncExternalStore(
    history.subscribe,
    history.getSnapshot,
    history.getSnapshot,
  );
  return {
    ...snapshot,
    back: history.back,
    forward: history.forward,
  };
}
