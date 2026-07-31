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
import { makeProviderFailure, makeProviderFailureTurnItem } from "./ProviderFailure.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import {
  canRouteRelatedSubagent,
  RunExecutionServiceV2,
  selectInheritedBackgroundTurnItems,
} from "./RunExecutionService.ts";
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
  readonly failFromDeadLetter: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly error: string;
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
      const selectInheritedBackgroundItems = (
        current: typeof projection,
      ): ReturnType<typeof selectInheritedBackgroundTurnItems> =>
        selectInheritedBackgroundTurnItems({
          threadId: current.thread.id,
          currentProviderThreadId: providerThread.id,
          currentRunOrdinal: run.ordinal,
          runs: current.runs,
          turnItems: current.turnItems,
        });
      const inheritedBackgroundTurnItems = yield* projectionStore
        .getThreadProjection(projection.thread.id)
        .pipe(Effect.map(selectInheritedBackgroundItems));
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
      const routableSubagents = projection.subagents.filter((subagent) =>
        canRouteRelatedSubagent(subagent.status),
      );
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
        loadInheritedBackgroundTurnItems: () =>
          projectionStore.getThreadProjection(projection.thread.id).pipe(
            Effect.map(selectInheritedBackgroundItems),
            Effect.catchCause(() => Effect.succeed(inheritedBackgroundTurnItems)),
          ),
        relatedThreadIds: routableSubagents.flatMap((subagent) =>
          subagent.childThreadId === null ? [] : [subagent.childThreadId],
        ),
        relatedProviderThreadIds: routableSubagents.flatMap((subagent) =>
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
        hasUnpairedRunInterruptRequest: () =>
          projectionStore.getThreadProjection(projection.thread.id).pipe(
            Effect.map((current) => {
              const requestId = idAllocator.derive.runSignalTurnItem({
                runId: run.id,
                signal: "interrupt-request",
              });
              const resultId = idAllocator.derive.runSignalTurnItem({
                runId: run.id,
                signal: "interrupt-result",
              });
              const hasRequest = current.turnItems.some((item) => item.id === requestId);
              const hasResult = current.turnItems.some((item) => item.id === resultId);
              return hasRequest && !hasResult;
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

    // A turn-start effect that exhausts its retry budget leaves the run
    // `starting` with a `pending` attempt forever: nothing else owns that
    // transition, so the thread shows indefinite progress with no error. This
    // is the compensating transition for that dead letter. The
    // `writeIfRunCurrent` guard makes it a no-op when the run advanced or
    // terminalized through any other path in the meantime.
    const failFromDeadLetter = Effect.fn("orchestrationV2.providerTurnStart.failFromDeadLetter")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly runId: RunId;
        readonly error: string;
      }) {
        const projection = yield* projectionStore.getThreadProjection(input.threadId);
        const run = projection.runs.find((candidate) => candidate.id === input.runId);
        if (run === undefined || run.status !== "starting" || run.activeAttemptId === null) {
          return;
        }
        const activeAttemptId = run.activeAttemptId;
        const attempt = projection.attempts.find((candidate) => candidate.id === activeAttemptId);
        const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
        const providerThread = projection.providerThreads.find(
          (candidate) => candidate.id === run.providerThreadId,
        );
        const now = yield* DateTime.now;
        const failure = makeProviderFailure({
          message: `Starting the provider turn failed permanently: ${input.error}`,
          retryable: false,
        });
        const runtimeRequestCancellationReason =
          "The provider turn failed before this runtime request was resolved.";
        const events: Array<OrchestrationV2DomainEvent> = [];
        if (attempt !== undefined) {
          events.push({
            id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
            type: "run-attempt.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: attempt.rootNodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...attempt, status: "failed", completedAt: now },
          });
        }
        if (rootNode !== undefined) {
          events.push({
            id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
            type: "node.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: rootNode.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...rootNode, status: "failed", completedAt: now },
          });
        }
        // A restart can inherit open run-owned work from the interrupted
        // attempt (subagents, child nodes, provider turns, streaming
        // messages, in-flight turn items). Live finalization cascades those
        // through `cascadeTerminalizeRunOwnedSubagents`; this path sweeps the
        // parent projection here and linked child threads below, so nothing
        // stays open under the failed run.
        for (const subagent of projection.subagents.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          events.push({
            id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
            type: "subagent.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: subagent.id,
            driver: subagent.driver,
            providerInstanceId: subagent.providerInstanceId,
            occurredAt: now,
            payload: { ...subagent, status: "failed", completedAt: now, updatedAt: now },
          });
        }
        for (const node of projection.nodes.filter(
          (candidate) =>
            candidate.runId === run.id &&
            candidate.id !== run.rootNodeId &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          events.push({
            id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
            type: "node.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: node.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...node, status: "failed", completedAt: now },
          });
        }
        for (const providerTurn of projection.providerTurns.filter(
          (candidate) =>
            candidate.runAttemptId !== null &&
            projection.attempts.some(
              (attemptRow) =>
                attemptRow.id === candidate.runAttemptId && attemptRow.runId === run.id,
            ) &&
            (candidate.status === "pending" || candidate.status === "running"),
        )) {
          events.push({
            id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
            type: "provider-turn.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: providerTurn.nodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...providerTurn, status: "cancelled", completedAt: now },
          });
        }
        for (const request of projection.runtimeRequests.filter(
          (candidate) =>
            candidate.status === "pending" &&
            projection.nodes.some((node) => node.id === candidate.nodeId && node.runId === run.id),
        )) {
          events.push({
            id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
            type: "runtime-request.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: request.nodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: {
              ...request,
              status: "cancelled",
              responseCapability: {
                type: "not_resumable",
                reason: runtimeRequestCancellationReason,
              },
              resolvedAt: now,
            },
          });
        }
        for (const message of projection.messages.filter(
          (candidate) => candidate.runId === run.id && candidate.streaming,
        )) {
          events.push({
            id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
            type: "message.updated",
            threadId: projection.thread.id,
            runId: run.id,
            ...(message.nodeId === null ? {} : { nodeId: message.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...message, streaming: false, updatedAt: now },
          });
        }
        for (const item of projection.turnItems.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          events.push({
            id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
            type: "turn-item.updated",
            threadId: projection.thread.id,
            runId: run.id,
            ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: {
              ...item,
              ...("streaming" in item ? { streaming: false } : {}),
              status: "failed",
              completedAt: now,
              updatedAt: now,
            },
          });
        }
        // Linked child threads carry the interrupted attempt's routed rows,
        // usually with `runId: null`, and provider-native children have no
        // runs of their own, so neither the per-run sweep above nor startup
        // reconcile (which iterates per-run rows) ever settles them. Follow
        // lifetime linkage the way `cascadeTerminalizeRunOwnedSubagents`
        // does: child thread ids come from all of this run's subagent rows
        // and subagent turn items, terminal links included (a link can
        // terminalize before the child settles), recursing through nested
        // subagents. A child row that names a nonterminal run in its own
        // thread belongs to an independently live child (an app-owned
        // delegation) and is left alone; the same guard decides which nested
        // links to follow.
        const isNonterminalRunStatus = (status: string) =>
          status === "queued" ||
          status === "preparing" ||
          status === "starting" ||
          status === "running" ||
          status === "waiting";
        const isOpenRowStatus = (status: string) =>
          status === "pending" || status === "running" || status === "waiting";
        const visitedThreadIds = new Set<ThreadId>([projection.thread.id]);
        const childThreadQueue: Array<ThreadId> = [];
        const enqueueChildThread = (childThreadId: ThreadId | null) => {
          if (childThreadId === null || visitedThreadIds.has(childThreadId)) {
            return;
          }
          visitedThreadIds.add(childThreadId);
          childThreadQueue.push(childThreadId);
        };
        for (const subagent of projection.subagents) {
          if (subagent.runId === run.id) enqueueChildThread(subagent.childThreadId);
        }
        for (const item of projection.turnItems) {
          if (item.type === "subagent" && item.runId === run.id) {
            enqueueChildThread(item.childThreadId);
          }
        }
        while (childThreadQueue.length > 0) {
          const childThreadId = childThreadQueue.shift();
          if (childThreadId === undefined) break;
          const childResult = yield* Effect.result(
            projectionStore.getThreadProjection(childThreadId),
          );
          if (childResult._tag === "Failure") {
            // A child with no projection row has nothing to settle (soft-deleted
            // threads still project, so they sweep normally). Any other read
            // failure is logged and skipped: compensation must not fail, so a
            // child-read blip cannot hold the parent settle hostage.
            if (childResult.failure._tag !== "ProjectionStoreThreadNotFoundError") {
              yield* Effect.logWarning(
                "Could not read a child thread while sweeping a dead letter",
                {
                  childThreadId,
                  runId: run.id,
                  threadId: projection.thread.id,
                  error: String(childResult.failure),
                },
              );
            }
            continue;
          }
          const child = childResult.success;
          const sweepable = (rowRunId: RunId | null) => {
            if (rowRunId === null || rowRunId === run.id) return true;
            const owningRun = child.runs.find((candidate) => candidate.id === rowRunId);
            return owningRun === undefined || !isNonterminalRunStatus(owningRun.status);
          };
          for (const subagent of child.subagents) {
            if (!sweepable(subagent.runId)) continue;
            enqueueChildThread(subagent.childThreadId);
            if (!isOpenRowStatus(subagent.status)) continue;
            events.push({
              id: yield* idAllocator.allocate.event({ threadId: childThreadId }),
              type: "subagent.updated",
              threadId: childThreadId,
              runId: subagent.runId ?? run.id,
              nodeId: subagent.id,
              driver: subagent.driver,
              providerInstanceId: subagent.providerInstanceId,
              occurredAt: now,
              payload: { ...subagent, status: "failed", completedAt: now, updatedAt: now },
            });
          }
          for (const item of child.turnItems) {
            if (!sweepable(item.runId)) continue;
            if (item.type === "subagent") enqueueChildThread(item.childThreadId);
            if (!isOpenRowStatus(item.status)) continue;
            events.push({
              id: yield* idAllocator.allocate.event({ threadId: childThreadId }),
              type: "turn-item.updated",
              threadId: childThreadId,
              runId: item.runId ?? run.id,
              ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: {
                ...item,
                ...("streaming" in item ? { streaming: false } : {}),
                status: "failed",
                completedAt: now,
                updatedAt: now,
              },
            });
          }
          for (const node of child.nodes) {
            if (!sweepable(node.runId) || !isOpenRowStatus(node.status)) continue;
            events.push({
              id: yield* idAllocator.allocate.event({ threadId: childThreadId }),
              type: "node.updated",
              threadId: childThreadId,
              runId: node.runId ?? run.id,
              nodeId: node.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: { ...node, status: "failed", completedAt: now },
            });
          }
          for (const providerTurn of child.providerTurns) {
            if (providerTurn.status !== "pending" && providerTurn.status !== "running") {
              continue;
            }
            const node = child.nodes.find((candidate) => candidate.id === providerTurn.nodeId);
            const attempt =
              providerTurn.runAttemptId === null
                ? undefined
                : child.attempts.find((candidate) => candidate.id === providerTurn.runAttemptId);
            const ownerRunIds = [
              ...(node === undefined ? [] : [node.runId]),
              ...(attempt === undefined ? [] : [attempt.runId]),
            ];
            if (
              ownerRunIds.length === 0 ||
              ownerRunIds.some((ownerRunId) => !sweepable(ownerRunId))
            ) {
              continue;
            }
            events.push({
              id: yield* idAllocator.allocate.event({ threadId: childThreadId }),
              type: "provider-turn.updated",
              threadId: childThreadId,
              runId: attempt?.runId ?? node?.runId ?? run.id,
              nodeId: providerTurn.nodeId,
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: { ...providerTurn, status: "cancelled", completedAt: now },
            });
          }
          for (const request of child.runtimeRequests) {
            const node = child.nodes.find((candidate) => candidate.id === request.nodeId);
            if (request.status !== "pending" || node === undefined || !sweepable(node.runId)) {
              continue;
            }
            events.push({
              id: yield* idAllocator.allocate.event({ threadId: childThreadId }),
              type: "runtime-request.updated",
              threadId: childThreadId,
              runId: node.runId ?? run.id,
              nodeId: request.nodeId,
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: {
                ...request,
                status: "cancelled",
                responseCapability: {
                  type: "not_resumable",
                  reason: runtimeRequestCancellationReason,
                },
                resolvedAt: now,
              },
            });
          }
          for (const message of child.messages) {
            if (!message.streaming || !sweepable(message.runId)) continue;
            events.push({
              id: yield* idAllocator.allocate.event({ threadId: childThreadId }),
              type: "message.updated",
              threadId: childThreadId,
              ...(message.runId === null ? {} : { runId: message.runId }),
              ...(message.nodeId === null ? {} : { nodeId: message.nodeId }),
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: { ...message, streaming: false, updatedAt: now },
            });
          }
        }
        if (providerThread !== undefined) {
          events.push({
            id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
            type: "turn-item.updated",
            threadId: projection.thread.id,
            runId: run.id,
            ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: makeProviderFailureTurnItem({
              idAllocator,
              driver: providerThread.driver,
              threadId: projection.thread.id,
              runId: run.id,
              nodeId: rootNode?.id ?? null,
              providerThreadId: providerThread.id,
              providerTurnId:
                attempt?.providerTurnId ??
                idAllocator.derive.providerTurn({
                  driver: providerThread.driver,
                  nativeTurnId: `failed:${activeAttemptId}`,
                }),
              itemOrdinal: Math.max(0, ...projection.turnItems.map((item) => item.ordinal)) + 1,
              failure,
              occurredAt: now,
            }),
          });
        }
        if (providerThread !== undefined && providerThread.status === "active") {
          // This rides the same guarded commit, so it only lands while the run
          // is still `starting` on our attempt and the binding is still ours.
          events.push({
            id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
            type: "provider-thread.updated",
            threadId: projection.thread.id,
            driver: providerThread.driver,
            providerInstanceId: providerThread.providerInstanceId,
            occurredAt: now,
            payload: { ...providerThread, status: "idle", updatedAt: now },
          });
        }
        events.push({
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, status: "failed", queuePosition: null, completedAt: now },
        });
        yield* eventSink.writeIfRunCurrent({
          threadId: projection.thread.id,
          runId: run.id,
          activeAttemptId,
          expectedStatus: "starting",
          events,
        });
      },
    );

    return ProviderTurnStartServiceV2.of({
      start: (input) =>
        start(input).pipe(
          Effect.mapError((cause) =>
            isProviderTurnStartError(cause)
              ? cause
              : new ProviderTurnStartError({ runId: input.runId, cause }),
          ),
        ),
      failFromDeadLetter: (input) =>
        failFromDeadLetter(input).pipe(
          Effect.mapError((cause) =>
            isProviderTurnStartError(cause)
              ? cause
              : new ProviderTurnStartError({ runId: input.runId, cause }),
          ),
        ),
    });
  }),
);
