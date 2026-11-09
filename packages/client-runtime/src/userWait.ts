import type { OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";
import { DateTime } from "effect";

export type UserWaitItem = Pick<OrchestrationV2TurnItem, "startedAt" | "completedAt">;

/**
 * A provider question or approval: while it is open, its run waits on the user instead of working.
 * A message-mode question does not block; its answer arrives later as a new message.
 */
export function isUserWaitItem(item: OrchestrationV2TurnItem): boolean {
  return (
    item.type === "approval_request" ||
    (item.type === "user_input_request" && item.responseMode !== "message")
  );
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

/**
 * The live working timer's start: the active run's, else provider-native runless work's, moved
 * past the answered requests of that work.
 */
export function activeWorkTimerStartedAt(input: {
  readonly runStartedAt: string | null;
  readonly runId: RunId | null | undefined;
  readonly runlessStartedAt: string | null;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
}): string | null {
  const startedAt = input.runStartedAt ?? input.runlessStartedAt;
  if (startedAt === null) return null;
  const runId = input.runStartedAt === null ? null : input.runId;
  return workingTimerStartedAt(
    startedAt,
    input.items.filter((item) => item.runId === runId && isUserWaitItem(item)),
  );
}
