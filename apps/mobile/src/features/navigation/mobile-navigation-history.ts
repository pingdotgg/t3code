export interface MobileNavigationHistorySnapshot {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface MobileNavigationHistory {
  readonly backTarget: () => string | null;
  readonly forwardTarget: () => string | null;
  readonly getSnapshot: () => MobileNavigationHistorySnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly visit: (
    location: MobileNavigationLocation,
    options?: { readonly traversal?: boolean },
  ) => void;
}

export interface MobileNavigationLocation {
  readonly pathname: string;
  readonly transitionKey: string;
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
    backTarget: () => entries[cursor - 1]?.pathname ?? null,
    forwardTarget: () => entries[cursor + 1]?.pathname ?? null,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    visit: (location, options) => {
      const current = entries[cursor];
      if (
        location.pathname === current?.pathname &&
        location.transitionKey === current.transitionKey
      ) {
        return;
      }

      if (options?.traversal) {
        const adjacentIndex =
          entries[cursor - 1]?.pathname === location.pathname
            ? cursor - 1
            : entries[cursor + 1]?.pathname === location.pathname
              ? cursor + 1
              : -1;
        if (adjacentIndex >= 0) {
          entries = entries.map((entry, index) => (index === adjacentIndex ? location : entry));
          cursor = adjacentIndex;
          publish();
          return;
        }
      } else if (location.transitionKey !== current?.transitionKey) {
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
