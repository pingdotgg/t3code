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
  const search = new URLSearchParams(
    Array.from(url.searchParams).filter(([, value]) => value !== "[object Object]"),
  );
  return `${url.pathname}${search.size > 0 ? `?${search}` : ""}`;
}
export function createMobileNavigationHistory(initialLocation: MobileNavigationLocation) {
  let entries = [initialLocation];
  let cursor = 0;
  let snapshot = snapshotFor(cursor, entries.length);
  let pendingTarget:
    | {
        direction: "back" | "forward";
        index: number;
        location: MobileNavigationLocation;
      }
    | { direction: "replace"; pathname: string }
    | null = null;
  const listeners = new Set<() => void>();
  const request = (direction: "back" | "forward", index: number) => {
    if (pendingTarget) return null;
    const location = entries[index];
    pendingTarget = location ? { direction, index, location } : null;
    return pendingTarget;
  };
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
    requestBack: () => request("back", cursor - 1),
    requestForward: () => request("forward", cursor + 1),
    requestReplacement: (pathname: string) => {
      if (pendingTarget) return false;
      pendingTarget = { direction: "replace", pathname };
      return true;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    visit: (location: MobileNavigationLocation) => {
      const current = entries[cursor];
      const target = pendingTarget;
      const targetPathname =
        target?.direction === "replace" ? target.pathname : target?.location.pathname;
      if (target && targetPathname === location.pathname) {
        pendingTarget = null;
        if (target.direction === "replace") {
          entries = entries.map((entry, index) => (index === cursor ? location : entry));
          return;
        }
        const previousRoot = target.location.transitionKey.split("/")[0]!;
        const nextRoot = location.transitionKey.split("/")[0]!;
        entries = entries.map((entry, index) => {
          const [root, ...nestedKeys] = entry.transitionKey.split("/");
          return index === target.index
            ? location
            : previousRoot !== nextRoot && root === previousRoot
              ? { ...entry, transitionKey: [nextRoot, ...nestedKeys].join("/") }
              : entry;
        });
        cursor = target.index;
        publish();
        return;
      }
      if (location.pathname === current?.pathname) {
        entries = entries.map((entry, index) => (index === cursor ? location : entry));
        return;
      }
      pendingTarget = null;
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
