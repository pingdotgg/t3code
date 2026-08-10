/**
 * Runs bulk thread launches one at a time. A launch only resolves once the
 * server has created the thread, prepared its worktree and dispatched the
 * turn, so awaiting each one in order is the backpressure that keeps parallel
 * `git worktree add` calls off the same repository. The extra delay spaces out
 * the setup scripts and provider processes that start behind them.
 */

/** Pause between launches, long enough that setup scripts do not pile up. */
export const DEFAULT_BULK_LAUNCH_DELAY_MS = 2000;

export interface BulkLaunchProgress {
  readonly completed: number;
  readonly total: number;
}

export interface BulkLaunchOutcome<T> {
  readonly started: ReadonlyArray<T>;
  readonly failed: ReadonlyArray<{ readonly item: T; readonly error: unknown }>;
  /** Items never attempted because the run was cancelled. */
  readonly cancelled: ReadonlyArray<T>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Launches every item in order, continuing past failures so one bad value
 * cannot strand the rest of the batch. Cancelling stops before the next
 * launch; threads that already started keep running.
 */
export async function runBulkLaunchQueue<T>(options: {
  readonly items: ReadonlyArray<T>;
  readonly launch: (item: T, index: number) => Promise<void>;
  readonly delayMs?: number;
  readonly isCancelled?: () => boolean;
  readonly onProgress?: (progress: BulkLaunchProgress) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<BulkLaunchOutcome<T>> {
  const delayMs = options.delayMs ?? DEFAULT_BULK_LAUNCH_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const started: Array<T> = [];
  const failed: Array<{ item: T; error: unknown }> = [];

  for (const [index, item] of options.items.entries()) {
    if (options.isCancelled?.()) {
      return { started, failed, cancelled: options.items.slice(index) };
    }

    try {
      await options.launch(item, index);
      started.push(item);
    } catch (error) {
      failed.push({ item, error });
    }
    options.onProgress?.({ completed: index + 1, total: options.items.length });

    const isLast = index === options.items.length - 1;
    if (!isLast && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return { started, failed, cancelled: [] };
}
