import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ProjectionStoreV2,
  ProjectionStoreThreadNotFoundError,
  layer,
  layerMemory,
} from "./ProjectionStore.ts";

const databaseLayer = Layer.mergeAll(
  SqlitePersistenceMemory,
  layer.pipe(Layer.provide(SqlitePersistenceMemory)),
);

it.effect.each(["sqlite", "memory"] as const)(
  "checks queue eligibility and delivery ownership without unrelated history in %s",
  (storage) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:completion-reads");
      const runId = RunId.make("run:completion-reads");
      const messageId = MessageId.make("message:completion-reads");
      const instanceId = ProviderInstanceId.make("codex");
      const thread: OrchestrationV2AppThread = {
        id: threadId,
        projectId: ProjectId.make("project:completion-reads"),
        title: "Completion controls",
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "test" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const run: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: thread.modelSelection,
        providerThreadId: null,
        userMessageId: messageId,
        rootNodeId: null,
        activeAttemptId: null,
        status: "queued",
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const putThread = (value: OrchestrationV2AppThread) =>
        store.apply({
          id: EventId.make(`event:thread:${value.id}`),
          type: "thread.created",
          threadId: value.id,
          occurredAt: now,
          payload: value,
        });
      const putRun = (value: OrchestrationV2Run) =>
        store.apply({
          id: EventId.make(`event:run:${value.id}:${value.status}`),
          type: "run.updated",
          threadId,
          runId: value.id,
          occurredAt: now,
          payload: value,
        });
      yield* putThread(thread);
      yield* putRun(run);
      const message = {
        id: messageId,
        threadId,
        runId,
        nodeId: null,
        role: "user" as const,
        text: "Continue",
        attachments: [],
        streaming: false,
        createdBy: "agent" as const,
        creationSource: "server" as const,
        createdAt: now,
        updatedAt: now,
        delegatedCompletion: { parentRunId: RunId.make("parent-run"), generation: 1, taskIds: [] },
      };
      yield* store.apply({
        id: EventId.make("event:input"),
        type: "message.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: message,
      });
      if (storage === "sqlite") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('obsolete-history', ${threadId}, NULL, NULL, 'assistant', 0, ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
        assert.equal((yield* Effect.exit(store.getThreadProjection(threadId)))._tag, "Failure");
      }
      assert.deepEqual(yield* store.getRunMessage(threadId, runId), message);
      assert.isTrue(yield* store.canStartQueuedRun(threadId));
      yield* putRun({ ...run, queueHeld: true });
      assert.isFalse(yield* store.canStartQueuedRun(threadId));
      yield* putRun(run);
      const blocker = { ...run, id: RunId.make("blocker"), ordinal: 2 };
      for (const status of ["preparing", "starting", "running", "waiting"] as const) {
        yield* putRun({ ...blocker, status });
        assert.isFalse(yield* store.canStartQueuedRun(threadId));
      }
      yield* putRun({ ...blocker, status: "completed" });
      assert.isTrue(yield* store.canStartQueuedRun(threadId));
      for (const barrier of ["archivedAt", "deletedAt"] as const) {
        yield* putThread({ ...thread, [barrier]: now });
        assert.isFalse(yield* store.canStartQueuedRun(threadId));
      }
      yield* putThread(thread);
      yield* putRun({ ...run, status: "completed" });
      assert.isFalse(yield* store.canStartQueuedRun(threadId));
      const otherId = ThreadId.make("thread:other");
      yield* putThread({ ...thread, id: otherId });
      assert.isUndefined(yield* store.getRunMessage(otherId, runId));
      assert.isUndefined(yield* store.getRunMessage(threadId, RunId.make("missing-run")));
      const missing = ThreadId.make("missing-thread");
      assert.instanceOf(
        yield* store.canStartQueuedRun(missing).pipe(Effect.flip),
        ProjectionStoreThreadNotFoundError,
      );
      assert.instanceOf(
        yield* store.getRunMessage(missing, runId).pipe(Effect.flip),
        ProjectionStoreThreadNotFoundError,
      );
    }).pipe(
      Effect.provide(
        storage === "sqlite" ? databaseLayer : Layer.merge(SqlitePersistenceMemory, layerMemory),
      ),
    ),
);
