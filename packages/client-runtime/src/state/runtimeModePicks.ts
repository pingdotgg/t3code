import type { RuntimeMode } from "@t3tools/contracts";

interface PendingPicks {
  readonly count: number;
  readonly latest: number;
  readonly latestMode: RuntimeMode;
  readonly latestSaved: boolean;
}

// The thread shell lags saves in flight, so it alone cannot tell whether a pick changes anything.
const pendingByThread = new Map<string, PendingPicks>();

/**
 * Starts saving a runtime-mode pick on an existing thread, or returns null when it would change
 * nothing. Its settle callback returns the mode the draft may release once the last save in
 * flight has landed and the latest pick was saved; otherwise null, so a newer pick keeps its
 * draft until its own save lands.
 */
export function beginRuntimeModePickSave(
  threadKey: string,
  storedMode: RuntimeMode,
  pick: RuntimeMode,
): ((saved: boolean) => RuntimeMode | null) | null {
  const current = pendingByThread.get(threadKey);
  if (current === undefined && storedMode === pick) return null;
  const sequence = (current?.latest ?? 0) + 1;
  pendingByThread.set(threadKey, {
    count: (current?.count ?? 0) + 1,
    latest: sequence,
    latestMode: pick,
    latestSaved: false,
  });
  return (saved) => {
    const entry = pendingByThread.get(threadKey);
    if (entry === undefined) return null;
    const settled = {
      ...entry,
      count: entry.count - 1,
      latestSaved: entry.latest === sequence ? saved : entry.latestSaved,
    };
    if (settled.count > 0) {
      pendingByThread.set(threadKey, settled);
      return null;
    }
    pendingByThread.delete(threadKey);
    return settled.latestSaved ? settled.latestMode : null;
  };
}
