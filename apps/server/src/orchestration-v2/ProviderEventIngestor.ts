import {
  NodeId,
  CommandId,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type RuntimeMode,
  type ProviderInteractionMode,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RawEventId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/sql/SqlError";

import { AgentScope } from "@t3tools/shared/AgentScope";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue, modelSelectionsEqual } from "@t3tools/shared/model";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailureTurnItem } from "@t3tools/provider-core/server/failure";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { stripUnservedToolOutputImageBytes } from "./toolOutputImageBytes.ts";
import { boundFileChangeForStorage } from "./WireProjection.ts";

export class ProviderEventNormalizeError extends Schema.TaggedError<ProviderEventNormalizeError>()(
  "ProviderEventNormalizeError",
  {
    providerSessionId: ProviderSessionId,
    threadId: ThreadId,
    providerEvent: ProviderAdapter.ProviderAdapterV2Event,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to normalize provider event ${this.providerEvent.type} for thread ${this.threadId}.`;
  }
}

export class ProviderEventPublishError extends Schema.TaggedError<ProviderEventPublishError>()(
  "ProviderEventPublishError",
  {
    providerSessionId: ProviderSessionId,
    eventCount: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to publish ${this.eventCount} normalized provider event(s).`;
  }
}

// A write that outlasts busy_timeout at BEGIN IMMEDIATE fails before anything
// commits, and the sink publishes only after a commit, so repeating the whole
// write is safe. Failing it would fail the run over a brief lock.
const isLockTimeout = (error: EventSink.EventSinkV2Error) =>
  SqlError.isSqlError(error.cause) && error.cause.reason._tag === "LockTimeoutError";
const retryLockTimeout = <A, R>(write: Effect.Effect<A, EventSink.EventSinkV2Error, R>) =>
  Effect.retry(write, { while: isLockTimeout, times: 2 });

export const ProviderEventIngestorV2Error = Schema.Union([
  ProviderEventNormalizeError,
  ProviderEventPublishError,
]);
export type ProviderEventIngestorV2Error = typeof ProviderEventIngestorV2Error.Type;

export interface ProviderTurnAnalyticsContext {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly origin?: ProviderTurnOrigin;
}

/**
 * Where the run's starting message came from. Most turns start without a
 * person (provider continuations, agent sends, delegated subagents), so
 * reports need this to tell user turns apart.
 */
export interface ProviderTurnOrigin {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  readonly scheduled: boolean;
  readonly subagent: boolean;
}

export class ProviderTurnAnalytics extends Context.Reference<{
  readonly record: (properties: Readonly<Record<string, unknown>>) => Effect.Effect<void>;
}>("t3/orchestration-v2/ProviderTurnAnalytics", {
  defaultValue: () => ({ record: () => Effect.void }),
}) {}

export const layerAnalytics = Layer.effect(
  ProviderTurnAnalytics,
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService.AnalyticsService;
    return {
      record: (properties: Readonly<Record<string, unknown>>) =>
        analytics.record("provider.turn.completed", properties),
    };
  }),
);

function providerTurnAnalyticsProperties(input: {
  readonly driver: ProviderAdapter.ProviderAdapterV2Event["driver"];
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly context?: ProviderTurnAnalyticsContext;
}): Readonly<Record<string, unknown>> {
  const usage = input.providerTurn.turnTokenUsage;
  const modelSelection = input.context?.modelSelection;
  const effort = modelSelection
    ? (getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
      getModelSelectionStringOptionValue(modelSelection, "effort"))
    : undefined;
  return {
    provider: input.driver,
    terminalStatus: input.providerTurn.status,
    usageStatus: usage?.usageStatus ?? "unavailable",
    usageScope: usage?.usageScope ?? "main_agent",
    ...(usage ? { hasSubagents: usage.hasSubagents } : {}),
    ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage?.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage?.cacheCreationTokens === undefined
      ? {}
      : { cacheCreationTokens: usage.cacheCreationTokens }),
    ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage?.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(modelSelection ? { model: modelSelection.model, mixedModels: false } : {}),
    ...(effort ? { effort } : {}),
    ...(input.context?.runtimeMode ? { runtimeMode: input.context.runtimeMode } : {}),
    ...(input.context?.interactionMode ? { interactionMode: input.context.interactionMode } : {}),
    ...input.context?.origin,
    ...(input.providerTurn.startedAt && input.providerTurn.completedAt
      ? {
          durationMs: Math.max(
            0,
            DateTime.toEpochMillis(input.providerTurn.completedAt) -
              DateTime.toEpochMillis(input.providerTurn.startedAt),
          ),
        }
      : {}),
  };
}

