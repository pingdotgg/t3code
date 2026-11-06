import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type ErrorTurnItem = Extract<OrchestrationV2TurnItem, { type: "error" }>;
/** Error items and the first input of each run are read, so callers may pass items stripped of other fields. */
type FailureScanTurnItem =
  | ErrorTurnItem
  | {
      readonly type: Exclude<OrchestrationV2TurnItem["type"], "error">;
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
 * Background subagents that die on a usage limit each start a root run from a notification.
 * Those runs finish within milliseconds, before the limit resets, and have no work to show.
 * They must not replace the limited run, or the thread is never armed or resumed.
 * Items of types other than user_message, notification and error may be omitted.
 */
function runsWithoutLimitedWakes(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<FailureScanTurnItem>,
): ReadonlyArray<OrchestrationV2Run> {
  const failed = latestExecutedRun(runs.filter((run) => run.status === "failed"));
  const failure = latestRootProviderFailure(failed, turnItems);
  if (failure?.class !== "usage_limit" || failure.resetAt == null) return runs;
  const resetMs = Date.parse(failure.resetAt);
  if (!Number.isFinite(resetMs)) return runs;
  const firstInputs = new Map<string, { readonly type: string; readonly ordinal: number }>();
  for (const item of turnItems) {
    if (item.nodeId == null || item.ordinal == null) continue;
    if (item.type !== "user_message" && item.type !== "notification") continue;
    const first = firstInputs.get(item.nodeId);
    if (first === undefined || item.ordinal < first.ordinal) {
      firstInputs.set(item.nodeId, { type: item.type, ordinal: item.ordinal });
    }
  }
  return runs.filter(
    (run) =>
      run.status !== "completed" ||
      run.completedAt === null ||
      DateTime.toEpochMillis(run.completedAt) > resetMs ||
      run.rootNodeId === null ||
      firstInputs.get(run.rootNodeId)?.type !== "notification",
  );
}

export function usageLimitBlockedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<FailureScanTurnItem>,
  sessionError: string | null,
): OrchestrationV2Run | null {
  const executed = latestExecutedRun(runsWithoutLimitedWakes(runs, turnItems));
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
    if (latest === null || run.ordinal > latest.ordinal) latest = run;
  }
  return latest;
}
