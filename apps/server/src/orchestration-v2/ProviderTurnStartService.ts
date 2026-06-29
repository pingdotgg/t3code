import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { EventSinkV2 } from "./EventSink.ts";
import {
  ContextHandoffServiceV2,
  providerMessageWithContextHandoffs,
} from "./ContextHandoffService.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RunExecutionServiceV2 } from "./RunExecutionService.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

export class ProviderTurnStartError extends Schema.TaggedErrorClass<ProviderTurnStartError>()(
  "ProviderTurnStartError",
  {
    runId: RunId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isProviderTurnStartError = Schema.is(ProviderTurnStartError);

export interface ProviderTurnStartServiceV2Shape {
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void, ProviderTurnStartError>;
}

export class ProviderTurnStartServiceV2 extends Context.Service<
  ProviderTurnStartServiceV2,
  ProviderTurnStartServiceV2Shape
>()("t3/orchestration-v2/ProviderTurnStartService/ProviderTurnStartServiceV2") {}

export const layer: Layer.Layer<
  ProviderTurnStartServiceV2,
  never,
  | EventSinkV2
  | ContextHandoffServiceV2
  | IdAllocatorV2
  | ProjectionStoreV2
  | ProviderSessionManagerV2
  | RunExecutionServiceV2
  | RuntimePolicyV2
> = Layer.effect(
  ProviderTurnStartServiceV2,
  Effect.gen(function* () {
    const eventSink = yield* EventSinkV2;
    const contextHandoffService = yield* ContextHandoffServiceV2;
    const idAllocator = yield* IdAllocatorV2;
    const projectionStore = yield* ProjectionStoreV2;
    const providerSessions = yield* ProviderSessionManagerV2;
    const runExecution = yield* RunExecutionServiceV2;
    const runtimePolicy = yield* RuntimePolicyV2;

    const start = Effect.fn("orchestrationV2.providerTurnStart.start")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) {
      const { runId } = input;
      const projection = yield* projectionStore.getThreadProjection(input.threadId);
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        return yield* new ProviderTurnStartError({ runId, cause: `Run ${runId} was not found.` });
      }
      if (run.status !== "starting") {
        // The effect is idempotent once the run has advanced or terminalized.
        return;
      }
      const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
      const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === run.providerThreadId,
      );
      const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
      const checkpointScope = projection.checkpointScopes.find(
        (candidate) => candidate.id === rootNode?.checkpointScopeId,
      );
      const handoffs = projection.contextHandoffs.filter(
        (handoff) => handoff.targetRunId === run.id && handoff.status === "ready",
      );
      const nativeForkTransfer = projection.contextTransfers.find(
        (transfer) =>
          transfer.type === "fork" &&
          transfer.targetThreadId === input.threadId &&
          transfer.targetRunId === run.id &&
          transfer.status === "pending" &&
          transfer.resolution === null,
      );
      const existingResumeFallback = projection.contextTransfers.find(
        (transfer) =>
          transfer.type === "provider_handoff" &&
          transfer.sourceThreadId === projection.thread.id &&
          transfer.targetThreadId === projection.thread.id &&
          transfer.targetRunId === run.id &&
          transfer.status === "resolved_portable" &&
          transfer.resolution?.strategy === "portable_context",
      );
      if (
        rootNode === undefined ||
        attempt === undefined ||
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        message === undefined ||
        checkpointScope === undefined
      ) {
        return yield* new ProviderTurnStartError({
          runId,
          cause: `Run ${runId} is missing its execution projection state.`,
        });
      }
      const providerSessionId = providerThread.providerSessionId;
      const isCurrentAttemptInStatus = (
        expectedStatus: OrchestrationV2Run["status"],
      ): Effect.Effect<boolean, never> =>
        projectionStore.getThreadProjection(projection.thread.id).pipe(
          Effect.map((current) => {
            const currentRun = current.runs.find((candidate) => candidate.id === run.id);
            return (
              currentRun?.activeAttemptId === attempt.id && currentRun.status === expectedStatus
            );
          }),
          Effect.catchCause(() => Effect.succeed(false)),
        );

      const resolvedRuntimePolicy = yield* runtimePolicy.resolve({
        thread: projection.thread,
        modelSelection: run.modelSelection,
      });
      const existingSessionProjection = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      const session = yield* providerSessions.open({
        threadId: projection.thread.id,
        providerSessionId,
        modelSelection: run.modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
        ...(existingSessionProjection === undefined
          ? {}
          : { resumeFromSession: existingSessionProjection }),
      });
      let effectiveHandoffs = handoffs;
      const loadedProviderThread = yield* Effect.gen(function* () {
        if (nativeForkTransfer !== undefined) {
          const sourceProjection = yield* projectionStore.getThreadProjection(
            nativeForkTransfer.sourceThreadId,
          );
          const sourceRun = sourceProjection.runs.find(
            (candidate) => candidate.id === nativeForkTransfer.sourcePoint.runId,
          );
          const sourceProviderThread = sourceProjection.providerThreads.find(
            (candidate) => candidate.id === sourceRun?.providerThreadId,
          );
          const sourceAttempt = sourceProjection.attempts.find(
            (candidate) => candidate.id === sourceRun?.activeAttemptId,
          );
          const sourceProviderTurn = sourceProjection.providerTurns.find(
            (candidate) =>
              candidate.id === sourceAttempt?.providerTurnId ||
              candidate.runAttemptId === sourceAttempt?.id,
          );
          if (sourceRun === undefined || sourceProviderThread === undefined) {
            return yield* new ProviderTurnStartError({
              runId,
              cause: `Native fork transfer ${nativeForkTransfer.id} has no source provider execution.`,
            });
          }
          return yield* session.forkThread({
            sourceProviderThread,
            sourceProviderTurns: sourceProjection.providerTurns,
            targetThreadId: projection.thread.id,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            ...(sourceProviderTurn === undefined ? {} : { providerTurnId: sourceProviderTurn.id }),
          });
        }
        if (providerThread.nativeThreadRef === null) {
          return yield* session.ensureThread({
            threadId: projection.thread.id,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            providerSessionId,
          });
        }
        const resumed = yield* Effect.result(
          session.resumeThread({
            providerThread,
            threadId: projection.thread.id,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
          }),
        );
        if (resumed._tag === "Success") {
          return resumed.success;
        }

        const replacement = yield* session.ensureThread({
          threadId: projection.thread.id,
          modelSelection: run.modelSelection,
          runtimePolicy: resolvedRuntimePolicy,
          providerSessionId,
        });
        if (existingResumeFallback !== undefined) {
          return replacement;
        }
        const transferId = yield* idAllocator.allocate.contextTransfer({
          sourceThreadId: projection.thread.id,
          targetThreadId: projection.thread.id,
          type: "provider_resume_fallback",
        });
        const createdAt = yield* DateTime.now;
        const handoff = yield* contextHandoffService.prepareProviderHandoff({
          threadId: projection.thread.id,
          targetRunId: run.id,
          transferId,
          fromProviderThreadIds: [providerThread.id],
          toProviderThreadId: providerThread.id,
          fromProviderInstanceId: providerThread.providerInstanceId,
          toProviderInstanceId: run.providerInstanceId,
          coveredRunOrdinals: { from: 1, to: Math.max(1, run.ordinal - 1) },
          strategy: "full_thread_summary",
          items: projection.turnItems,
          createdAt,
        });
        effectiveHandoffs = [...handoffs, handoff];
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "context-handoff.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: handoff,
            },
            {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "context-transfer.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: {
                id: transferId,
                type: "provider_handoff",
                sourceThreadId: projection.thread.id,
                targetThreadId: projection.thread.id,
                sourcePoint: { threadId: projection.thread.id },
                basePoint: null,
                sourceProviderInstanceId: providerThread.providerInstanceId,
                targetProviderInstanceId: run.providerInstanceId,
                targetRunId: run.id,
                status: "resolved_portable",
                resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                createdBy: "system",
                error: null,
                createdAt,
                updatedAt: createdAt,
                consumedAt: null,
              },
            },
          ],
        });
        return replacement;
      });
      if (!(yield* isCurrentAttemptInStatus("starting"))) {
        return;
      }
      const now = yield* DateTime.now;
      const runningProviderThread: OrchestrationV2ProviderThread = {
        ...loadedProviderThread,
        id: providerThread.id,
        driver: session.driver,
        providerInstanceId: run.providerInstanceId,
        providerSessionId,
        appThreadId: projection.thread.id,
        ownerNodeId: providerThread.ownerNodeId,
        firstRunOrdinal: providerThread.firstRunOrdinal ?? run.ordinal,
        lastRunOrdinal: run.ordinal,
        handoffIds: providerThread.handoffIds,
        forkedFrom: providerThread.forkedFrom,
        status: "active",
        createdAt: providerThread.createdAt,
        updatedAt: now,
      };
      const runningRun: OrchestrationV2Run = {
        ...run,
        status: "running",
        startedAt: now,
      };
      const runningAttempt: OrchestrationV2RunAttempt = {
        ...attempt,
        status: "running",
        startedAt: now,
      };
      const runningRootNode: OrchestrationV2ExecutionNode = {
        ...rootNode,
        status: "running",
        startedAt: now,
      };
      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: yield* idAllocator.allocate.event({
            threadId: projection.thread.id,
            providerSessionId,
          }),
          type: "provider-session.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: session.providerSession,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "provider-thread.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningProviderThread,
        },
        ...(nativeForkTransfer === undefined || runningProviderThread.nativeThreadRef === null
          ? []
          : [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-transfer.updated" as const,
                threadId: projection.thread.id,
                runId: run.id,
                driver: session.driver,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...nativeForkTransfer,
                  targetProviderInstanceId: run.providerInstanceId,
                  targetRunId: run.id,
                  status: "consumed" as const,
                  resolution: {
                    strategy: "native_fork" as const,
                    providerThreadRef: runningProviderThread.nativeThreadRef,
                  },
                  error: null,
                  updatedAt: now,
                  consumedAt: now,
                },
              },
            ]),
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRun,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run-attempt.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningAttempt,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "node.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRootNode,
        },
      ];
      const runningWrite = yield* eventSink.writeIfRunCurrent({
        threadId: projection.thread.id,
        runId: run.id,
        activeAttemptId: attempt.id,
        expectedStatus: "starting",
        events,
      });
      if (!runningWrite.committed) {
        return;
      }
      yield* runExecution.startRootRun({
        commandId: CommandId.make(`command:effect:provider-turn.start:${run.id}`),
        appThread: projection.thread,
        providerSessionId,
        session,
        run: runningRun,
        rootNode: runningRootNode,
        checkpointScope,
        providerThread: runningProviderThread,
        attempt: runningAttempt,
        attemptId: attempt.id,
        relatedThreadIds: projection.subagents.flatMap((subagent) =>
          subagent.childThreadId === null ? [] : [subagent.childThreadId],
        ),
        relatedProviderThreadIds: projection.subagents.flatMap((subagent) =>
          subagent.providerThreadId === null ? [] : [subagent.providerThreadId],
        ),
        providerTurnOrdinal:
          Math.max(
            0,
            ...projection.providerTurns
              .filter((turn) => turn.providerThreadId === providerThread.id)
              .map((turn) => turn.ordinal),
          ) + 1,
        shouldStartProviderTurn: () => isCurrentAttemptInStatus("running"),
        shouldFinalizeRun: () =>
          projectionStore.getThreadProjection(projection.thread.id).pipe(
            Effect.map((current) => {
              const currentRun = current.runs.find((candidate) => candidate.id === run.id);
              return (
                currentRun?.activeAttemptId === attempt.id &&
                (currentRun.status === "starting" || currentRun.status === "running")
              );
            }),
            Effect.catchCause(() => Effect.succeed(false)),
          ),
        message: {
          messageId: message.id,
          text:
            effectiveHandoffs.length === 0
              ? message.text
              : providerMessageWithContextHandoffs({
                  handoffs: effectiveHandoffs,
                  userText: message.text,
                }),
          attachments: message.attachments,
          createdBy: message.createdBy,
          creationSource: message.creationSource,
        },
        modelSelection: run.modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
      });
    });

    return ProviderTurnStartServiceV2.of({
      start: (input) =>
        start(input).pipe(
          Effect.mapError((cause) =>
            isProviderTurnStartError(cause)
              ? cause
              : new ProviderTurnStartError({ runId: input.runId, cause }),
          ),
        ),
    });
  }),
);
