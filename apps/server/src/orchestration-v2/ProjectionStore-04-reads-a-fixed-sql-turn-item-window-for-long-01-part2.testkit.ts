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
  providerInstanceId,
  encodeUnknownJsonString,
  traceSqlStatements,
} from "./ProjectionStore-fixtures.testkit.ts";

import * as SqlError from "effect/sql/SqlError";

export interface SqlTurnWindowContext {
  readonly projectionStore: ProjectionStore.ProjectionStoreV2Shape;
  readonly sql: SqlClient.SqlClient;
  readonly threadId: ThreadId;
  readonly nowIso: string;
  readonly sqlPageLimit: number;
}

export const runSqlTurnWindowScenarios = (
  ctx: SqlTurnWindowContext,
): Effect.Effect<void, SqlError.SqlError | ProjectionStore.ProjectionStoreV2Error, never> =>
  Effect.gen(function* () {
    const { projectionStore, sql, threadId, nowIso, sqlPageLimit } = ctx;
    const hiddenRunId = RunId.make("run:bounded-sql-history:hidden-suffix");
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, provider_thread_id, status,
        requested_at, completed_at, payload_json
      ) VALUES (
        ${hiddenRunId}, ${threadId}, 1001, 'codex', NULL, 'rolled_back', ${nowIso}, ${nowIso},
        ${encodeUnknownJsonString({
          id: hiddenRunId,
          threadId,
          ordinal: 1001,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: "message:bounded-sql-history:hidden-suffix",
          rootNodeId: "node:bounded-sql-history:hidden-suffix",
          activeAttemptId: null,
          status: "rolled_back",
          requestedAt: nowIso,
          startedAt: nowIso,
          completedAt: nowIso,
          checkpointId: null,
          contextHandoffId: null,
        })}
      )
    `;
    for (let ordinal = 1_001; ordinal <= 1_100; ordinal += 1) {
      const id = `turn-item:bounded-sql-history:hidden:${ordinal}`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${id}, ${threadId}, ${hiddenRunId}, NULL, NULL, NULL, NULL, ${ordinal},
          'command_execution', 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            id,
            threadId,
            runId: hiddenRunId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: "rolled back",
            input: "echo hidden",
            output: "hidden",
            exitCode: 0,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "command_execution",
          })}
        )
      `;
    }

    const hiddenSuffixSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
      rowLimit: sqlPageLimit,
    });
    const hiddenSuffixPage = buildBoundedThreadProjection({
      policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
      projection: hiddenSuffixSnapshot.projection,
      snapshotSequence: hiddenSuffixSnapshot.snapshotSequence,
    });
    assert.lengthOf(hiddenSuffixPage.projection.visibleTurnItems, 75);
    assert.strictEqual(hiddenSuffixPage.latestLocalTurnOrdinal, 1_100);
    assert.isTrue(hiddenSuffixPage.hasMoreHistory);
    assert.isFalse(
      hiddenSuffixPage.projection.visibleTurnItems.some((row) =>
        String(row.sourceItemId).includes(":hidden:"),
      ),
    );
    const hiddenSuffixCursor = hiddenSuffixPage.historyCursor;
    assert.isNotNull(hiddenSuffixCursor);
    const hiddenSuffixAnchor = TurnItemId.make(decodeThreadHistoryCursor(hiddenSuffixCursor!).si);
    const hiddenSuffixOlderSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
      rowLimit: sqlPageLimit,
      anchorItemId: hiddenSuffixAnchor,
    });
    const hiddenSuffixOlderPage = selectHistoryPageFromCursor({
      policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
      items: hiddenSuffixOlderSnapshot.projection.visibleTurnItems,
      cursor: hiddenSuffixCursor!,
      snapshotSequence: hiddenSuffixOlderSnapshot.snapshotSequence,
    });
    assert.lengthOf(hiddenSuffixOlderPage.items, 75);
    assert.isTrue(hiddenSuffixOlderPage.hasMoreHistory);

    const cancelledRunId = RunId.make("run:bounded-sql-history:cancelled-suffix");
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, provider_thread_id, status,
        requested_at, completed_at, payload_json
      ) VALUES (
        ${cancelledRunId}, ${threadId}, 1002, 'codex', NULL, 'cancelled', ${nowIso}, ${nowIso},
        ${encodeUnknownJsonString({
          id: cancelledRunId,
          threadId,
          ordinal: 1002,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: "message:bounded-sql-history:cancelled-suffix",
          rootNodeId: "node:bounded-sql-history:cancelled-suffix",
          activeAttemptId: null,
          status: "cancelled",
          requestedAt: nowIso,
          startedAt: nowIso,
          completedAt: nowIso,
          checkpointId: null,
          contextHandoffId: null,
        })}
      )
    `;
    for (let ordinal = 1_101; ordinal <= 1_200; ordinal += 1) {
      const id = `turn-item:bounded-sql-history:cancelled:${ordinal}`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${id}, ${threadId}, ${cancelledRunId}, NULL, NULL, NULL, NULL, ${ordinal},
          'user_message', 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            createdBy: "user",
            creationSource: "web",
            id,
            threadId,
            runId: cancelledRunId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: "cancelled queued message",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "user_message",
            messageId: `message:bounded-sql-history:cancelled:${ordinal}`,
            inputIntent: "queued_turn",
            text: "cancelled",
            attachments: [],
          })}
        )
      `;
    }
    const runlessQueuedId = "turn-item:bounded-sql-history:runless-queued";
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
        parent_item_id, ordinal, type, status, updated_at, payload_json
      ) VALUES (
        ${runlessQueuedId}, ${threadId}, NULL, NULL, NULL, NULL, NULL, 1201,
        'user_message', 'completed', ${nowIso},
        ${encodeUnknownJsonString({
          createdBy: "user",
          creationSource: "web",
          id: runlessQueuedId,
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1201,
          status: "completed",
          title: "runless queued message",
          startedAt: nowIso,
          completedAt: nowIso,
          updatedAt: nowIso,
          type: "user_message",
          messageId: "message:bounded-sql-history:runless-queued",
          inputIntent: "queued_turn",
          text: "still visible",
          attachments: [],
        })}
      )
    `;
    const laterCancelledId = "turn-item:bounded-sql-history:cancelled:1202";
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
        parent_item_id, ordinal, type, status, updated_at, payload_json
      ) VALUES (
        ${laterCancelledId}, ${threadId}, ${cancelledRunId}, NULL, NULL, NULL, NULL, 1202,
        'user_message', 'completed', ${nowIso},
        ${encodeUnknownJsonString({
          createdBy: "user",
          creationSource: "web",
          id: laterCancelledId,
          threadId,
          runId: cancelledRunId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1202,
          status: "completed",
          title: "later cancelled queued message",
          startedAt: nowIso,
          completedAt: nowIso,
          updatedAt: nowIso,
          type: "user_message",
          messageId: "message:bounded-sql-history:cancelled:1202",
          inputIntent: "queued_turn",
          text: "cancelled",
          attachments: [],
        })}
      )
    `;
    const cancelledSuffixSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
      rowLimit: sqlPageLimit,
    });
    const cancelledSuffixPage = buildBoundedThreadProjection({
      policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
      projection: cancelledSuffixSnapshot.projection,
      snapshotSequence: cancelledSuffixSnapshot.snapshotSequence,
    });
    assert.strictEqual(cancelledSuffixPage.latestLocalTurnOrdinal, 1_202);
    assert.lengthOf(cancelledSuffixPage.projection.visibleTurnItems, 75);
    assert.isFalse(
      cancelledSuffixPage.projection.visibleTurnItems.some((row) =>
        String(row.sourceItemId).includes(":cancelled:"),
      ),
    );
    assert.isTrue(
      cancelledSuffixPage.projection.visibleTurnItems.some(
        (row) => row.sourceItemId === runlessQueuedId,
      ),
    );

    const interruptRunId = RunId.make("run:bounded-sql-history:interrupt");
    const interruptNodeId = NodeId.make("node:bounded-sql-history:interrupt");
    const interruptRequestId = TurnItemId.make("turn-item:bounded-sql-history:interrupt-request");
    const interruptResultId = TurnItemId.make("turn-item:bounded-sql-history:interrupt-result");
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, provider_thread_id, status,
        requested_at, completed_at, payload_json
      ) VALUES (
        ${interruptRunId}, ${threadId}, 1003, 'codex', 'provider-thread:interrupt', 'completed',
        ${nowIso}, ${nowIso},
        ${encodeUnknownJsonString({
          id: interruptRunId,
          threadId,
          ordinal: 1003,
          providerInstanceId,
          modelSelection,
          providerThreadId: "provider-thread:interrupt",
          userMessageId: "message:interrupt",
          rootNodeId: interruptNodeId,
          activeAttemptId: "attempt:bounded-sql-history:interrupt",
          status: "completed",
          requestedAt: nowIso,
          startedAt: nowIso,
          completedAt: nowIso,
          checkpointId: null,
          contextHandoffId: null,
        })}
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_run_attempts (
        attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
        provider_instance_id, provider_thread_id, provider_turn_id, status, payload_json
      ) VALUES (
        'attempt:bounded-sql-history:interrupt', ${threadId}, ${interruptRunId}, 1,
        ${interruptNodeId}, 'codex', ${providerInstanceId}, 'provider-thread:interrupt', NULL,
        'superseded',
        ${encodeUnknownJsonString({
          id: "attempt:bounded-sql-history:interrupt",
          runId: interruptRunId,
          attemptOrdinal: 1,
          rootNodeId: interruptNodeId,
          providerInstanceId,
          providerThreadId: "provider-thread:interrupt",
          providerTurnId: null,
          reason: "initial",
          status: "superseded",
          startedAt: nowIso,
          completedAt: nowIso,
        })}
      )
    `;
    const insertInterruptItem = (input: {
      id: TurnItemId;
      ordinal: number;
      type: "run_interrupt_request" | "run_interrupt_result";
    }) => sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
        parent_item_id, ordinal, type, status, updated_at, payload_json
      ) VALUES (
        ${input.id}, ${threadId}, ${interruptRunId}, ${interruptNodeId}, NULL, NULL, NULL,
        ${input.ordinal}, ${input.type}, 'completed', ${nowIso},
        ${encodeUnknownJsonString({
          id: input.id,
          threadId,
          runId: interruptRunId,
          nodeId: interruptNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: input.ordinal,
          status: "completed",
          title: input.type,
          message: input.type === "run_interrupt_request" ? "Stopping" : "Stopped",
          startedAt: nowIso,
          completedAt: nowIso,
          updatedAt: nowIso,
          type: input.type,
        })}
      )
    `;
    yield* insertInterruptItem({
      id: interruptRequestId,
      ordinal: 1_201,
      type: "run_interrupt_request",
    });
    for (let ordinal = 1_202; ordinal <= 1_281; ordinal += 1) {
      const id = `turn-item:bounded-sql-history:interrupt-filler:${ordinal}`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${id}, ${threadId}, NULL, NULL, NULL, NULL, NULL, ${ordinal},
          'command_execution', 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            id,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: "filler",
            input: "echo filler",
            output: "ok",
            exitCode: 0,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "command_execution",
          })}
        )
      `;
    }
    yield* insertInterruptItem({
      id: interruptResultId,
      ordinal: 1_282,
      type: "run_interrupt_result",
    });

    const interruptSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
      rowLimit: sqlPageLimit,
    });
    assert.isTrue(
      interruptSnapshot.projection.turnItems.some((item) => item.id === interruptRequestId),
    );
    assert.isTrue(
      interruptSnapshot.projection.visibleTurnItems.some(
        (row) => row.sourceItemId === interruptResultId,
      ),
    );

    yield* sql`
      UPDATE orchestration_v2_projection_turn_items
      SET payload_json = json_set(payload_json, '$.createdBy', 'agent')
      WHERE thread_id = ${threadId} AND type = 'user_message'
    `;
    const agentPromptId = TurnItemId.make("turn-item:bounded-sql-history:interrupt-filler:1281");
    yield* sql`
      UPDATE orchestration_v2_projection_turn_items
      SET type = 'user_message',
        payload_json = json_set(payload_json,
          '$.type', 'user_message', '$.inputIntent', 'turn_start',
          '$.createdBy', 'agent', '$.creationSource', 'provider',
          '$.messageId', 'message:bounded-sql-history:agent-prompt',
          '$.text', 'Continue the child task', '$.attachments', json('[]'))
      WHERE turn_item_id = ${agentPromptId}
    `;
    const agentWindow = yield* projectionStore.getThreadSnapshotWindow(threadId, {
      rowLimit: sqlPageLimit,
      userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
    });
    assert.lengthOf(
      agentWindow.projection.visibleTurnItems.filter(
        (row) => row.item.type !== "run_interrupt_request",
      ),
      sqlPageLimit,
    );
    assert.isTrue(
      agentWindow.projection.visibleTurnItems.some((row) => row.sourceItemId === agentPromptId),
    );
  });
