export type ThreadNotificationKind = "input" | "completion";

export interface ThreadNotificationObservation {
  /** Run, status and request key while the thread needs attention, otherwise null. */
  readonly attention: string | null;
  /** The pending request's id, when it has one; null whenever attention is. */
  readonly requestId: string | null;
  /** The thread is idle and its latest run completed. */
  readonly settled: boolean;
  /** When the latest run completed, if it did. */
  readonly completedAt: number | null;
  /** The latest run answers a background-work progress wake, like a Monitor line. */
  readonly backgroundWake: boolean;
}

/** Matches the push relay's completion confirmation: a final wake can start right after a progress wake. */
export const RELEASED_COMPLETION_GRACE_MS = 5_000;

export function createThreadNotificationGate<Key>(
  notify: (key: Key, kind: ThreadNotificationKind) => void,
) {
  // The newest completion already notified, or deliberately skipped.
  const handled = new Map<Key, number>();
  // Wake completions waiting out the grace, by completion time; no timer while paused.
  const releases = new Map<
    Key,
    { readonly at: number; readonly timer: ReturnType<typeof setTimeout> | undefined }
  >();
  const release = (key: Key, at: number) => {
    const timer = setTimeout(() => {
      releases.delete(key);
      handled.set(key, at);
      notify(key, "completion");
    }, RELEASED_COMPLETION_GRACE_MS);
    releases.set(key, { at, timer });
  };
  const skip = (key: Key, at: number | null) => {
    if (at !== null && at > (handled.get(key) ?? -Infinity)) handled.set(key, at);
  };
  const cancel = (key: Key) => {
    clearTimeout(releases.get(key)?.timer);
    releases.delete(key);
  };
  // Attention keys with a request id seen since the thread last stopped needing attention.
  const attended = new Map<Key, Set<string>>();
  const attend = (
    key: Key,
    prior: ThreadNotificationObservation | undefined,
    next: ThreadNotificationObservation,
  ): boolean => {
    if (next.attention === null) {
      attended.delete(key);
      return false;
    }
    if (next.requestId === null) return next.attention !== prior?.attention;
    const seen = attended.get(key);
    if (seen?.has(next.attention)) return false;
    if (seen) seen.add(next.attention);
    else attended.set(key, new Set([next.attention]));
    return true;
  };
  return {
    observe(
      key: Key,
      prior: ThreadNotificationObservation | undefined,
      next: ThreadNotificationObservation,
      options: { readonly archived: boolean; readonly quiet: boolean },
    ): void {
      // The grace survives updates that keep the wake's completion; anything else cancels it.
      const pending = releases.get(key);
      if (pending?.at === next.completedAt && !options.archived && !options.quiet) {
        if (pending.timer === undefined) release(key, pending.at);
        return;
      }
      cancel(key);
      // The first sighting, archived threads, and stopped or silent runs never notify completion.
      if (!prior || options.archived || options.quiet) skip(key, next.completedAt);
      const fresh = attend(key, prior, next);
      if (!prior || options.archived) return;
      if (fresh) {
        notify(key, "input");
        return;
      }
      const at = next.completedAt;
      if (!next.settled || at === null || at <= (handled.get(key) ?? -Infinity)) return;
      if (next.backgroundWake) {
        release(key, at);
        return;
      }
      handled.set(key, at);
      notify(key, "completion");
    },
    /** Stops grace timers while the snapshot is stale; the next observation restarts or drops them. */
    pause(): void {
      for (const [key, { at, timer }] of releases) {
        clearTimeout(timer);
        releases.set(key, { at, timer: undefined });
      }
    },
    /** Forgets threads that left the snapshot. */
    retain(keys: ReadonlySet<Key>): void {
      for (const key of handled.keys()) if (!keys.has(key)) handled.delete(key);
      for (const key of releases.keys()) if (!keys.has(key)) cancel(key);
      for (const key of attended.keys()) if (!keys.has(key)) attended.delete(key);
    },
    clear(): void {
      for (const key of releases.keys()) cancel(key);
      handled.clear();
      attended.clear();
    },
  };
}
