const RECHECK_MIN_MS = 30 * 60 * 1_000;
const RECHECK_MAX_MS = 24 * 60 * 60 * 1_000;
const RECHECK_IDLE_DIVISOR = 12;

/**
 * When a scheduled sweep last found no pull request for a branch. Sweeps wait on this instead of
 * GitManager's caches, which expire in minutes and evict past a few thousand branches.
 */
export function makeNoPullRequestRechecks() {
  const readAtMs = new Map<string, number>();
  return {
    /** Reread every half hour at first, every two hours after a day idle, daily after twelve days. */
    waiting: (key: string, nowMs: number, activityAtMs: number): boolean => {
      const lastReadAtMs = readAtMs.get(key);
      if (lastReadAtMs === undefined) return false;
      const delayMs = Math.min(
        Math.max((nowMs - activityAtMs) / RECHECK_IDLE_DIVISOR, RECHECK_MIN_MS),
        RECHECK_MAX_MS,
      );
      return nowMs - lastReadAtMs < delayMs;
    },
    record: (key: string, nowMs: number, pullRequestFound: boolean): void => {
      if (pullRequestFound) readAtMs.delete(key);
      else readAtMs.set(key, nowMs);
    },
    retain: (keys: { readonly has: (key: string) => boolean }): void => {
      for (const key of readAtMs.keys()) {
        if (!keys.has(key)) readAtMs.delete(key);
      }
    },
  };
}
