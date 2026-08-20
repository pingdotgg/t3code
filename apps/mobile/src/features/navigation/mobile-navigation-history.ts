export interface MobileNavigationHistorySnapshot {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface MobileNavigationHistory {
  readonly backTarget: () => string | null;
  readonly forwardTarget: () => string | null;
  readonly getSnapshot: () => MobileNavigationHistorySnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly visit: (pathname: string) => void;
}

function snapshotFor(cursor: number, entryCount: number): MobileNavigationHistorySnapshot {
  return {
    canGoBack: cursor > 0,
    canGoForward: cursor < entryCount - 1,
  };
}

export function createMobileNavigationHistory(initialPathname: string): MobileNavigationHistory {
  let entries = [initialPathname];
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
    backTarget: () => entries[cursor - 1] ?? null,
    forwardTarget: () => entries[cursor + 1] ?? null,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    visit: (pathname) => {
      if (pathname === entries[cursor]) {
        return;
      }
      if (pathname === entries[cursor - 1]) {
        cursor -= 1;
        publish();
        return;
      }
      if (pathname === entries[cursor + 1]) {
        cursor += 1;
        publish();
        return;
      }
      const priorIndex = entries.lastIndexOf(pathname, cursor - 1);
      if (priorIndex >= 0) {
        cursor = priorIndex;
        publish();
        return;
      }
      const forwardIndex = entries.indexOf(pathname, cursor + 1);
      if (forwardIndex >= 0) {
        cursor = forwardIndex;
        publish();
        return;
      }
      entries = [...entries.slice(0, cursor + 1), pathname];
      cursor = entries.length - 1;
      publish();
    },
  };
}
