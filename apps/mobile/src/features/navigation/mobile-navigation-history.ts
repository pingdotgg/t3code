export interface MobileNavigationHistorySnapshot {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface MobileNavigationHistory {
  readonly back: () => string | null;
  readonly forward: () => string | null;
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

  const move = (nextCursor: number): string | null => {
    const pathname = entries[nextCursor];
    if (pathname === undefined) {
      return null;
    }
    cursor = nextCursor;
    publish();
    return pathname;
  };

  return {
    back: () => move(cursor - 1),
    forward: () => move(cursor + 1),
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
      entries = [...entries.slice(0, cursor + 1), pathname];
      cursor = entries.length - 1;
      publish();
    },
  };
}
