import { assert, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  CommandId,
  CheckpointId,
  ContextTransferId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2ThreadShellSnapshot,
  NodeId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type ThreadPullRequestLink,
  isLiveSubagentShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  encodeThreadHistoryCursor,
  selectHistoryPageFromCursor,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT,
} from "./threadHistoryPaging.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import { layerReaderDatabase, traceSqlRouting } from "../persistence/testkit/SqliteRouting.ts";

import {
  layerTest,
  modelSelection,
  driver,
  providerInstanceId,
  encodeUnknownJsonString,
  traceSqlStatements,
} from "./ProjectionStore-fixtures.testkit.ts";
import { runForkWindowScenarios, type ForkWindowContext } from "./ProjectionStore-11-keeps-fork-visible-items-stable-after-a-sour-01-part2.testkit.ts";

it.layer(layerTest)("ProjectionStoreV2", (it) => {
  it.effect("keeps fork visible items stable after a source run is rolled back", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:projection-fork-source-rollback");
      const sourceThreadId = ThreadId.make("thread:projection-fork-source-rollback:source");
      const targetThreadId = ThreadId.make("thread:projection-fork-source-rollback:target");
      const sourceProviderThreadId = ProviderThreadId.make(
        "provider-thread:projection-fork-source-rollback:source",
      );
      const targetProviderThreadId = ProviderThreadId.make(
        "provider-thread:projection-fork-source-rollback:target",
      );
      const sourceRun1Id = RunId.make("run:projection-fork-source-rollback:source:1");
      const sourceRun2Id = RunId.make("run:projection-fork-source-rollback:source:2");
      const sourceRun3Id = RunId.make("run:projection-fork-source-rollback:source:3");
      const sourceRun1NodeId = NodeId.make("node:projection-fork-source-rollback:source:1");
      const sourceRun2NodeId = NodeId.make("node:projection-fork-source-rollback:source:2");
      const sourceRun3NodeId = NodeId.make("node:projection-fork-source-rollback:source:3");

      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:source-thread"),
        type: "thread.created",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: sourceThreadId,
          projectId,
          title: "Projection fork source rollback source",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: sourceProviderThreadId,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: sourceThreadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:target-thread"),
        type: "thread.created",
        threadId: targetThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: targetThreadId,
          projectId,
          title: "Projection fork source rollback target",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: targetProviderThreadId,
          lineage: {
            parentThreadId: sourceThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: {
            type: "run",
            threadId: sourceThreadId,
            runId: sourceRun2Id,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });

      for (const [ordinal, runId, nodeId, promptText, responseText] of [
        [1, sourceRun1Id, sourceRun1NodeId, "source one", "one"],
        [2, sourceRun2Id, sourceRun2NodeId, "source two", "two"],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-fork-source-rollback:run-${ordinal}`),
          type: "run.created",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: runId,
            threadId: sourceThreadId,
            ordinal,
            providerInstanceId,
            modelSelection,
            providerThreadId: sourceProviderThreadId,
            userMessageId: MessageId.make(
              `message:projection-fork-source-rollback:user:${ordinal}`,
            ),
            rootNodeId: nodeId,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-fork-source-rollback:user-item-${ordinal}`),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: TurnItemId.make(`turn-item:projection-fork-source-rollback:user:${ordinal}`),
            threadId: sourceThreadId,
            runId,
            nodeId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal * 100,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            messageId: MessageId.make(`message:projection-fork-source-rollback:user:${ordinal}`),
            inputIntent: "turn_start",
            text: promptText,
            attachments: [],
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-fork-source-rollback:assistant-item-${ordinal}`),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`turn-item:projection-fork-source-rollback:assistant:${ordinal}`),
            threadId: sourceThreadId,
            runId,
            nodeId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal * 100 + 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "assistant_message",
            messageId: MessageId.make(
              `message:projection-fork-source-rollback:assistant:${ordinal}`,
            ),
            text: responseText,
            streaming: false,
          },
        });
      }

      const targetBeforeRollback = yield* projectionStore.getThreadProjection(targetThreadId);
      assert.deepEqual(
        targetBeforeRollback.visibleTurnItems.map((row) => row.item.type),
        ["user_message", "assistant_message", "user_message", "assistant_message", "fork"],
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:run-2-rolled-back"),
        type: "run.updated",
        threadId: sourceThreadId,
        runId: sourceRun2Id,
        nodeId: sourceRun2NodeId,
        driver,
        occurredAt: now,
        payload: {
          id: sourceRun2Id,
          threadId: sourceThreadId,
          ordinal: 2,
          providerInstanceId,
          modelSelection,
          providerThreadId: sourceProviderThreadId,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:user:2"),
          rootNodeId: sourceRun2NodeId,
          activeAttemptId: null,
          status: "rolled_back",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const sourceMessages = (yield* projectionStore.getThreadRecords(sourceThreadId, ["messages"]))
        .messages;
      assert.deepEqual(
        sourceMessages,
        (yield* projectionStore.getThreadProjection(sourceThreadId)).messages,
      );
      const targetAfterRollback = yield* projectionStore.getThreadProjection(targetThreadId);
      const shellSnapshot = yield* projectionStore.getShellSnapshot();
      for (const shell of [
        yield* projectionStore.getThreadShell(sourceThreadId),
        shellSnapshot.threads.find((thread) => thread.id === sourceThreadId),
      ]) {
        assert.equal(shell?.itemCount, 2);
      }
      for (const shell of [
        yield* projectionStore.getThreadShell(targetThreadId),
        shellSnapshot.threads.find((thread) => thread.id === targetThreadId),
      ]) {
        assert.equal(shell?.visibleItemCount, targetAfterRollback.visibleTurnItems.length);
      }
      const forwardPage = yield* projectionStore.getTimelinePage(targetThreadId, {
        view: "activity",
        limit: 2,
      });
      assert.deepEqual(forwardPage.items, targetAfterRollback.visibleTurnItems.slice(0, 2));
      assert.equal(forwardPage.totalItems, targetAfterRollback.visibleTurnItems.length);
      assert.isTrue(forwardPage.hasMore);
      const followingPage = yield* projectionStore.getTimelinePage(targetThreadId, {
        view: "activity",
        limit: 10,
        afterPosition: 1,
      });
      assert.deepEqual(followingPage.items, targetAfterRollback.visibleTurnItems.slice(2));
      assert.isFalse(followingPage.hasMore);
      const tracedTimelinePage = (limit: number) =>
        Effect.gen(function* () {
          const { statements, tracer } = traceSqlStatements();
          const page = yield* projectionStore
            .getTimelinePage(targetThreadId, { view: "activity", limit })
            .pipe(Effect.withTracer(tracer));
          return { page, statements };
        });
      const singleItemPage = yield* tracedTimelinePage(1);
      const fullPage = yield* tracedTimelinePage(10);
      assert.deepEqual(fullPage.page.items, targetAfterRollback.visibleTurnItems);
      assert.lengthOf(fullPage.statements, singleItemPage.statements.length);

      assert.deepEqual(
        targetAfterRollback.visibleTurnItems.map((row) => [
          row.visibility,
          row.item.type,
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.text
            : row.item.title,
        ]),
        [
          ["inherited", "user_message", "source one"],
          ["inherited", "assistant_message", "one"],
          ["inherited", "user_message", "source two"],
          ["inherited", "assistant_message", "two"],
          ["synthetic", "fork", "Forked from conversation"],
        ],
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:run-3"),
        type: "run.updated",
        threadId: sourceThreadId,
        runId: sourceRun3Id,
        nodeId: sourceRun3NodeId,
        driver,
        occurredAt: now,
        payload: {
          id: sourceRun3Id,
          threadId: sourceThreadId,
          ordinal: 4,
          providerInstanceId,
          modelSelection,
          providerThreadId: sourceProviderThreadId,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:user:3"),
          rootNodeId: sourceRun3NodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const nowIso = DateTime.formatIso(now);
      for (let index = 0; index < 300; index += 1) {
        const id = `turn-item:projection-fork-source-rollback:post-fork:${index}`;
        const ordinal = index < 10 ? 190 + index : 300 + index;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${sourceThreadId}, ${sourceRun3Id}, ${sourceRun3NodeId},
            ${sourceProviderThreadId}, NULL, NULL, ${ordinal}, 'command_execution',
            'completed', ${nowIso}, ${encodeUnknownJsonString({
              id,
              threadId: sourceThreadId,
              runId: sourceRun3Id,
              nodeId: sourceRun3NodeId,
              providerThreadId: sourceProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "post fork",
              input: "echo later",
              output: "later",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }

      const { statements, tracer } = traceSqlStatements();
      const boundedFork = yield* projectionStore
        .getThreadSnapshotWindow(targetThreadId, { rowLimit: 2 })
        .pipe(Effect.withTracer(tracer));
      assert.lengthOf(
        statements.filter((statement) => statement.includes("WITH RECURSIVE retained")),
        1,
      );
      assert.lengthOf(
        statements.filter((statement) => statement.includes("SELECT node.payload_json")),
        1,
      );
      assert.lengthOf(boundedFork.projection.turnItems, 0);
      assert.deepEqual(
        boundedFork.projection.visibleTurnItems.map((row) => [row.visibility, row.item.type]),
        [
          ["inherited", "user_message"],
          ["inherited", "assistant_message"],
          ["synthetic", "fork"],
        ],
      );
      const parentPage = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 2,
        anchorItemId: TurnItemId.make("turn-item:projection-fork-source-rollback:assistant:1"),
      });
      assert.deepEqual(
        parentPage.projection.visibleTurnItems.map((row) =>
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.text
            : row.item.type,
        ),
        ["source one", "one", "fork"],
      );


      yield* runForkWindowScenarios({
        projectionStore,
        sql,
        now,
        projectId,
        sourceThreadId,
        targetThreadId,
        sourceProviderThreadId,
        targetProviderThreadId,
        sourceRun1Id,
        sourceRun2Id,
      });
    }),
  );
});
