import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Only a failed root turn of the current run owns the thread's failure state. */
export function latestRootProviderFailure(
  run: OrchestrationV2Run | null,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ProviderFailure | null {
  if (run?.status !== "failed") return null;
  let latest: Extract<OrchestrationV2TurnItem, { type: "error" }> | null = null;
  for (const item of turnItems) {
    if (
      item.type !== "error" ||
      item.status !== "failed" ||
      item.runId !== run.id ||
      item.nodeId !== run.rootNodeId
    )
      continue;
    if (
      latest === null ||
      DateTime.toEpochMillis(item.updatedAt) > DateTime.toEpochMillis(latest.updatedAt) ||
      (DateTime.toEpochMillis(item.updatedAt) === DateTime.toEpochMillis(latest.updatedAt) &&
        (item.ordinal > latest.ordinal || (item.ordinal === latest.ordinal && item.id > latest.id)))
    ) {
      latest = item;
    }
  }
  return latest?.failure ?? null;
}

/** A distinct session failure supersedes the turn's classification. */
export function threadErrorSummary(
  failure: OrchestrationV2ProviderFailure | null,
  sessionError: string | null,
) {
  const currentFailure =
    sessionError !== null && sessionError !== failure?.message ? null : failure;
  return {
    usageLimitResetAt:
      currentFailure?.class === "usage_limit" ? (currentFailure.resetAt ?? null) : null,
    lastError: sessionError ?? failure?.message ?? null,
    lastErrorClass:
      sessionError !== null && sessionError !== failure?.message ? null : (failure?.class ?? null),
  };
}

export function latestExecutedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | null {
  let latest: OrchestrationV2Run | null = null;
  for (const run of runs) {
    if (!hasExecuted(run)) continue;
    if (latest === null || runRanAfter(run, latest)) latest = run;
  }
  return latest;
}

function hasExecuted(run: OrchestrationV2Run): boolean {
  return run.status !== "queued" && !(run.status === "cancelled" && run.startedAt === null);
}

/**
 * Whether started `run` ran after `other`. Ordinals follow submission, but a
 * run can start ahead of a held queue (a restart continuation, or a message
 * sent while the queue is held), so a queued run resumed later can have a
 * lower ordinal than one that already ended. An unfinished run is the latest.
 */
export function runRanAfter(
  run: Pick<OrchestrationV2Run, "ordinal" | "completedAt">,
  other: Pick<OrchestrationV2Run, "ordinal" | "completedAt">,
): boolean {
  const end = (candidate: typeof run) =>
    !candidate.completedAt
      ? Number.POSITIVE_INFINITY
      : DateTime.toEpochMillis(candidate.completedAt);
  return end(run) === end(other) ? run.ordinal > other.ordinal : end(run) > end(other);
}

const WAKE_RECORD_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "notification",
  "checkpoint",
  "system_notice",
]);

function isCompletedWakeRun(run: OrchestrationV2Run): boolean {
  return run.status === "completed" && run.workStartedAt !== undefined;
}

/**
 * Completed wake runs that ended after a failed run with no other run in
 * between, newest first. Only these can hide a usage limit, so a caller whose
 * turn items do not cover the wakes probes these runs for work before asking
 * usageLimitBlockedRun.
 */
export function completedWakeRunsAfterFailure(
  runs: ReadonlyArray<OrchestrationV2Run>,
): ReadonlyArray<OrchestrationV2Run> {
  const latest = latestExecutedRun(runs);
  if (latest === null || !isCompletedWakeRun(latest)) return [];
  const wakes: Array<OrchestrationV2Run> = [];
  const executed = runs
    .filter(hasExecuted)
    .sort((left, right) => (runRanAfter(left, right) ? -1 : 1));
  for (const run of executed) {
    if (run.status === "failed") return wakes;
    if (!isCompletedWakeRun(run)) return [];
    wakes.push(run);
  }
  return [];
}

/**
 * Run ids with any loaded item other than the wake record itself. One pass:
 * the limit check runs repeatedly per client render, and asking per wake would
 * rescan every item.
 */
export function runIdsWithWork(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlySet<OrchestrationV2Run["id"]> {
  const runIds = new Set<OrchestrationV2Run["id"]>();
  for (const item of turnItems) {
    if (item.runId !== null && !WAKE_RECORD_ITEM_TYPES.has(item.type)) runIds.add(item.runId);
  }
  return runIds;
}

/**
 * The latest run that actually started, when it stopped because the
 * subscription limit was reached. Queued messages after that run must stay
 * queued instead of being sent into the same limit.
 *
 * A limited provider answers a background wake with an empty turn, which
 * completes. Wakes that recorded nothing but the wake itself therefore do not
 * end the stop. `turnItems` must hold every item of those wake runs, unless
 * `wakeRunIdsWithWork` says which wakes did work. That lets a store-backed
 * caller probe wake work by item type instead of loading wake item payloads.
 */
export function usageLimitBlockedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  sessionError: string | null,
  wakeRunIdsWithWork?: ReadonlySet<OrchestrationV2Run["id"]>,
): OrchestrationV2Run | null {
  const worked = wakeRunIdsWithWork ?? runIdsWithWork(turnItems);
  const idleWakeRunIds = new Set<string>();
  for (const wake of completedWakeRunsAfterFailure(runs)) {
    if (worked.has(wake.id)) {
      break;
    }
    idleWakeRunIds.add(wake.id);
  }
  const executed = latestExecutedRun(
    idleWakeRunIds.size === 0 ? runs : runs.filter((run) => !idleWakeRunIds.has(run.id)),
  );
  if (executed?.status !== "failed") return null;
  const summary = threadErrorSummary(latestRootProviderFailure(executed, turnItems), sessionError);
  return summary.lastErrorClass === "usage_limit" ? executed : null;
}

/**
 * That limited run, when newer runs were queued, cancelled before starting, or
 * wakes that did nothing. Callers that treat the highest-ordinal run as the
 * thread outcome would otherwise hide the limit.
 */
export function usageLimitRunPresentedAsLatest(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  sessionError: string | null,
  wakeRunIdsWithWork?: ReadonlySet<OrchestrationV2Run["id"]>,
): OrchestrationV2Run | null {
  const blocked = usageLimitBlockedRun(runs, turnItems, sessionError, wakeRunIdsWithWork);
  return blocked !== null && runs.some((run) => run.ordinal > blocked.ordinal) ? blocked : null;
}

/**
 * The newest run that is not waiting in a held queue, or null when only held
 * runs exist. A held queue waits for the user, so its runs never stand for the
 * thread's outcome. The SQL thread shell selects the same run.
 */
export function latestUnheldRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | null {
  let latest: OrchestrationV2Run | null = null;
  for (const run of runs) {
    if (run.status === "queued" && run.queueHeld === true) continue;
    if (latest === null || run.ordinal > latest.ordinal) latest = run;
  }
  return latest;
}
