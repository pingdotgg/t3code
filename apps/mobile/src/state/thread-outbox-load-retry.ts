export function startThreadOutboxLoadRetry(input: {
  readonly load: () => Promise<boolean>;
  readonly retryDelayMs: (attempt: number) => number;
  readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = input.schedule ?? setTimeout;
  const cancel = input.cancel ?? clearTimeout;
  const attemptLoad = async (attempt: number): Promise<void> => {
    if ((await input.load()) || cancelled) {
      return;
    }
    timer = schedule(
      () => {
        void attemptLoad(attempt + 1);
      },
      input.retryDelayMs(attempt + 1),
    );
  };
  void attemptLoad(0);
  return () => {
    cancelled = true;
    if (timer !== null) {
      cancel(timer);
    }
  };
}
