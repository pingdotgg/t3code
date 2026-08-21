export interface MobileNavigationHistorySnapshot {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface MobileNavigationLocation {
  readonly pathname: string;
  readonly transitionKey: string;
}

function snapshotFor(cursor: number, entryCount: number) {
  return {
    canGoBack: cursor > 0,
    canGoForward: cursor < entryCount - 1,
  };
}
export function normalizeMobileNavigationPath(rawPath: string) {
  const url = new URL(rawPath, "t3code://app");
  for (const [key, value] of url.searchParams) {
    if (value === "[object Object]") url.searchParams.delete(key);
  }
  return `${url.pathname}${url.search}`;
}

export function createMobileNavigationHistory(initialLocation: MobileNavigationLocation) {
  let entries = [initialLocation];
  let cursor = 0;
  let snapshot = snapshotFor(cursor, entries.length);
  let pendingTarget: { index: number; location: MobileNavigationLocation } | null = null;
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
      if (pendingTarget) return null;
      const index = cursor - 1;
      const location = entries[index];
      pendingTarget = location ? { index, location } : null;
      return pendingTarget;
    },
    requestForward: () => {
      if (pendingTarget) return null;
      const index = cursor + 1;
      const location = entries[index];
      pendingTarget = location ? { index, location } : null;
      return pendingTarget;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    visit: (location: MobileNavigationLocation) => {
      const current = entries[cursor];
      if (location.pathname === current?.pathname) {
        entries = entries.map((entry, index) => (index === cursor ? location : entry));
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
