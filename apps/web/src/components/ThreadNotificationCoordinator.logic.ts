import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";
import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";

export type ThreadNotificationKind = "input" | "completion";

export interface ThreadNotificationObservation {
  /** Run and status key while the thread needs attention, otherwise null. */
  readonly attention: string | null;
  /** The thread is idle and its latest run completed. */
  readonly settled: boolean;
  /** When the latest run completed, if it did. */
  readonly completedAt: number | null;
  /** The thread is intentionally hidden until its snooze wake time. */
  readonly snoozed: boolean;
}

/**
 * Whether completion notifications are suppressed by snooze. A completion that landed
 * during the snooze stays suppressed even when its update is processed after the wake.
 */
export function isSnoozedForNotification(
  thread: ThreadSnoozeShell,
  completedAt: number | null,
  now: number,
): boolean {
  if (effectiveSnoozed(thread, { now: new Date(now).toISOString() })) return true;
  if (completedAt === null) return false;
  if (thread.snoozedAt != null && completedAt < Date.parse(thread.snoozedAt)) return false;
  return effectiveSnoozed(thread, { now: new Date(completedAt).toISOString() });
}

/**
 * Attention notifies at once. Completion waits out the Working shelf's exit grace,
 * because an orchestrator run can end moments before its continuation starts. Any
 * observation that is not settled during the wait cancels it.
 */
export function createThreadNotificationGate<Key>(
  notify: (key: Key, kind: ThreadNotificationKind) => void,
) {
  const pending = new Map<Key, { at: number; timer: ReturnType<typeof setTimeout> }>();
  // The newest completion already notified, or deliberately skipped.
  const handled = new Map<Key, number>();
  // The newest completion seen settled, kept while the thread works or waits.
  const lastSettled = new Map<Key, number>();
  const cancel = (key: Key) => {
    clearTimeout(pending.get(key)?.timer);
    pending.delete(key);
  };
  const skip = (key: Key, at: number | null) => {
    if (at !== null && at > (handled.get(key) ?? -Infinity)) handled.set(key, at);
  };
  return {
    observe(
      key: Key,
      prior: ThreadNotificationObservation | undefined,
      next: ThreadNotificationObservation,
      options: { readonly archived: boolean; readonly quiet: boolean; readonly snoozed: boolean },
    ): void {
      if (next.settled && next.completedAt !== null) lastSettled.set(key, next.completedAt);
      // Snoozing drops the newest completion not yet notified, so it cannot notify after wake.
      if (options.snoozed) skip(key, lastSettled.get(key) ?? null);
      if (!next.settled || options.archived || options.quiet || options.snoozed) cancel(key);
      // The first sighting, archived threads, and stopped or silent runs never notify completion.
      if (!prior || options.archived || options.quiet || options.snoozed)
        skip(key, next.completedAt);
      if (!prior || options.archived) return;
      if (next.attention && next.attention !== prior.attention) {
        // Attention replaces the completion before it, so that run must not notify later.
        skip(key, lastSettled.get(key) ?? null);
        cancel(key);
        notify(key, "input");
        return;
      }
      const at = next.completedAt;
      if (!next.settled || at === null || at <= (handled.get(key) ?? -Infinity)) return;
      if (pending.get(key)?.at === at) return;
      cancel(key);
      pending.set(key, {
        at,
        timer: setTimeout(() => {
          pending.delete(key);
          handled.set(key, at);
          notify(key, "completion");
        }, WORKING_EXIT_GRACE_MS),
      });
    },
    /** Forgets threads that left the snapshot. */
    retain(keys: ReadonlySet<Key>): void {
      for (const key of pending.keys()) if (!keys.has(key)) cancel(key);
      for (const key of handled.keys()) if (!keys.has(key)) handled.delete(key);
      for (const key of lastSettled.keys()) if (!keys.has(key)) lastSettled.delete(key);
    },
    cancelPending(): void {
      for (const key of pending.keys()) cancel(key);
    },
    clear(): void {
      for (const key of pending.keys()) cancel(key);
      handled.clear();
      lastSettled.clear();
    },
  };
}
