type IdleCallbackHandle = number;
type IdleDeadlineLike = {
  didTimeout: boolean;
  timeRemaining(): number;
};
type IdleCallback = (deadline: IdleDeadlineLike) => void;
type RequestIdleCallbackFn = (callback: IdleCallback) => IdleCallbackHandle;
type CancelIdleCallbackFn = (handle: IdleCallbackHandle) => void;

export function scheduleIdleTask(task: () => void): () => void {
  const targetWindow = typeof window === "undefined" ? undefined : window;
  let cancelled = false;

  const run = () => {
    if (cancelled) {
      return;
    }
    task();
  };

  if (targetWindow) {
    const requestIdleCallback = targetWindow.requestIdleCallback as
      | RequestIdleCallbackFn
      | undefined;
    const cancelIdleCallback = targetWindow.cancelIdleCallback as CancelIdleCallbackFn | undefined;
    if (requestIdleCallback) {
      const handle = requestIdleCallback(() => {
        run();
      });
      return () => {
        cancelled = true;
        cancelIdleCallback?.(handle);
      };
    }

    const timeoutHandle = targetWindow.setTimeout(run, 0);
    return () => {
      cancelled = true;
      targetWindow.clearTimeout(timeoutHandle);
    };
  }

  run();
  return () => {
    cancelled = true;
  };
}