type TodoListPlan = Extract<OrchestrationV2PlanArtifact, { readonly kind: "todo_list" }>;

function withPlanStepDurations(
  plan: TodoListPlan,
  previous: TodoListPlan | undefined,
  occurredAt: DateTime.Utc,
): TodoListPlan {
  const occurredAtIso = DateTime.formatIso(occurredAt);
  const occurredAtMs = DateTime.toEpochMillis(occurredAt);
  const previousById = new Map(previous?.steps.map((step) => [step.id, step]));
  // Provider step IDs may be positional. Changed text must not inherit another task's timing.
  const previousStep = (step: TodoListPlan["steps"][number]) => {
    const prior = previousById.get(step.id);
    return prior?.text === step.text ? prior : undefined;
  };
  const hasNewCompletion = plan.steps.some((step) => {
    const prior = previousStep(step);
    return step.status === "completed" && prior?.status !== "completed";
  });
  let fallbackCompletionConsumed = false;

  return {
    ...plan,
    steps: plan.steps.map((step) => {
      const prior = previousStep(step);
      const baseStep = { id: step.id, text: step.text, status: step.status };
      if (step.status === "completed") {
        if (prior?.status === "completed") {
          return {
            ...baseStep,
            ...(prior.durationMs === undefined ? {} : { durationMs: prior.durationMs }),
          };
        }
        const durationAnchorAt =
          prior?.status === "running" || !fallbackCompletionConsumed
            ? prior?.durationAnchorAt
            : occurredAtIso;
        fallbackCompletionConsumed = true;
        const anchorMs =
          durationAnchorAt === undefined ? occurredAtMs : Date.parse(durationAnchorAt);
        const durationMs = Number.isFinite(anchorMs) ? Math.max(0, occurredAtMs - anchorMs) : 0;
        return {
          ...baseStep,
          ...(durationMs > 0 ? { durationMs } : {}),
        };
      }
      if (step.status === "running") {
        return {
          ...baseStep,
          durationAnchorAt:
            prior?.status === "running" ? (prior.durationAnchorAt ?? occurredAtIso) : occurredAtIso,
        };
      }
      return {
        ...baseStep,
        durationAnchorAt:
          hasNewCompletion || prior?.status !== "pending"
            ? occurredAtIso
            : (prior.durationAnchorAt ?? occurredAtIso),
      };
    }),
  };
}

const CONVERSATION_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "interrupted",
  "failed",
]);

function runsOffNativeBranch(input: {
  readonly projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">;
  readonly providerThreadId: ProviderThreadId;
  readonly retainedNativeTurnIds: ReadonlySet<string>;
  readonly reportingRunId: RunId | undefined;
}): ReadonlyArray<OrchestrationV2Run> {
  const { attempts, providerTurns, runs } = input.projection;
  const nativeTurnId = (run: OrchestrationV2Run) => {
    const attempt = attempts.find((candidate) => candidate.id === run.activeAttemptId);
    if (attempt === undefined) return null;
    const ref = providerTurns.find(
      (turn) => turn.id === attempt.providerTurnId || turn.runAttemptId === attempt.id,
    )?.nativeTurnRef;
    return ref?.strength === "strong" ? ref.nativeId : null;
  };
  const settled = runs.flatMap((run) =>
    run.providerThreadId === input.providerThreadId &&
    run.id !== input.reportingRunId &&
    CONVERSATION_RUN_STATUSES.has(run.status)
      ? [{ run, nativeTurnId: nativeTurnId(run) }]
      : [],
  );
  const lastRetainedOrdinal = settled.reduce(
    (last, { run, nativeTurnId }) =>
      nativeTurnId !== null && input.retainedNativeTurnIds.has(nativeTurnId)
        ? Math.max(last, run.ordinal)
        : last,
    0,
  );
  return settled
    .filter(({ run, nativeTurnId }) =>
      nativeTurnId === null
        ? run.ordinal > lastRetainedOrdinal
        : !input.retainedNativeTurnIds.has(nativeTurnId),
    )
    .map(({ run }) => run);
}

