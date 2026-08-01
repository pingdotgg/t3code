import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type RunId,
  ThreadId,
} from "@piku/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class ProviderRuntimeRecoveryError extends Schema.TaggedErrorClass<ProviderRuntimeRecoveryError>()(
  "ProviderRuntimeRecoveryError",
  {
    operation: Schema.Literals(["read-projections", "reconcile", "drain-outbox"]),
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Provider runtime recovery failed during ${this.operation}.`;
  }
}

export interface ProviderRuntimeRecoverySummary {
  readonly terminalizedRuns: number;
  readonly stoppedSessions: number;
  readonly closedRequests: number;
  readonly retiredEffects: number;
  readonly requeuedEffects: number;
  readonly executedEffects: number;
}

export interface ProviderRuntimeReconciliationSummary {
  readonly terminalizedRuns: number;
  readonly stoppedSessions: number;
  readonly closedRequests: number;
  readonly retiredEffects: number;
  readonly requeuedEffects: number;
}

/**
 * "startup"/"shutdown" reconcile a whole projection: nothing live survives a
 * process boundary, so sessions, provider threads, and pending requests are
 * all force-settled. "janitor" runs inside a live process against runs that
 * lost their liveness lease; it only touches the orphaned runs' own subtree
 * and must leave idle-but-live sessions alone.
 */
export type ProviderRuntimeReconcileMode =
  | { readonly trigger: "startup" | "shutdown" }
  | { readonly trigger: "janitor"; readonly runIds: ReadonlySet<RunId> };

export class ProviderRuntimeRecoveryService extends Context.Service<
  ProviderRuntimeRecoveryService,
  {
    readonly reconcile: (
      trigger: "startup" | "shutdown",
    ) => Effect.Effect<ProviderRuntimeReconciliationSummary, ProviderRuntimeRecoveryError>;
    readonly janitorThread: (input: {
      readonly threadId: ThreadId;
      readonly runIds: ReadonlySet<RunId>;
    }) => Effect.Effect<{ readonly terminalizedRuns: number }, ProviderRuntimeRecoveryError>;
    readonly recover: Effect.Effect<ProviderRuntimeRecoverySummary, ProviderRuntimeRecoveryError>;
  }
>()("piku/orchestration-v2/ProviderRuntimeRecoveryService") {}

function nonterminalRuns(projection: OrchestrationV2ThreadProjection) {
  return projection.runs.filter((run) => {
    const status: string = run.status;
    return (
      run.status === "queued" ||
      status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting"
    );
  });
}

export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const reconcileProjection = Effect.fn("ProviderRuntimeRecoveryService.reconcileProjection")(
    function* (projection: OrchestrationV2ThreadProjection, mode: ProviderRuntimeReconcileMode) {
      const trigger = mode.trigger;
      const now = yield* DateTime.now;
      const runs = [] as Array<OrchestrationV2ThreadProjection["runs"][number]>;
      for (const run of nonterminalRuns(projection)) {
        if (mode.trigger === "janitor" && !mode.runIds.has(run.id)) continue;
        if (run.status === "waiting") {
          const checkpointEffects = yield* outbox
            .listByCommandId(CommandId.make(`command:effect:checkpoint.capture:${run.id}`))
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderRuntimeRecoveryError({
                    operation: "reconcile",
                    threadId: projection.thread.id,
                    cause,
                  }),
              ),
            );
          const hasReplayableCheckpoint = checkpointEffects.some(
            (effect) =>
              effect.request.type === "checkpoint.capture" &&
              effect.request.runId === run.id &&
              (effect.status === "pending" || effect.status === "running"),
          );
          if (hasReplayableCheckpoint) continue;
        }
        runs.push(run);
      }
      const janitoredRunIds = new Set(runs.map((run) => run.id));
      const janitoredNodeIds =
        mode.trigger === "janitor"
          ? new Set(
              projection.nodes
                .filter((node) => node.runId !== null && janitoredRunIds.has(node.runId))
                .map((node) => node.id),
            )
          : null;
      const requests = projection.runtimeRequests.filter(
        (request) =>
          request.status === "pending" &&
          (janitoredNodeIds === null || janitoredNodeIds.has(request.nodeId)),
      );
      const detail =
        trigger === "janitor"
          ? "Cancelled because no live process owned this work."
          : `Cancelled because the server ${trigger === "startup" ? "restarted" : "shut down"} before the provider work completed.`;
      const commandId = CommandId.make(
        `command:runtime-reconcile:${trigger}:${projection.thread.id}:${DateTime.formatIso(now)}`,
      );
      const allocateEventId = () =>
        ids.allocate.event({ threadId: projection.thread.id, commandId }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "reconcile",
                threadId: projection.thread.id,
                cause,
              }),
          ),
        );
      const events: Array<OrchestrationV2DomainEvent> = [];
      for (const request of requests) {
        events.push({
          id: yield* allocateEventId(),
          type: "runtime-request.updated",
          threadId: projection.thread.id,
          nodeId: request.nodeId,
          occurredAt: now,
          payload: {
            ...request,
            status: trigger === "shutdown" ? "cancelled" : "expired",
            responseCapability: {
              type: "not_resumable",
              reason:
                trigger === "janitor"
                  ? "The work that raised this runtime request is no longer running."
                  : `The server ${trigger === "startup" ? "restarted" : "shut down"} before this runtime request was resolved.`,
            },
            resolvedAt: now,
          },
        });
      }
      for (const run of runs) {
        events.push({
          id: yield* allocateEventId(),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, status: "cancelled", queuePosition: null, completedAt: now },
        });
        for (const attempt of projection.attempts.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.status === "pending" || candidate.status === "running"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "run-attempt.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: attempt.rootNodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...attempt, status: "cancelled", completedAt: now },
          });
        }
        for (const node of projection.nodes.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "node.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: node.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...node, status: "cancelled", completedAt: now },
          });
        }
        for (const subagent of projection.subagents.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "subagent.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: subagent.id,
            driver: subagent.driver,
            providerInstanceId: subagent.providerInstanceId,
            occurredAt: now,
            payload: { ...subagent, status: "cancelled", completedAt: now, updatedAt: now },
          });
        }
        for (const providerTurn of projection.providerTurns.filter(
          (candidate) =>
            candidate.runAttemptId !== null &&
            projection.attempts.some(
              (attempt) => attempt.id === candidate.runAttemptId && attempt.runId === run.id,
            ) &&
            (candidate.status === "pending" || candidate.status === "running"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "provider-turn.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: providerTurn.nodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...providerTurn, status: "cancelled", completedAt: now },
          });
        }
        for (const message of projection.messages.filter(
          (candidate) => candidate.runId === run.id && candidate.streaming,
        )) {
          events.push({
            id: yield* allocateEventId(),
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
            id: yield* allocateEventId(),
            type: "turn-item.updated",
            threadId: projection.thread.id,
            runId: run.id,
            ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...item, status: "cancelled", completedAt: now, updatedAt: now },
          });
        }
      }
      const janitoredProviderThreadIds = new Set(
        runs.flatMap((run) => (run.providerThreadId === null ? [] : [run.providerThreadId])),
      );
      for (const providerThread of projection.providerThreads.filter(
        (candidate) =>
          candidate.status === "active" &&
          (mode.trigger !== "janitor" || janitoredProviderThreadIds.has(candidate.id)),
      )) {
        events.push({
          id: yield* allocateEventId(),
          type: "provider-thread.updated",
          threadId: projection.thread.id,
          driver: providerThread.driver,
          providerInstanceId: providerThread.providerInstanceId,
          occurredAt: now,
          payload: { ...providerThread, status: "idle", updatedAt: now },
        });
      }
      // The janitor never touches provider sessions: an idle session can be
      // alive and warm in this process with no run attached, and marking it
      // stopped would desynchronize the projection from the live entry.
      const sessionsToStop =
        mode.trigger === "janitor"
          ? []
          : projection.providerSessions.filter(
              (candidate) => candidate.status !== "stopped" && candidate.status !== "error",
            );
      for (const session of sessionsToStop) {
        events.push({
          id: yield* allocateEventId(),
          type: "provider-session.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: session.providerInstanceId,
          occurredAt: now,
          payload: { ...session, status: "stopped", updatedAt: now, lastError: null },
        });
      }
      const stoppedSessions = sessionsToStop.length;
      let retiredEffects: number;
      if (events.length === 0) {
        const retiredEffectIds = yield* outbox
          .cancelUnsettled({
            threadId: projection.thread.id,
            effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
            reason: detail,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "reconcile",
                  threadId: projection.thread.id,
                  cause: { detail, cause },
                }),
            ),
          );
        yield* outbox.signalCancellations(retiredEffectIds);
        retiredEffects = retiredEffectIds.length;
      } else {
        const result = yield* eventSink
          .commitCommand({
            commandId,
            threadId: projection.thread.id,
            commandType: "provider-runtime.reconcile",
            acceptedAt: now,
            events,
            effects: [],
            cancelUnsettledEffects: {
              effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
              reason: detail,
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "reconcile",
                  threadId: projection.thread.id,
                  cause,
                }),
            ),
          );
        retiredEffects = result.cancelledEffectCount;
      }
      return {
        terminalizedRuns: runs.length,
        stoppedSessions,
        closedRequests: requests.length,
        retiredEffects,
      };
    },
  );

  const reconcile = (trigger: "startup" | "shutdown") =>
    Effect.gen(function* () {
      const shell = yield* projections
        .getShellSnapshot()
        .pipe(
          Effect.mapError(
            (cause) => new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
          ),
        );
      let terminalizedRuns = 0;
      let stoppedSessions = 0;
      let closedRequests = 0;
      let retiredEffects = 0;
      for (const thread of [...shell.threads, ...shell.archivedThreads]) {
        const projection = yield* projections.getThreadProjection(thread.id).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "read-projections",
                threadId: thread.id,
                cause,
              }),
          ),
        );
        const result = yield* reconcileProjection(projection, { trigger });
        terminalizedRuns += result.terminalizedRuns;
        stoppedSessions += result.stoppedSessions;
        closedRequests += result.closedRequests;
        retiredEffects += result.retiredEffects;
      }
      const outboxReconciliation = yield* outbox.reconcileAfterProcessLoss.pipe(
        Effect.mapError(
          (cause) => new ProviderRuntimeRecoveryError({ operation: "drain-outbox", cause }),
        ),
      );
      return {
        terminalizedRuns,
        stoppedSessions,
        closedRequests,
        retiredEffects: retiredEffects + outboxReconciliation.cancelled,
        requeuedEffects: outboxReconciliation.requeued,
      } satisfies ProviderRuntimeReconciliationSummary;
    });

  const janitorThread = Effect.fn("ProviderRuntimeRecoveryService.janitorThread")(
    function* (input: { readonly threadId: ThreadId; readonly runIds: ReadonlySet<RunId> }) {
      const projection = yield* projections.getThreadProjection(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderRuntimeRecoveryError({
              operation: "read-projections",
              threadId: input.threadId,
              cause,
            }),
        ),
      );
      const result = yield* reconcileProjection(projection, {
        trigger: "janitor",
        runIds: input.runIds,
      });
      return { terminalizedRuns: result.terminalizedRuns };
    },
  );

  const recover = Effect.gen(function* () {
    const reconciliation = yield* reconcile("startup");
    let executedEffects = 0;
    while (
      yield* worker.runOnce.pipe(
        Effect.mapError(
          (cause) => new ProviderRuntimeRecoveryError({ operation: "drain-outbox", cause }),
        ),
      )
    ) {
      executedEffects += 1;
    }
    return { ...reconciliation, executedEffects } satisfies ProviderRuntimeRecoverySummary;
  });

  return ProviderRuntimeRecoveryService.of({ reconcile, janitorThread, recover });
});

export const layer = Layer.effect(ProviderRuntimeRecoveryService, make);
