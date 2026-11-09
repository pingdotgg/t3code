import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { DateTime } from "effect";

export type UserWaitItem = Pick<OrchestrationV2TurnItem, "startedAt" | "completedAt">;

/** A provider question or approval: while it is open, its run waits on the user instead of working. */
export function isUserWaitItem(item: Pick<OrchestrationV2TurnItem, "type">): boolean {
  return item.type === "user_input_request" || item.type === "approval_request";
}

/**
 * Milliseconds of [startMs, endMs] the run spent waiting on its requests. Overlapping requests
 * count once, and an open request waits until `endMs` (skipped when `endMs` is unbounded).
 */
export function userWaitMs(
  requests: ReadonlyArray<UserWaitItem>,
  startMs: number,
  endMs: number,
): number {
  if (requests.length === 0) return 0;
  const spans: Array<readonly [number, number]> = [];
  for (const request of requests) {
    if (request.startedAt === null) continue;
    const from = Math.max(startMs, DateTime.toEpochMillis(request.startedAt));
    const to =
      request.completedAt === null
        ? endMs
        : Math.min(endMs, DateTime.toEpochMillis(request.completedAt));
    if (Number.isFinite(to) && to > from) spans.push([from, to]);
  }
  spans.sort((left, right) => left[0] - right[0]);
  let total = 0;
  let coveredUntil = startMs;
  for (const [from, to] of spans) {
    if (to <= coveredUntil) continue;
    total += to - Math.max(from, coveredUntil);
    coveredUntil = to;
  }
  return total;
}

/** A live working timer's start, moved past answered requests so it counts only working time. */
export function workingTimerStartedAt(
  startedAt: string,
  requests: ReadonlyArray<UserWaitItem>,
): string {
  const startMs = Date.parse(startedAt);
  const waitedMs = userWaitMs(requests, startMs, Number.POSITIVE_INFINITY);
  return waitedMs === 0 ? startedAt : DateTime.formatIso(DateTime.makeUnsafe(startMs + waitedMs));
}
