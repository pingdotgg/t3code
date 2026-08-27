type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();
let pending: string | null = null;

/**
 * A sidebar "Rename" hands the request to the view showing that thread. That
 * view usually mounts after the navigation that follows, so an unclaimed
 * request waits for it; a view for any other thread mounting drops it.
 */
export function requestShellRename(threadKey: string): void {
  const targets = listeners.get(threadKey);
  if (targets !== undefined && targets.size > 0) {
    for (const listener of targets) listener();
    return;
  }
  pending = threadKey;
}

export function subscribeShellRenameRequests(threadKey: string, listener: Listener): () => void {
  let targets = listeners.get(threadKey);
  if (targets === undefined) {
    targets = new Set();
    listeners.set(threadKey, targets);
  }
  targets.add(listener);
  if (pending !== null) {
    const claimed = pending === threadKey;
    pending = null;
    if (claimed) listener();
  }
  return () => {
    targets.delete(listener);
    if (targets.size === 0) listeners.delete(threadKey);
  };
}
