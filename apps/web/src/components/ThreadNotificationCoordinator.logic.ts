export type ThreadNotificationKind = "input" | "completion";

export interface ThreadNotificationObservation {
  /** Run and status key while the thread needs attention, otherwise null. */
  readonly attention: string | null;
  /** The thread is idle and its latest run completed. */
  readonly settled: boolean;
  /** When the latest run completed, if it did. */
  readonly completedAt: number | null;
  /** When the latest run completed, while background work holds its alert back. */
  readonly heldAt: number | null;
}

/** Matches the push relay's completion confirmation: a final wake can start right after a hold ends. */
export const RELEASED_COMPLETION_GRACE_MS = 5_000;

export function createThreadNotificationGate<Key>(
  notify: (key: Key, kind: ThreadNotificationKind) => void,
) {
  // The newest completion already notified, or deliberately skipped.
  const handled = new Map<Key, number>();
  // Released holds waiting out the grace, by completion time.
  const releases = new Map<
    Key,
    { readonly at: number; readonly timer: ReturnType<typeof setTimeout> }
  >();
  const skip = (key: Key, at: number | null) => {
    if (at !== null && at > (handled.get(key) ?? -Infinity)) handled.set(key, at);
  };
  const cancel = (key: Key) => {
    clearTimeout(releases.get(key)?.timer);
    releases.delete(key);
  };
  return {
    observe(
      key: Key,
      prior: ThreadNotificationObservation | undefined,
      next: ThreadNotificationObservation,
      options: { readonly archived: boolean; readonly quiet: boolean },
    ): void {
      // The grace survives updates that keep the released completion; anything else cancels it.
      if (releases.get(key)?.at === next.completedAt && !options.archived && !options.quiet) return;
      cancel(key);
      // The first sighting, archived threads, and stopped or silent runs never notify completion.
      if (!prior || options.archived || options.quiet) skip(key, next.completedAt);
      if (!prior || options.archived) return;
      if (next.attention && next.attention !== prior.attention) {
        notify(key, "input");
        return;
      }
      const at = next.completedAt;
      if (!next.settled || at === null || at <= (handled.get(key) ?? -Infinity)) return;
      if (prior.heldAt === at) {
        const timer = setTimeout(() => {
          releases.delete(key);
          handled.set(key, at);
          notify(key, "completion");
        }, RELEASED_COMPLETION_GRACE_MS);
        releases.set(key, { at, timer });
        return;
      }
      handled.set(key, at);
      notify(key, "completion");
    },
    /** Forgets threads that left the snapshot. */
    retain(keys: ReadonlySet<Key>): void {
      for (const key of handled.keys()) if (!keys.has(key)) handled.delete(key);
      for (const key of releases.keys()) if (!keys.has(key)) cancel(key);
    },
    clear(): void {
      for (const key of releases.keys()) cancel(key);
      handled.clear();
    },
  };
}
