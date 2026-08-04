export interface RecoverableTransitionQueue {
  readonly enqueue: (transition: () => Promise<void>) => Promise<void>;
  readonly retryPending: () => Promise<void>;
  readonly hasPending: () => boolean;
}

export function createRecoverableTransitionQueue(): RecoverableTransitionQueue {
  const pending: Array<() => Promise<void>> = [];
  let active: Promise<void> | null = null;

  const runPending = (): Promise<void> => {
    if (active !== null) {
      return active;
    }
    if (pending.length === 0) {
      return Promise.resolve();
    }
    active = (async () => {
      while (pending.length > 0) {
        await pending[0]!();
        pending.shift();
      }
    })().finally(() => {
      active = null;
    });
    return active;
  };

  const runAfterActive = (): Promise<void> => {
    if (active === null) {
      return runPending();
    }
    return active.catch(() => undefined).then(runPending);
  };

  return {
    enqueue: (transition) => {
      pending.push(transition);
      return runAfterActive();
    },
    retryPending: runAfterActive,
    hasPending: () => pending.length > 0,
  };
}
