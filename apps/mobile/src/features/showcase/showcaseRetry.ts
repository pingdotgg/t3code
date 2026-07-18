export interface ShowcaseRetryOptions {
  readonly isCancelled: () => boolean;
  readonly attemptTimeoutMs?: number;
  readonly retryDelayMs?: number;
}

const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAttemptWithTimeout(
  operation: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation(),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

/** Retry transient showcase setup work until it succeeds or the owning effect unmounts. */
export async function retryShowcaseOperation(
  operation: () => Promise<boolean>,
  options: ShowcaseRetryOptions,
): Promise<boolean> {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  while (!options.isCancelled()) {
    if (await runAttemptWithTimeout(operation, attemptTimeoutMs)) return true;
    if (!options.isCancelled()) await delay(retryDelayMs);
  }
  return false;
}
