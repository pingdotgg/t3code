import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type ThreadNotificationKind = "input" | "completion";

export interface ThreadNotificationObservation {
  /** Run and status key while the thread needs attention, otherwise null. */
  readonly attention: string | null;
  /** The thread is idle and its latest run completed. */
  readonly settled: boolean;
  /** When the latest run completed, if it did. */
  readonly completedAt: number | null;
}

export function createThreadNotificationGate<Key>(
  notify: (key: Key, kind: ThreadNotificationKind) => void,
) {
  // The newest completion already notified, or deliberately skipped.
  const handled = new Map<Key, number>();
  const skip = (key: Key, at: number | null) => {
    if (at !== null && at > (handled.get(key) ?? -Infinity)) handled.set(key, at);
  };
  return {
    observe(
      key: Key,
      prior: ThreadNotificationObservation | undefined,
      next: ThreadNotificationObservation,
      options: { readonly archived: boolean; readonly quiet: boolean },
    ): void {
      // The first sighting, archived threads, and stopped or silent runs never notify completion.
      if (!prior || options.archived || options.quiet) skip(key, next.completedAt);
      if (!prior || options.archived) return;
      if (next.attention && next.attention !== prior.attention) {
        notify(key, "input");
        return;
      }
      const at = next.completedAt;
      if (!next.settled || at === null || at <= (handled.get(key) ?? -Infinity)) return;
      handled.set(key, at);
      notify(key, "completion");
    },
    /** Forgets threads that left the snapshot. */
    retain(keys: ReadonlySet<Key>): void {
      for (const key of handled.keys()) if (!keys.has(key)) handled.delete(key);
    },
    clear(): void {
      handled.clear();
    },
  };
}

// A Monitor wakes the agent on every event it prints. The run for each wake ends as completed
// once the agent acknowledges the event, although the task it is monitoring has not finished.
export function isMonitorWakeRun(
  thread: Pick<
    OrchestrationV2ThreadShell,
    "latestRunRequestedAt" | "latestUserAuthoredMessageAt" | "pendingBackgroundTasks"
  >,
): boolean {
  const { latestRunRequestedAt, latestUserAuthoredMessageAt } = thread;
  // Servers without latestUserAuthoredMessageAt cannot tell a wake from the user's own run.
  if (latestRunRequestedAt == null || latestUserAuthoredMessageAt === undefined) return false;
  const startedByUser =
    latestUserAuthoredMessageAt !== null &&
    !DateTime.isGreaterThan(latestRunRequestedAt, latestUserAuthoredMessageAt);
  const monitorPending = (thread.pendingBackgroundTasks ?? []).some(
    (task) => task.kind === "monitor",
  );
  return !startedByUser && monitorPending;
}
