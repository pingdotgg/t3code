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
















it.effect("maintains delegated candidate indexes across legacy rows and payload transitions", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const parent = yield* createThread("index-parent");
    const child = yield* createThread("index-child");
    const run = yield* createRun(child, "completed");
    const rows = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${child}
    `;
    const original = JSON.parse(rows[0]!.payload_json);
    for (const payload of [
      "{broken",
      JSON.stringify({
        ...original,
        lineage: { parentThreadId: parent, relationshipToParent: "subagent" },
        forkedFrom: { type: "provider_thread" },
      }),
      JSON.stringify({
        ...original,
        lineage: { parentThreadId: parent, relationshipToParent: "subagent" },
        forkedFrom: { type: "node", nodeId: "node:index" },
      }),
      JSON.stringify({
        ...original,
        lineage: { parentThreadId: child, relationshipToParent: "subagent" },
        forkedFrom: { type: "node", nodeId: "node:index" },
      }),
      JSON.stringify(original),
    ]) {
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${payload}
        WHERE thread_id = ${child}`;
      const expected = payload.includes('"type":"node"') ? [child] : [];
      assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), expected);
    }
    for (const entry of [
      ["{broken", false],
      ["{}", false],
      ['{"delegatedCompletion":{"delivery":null}}', false],
      ['{"delegatedCompletion":{"delivery":[]}}', false],
      ['{"delegatedCompletion":{"delivery":{}}}', true],
      ["{}", false],
    ] as const) {
      const [payload, included] = entry;
      yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = ${payload}
        WHERE run_id = ${run}`;
      assert.deepEqual(
        yield* projections.getRecoveryThreadIds("delegated-completions"),
        included ? [child] : [],
      );
    }
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{broken'
      WHERE thread_id = ${parent}`;
    yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = '{broken'
      WHERE run_id = ${run}`;
    const existing = yield* createThread("index-existing", {
      lineage: { parentThreadId: child, relationshipToParent: "subagent", rootThreadId: parent },
      forkedFrom: { type: "node", nodeId: NodeId.make("node:index-existing") },
    });
    yield* createRun(existing, "completed", {
      delegatedCompletion: {
        disposition: "open",
        nextGeneration: 2,
        delivery: {
          generation: 1,
          messageId: MessageId.make("message:index-existing"),
          taskIds: [],
        },
      },
    });
    yield* sql`DROP INDEX orchestration_v2_projection_threads_subagent_result_idx`;
    yield* sql`DROP INDEX orchestration_v2_projection_runs_delegated_delivery_idx`;
    yield* delegatedRecoveryIndexes;
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), [existing]);
    assert.deepEqual(yield* projections.getRecoveryThreadIds("delegated-completions"), [existing]);
  }).pipe(Effect.provide(layerTest)),
);

