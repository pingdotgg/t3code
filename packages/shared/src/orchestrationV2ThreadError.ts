import type {
  OrchestrationV2LimitRecovery,
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type ErrorTurnItem = Extract<OrchestrationV2TurnItem, { type: "error" }>;
/** Only error items are read, so callers may pass items stripped of other fields. */
type FailureScanTurnItem =
  | ErrorTurnItem
  | { readonly type: Exclude<OrchestrationV2TurnItem["type"], "error"> };

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

export function usageLimitBlockedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<FailureScanTurnItem>,
  sessionError: string | null,
): OrchestrationV2Run | null {
  const executed = latestExecutedRun(runs);
  if (executed?.status !== "failed") return null;
  const summary = threadErrorSummary(latestRootProviderFailure(executed, turnItems), sessionError);
  return summary.lastErrorClass === "usage_limit" ? executed : null;
}

const REFUSED_CONTINUATION_BACKOFF_MINUTES = [2, 5, 15] as const;

/** A usage-limit failure's reset when it is after the run ended; null when not limited. */
function laterUsageLimitReset(
  run: OrchestrationV2Run,
  turnItems: ReadonlyArray<FailureScanTurnItem>,
): { readonly resetAt: string | null } | null {
  const failure = latestRootProviderFailure(run, turnItems);
  if (failure?.class !== "usage_limit") return null;
  const endedMs = DateTime.toEpochMillis(run.completedAt ?? run.requestedAt);
  return {
    resetAt: failure.resetAt && Date.parse(failure.resetAt) > endedMs ? failure.resetAt : null,
  };
}

/**
 * When usage-limit recovery may resume `run`: the provider's reset when it is after the run
 * ended. A continuation refused with no later reset retries after a backoff, giving up after
 * the last step; any other limited run without a later reset has nothing to wait for.
 */
export function usageLimitRecoveryResetAt(
  run: OrchestrationV2Run | null,
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<FailureScanTurnItem>,
): string | null {
  const limit = run === null ? null : laterUsageLimitReset(run, turnItems);
  if (run === null || limit === null) return null;
  if (limit.resetAt !== null) return limit.resetAt;
  let refusals = 0;
  for (const current of usageLimitContinuationChain(run, runs)) {
    if (current.usageLimitContinuationOfRunId === undefined) break;
    const refused = laterUsageLimitReset(current, turnItems);
    if (refused === null || refused.resetAt !== null) break;
    refusals += 1;
  }
  return refusedContinuationRetryAt(run.completedAt ?? run.requestedAt, refusals);
}

/** When recovery retries a continuation refused `refusals` times in a row; null once it gives up. */
export function refusedContinuationRetryAt(endedAt: DateTime.Utc, refusals: number): string | null {
  const minutes = REFUSED_CONTINUATION_BACKOFF_MINUTES[refusals - 1];
  return minutes === undefined ? null : DateTime.formatIso(DateTime.add(endedAt, { minutes }));
}

/**
 * `run` and the runs its continuation chain retries, as far as the backoff can count, so a
 * long or cyclic chain costs at most one more step than the backoff has.
 */
export function usageLimitContinuationChain(
  run: OrchestrationV2Run,
  runs: ReadonlyArray<OrchestrationV2Run>,
): ReadonlyArray<OrchestrationV2Run> {
  const chain = [run];
  let current: OrchestrationV2Run | undefined = run;
  while (
    chain.length <= REFUSED_CONTINUATION_BACKOFF_MINUTES.length &&
    current.usageLimitContinuationOfRunId !== undefined
  ) {
    const sourceRunId: string = current.usageLimitContinuationOfRunId;
    current = runs.find((candidate) => candidate.id === sourceRunId);
    if (current === undefined) break;
    chain.push(current);
  }
  return chain;
}

/**
 * The reset a usage-limit notice offers for `runId`, which stopped at `stoppedAtMs`: the
 * provider's reset when it is later. Otherwise a recovery still armed for the run (auto-resume
 * on, or its snooze still ahead) carries the server's retry time; else the provider's reset.
 */
export function usageLimitNoticeResetAt(input: {
  readonly runId: string | null | undefined;
  readonly resetAt: string | null | undefined;
  readonly stoppedAtMs: number;
  readonly recovery: OrchestrationV2LimitRecovery | null | undefined;
  readonly snoozedUntilMs: number | null;
  readonly nowMs: number;
}): string | null {
  const { runId, resetAt, stoppedAtMs, recovery, snoozedUntilMs, nowMs } = input;
  if (resetAt != null && Date.parse(resetAt) > stoppedAtMs) return resetAt;
  if (runId == null || recovery?.runId !== runId) return resetAt ?? null;
  const retryMs = Date.parse(recovery.resetAt);
  const armed =
    recovery.autoResume ||
    (recovery.snooze === true && snoozedUntilMs === retryMs && retryMs > nowMs);
  return armed && retryMs > stoppedAtMs ? recovery.resetAt : (resetAt ?? null);
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
