import { latestProviderTurnForAttempt } from "@t3tools/contracts";
import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderRetry,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export const STREAM_RECOVERY_PROMPT =
  "The previous turn ended after the provider exhausted its stream retries. Inspect the saved conversation, completed actions, and delegated results. Continue only unfinished, already authorized work; check what completed before repeating any action.";

// Two host continuations, after the native provider's own retry budget: 30s, then 60s.
export const CODEX_STREAM_RECOVERY_DELAYS_MS = [30_000, 60_000] as const;

export function unchangedCodexStreamFailure(
  retry: OrchestrationV2ProviderFailure | undefined,
  terminal: OrchestrationV2ProviderFailure,
  blocked: boolean,
  progress: OrchestrationV2ProviderRetry | undefined,
): boolean {
  return (
    !blocked &&
    progress?.maxAttempts != null &&
    progress.attempt >= progress.maxAttempts &&
    retry?.code === "responseStreamDisconnected" &&
    retry.class === "transport_error" &&
    retry.retryable === true &&
    (terminal.code === "other" || terminal.code === retry.code) &&
    terminal.message === retry.message
  );
}

/** Re-check under the thread command lock; stale timer deliveries cannot change user intent. */
export function streamRecoverySource(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "providerThreads" | "providerTurns" | "runtimeRequests" | "turnItems"
  >,
  source: OrchestrationV2Run | undefined,
): source is OrchestrationV2Run {
  if (
    !source ||
    source.status !== "failed" ||
    source.streamRecovery?.state !== "pending" ||
    projection.thread.archivedAt !== null ||
    projection.thread.deletedAt !== null ||
    projection.thread.settledOverride === "settled" ||
    projection.thread.settledAt !== null ||
    projection.thread.snoozedUntil != null ||
    projection.thread.providerInstanceId !== source.providerInstanceId ||
    projection.runs.some(
      (run) =>
        run.id !== source.id &&
        (run.ordinal > source.ordinal ||
          ["preparing", "starting", "running", "waiting"].includes(run.status)),
    ) ||
    projection.runtimeRequests.some((request) => request.status === "pending") ||
    projection.turnItems.some(
      (item) => item.runId === source.id && item.type === "run_interrupt_request",
    ) ||
    (source.completedAt !== null &&
      DateTime.toEpochMillis(projection.thread.updatedAt) >
        DateTime.toEpochMillis(source.completedAt))
  )
    return false;
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === source.providerThreadId,
  );
  if (
    !providerThread ||
    providerThread.driver !== "codex" ||
    providerThread.ownerNodeId !== null ||
    providerThread.status !== "idle" ||
    providerThread.nativeThreadRef?.strength !== "strong" ||
    providerThread.nativeThreadRef.driver !== "codex" ||
    providerThread.appThreadId !== projection.thread.id ||
    projection.thread.activeProviderThreadId !== providerThread.id ||
    (providerThread.pendingBackgroundTasks?.length ?? 0) > 0
  )
    return false;
  const turn = latestProviderTurnForAttempt(projection.providerTurns, source.activeAttemptId);
  return (
    turn?.status === "failed" &&
    turn.providerThreadId === providerThread.id &&
    projection.turnItems.some(
      (item) =>
        item.type === "error" &&
        item.runId === source.id &&
        item.nodeId === source.rootNodeId &&
        item.providerTurnId === turn.id &&
        item.failure.streamRetryExhausted === true,
    )
  );
}
