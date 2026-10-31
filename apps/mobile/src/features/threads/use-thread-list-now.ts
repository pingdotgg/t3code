import { useState } from "react";

import { useNowAfter, useNowMinuteMs } from "../../lib/clock";
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
  const minuteMs = useNowMinuteMs();
  // The latest time returned. The next wake is searched after it, not after
  // the floored minute, so a second snooze expiring later in the same minute
  // arms its own wake instead of waiting for the next minute tick.
  const [latestMs, setLatestMs] = useState(minuteMs);
  const afterWakeMs = useNowAfter(nextSnoozeWakeAfter(threads, Math.max(minuteMs, latestMs)));
  const nowMs = Math.max(minuteMs, afterWakeMs, latestMs);
  if (nowMs !== latestMs) setLatestMs(nowMs);
  return new Date(nowMs).toISOString();
}
