import { isOrchestrationV2WorkActive, type NodeId, type OrchestrationV2StoredEvent, RunId, ThreadId } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import { OrchestratorProjectionError } from "../orchestrationErrors.ts";
import { delegatedTaskTerminalStatus } from "../orchestrationCommandQueries.ts";
import type { FailQueuedRunStartPart } from "./FailQueuedRunStart.ts";
import type { StartNextQueuedRunPart } from "./StartNextQueuedRun.ts";
import type { DispatchDelegatedTaskCompletionDeliveryResolutionPart } from "./DispatchDelegatedTaskCompletionDeliveryResolution.ts";
import type { RecordSubagentFollowupPart } from "./RecordSubagentFollowup.ts";
import type { DispatchSteerIntoRunPart } from "./DispatchSteerIntoRun.ts";
import type { SettleInterruptedRunPart } from "./SettleInterruptedRun.ts";
import type { SettleBackgroundWorkPart } from "./SettleBackgroundWork.ts";
import type { DispatchRunInterruptPart } from "./DispatchRunInterrupt.ts";
import type { DispatchRuntimeRequestRespondPart } from "./DispatchRuntimeRequestRespond.ts";
import type { DispatchThreadMergeBackPart } from "./DispatchThreadMergeBack.ts";
import type { DispatchDelegatedTaskRequestPart } from "./DispatchDelegatedTaskRequest.ts";
import type { DispatchRemoteDelegatedTaskCompletePart } from "./DispatchRemoteDelegatedTaskComplete.ts";
import type { DispatchSubagentStopPart } from "./DispatchSubagentStop.ts";
import type { FinalizeAppOwnedSubagentTaskPart } from "./FinalizeAppOwnedSubagentTask.ts";
import type { DispatchOncePart } from "./DispatchOnce.ts";
import type { DispatchWithReceiptEffectPart } from "./DispatchWithReceiptEffect.ts";

type Deps = Record<never, never> & FailQueuedRunStartPart & StartNextQueuedRunPart & DispatchDelegatedTaskCompletionDeliveryResolutionPart & RecordSubagentFollowupPart & DispatchSteerIntoRunPart & SettleInterruptedRunPart & SettleBackgroundWorkPart & DispatchRunInterruptPart & DispatchRuntimeRequestRespondPart & DispatchThreadMergeBackPart & DispatchDelegatedTaskRequestPart & DispatchRemoteDelegatedTaskCompletePart & DispatchSubagentStopPart & FinalizeAppOwnedSubagentTaskPart & DispatchOncePart & DispatchWithReceiptEffectPart;

export const installRecoverDelegatedTasks = Effect.fnUntraced(function* (deps: Deps) {
  const { appOwnedSubagentParentThreadId, childAwaitsRestartContinuation, eventSink, finalizeAppOwnedSubagent, finalizeDelegatedCompletionDelivery, offerDelegatedCompletionDelivery, projectionStore, releaseUnattendedHolds, retryContinuationStart, startNextQueuedRun, threadDispatch } = deps;

const handleRunUpdate = Effect.fn("Orchestrator.handleRunUpdate")(
  function* (stored: OrchestrationV2StoredEvent) {
    if (stored.event.type !== "run.updated") return;
    const threadId = stored.event.threadId;
    const run = stored.event.payload;
    // Take parent and child locks sequentially, never nested: delegation holds the parent
    // while writing child events, so nesting parent inside child would invert the order.
    // The keyed semaphores are neither reentrant nor deadlock-aware.
    if (delegatedTaskTerminalStatus(run.status) !== null) {
      // Before the parent hears of the failure: a pending continuation keeps the task open.
      if (run.status === "failed" && run.restartContinuationOfRunId !== undefined) {
        yield* threadDispatch.withLock(threadId, retryContinuationStart(threadId, run.id)).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to schedule a restart continuation retry", {
              threadId,
              runId: run.id,
              cause,
            }),
          ),
        );
      }
      yield* threadDispatch.withLock(
        threadId,
        finalizeDelegatedCompletionDelivery(threadId, run.id),
      );
      yield* threadDispatch
        .withLock(
          threadId,
          (run.status === "completed"
            ? releaseUnattendedHolds(threadId, run.id)
            : Effect.void
          ).pipe(
            Effect.andThen(
              startNextQueuedRun(threadId, {
                endedRunId: run.id,
                ...(run.status === "failed" ? { failedRunId: run.id } : {}),
              }),
            ),
          ),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to start the next queued V2 run", { threadId, cause }),
          ),
        );
    }
    const parentThreadId = yield* appOwnedSubagentParentThreadId(threadId);
    if (parentThreadId !== undefined) {
      yield* threadDispatch.withLock(
        parentThreadId,
        finalizeAppOwnedSubagent(threadId, { syncRunId: run.id }),
      );
    }
  },
  (effect, stored) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to react to V2 run update", {
          threadId: stored.event.threadId,
          sequence: stored.sequence,
          cause,
        }),
      ),
    ),
);

const terminalEventsAfterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);

yield* eventSink
  .stream({ afterSequence: terminalEventsAfterSequence, eventType: "run.updated" })
  .pipe(
    Stream.filter(
      (stored) =>
        stored.event.type === "run.updated" &&
        !String(stored.commandId).startsWith("command:runtime-reconcile:") &&
        ((stored.event.payload.delegatedTaskId !== undefined &&
          (stored.event.payload.status === "queued" ||
            stored.event.payload.status === "starting")) ||
          stored.event.payload.status === "completed" ||
          stored.event.payload.status === "interrupted" ||
          stored.event.payload.status === "failed" ||
          stored.event.payload.status === "cancelled" ||
          stored.event.payload.status === "rolled_back"),
    ),
    Stream.runForEach(handleRunUpdate),
    Effect.forkScoped,
  );

const providerThreadsWithBackgroundWork = new Set<string>();

const settlesChildWork = (stored: OrchestrationV2StoredEvent) => {
  const { event } = stored;
  if (event.type === "subagent.updated")
    return !isOrchestrationV2WorkActive(event.payload.status);
  if (event.type !== "provider-thread.updated") return false;
  if (backgroundWorkHoldsCompletion(event.payload.pendingBackgroundTasks ?? [])) {
    providerThreadsWithBackgroundWork.add(event.payload.id);
    return false;
  }
  return providerThreadsWithBackgroundWork.delete(event.payload.id);
};

yield* Stream.merge(
  eventSink.stream({
    afterSequence: terminalEventsAfterSequence,
    eventType: "provider-thread.updated",
  }),
  eventSink.stream({ afterSequence: terminalEventsAfterSequence, eventType: "subagent.updated" }),
).pipe(
  Stream.filter(settlesChildWork),
  Stream.runForEach((stored) =>
    Effect.gen(function* () {
      const childThreadId = stored.event.threadId;
      const parentThreadId = yield* appOwnedSubagentParentThreadId(childThreadId);
      if (parentThreadId === undefined) return;
      yield* threadDispatch.withLock(parentThreadId, finalizeAppOwnedSubagent(childThreadId));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to finalize a delegated child after its work settled", {
          threadId: stored.event.threadId,
          sequence: stored.sequence,
          cause,
        }),
      ),
    ),
  ),
  Effect.forkScoped,
);

