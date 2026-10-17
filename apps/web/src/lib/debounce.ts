/** Keep only the latest call; cancellation and execution release its arguments. */
export function createDebouncer<Args extends unknown[]>(
  callback: (...args: Args) => void,
  wait: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Args | undefined;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  const flush = () => {
    const args = pending;
    cancel();
    if (args !== undefined) callback(...args);
  };
  return {
    schedule: (...args: Args) => {
      cancel();
      pending = args;
      timer = setTimeout(flush, wait);
    },
    cancel,
    flush,
  };
}
