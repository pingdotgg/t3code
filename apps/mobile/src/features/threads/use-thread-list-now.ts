import { useNowWithWakes } from "../../lib/clock";
import { nextSnoozeWakeAfter } from "./threadListV2";

/**
 * The thread list's clock as an ISO timestamp. It advances on each wall-clock
 * minute and the moment any snooze expires, so the list re-partitions on time
 * instead of on the next minute tick. Waking on every snoozed thread, not just
 * the ones the list shows as snoozed, only costs an extra render.
 */
export function useThreadListNow(
  threads: ReadonlyArray<{ readonly snoozedUntil?: string | null }>,
): string {
  return new Date(
    useNowWithWakes((afterMs) => nextSnoozeWakeAfter(threads, afterMs)),
  ).toISOString();
}
