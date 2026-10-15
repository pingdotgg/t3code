/** Keep synchronous startup consumers while refreshing through nonblocking IPC. */
export function createPreloadSnapshot<T>(readInitial: () => T, readLatest: () => Promise<T>) {
  let snapshot: { readonly value: T } | undefined;
  let pending: Promise<T> | undefined;

  return {
    read: (): T => {
      snapshot ??= { value: readInitial() };
      return snapshot.value;
    },
    refresh: (): Promise<T> => {
      if (pending !== undefined) return pending;
      pending = readLatest()
        .then((value) => {
          snapshot = { value };
          return value;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}
