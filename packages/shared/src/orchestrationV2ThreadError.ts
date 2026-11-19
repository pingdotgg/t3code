import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type ErrorTurnItem = Extract<OrchestrationV2TurnItem, { type: "error" }>;
/** Error items, run inputs and the run of other items are read, so callers may pass stripped items. */
type FailureScanTurnItem =
  | ErrorTurnItem
  | {
      readonly type: Exclude<OrchestrationV2TurnItem["type"], "error">;
      readonly runId?: OrchestrationV2TurnItem["runId"];
      readonly nodeId?: OrchestrationV2TurnItem["nodeId"];
      readonly ordinal?: number;
    };

export function latestRootProviderFailure(
  run: OrchestrationV2Run | null,
  turnItems: ReadonlyArray<FailureScanTurnItem>,
): OrchestrationV2ProviderFailure | null {
  if (run?.status !== "failed") return null;
  let latest: ErrorTurnItem | null = null;
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
    lastErrorClass: currentFailure?.class ?? null,
    lastErrorCode: currentFailure?.code ?? null,
  };
}

export function latestExecutedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | null {
  let latest: OrchestrationV2Run | null = null;
  for (const run of runs) {
    if (run.status === "queued") continue;
    if (run.status === "cancelled" && run.startedAt === null) continue;
    if (latest === null || runRanAfter(run, latest)) latest = run;
  }
  return latest;
}

/**
 * Work started now would run in the project checkout, not the worktree the thread asked for. A
 * failed or interrupted setup leaves the request standing until a worktree exists or later work
 * has run past it.
 */
export function orchestrationV2WorktreePending(
  worktreePath: string | null,
  runs: ReadonlyArray<OrchestrationV2Run>,
): boolean {
  const latest = latestExecutedRun(runs);
  return (
    worktreePath === null &&
    (latest?.status === "preparing" ||
      latest?.status === "failed" ||
      latest?.status === "interrupted") &&
    latest.workspacePreparation?.type === "worktree"
  );
}

/** Held queues can execute out of ordinal order; unfinished runs count as latest. */
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

/**
 * Subagents that die on a usage limit start notification runs that finish before the reset
 * with no work to show. These candidates ran on the limited provider after its latest failure
 * and before the reset; continuations and other providers' runs are never wakes.
 */
export function usageLimitWakeCandidates(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<FailureScanTurnItem>,
): ReadonlyArray<OrchestrationV2Run> {
  const failed = latestExecutedRun(runs.filter((run) => run.status === "failed"));
  const failure = latestRootProviderFailure(failed, turnItems);
  if (failed === null || failure?.class !== "usage_limit" || failure.resetAt == null) return [];
  const resetMs = Date.parse(failure.resetAt);
  if (!Number.isFinite(resetMs)) return [];
  return runs.filter(
    (run) =>
      run.status === "completed" &&
      run.completedAt !== null &&
      run.rootNodeId !== null &&
      run.providerInstanceId === failed.providerInstanceId &&
      DateTime.toEpochMillis(run.completedAt) <= resetMs &&
      runRanAfter(run, failed) &&
      run.manualContinuationOfRunId === undefined &&
      run.usageLimitContinuationOfRunId === undefined &&
      run.restartContinuationOfRunId === undefined,
  );
}

/** Inputs, and the interrupt signal Stop leaves on the latest run, are not work. */
export const NO_WORK_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "user_message",
  "notification",
  "run_interrupt_request",
]);

/** The wake candidates a notification started; only those without any other item are wakes. */
export function notificationStartedWakeCandidates(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<FailureScanTurnItem>,
): ReadonlyArray<OrchestrationV2Run> {
  const candidates = usageLimitWakeCandidates(runs, turnItems);
  if (candidates.length === 0) return candidates;
  const firstInputs = new Map<string, { readonly type: string; readonly ordinal: number }>();
  for (const item of turnItems) {
    if (item.nodeId == null || item.ordinal == null) continue;
    if (item.type !== "user_message" && item.type !== "notification") continue;
    const first = firstInputs.get(item.nodeId);
    if (first === undefined || item.ordinal < first.ordinal) {
      firstInputs.set(item.nodeId, { type: item.type, ordinal: item.ordinal });
    }
  }
  return candidates.filter(
    (run) => run.rootNodeId !== null && firstInputs.get(run.rootNodeId)?.type === "notification",
  );
}

/**
 * Drops notification-started candidates that hold no work item, so they cannot replace the
 * limited run. Callers must pass every item
 * of notificationStartedWakeCandidates; other runs need only user_message, notification, error.
 */
function runsWithoutLimitedWakes(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<FailureScanTurnItem>,
): ReadonlyArray<OrchestrationV2Run> {
  const started = notificationStartedWakeCandidates(runs, turnItems);
  if (started.length === 0) return runs;
  const worked = new Set<string>();
  for (const item of turnItems) {
    if (item.runId != null && !NO_WORK_ITEM_TYPES.has(item.type)) worked.add(item.runId);
  }
  const wakes = new Set(started.filter((run) => !worked.has(run.id)));
  return wakes.size === 0 ? runs : runs.filter((run) => !wakes.has(run));
}

/** The latest executed run, not counting notification wakes that did no work before a reset. */
export function latestRunIgnoringLimitedWakes(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<FailureScanTurnItem>,
): OrchestrationV2Run | null {
  return latestExecutedRun(runsWithoutLimitedWakes(runs, turnItems));
}

export function usageLimitBlockedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<FailureScanTurnItem>,
  sessionError: string | null,
): OrchestrationV2Run | null {
  const executed = latestRunIgnoringLimitedWakes(runs, turnItems);
  if (executed?.status !== "failed") return null;
  const summary = threadErrorSummary(latestRootProviderFailure(executed, turnItems), sessionError);
  return summary.lastErrorClass === "usage_limit" ? executed : null;
}

/** Retains a limited run's outcome when higher-ordinal runs never started. */
export function usageLimitRunPresentedAsLatest(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<FailureScanTurnItem>,
  sessionError: string | null,
): OrchestrationV2Run | null {
  const blocked = usageLimitBlockedRun(runs, turnItems, sessionError);
  return blocked !== null && runs.some((run) => run.ordinal > blocked.ordinal) ? blocked : null;
}

export function latestUnheldRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | null {
  let latest: OrchestrationV2Run | null = null;
  for (const run of runs) {
    if (run.status === "queued" && run.queueHeld === true) continue;
    if (outlivedBeforeStart(run, runs)) continue;
    if (latest === null || run.ordinal > latest.ordinal) latest = run;
  }
  return latest;
}

// Steering a queued message cancels its run before it starts and hands the message to the
// earlier run, which outlives the cancellation; that earlier run then presents as latest.
function outlivedBeforeStart(
  run: OrchestrationV2Run,
  runs: ReadonlyArray<OrchestrationV2Run>,
): boolean {
  if (run.status !== "cancelled" || run.startedAt !== null || !run.completedAt) return false;
  const cancelledAt = DateTime.toEpochMillis(run.completedAt);
  return runs.some(
    (earlier) =>
      earlier.ordinal < run.ordinal &&
      earlier.status !== "queued" &&
      (!earlier.completedAt || DateTime.toEpochMillis(earlier.completedAt) >= cancelledAt),
  );
}
