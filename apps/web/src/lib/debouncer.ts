export function createDebouncer<TArgs extends Array<unknown>>(
  fn: (...args: TArgs) => void,
  waitMs: number,
) {
  let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
  let latestArgs: TArgs | null = null;

  const clearPendingTimeout = () => {
    if (timeout === null) return;
    globalThis.clearTimeout(timeout);
    timeout = null;
  };

  const execute = () => {
    const args = latestArgs;
    latestArgs = null;
    timeout = null;

    if (args !== null) {
      fn(...args);
    }
  };

  return {
    maybeExecute: (...args: TArgs) => {
      latestArgs = args;
      clearPendingTimeout();
      timeout = globalThis.setTimeout(execute, waitMs);
    },
    cancel: () => {
      clearPendingTimeout();
      latestArgs = null;
    },
    flush: () => {
      if (latestArgs === null) return;
      clearPendingTimeout();
      execute();
    },
  };
}
