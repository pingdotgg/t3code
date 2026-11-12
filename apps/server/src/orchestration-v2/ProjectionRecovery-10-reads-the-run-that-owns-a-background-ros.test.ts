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
















it.effect("reads the run that owns a background roster, not a queued or resumed one", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const withRoster = Effect.fn(function* (threadId: ThreadId) {
      yield* projections.apply({
        id: EventId.make(`event:${threadId}:roster`),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: ProviderThreadId.make(`provider-thread:${threadId}`),
          appThreadId: threadId,
          ownerNodeId: null,
          driver,
          providerInstanceId,
          providerSessionId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          pendingBackgroundTasks: [
            { taskId: "background", description: "Still running", kind: "command" },
          ],
        },
      });
    });
    const runIds = (threadId: ThreadId) =>
      projections
        .getRuntimeRecoveryProjection(threadId)
        .pipe(Effect.map((state) => state.runs.map((run) => run.id)));
    const settled = yield* createThread("roster-before-queue");
    const settledRun = yield* createRun(settled, "completed", {
      providerThreadId: ProviderThreadId.make(`provider-thread:${settled}`),
    });
    const queuedRun = yield* createRun(settled, "queued", { ordinal: 2, completedAt: null });
    yield* withRoster(settled);
    assert.deepEqual(yield* runIds(settled), [settledRun, queuedRun]);
    const resumed = yield* createThread("roster-after-resume");
    const resumedRun = yield* createRun(resumed, "completed", {
      providerThreadId: ProviderThreadId.make(`provider-thread:${resumed}`),
      completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00.000Z"),
    });
    const continuationRun = yield* createRun(resumed, "completed", {
      providerThreadId: ProviderThreadId.make(`provider-thread:${resumed}`),
      ordinal: 2,
      completedAt: DateTime.makeUnsafe("2026-10-03T10:00:00.000Z"),
    });
    yield* withRoster(resumed);
    assert.deepEqual(yield* runIds(resumed), [resumedRun, continuationRun]);
    const quiet = yield* createThread("no-roster-before-queue");
    yield* createRun(quiet, "completed");
    const quietQueued = yield* createRun(quiet, "queued", { ordinal: 2, completedAt: null });
    assert.deepEqual(yield* runIds(quiet), [quietQueued]);
  }).pipe(Effect.provide(layerTest)),
);

