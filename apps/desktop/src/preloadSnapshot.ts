export function createPreloadSnapshot<T>(readInitial: () => T, readLatest: () => Promise<T>) {
  let snapshot: { readonly value: T } | undefined;
  let pending: Promise<T> | undefined;

  return {
    read: () => {
      snapshot ??= { value: readInitial() };
      return snapshot.value;
    },
    refresh: () => {
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
