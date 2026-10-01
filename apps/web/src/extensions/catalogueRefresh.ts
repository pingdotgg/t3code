/** Coalesce receipts during a refresh without cancelling the generation being installed. */
export function createCatalogueRefreshQueue(refresh: () => Promise<void>) {
  let dirty = false;
  let disposed = false;
  let pending: Promise<void> | undefined;
  return {
    request(): Promise<void> {
      if (disposed) return Promise.resolve();
      dirty = true;
      if (!pending) {
        pending = (async () => {
          try {
            while (dirty) {
              dirty = false;
              await refresh();
            }
          } finally {
            pending = undefined;
          }
        })();
      }
      return pending;
    },
    dispose() {
      disposed = true;
      dirty = false;
    },
  };
}
