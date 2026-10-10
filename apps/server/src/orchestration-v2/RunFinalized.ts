import {
  EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RunFinalizationOperation,
  type OrchestrationV2RunFinalizedOutcome,
  type RunId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

/**
 * The id of a run's one finalization record, `run.finalized` or
 * `run.finalization-failed`. The event log's unique event id keeps a run to
 * one of them, and consumers can deduplicate deliveries by it.
 */
export const runFinalizedEventId = (runId: RunId) => EventId.make(`event:run-finalized:${runId}`);

/**
 * The checkpoint capture a finished run enqueues. RunFinalizationService
 * records `run.finalized` once capture and refresh succeed, or
 * `run.finalization-failed` in the same commit that gives up on the capture.
 * Cancelling the capture records that failure too.
 */
export const checkpointCaptureEffectId = (runId: RunId) => `effect:checkpoint.capture:${runId}`;

const SETTLED_RUN_STATUSES: ReadonlySet<string> = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);

/** Whether a persisted run status is final, including a discarded (rolled-back) run. */
export const isSettledRunStatus = (status: string) => SETTLED_RUN_STATUSES.has(status);

/** The finalized outcome for a run status, or null when the run is not finished or was discarded. */
export const runFinalizedOutcome = (
  status: OrchestrationV2Run["status"],
): OrchestrationV2RunFinalizedOutcome | null =>
  status === "completed" ||
  status === "failed" ||
  status === "interrupted" ||
  status === "cancelled"
    ? status
    : null;

/**
 * The step a run's finalization stopped at when its capture was abandoned
 * without reporting one: before the checkpoint commit or after it.
 */
export const abandonedOperation = (
  run: OrchestrationV2Run,
): OrchestrationV2RunFinalizationOperation =>
  run.checkpointId === null ? "capture-checkpoint" : "refresh-workspace";

const recordEnvelope = (run: OrchestrationV2Run, occurredAt: DateTime.Utc) => ({
  id: runFinalizedEventId(run.id),
  threadId: run.threadId,
  runId: run.id,
  ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
  providerInstanceId: run.providerInstanceId,
  occurredAt,
});

export const makeRunFinalizedEvent = (input: {
  readonly run: OrchestrationV2Run;
  readonly outcome: OrchestrationV2RunFinalizedOutcome;
  readonly occurredAt: DateTime.Utc;
}): Extract<OrchestrationV2DomainEvent, { readonly type: "run.finalized" }> => ({
  ...recordEnvelope(input.run, input.occurredAt),
  type: "run.finalized",
  payload: {
    runId: input.run.id,
    outcome: input.outcome,
    checkpointId: input.run.checkpointId,
  },
});

export const makeRunFinalizationFailedEvent = (input: {
  readonly run: OrchestrationV2Run;
  readonly operation: OrchestrationV2RunFinalizationOperation;
  readonly occurredAt: DateTime.Utc;
}): Extract<OrchestrationV2DomainEvent, { readonly type: "run.finalization-failed" }> => ({
  ...recordEnvelope(input.run, input.occurredAt),
  type: "run.finalization-failed",
  payload: { runId: input.run.id, operation: input.operation },
});