const recoverDelegatedTasks = Effect.gen(function* () {
  yield* projectionStore.getRecoveryThreadIds("subagent-results").pipe(
    Effect.tap((threadIds) =>
      Effect.annotateCurrentSpan("recovery.subagentResultThreads", threadIds.length),
    ),
    Effect.flatMap((threadIds) =>
      Effect.forEach(
        threadIds,
        (threadId) =>
          Effect.gen(function* () {
            const thread = yield* projectionStore.getThreadShell(threadId);
            const parentThreadId = thread?.lineage.parentThreadId;
            if (parentThreadId === undefined || parentThreadId === null) return;
            yield* threadDispatch.withLock(parentThreadId, finalizeAppOwnedSubagent(threadId));
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to recover terminal app-owned subagent", {
                childThreadId: threadId,
                cause,
              }),
            ),
          ),
        { concurrency: 8, discard: true },
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to inspect app-owned subagents during recovery", {
        cause,
      }),
    ),
  );
  yield* projectionStore.getRecoveryThreadIds("delegated-completions").pipe(
    Effect.tap((threadIds) =>
      Effect.annotateCurrentSpan("recovery.delegatedCompletionThreads", threadIds.length),
    ),
    Effect.flatMap((threadIds) =>
      Effect.forEach(
        threadIds,
        (threadId) =>
          threadDispatch
            .withLock(
              threadId,
              Effect.gen(function* () {
                const projection = yield* projectionStore.getThreadRecords(threadId, ["runs"]);
                // Only the current delivery's run can settle its cohort; revisiting historical delivery runs repeatedly reloads the thread.
                const openDeliveryMessageIds = new Set(
                  projection.runs.flatMap((run) =>
                    run.delegatedCompletion?.delivery == null
                      ? []
                      : [run.delegatedCompletion.delivery.messageId],
                  ),
                );
                const terminalDeliveryRunIds = projection.runs
                  .filter(
                    (run) =>
                      delegatedTaskTerminalStatus(run.status) !== null &&
                      openDeliveryMessageIds.has(run.userMessageId),
                  )
                  .map((run) => run.id);
                for (const runId of terminalDeliveryRunIds) {
                  yield* finalizeDelegatedCompletionDelivery(threadId, runId);
                }
                const refreshed =
                  terminalDeliveryRunIds.length === 0
                    ? projection
                    : yield* projectionStore.getThreadRecords(threadId, ["runs"]);
                for (const run of refreshed.runs) {
                  if (
                    run.delegatedCompletion?.delivery !== null &&
                    run.delegatedCompletion !== undefined
                  ) {
                    yield* offerDelegatedCompletionDelivery(threadId, run.id);
                  }
                }
              }),
            )
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to recover delegated completion delivery", {
                  threadId,
                  cause,
                }),
              ),
            ),
        { concurrency: 8, discard: true },
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to inspect delegated completion delivery during recovery", {
        cause,
      }),
    ),
  );
});

const delegatedTaskResultPending = Effect.fn("Orchestrator.delegatedTaskResultPending")(
  function* (childThreadId: ThreadId, taskId?: NodeId) {
    const child = yield* projectionStore.getThreadRecords(
      childThreadId,
      ["runs", "messages", "subagents", "providerThreads", "providerTurns", "attempts"],
      { messageRoles: ["user"] },
    );
    if (taskId !== undefined) {
      const runs = child.runs.filter((run) => run.delegatedTaskId === taskId);
      const run = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      if (run === undefined || delegatedTaskTerminalStatus(run.status) === null) return true;
      return yield* childAwaitsRestartContinuation(runs, run);
    }
    const progress = delegatedTaskProgress(child);
    if (progress.state !== "result_available") return true;
    if (progress.resultRun === undefined) return false;
    return yield* childAwaitsRestartContinuation(child.runs, progress.resultRun);
  },
  (effect, childThreadId, _taskId?) =>
    effect.pipe(
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: childThreadId, cause }),
      ),
    ),
);

const recoverDelegatedTask = Effect.fn("Orchestrator.recoverDelegatedTask")(
  function* (threadId: ThreadId, sourceRunId: RunId) {
    const parentThreadId = yield* appOwnedSubagentParentThreadId(threadId);
    if (parentThreadId === undefined) return;
    yield* threadDispatch.withLock(
      parentThreadId,
      finalizeAppOwnedSubagent(threadId, { settledContinuationOf: sourceRunId }),
    );
  },
  (effect, threadId, _sourceRunId) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to recover delegated task after restart", {
          childThreadId: threadId,
          cause,
        }),
      ),
    ),
);

const shellProjectionError = (cause: unknown) =>
  new OrchestratorProjectionError({ threadId: ThreadId.make("thread:shell"), cause });

  return { handleRunUpdate, terminalEventsAfterSequence, providerThreadsWithBackgroundWork, settlesChildWork, recoverDelegatedTasks, delegatedTaskResultPending, recoverDelegatedTask, shellProjectionError };
});

export type RecoverDelegatedTasksPart = ReturnType<typeof installRecoverDelegatedTasks> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installRecoverDelegatedTasks>;