export interface ProviderEventIngestInput {
  readonly providerSessionId: ProviderSessionId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly commandId?: CommandId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly nodeId?: NodeId;
  readonly rawEventId?: RawEventId;
  readonly event: ProviderAdapter.ProviderAdapterV2Event;
  readonly analyticsContext?: ProviderTurnAnalyticsContext;
}

export interface ProviderEventIngestorV2Shape {
  readonly normalize: (
    input: ProviderEventIngestInput,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2DomainEvent>, ProviderEventIngestorV2Error>;
  readonly ingestNormalized: (
    input: ProviderEventIngestInput & {
      readonly writeIfRunCurrent?: {
        readonly runId: RunId;
        readonly activeAttemptId: RunAttemptId;
        readonly expectedStatus: OrchestrationV2Run["status"];
      };
      readonly writeIfProviderThreadOwner?: {
        readonly providerThreadId: ProviderThreadId;
        readonly runId: RunId;
        readonly activeAttemptId: RunAttemptId;
        readonly expectedLastRunOrdinal: number;
      };
    },
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, ProviderEventIngestorV2Error>;
}

export class ProviderEventIngestorV2 extends Context.Service<
  ProviderEventIngestorV2,
  ProviderEventIngestorV2Shape
>()("t3/orchestration-v2/ProviderEventIngestor/ProviderEventIngestorV2") {}

function compactUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

const decodeDomainEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEvent);

export const layer: Layer.Layer<
  ProviderEventIngestorV2,
  never,
  | EventSink.EventSinkV2
  | GitVcsDriver.GitVcsDriver
  | IdAllocator.IdAllocatorV2
  | ProjectionStore.ProjectionStoreV2
  | ThreadCommandExecutor.ThreadCommandExecutor
> = Layer.effect(
  ProviderEventIngestorV2,
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const analytics = yield* ProviderTurnAnalytics;
    const agentScope = yield* AgentScope;
    const completedTurnAnalytics = new Set<string>();

    const makeDomainEvent =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (
        input: ProviderEventIngestInput,
        payloadInput: {
          readonly type: OrchestrationV2DomainEvent["type"];
          readonly payload: OrchestrationV2DomainEvent["payload"];
          readonly threadId?: ThreadId;
          readonly runId?: RunId | null;
          readonly nodeId?: NodeId | null;
          readonly occurredAt?: DateTime.Utc;
        },
      ) {
        const threadId = payloadInput.threadId ?? input.threadId;
        const eventId = yield* idAllocator.allocate.event({
          threadId,
          providerSessionId: input.providerSessionId,
        });
        const occurredAt = payloadInput.occurredAt ?? (yield* DateTime.now);
        return yield* decodeDomainEvent(
          compactUndefined({
            id: eventId,
            type: payloadInput.type,
            threadId,
            runId: payloadInput.runId ?? input.runId,
            nodeId: payloadInput.nodeId ?? input.nodeId,
            driver: input.event.driver,
            providerInstanceId: input.providerInstanceId,
            rawEventId: input.rawEventId,
            occurredAt,
            payload: payloadInput.payload,
          }),
        );
      });

