export interface MobileNavigationHistorySnapshot {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface MobileNavigationHistory {
  readonly cancelPendingTraversal: () => void;
  readonly getSnapshot: () => MobileNavigationHistorySnapshot;
  readonly requestBack: () => MobileNavigationTarget | null;
  readonly requestForward: () => MobileNavigationTarget | null;
  readonly subscribe: (listener: () => void) => () => void;
  readonly visit: (location: MobileNavigationLocation) => void;
}

export interface MobileNavigationLocation {
  readonly pathname: string;
  readonly transitionKey: string;
}

export interface MobileNavigationTarget {
  readonly direction: "back" | "forward";
  readonly index: number;
  readonly location: MobileNavigationLocation;
}

function snapshotFor(cursor: number, entryCount: number): MobileNavigationHistorySnapshot {
  return {
    canGoBack: cursor > 0,
    canGoForward: cursor < entryCount - 1,
  };
}

export function createMobileNavigationHistory(
  initialLocation: MobileNavigationLocation,
): MobileNavigationHistory {
  let entries = [initialLocation];
  let cursor = 0;
  let snapshot = snapshotFor(cursor, entries.length);
  let pendingTarget: MobileNavigationTarget | null = null;
  const listeners = new Set<() => void>();

  const publish = () => {
    const nextSnapshot = snapshotFor(cursor, entries.length);
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
    cancelPendingTraversal: () => {
      pendingTarget = null;
    },
    getSnapshot: () => snapshot,
    requestBack: () => {
      const index = cursor - 1;
      const location = entries[index];
      pendingTarget = location ? { direction: "back", index, location } : null;
      return pendingTarget;
    },
    requestForward: () => {
      const index = cursor + 1;
      const location = entries[index];
      pendingTarget = location ? { direction: "forward", index, location } : null;
      return pendingTarget;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    visit: (location) => {
      const current = entries[cursor];
      if (
        location.pathname === current?.pathname &&
        location.transitionKey === current.transitionKey
      ) {
        return;
      }

      if (pendingTarget) {
        const target = pendingTarget;
        pendingTarget = null;
        if (target.location.pathname === location.pathname) {
          entries = entries.map((entry, index) => (index === target.index ? location : entry));
          cursor = target.index;
          publish();
          return;
        }
      }

      if (location.transitionKey !== current?.transitionKey) {
        const priorIndex = entries.findLastIndex(
          (entry, index) => index < cursor && entry.transitionKey === location.transitionKey,
        );
        if (priorIndex >= 0) {
          cursor = priorIndex;
          publish();
          return;
        }
        const forwardIndex = entries.findIndex(
          (entry, index) => index > cursor && entry.transitionKey === location.transitionKey,
        );
        if (forwardIndex >= 0) {
          cursor = forwardIndex;
          publish();
          return;
        }
      }

      entries = [...entries.slice(0, cursor + 1), location];
      cursor = entries.length - 1;
      publish();
    },
  };
}
