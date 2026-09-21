import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
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
  "loads startup state without obsolete transcript payloads in %s",
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
        ordinal: 2,
        providerInstanceId: instanceId,
        modelSelection: thread.modelSelection,
        providerThreadId: null,
        userMessageId: messageId,
        rootNodeId: NodeId.make("startup:root"),
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
      const scopeId = CheckpointScopeId.make("startup:shared-scope");
      yield* store.apply({
        id: EventId.make("startup:root-event"),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: run.rootNodeId!,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId: run.rootNodeId!,
          kind: "root_turn",
          status: "pending",
          countsForRun: true,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: scopeId,
          startedAt: null,
          completedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("startup:scope-event"),
        type: "checkpoint-scope.created",
        threadId,
        occurredAt: now,
        payload: {
          id: scopeId,
          threadId,
          runId: RunId.make("run:old"),
          nodeId: NodeId.make("startup:earlier-root"),
          parentScopeId: null,
          providerThreadId: null,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/repo/worktree",
          createdAt: now,
        },
      });
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
      const oldRunId = RunId.make("run:old");
      yield* putRun({ ...run, id: oldRunId, ordinal: 1, status: "completed" });
      const item = {
        id: TurnItemId.make("item:history"),
        threadId,
        runId: oldRunId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed" as const,
        title: "old command",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "command_execution" as const,
        input: "echo history",
        output: "historical result",
      };
      yield* store.apply({
        id: EventId.make("item-event"),
        type: "turn-item.updated",
        threadId,
        runId: oldRunId,
        occurredAt: now,
        payload: item,
      });
      if (storage === "sqlite") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_messages
          (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
          VALUES ('obsolete-history', ${threadId}, NULL, NULL, 'assistant', 0,
            ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            type, status, ordinal, updated_at, payload_json)
          VALUES ('obsolete-tool', ${threadId}, ${oldRunId}, NULL, NULL, NULL,
            'tool_call', 'completed', 2, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
        assert.equal((yield* Effect.exit(store.getThreadProjection(threadId)))._tag, "Failure");
      }
      const context = yield* store.getTurnStartContext(threadId, runId);
      assert.equal(context.thread.id, threadId);
      assert.deepEqual(
        context.checkpointScopes.map((scope) => scope.id),
        [scopeId],
      );
      assert.equal(context.messages.find((m) => m.id === messageId)?.text, "Continue");
      assert.isTrue(context.hasConversation);
      assert.deepEqual(context.turnItems, []);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId), [item]);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, [oldRunId]), [item]);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, [runId]), []);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, []), []);
      for (const text of ["/compact", " \t/COMPACT\n", "\u00a0/compact\u3000"]) {
        yield* store.apply({
          id: EventId.make("compact-input"),
          type: "message.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: { ...message, text },
        });
        assert.isFalse((yield* store.getTurnStartContext(threadId, runId)).hasConversation);
      }
      const marker = {
        ...message,
        id: MessageId.make("old-compact"),
        runId: oldRunId,
        text: "\t/COMPACT\n",
      };
      yield* store.apply({
        id: EventId.make("old-compact-input"),
        type: "message.updated",
        threadId,
        runId: oldRunId,
        occurredAt: now,
        payload: marker,
      });
      assert.include(
        (yield* store.getTurnStartContext(threadId, runId)).messages.map((m) => m.id),
        marker.id,
      );
      const other = ThreadId.make("other");
      yield* putThread({ ...thread, id: other });
      assert.deepEqual((yield* store.getTurnStartContext(other, runId)).messages, []);
      assert.deepEqual(yield* store.getTurnStartHistory(other, [oldRunId]), []);
      assert.isFalse((yield* store.getTurnStartContext(other, runId)).hasConversation);
      assert.instanceOf(
        yield* store.getTurnStartContext(ThreadId.make("missing"), runId).pipe(Effect.flip),
        ProjectionStoreThreadNotFoundError,
      );
    }).pipe(
      Effect.provide(
        storage === "sqlite" ? databaseLayer : Layer.merge(SqlitePersistenceMemory, layerMemory),
      ),
    ),
);