    const dismissNativeUserInputs = Effect.fn("ProviderEventIngestor.dismissNativeUserInputs")(
      function* (
        input: ProviderEventIngestInput,
        providerTurnId: ProviderTurnId,
        threadId = input.threadId,
      ) {
        const pending = yield* projections.getPendingNativeUserInputs(threadId, providerTurnId);
        const now = yield* DateTime.now;
        const events: Array<OrchestrationV2DomainEvent> = [];
        for (const request of pending.runtimeRequests) {
          events.push(
            yield* makeDomainEvent(input, {
              type: "runtime-request.updated",
              threadId,
              nodeId: request.nodeId,
              payload: { ...request, status: "cancelled", resolvedAt: now },
            }),
          );
        }
        for (const node of pending.nodes) {
          events.push(
            yield* makeDomainEvent(input, {
              type: "node.updated",
              threadId,
              nodeId: node.id,
              runId: node.runId,
              payload: { ...node, status: "cancelled", completedAt: now },
            }),
          );
        }
        for (const item of pending.turnItems) {
          events.push(
            yield* makeDomainEvent(input, {
              type: "turn-item.updated",
              threadId,
              nodeId: item.nodeId,
              runId: item.runId,
              payload: { ...item, status: "cancelled", completedAt: now, updatedAt: now },
            }),
          );
        }
        return events;
      },
    );

    /** Providers may reveal native subagent models late; lock full-row updates against concurrent thread commands. */
    const syncSubagentThreadModel = Effect.fn("ProviderEventIngestor.syncSubagentThreadModel")(
      function* (input: ProviderEventIngestInput, subagent: OrchestrationV2Subagent) {
        const { childThreadId, model } = subagent;
        if (
          subagent.origin !== "provider_native" ||
          childThreadId === null ||
          (model === null && subagent.modelSelection === undefined)
        ) {
          return [];
        }
        const reportedSelection = ({ modelSelection }: { modelSelection: ModelSelection }) =>
          subagent.modelSelection ??
          (model === null || model === modelSelection.model
            ? modelSelection
            : { instanceId: modelSelection.instanceId, model });
        const staleThread = projections.getThread(childThreadId).pipe(
          Effect.map((thread) =>
            modelSelectionsEqual(thread.modelSelection, reportedSelection(thread)) ? null : thread,
          ),
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
        );
        if ((yield* staleThread) === null) return [];
        return yield* threadCommands.withLock(
          childThreadId,
          Effect.gen(function* () {
            const thread = yield* staleThread;
            if (thread === null) return [];
            const now = yield* DateTime.now;
            const event = yield* makeDomainEvent(input, {
              type: "thread.model-selection-updated",
              threadId: thread.id,
              payload: {
                ...thread,
                modelSelection: reportedSelection(thread),
                updatedAt: now,
              },
              occurredAt: now,
            });
            return yield* eventSink.write({ events: [event] }).pipe(retryLockTimeout);
          }),
        );
      },
    );

