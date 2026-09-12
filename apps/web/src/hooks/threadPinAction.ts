// Shared across hook instances so sidebar, header and menu actions invalidate each other.
const currentActions = new Map<string, symbol>();

/** Claims a thread's pin state for one unpin Undo; any later claim or invalidation expires it. */
export function begin(key: string) {
  const token = Symbol();
  currentActions.set(key, token);
  const isCurrent = () => currentActions.get(key) === token;
  return {
    isCurrent,
    finish: () => {
      if (isCurrent()) currentActions.delete(key);
    },
  };
}

/** Expires any outstanding Undo for the thread, e.g. when it is pinned or reordered. */
export function invalidate(key: string) {
  currentActions.delete(key);
}
