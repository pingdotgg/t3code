import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import delegatedRecoveryIndexes from "../persistence/Migrations/079_DelegatedRecoveryIndexes.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import { restartContinuationRun } from "./RestartContinuation.ts";

const layerTest = Layer.mergeAll(ProjectionStore.layer, EffectOutbox.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerRecoveryTest = ProviderRuntimeRecovery.layer.pipe(
  Layer.provideMerge(
    EventSink.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          EventStore.layer,
          ProjectionStore.layer,
          EffectOutbox.layer,
          IdAllocator.layer,
        ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      ),
    ),
  ),
  Layer.provide(ServerSettings.layerTest()),
);
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const driver = ProviderDriverKind.make("codex");

const createThread = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:recovery:${name}`);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:recovery"),
    title: name,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
  yield* projections.apply({
    id: EventId.make(`event:${threadId}:created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  });
  return threadId;
});

const createRun = Effect.fn(function* (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"],
  overrides: Partial<OrchestrationV2Run> = {},
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const ordinal = overrides.ordinal ?? 1;
  const runId = RunId.make(`run:${threadId}:${ordinal}`);
  yield* projections.apply({
    id: EventId.make(`event:${runId}:created`),
    type: "run.created",
    threadId,
    runId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: now,
      completedAt: status === "completed" ? now : null,
      checkpointId: null,
      contextHandoffId: null,
      ...overrides,
    },
  });
  return runId;
});
















it.effect.each(["startup", "shutdown"] as const)(
  "%s cancels queued buffered wakes and holds durable messages",
  (trigger) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      const now = yield* DateTime.now;
      const bufferedThreads = [] as ThreadId[];
      const durableThreads = [] as ThreadId[];
      for (const kind of ["buffered", "user", "notification", "delegated"] as const) {
        const threadId = yield* createThread(`wake:${trigger}:${kind}`);
        const buffered = kind === "buffered";
        (buffered ? bufferedThreads : durableThreads).push(threadId);
        const messageId = MessageId.make(`message:${threadId}`);
        const runId = yield* createRun(threadId, "queued", {
          userMessageId: messageId,
          startedAt: null,
          queuePosition: 1,
        });
        yield* createRun(threadId, "completed", { ordinal: 2 });
        yield* projections.apply({
          id: EventId.make(`message:${threadId}`),
          type: "message.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: messageId,
            threadId,
            runId,
            nodeId: null,
            role: "user",
            text: "Queued work",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
            createdBy: kind === "user" ? "user" : "agent",
            creationSource: buffered ? "provider" : "server",
            ...(kind === "user" || kind === "delegated"
              ? {}
              : {
                  notification: {
                    source: { kind: "background_task" as const },
                    outcome: "updated" as const,
                    summary: "Background activity updated",
                  },
                }),
            ...(kind === "delegated"
              ? { delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [] } }
              : {}),
          },
        });
      }
      assert.deepEqual(
        new Set(yield* projections.getRecoveryThreadIds("runtime")),
        new Set([...bufferedThreads, ...durableThreads]),
      );
      const summary = yield* recovery.reconcile(trigger);
      assert.equal(summary.terminalizedRuns, 1);
      for (const threadId of bufferedThreads) {
        const projection = yield* projections.getThreadProjection(threadId);
        assert.equal(projection.runs[0]?.status, "cancelled");
        assert.isNotNull(projection.runs[0]?.completedAt);
        assert.isNull(projection.runs[0]?.queuePosition);
        assert.equal(projection.runs[1]?.status, "completed");
      }
      for (const threadId of durableThreads) {
        const projection = yield* projections.getThreadProjection(threadId);
        assert.equal(projection.runs[0]?.status, "queued");
        assert.isTrue(projection.runs[0]?.queueHeld);
      }
      assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
    }).pipe(Effect.provide(layerRecoveryTest)),
);