    /** Retire rewound runs like CheckpointRollbackService; retain the reporting run and its lastRunOrdinal. */
    const rollBackRewoundRuns = Effect.fn("ProviderEventIngestor.rollBackRewoundRuns")(function* (
      input: ProviderEventIngestInput,
      rewind: {
        readonly threadId: ThreadId;
        readonly providerThreadId: ProviderThreadId;
        readonly retainedNativeTurnIds: ReadonlySet<string>;
      },
    ) {
      const projection = yield* projections.getThreadRecords(rewind.threadId, [
        "runs",
        "attempts",
        "providerTurns",
        "nodes",
        "checkpoints",
      ]);
      const runs = runsOffNativeBranch({
        projection,
        providerThreadId: rewind.providerThreadId,
        retainedNativeTurnIds: rewind.retainedNativeTurnIds,
        reportingRunId: input.runId,
      });
      if (runs.length === 0) return [];
      const now = yield* DateTime.now;
      const eventId = () =>
        idAllocator.allocate.event({
          threadId: rewind.threadId,
          providerSessionId: input.providerSessionId,
        });
      const runIds = new Set(runs.map((run) => run.id));
      const events: Array<OrchestrationV2DomainEvent> = [];
      for (const checkpoint of projection.checkpoints) {
        if (checkpoint.status !== "ready" || checkpoint.runId === null) continue;
        if (!runIds.has(checkpoint.runId)) continue;
        events.push({
          id: yield* eventId(),
          type: "checkpoint.captured",
          threadId: rewind.threadId,
          runId: checkpoint.runId,
          nodeId: checkpoint.nodeId,
          providerInstanceId: input.providerInstanceId,
          occurredAt: now,
          payload: { ...checkpoint, status: "stale" },
        });
      }
      for (const run of runs) {
        const rootNode = projection.nodes.find((node) => node.id === run.rootNodeId);
        events.push({
          id: yield* eventId(),
          type: "run.updated",
          threadId: rewind.threadId,
          runId: run.id,
          ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, status: "rolled_back", completedAt: now },
        });
        if (rootNode !== undefined) {
          events.push({
            id: yield* eventId(),
            type: "node.updated",
            threadId: rewind.threadId,
            runId: run.id,
            nodeId: rootNode.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...rootNode, status: "rolled_back", completedAt: now },
          });
        }
      }
      return events;
    });

    const normalize: ProviderEventIngestorV2Shape["normalize"] =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(
        function* (input) {
          switch (input.event.type) {
            case "app_thread.created": {
              const offered = input.event.appThread;
              const existing = yield* projections.getThread(offered.id).pipe(
                Effect.catchTags({
                  ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
                }),
              );
              if (
                existing !== null &&
                (input.event.createOnly === true ||
                  (existing.title === offered.title &&
                    modelSelectionsEqual(existing.modelSelection, offered.modelSelection)))
              )
                return [];
              const now = yield* DateTime.now;
              return [
                yield* makeDomainEvent(input, {
                  type: existing === null ? "thread.created" : "thread.metadata-updated",
                  threadId: offered.id,
                  payload:
                    existing === null
                      ? offered
                      : {
                          ...existing,
                          title: offered.title,
                          modelSelection: offered.modelSelection,
                          updatedAt: now,
                        },
                  occurredAt: now,
                }),
              ];
            }
            case "provider_session.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "provider-session.updated",
                  payload: input.event.providerSession,
                }),
              ];
            case "provider_thread.updated": {
              const threadId = input.event.providerThread.appThreadId ?? input.threadId;
              const updated = yield* makeDomainEvent(input, {
                type: "provider-thread.updated",
                threadId,
                payload: input.event.providerThread,
              });
              return input.event.retainedNativeTurnIds === undefined
                ? [updated]
                : [
                    updated,
                    ...(yield* rollBackRewoundRuns(input, {
                      threadId,
                      providerThreadId: input.event.providerThread.id,
                      retainedNativeTurnIds: new Set(input.event.retainedNativeTurnIds),
                    })),
                  ];
            }
            case "provider_turn.updated":
              return [
                ...(["completed", "interrupted", "failed", "cancelled"].includes(
                  input.event.providerTurn.status,
                )
                  ? yield* dismissNativeUserInputs(
                      input,
                      input.event.providerTurn.id,
                      input.event.threadId,
                    )
                  : []),
                yield* makeDomainEvent(input, {
                  type: "provider-turn.updated",
                  ...(input.event.threadId === undefined ? {} : { threadId: input.event.threadId }),
                  payload: input.event.providerTurn,
                  nodeId: input.event.providerTurn.nodeId,
                }),
              ];
            case "node.updated":
              // Adapters send an unchanged node again with each text delta. Compare with the
              // stored node, not the last one sent, because the server also writes nodes.
              if (yield* projections.isNodeStored(input.event.node)) return [];
              return [
                yield* makeDomainEvent(input, {
                  type: "node.updated",
                  threadId: input.event.node.threadId,
                  payload: input.event.node,
                  runId: input.event.node.runId,
                  nodeId: input.event.node.id,
                }),
              ];
            case "subagent.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "subagent.updated",
                  threadId: input.event.subagent.threadId,
                  payload: input.event.subagent,
                  runId: input.event.subagent.runId,
                  nodeId: input.event.subagent.id,
                }),
              ];
            case "message.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "message.updated",
                  threadId: input.event.message.threadId,
                  payload: input.event.message,
                  runId: input.event.message.runId,
                  nodeId: input.event.message.nodeId,
                }),
              ];
            case "turn_item.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "turn-item.updated",
                  threadId: input.event.turnItem.threadId,
                  payload: boundFileChangeForStorage(
                    stripUnservedToolOutputImageBytes(input.event.turnItem),
                  ),
                  runId: input.event.turnItem.runId,
                  nodeId: input.event.turnItem.nodeId,
                }),
              ];
            case "runtime_request.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "runtime-request.updated",
                  ...(input.event.threadId === undefined ? {} : { threadId: input.event.threadId }),
                  payload: input.event.runtimeRequest,
                  nodeId: input.event.runtimeRequest.nodeId,
                }),
              ];
            case "plan.updated": {
              const occurredAt = yield* DateTime.now;
              const plan = input.event.plan;
              const previous =
                plan.kind === "todo_list"
                  ? yield* projections.getPlan(plan.threadId, plan.id)
                  : undefined;
              const payload =
                plan.kind === "todo_list"
                  ? withPlanStepDurations(
                      plan,
                      previous?.kind === "todo_list" ? previous : undefined,
                      occurredAt,
                    )
                  : plan;
              return [
                yield* makeDomainEvent(input, {
                  type: "plan.updated",
                  threadId: plan.threadId,
                  payload,
                  runId: plan.runId,
                  nodeId: plan.nodeId,
                  occurredAt,
                }),
              ];
            }
            case "command_output.delta":
              // Live output is routed to the command output hub before ingestion.
              return [];
            case "turn.terminal":
              const dismissed = yield* dismissNativeUserInputs(input, input.event.providerTurnId);
              if (input.event.status !== "failed") {
                return dismissed;
              }
              const occurredAt = yield* DateTime.now;
              const failure = (yield* agentScope.oomKilled(input.threadId))
                ? { ...input.event.failure, message: "Killed: out of memory.", code: "oom_kill" }
                : input.event.failure;
              return [
                ...dismissed,
                yield* makeDomainEvent(input, {
                  type: "turn-item.updated",
                  payload: makeProviderFailureTurnItem({
                    driver: input.event.driver,
                    threadId: input.threadId,
                    runId: input.runId ?? null,
                    nodeId: input.nodeId ?? null,
                    providerThreadId: input.event.providerThreadId,
                    providerTurnId: input.event.providerTurnId,
                    itemOrdinal: input.event.failureItemOrdinal,
                    failure,
                    ...(input.event.retry === undefined ? {} : { retry: input.event.retry }),
                    ...(input.event.retryStartedAt === undefined
                      ? {}
                      : { retryStartedAt: input.event.retryStartedAt }),
                    occurredAt,
                  }),
                }),
              ];
          }
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderEventNormalizeError({
                  providerSessionId: input.providerSessionId,
                  threadId: input.threadId,
                  providerEvent: input.event,
                  cause,
                }),
            ),
          ),
      );

    return ProviderEventIngestorV2.of({
      normalize,
      ingestNormalized:
        /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
        Effect.fnUntraced(
          function* (input) {
            const events = yield* normalize(input);
            if (events.length === 0) {
              return [];
            }
            const mapWriteError = (cause: unknown) =>
              new ProviderEventPublishError({
                providerSessionId: input.providerSessionId,
                eventCount: events.length,
                cause,
              });
            if (input.writeIfProviderThreadOwner !== undefined) {
              const ownerResult = yield* eventSink
                .writeIfProviderThreadOwner({
                  guardPendingUserInputCancellations: true,
                  ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                  ...input.writeIfProviderThreadOwner,
                  events,
                })
                .pipe(retryLockTimeout, Effect.mapError(mapWriteError));
              return ownerResult.storedEvents;
            }
            if (input.writeIfRunCurrent === undefined) {
              return yield* eventSink
                .write({
                  guardPendingUserInputCancellations: true,
                  ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                  events,
                })
                .pipe(retryLockTimeout, Effect.mapError(mapWriteError));
            }
            const result = yield* eventSink
              .writeIfRunCurrent({
                guardPendingUserInputCancellations: true,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                threadId: input.threadId,
                ...input.writeIfRunCurrent,
                events,
              })
              .pipe(retryLockTimeout, Effect.mapError(mapWriteError));
            return result.storedEvents;
          },
          (effect, input) =>
            effect.pipe(
              Effect.flatMap((storedEvents) =>
                Effect.gen(function* () {
                  if (input.event.type !== "app_thread.created") return storedEvents;
                  const created = storedEvents.find(
                    (stored) => stored.event.type === "thread.created",
                  );
                  if (created?.event.type !== "thread.created") return storedEvents;
                  const child = created.event.payload;
                  if (
                    child.worktreePath === null ||
                    child.branch === null ||
                    !isTemporaryWorktreeBranch(child.branch)
                  )
                    return storedEvents;
                  // Git renames before scanning committed threads. If that scan missed this
                  // creation, HEAD already has the new name, even if the parent moved away.
                  const branch = yield* git.resolveBranchName(child.worktreePath, "HEAD");
                  if (branch === null || branch === child.branch) return storedEvents;
                  const now = yield* DateTime.now;
                  const event = yield* makeDomainEvent(input, {
                    type: "thread.metadata-updated",
                    threadId: child.id,
                    payload: { ...child, branch, updatedAt: now },
                    occurredAt: now,
                  });
                  const synced = yield* eventSink.write({ events: [event] });
                  return [...storedEvents, ...synced];
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Native thread worktree branch recheck failed", {
                      threadId:
                        input.event.type === "app_thread.created"
                          ? input.event.appThread.id
                          : input.threadId,
                      cause,
                    }).pipe(Effect.as(storedEvents)),
                  ),
                ),
              ),
              // @effect-diagnostics-next-line flatMapConditionalToFilterOrFail:off - The predicate narrows the captured event for the subagent update.
              Effect.flatMap((storedEvents) =>
                storedEvents.length === 0 || input.event.type !== "subagent.updated"
                  ? Effect.succeed(storedEvents)
                  : syncSubagentThreadModel(input, input.event.subagent).pipe(
                      Effect.map((synced) => [...storedEvents, ...synced]),
                      Effect.mapError(
                        (cause) =>
                          new ProviderEventPublishError({
                            providerSessionId: input.providerSessionId,
                            eventCount: 1,
                            cause,
                          }),
                      ),
                    ),
              ),
              Effect.tap((storedEvents) =>
                Effect.gen(function* () {
                  if (storedEvents.length === 0 || input.event.type !== "provider_turn.updated")
                    return;
                  const providerTurn = input.event.providerTurn;
                  if (
                    providerTurn.status !== "completed" &&
                    providerTurn.status !== "failed" &&
                    providerTurn.status !== "interrupted" &&
                    providerTurn.status !== "cancelled"
                  )
                    return;
                  const key = `${input.providerInstanceId}:${providerTurn.id}`;
                  if (completedTurnAnalytics.has(key)) return;
                  completedTurnAnalytics.add(key);
                  if (completedTurnAnalytics.size > 4096) {
                    const oldest = completedTurnAnalytics.values().next().value;
                    if (oldest !== undefined) completedTurnAnalytics.delete(oldest);
                  }
                  yield* analytics.record(
                    providerTurnAnalyticsProperties({
                      driver: input.event.driver,
                      providerTurn,
                      ...(input.analyticsContext === undefined
                        ? {}
                        : { context: input.analyticsContext }),
                    }),
                  );
                }),
              ),
              (effect) =>
                input.event.type === "app_thread.created"
                  ? threadCommands.withLock(input.event.appThread.id, effect)
                  : effect,
            ),
        ),
    });
  }),
);
