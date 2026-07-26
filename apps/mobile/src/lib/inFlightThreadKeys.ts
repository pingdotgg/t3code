import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey } from "./scopedEntities";

/**
 * Bookkeeping for thread mutations already submitted, shared by the
 * single-thread list actions and the settled-group archive so neither can
 * submit a second command for a thread the other is acting on.
 *
 * This matters because `thread.archive` is not idempotent — the decider
 * rejects a repeat via `requireThreadNotArchived` — and the command scheduler
 * serializes per thread, so an unguarded overlap does not race harmlessly, it
 * deterministically fails the second submission and reports it as a partial
 * batch failure.
 */

/**
 * Claims every thread not already being acted on, adding its key to the
 * in-flight set, and returns the claimed batch. Threads a single-thread action
 * already owns are skipped rather than waited for — that action is archiving
 * them anyway.
 *
 * The whole batch is claimed before any command is sent, so a swipe on a
 * thread late in the batch is blocked for the entire run rather than only once
 * the loop reaches it. Callers must release the returned keys when done.
 */
export function claimThreadsForBatch<
  T extends { readonly environmentId: EnvironmentId; readonly id: ThreadId },
>(
  threads: ReadonlyArray<T>,
  inFlight: Set<string>,
): ReadonlyArray<{ readonly thread: T; readonly key: string }> {
  const claimed: Array<{ readonly thread: T; readonly key: string }> = [];
  for (const thread of threads) {
    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (inFlight.has(key)) {
      continue;
    }
    inFlight.add(key);
    claimed.push({ thread, key });
  }
  return claimed;
}

export function releaseThreadKeys(
  claimed: ReadonlyArray<{ readonly key: string }>,
  inFlight: Set<string>,
): void {
  for (const { key } of claimed) {
    inFlight.delete(key);
  }
}
