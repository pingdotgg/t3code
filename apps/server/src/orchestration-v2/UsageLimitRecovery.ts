import type { OrchestrationV2LimitRecovery, OrchestrationV2Run, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

// Claude can still refuse a turn just after its reported reset time.
export const RESUME_MARGIN_MS = 120_000;
export const dueMs = (resetMs: number, completedAt: DateTime.Utc): number =>
  Math.max(resetMs, DateTime.toEpochMillis(completedAt)) + RESUME_MARGIN_MS;

export const recoveryRunCompletedMs = (projection: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly thread: { readonly limitRecovery?: OrchestrationV2LimitRecovery | null | undefined };
}): number | undefined => {
  const run = projection.runs.find((run) => run.id === projection.thread.limitRecovery?.runId);
  return run ? DateTime.toEpochMillis(run.completedAt ?? run.requestedAt) : undefined;
};

// Claude can refuse again with the same, now past, reset. Allow one re-arm while the recovery
// still names a run that failed before that reset. A stopped arm cannot enable another retry.
export const staleResetAllowed = (thread: {
  readonly limitRecovery?: OrchestrationV2LimitRecovery | null | undefined;
  readonly latestRunId: RunId | null;
  readonly usageLimitResetAt?: string | null | undefined;
  readonly recoveryCompletedMs?: number | undefined;
}): boolean => {
  const recovery = thread.limitRecovery;
  if (!recovery?.autoResume || recovery.resetAt !== thread.usageLimitResetAt) return false;
  return (
    recovery.runId === thread.latestRunId ||
    (thread.recoveryCompletedMs !== undefined &&
      Date.parse(recovery.resetAt) > thread.recoveryCompletedMs)
  );
};
