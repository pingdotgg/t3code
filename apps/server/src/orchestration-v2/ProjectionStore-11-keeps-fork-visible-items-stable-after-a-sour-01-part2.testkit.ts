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
import * as SqlError from "effect/sql/SqlError";
import { layerReaderDatabase, traceSqlRouting } from "../persistence/testkit/SqliteRouting.ts";

import {
  layerTest,
  modelSelection,
  driver,
  providerInstanceId,
  encodeUnknownJsonString,
  traceSqlStatements,
} from "./ProjectionStore-fixtures.testkit.ts";

export interface ForkWindowContext {
  readonly projectionStore: ProjectionStore.ProjectionStoreV2Shape;
  readonly sql: SqlClient.SqlClient;
  readonly now: DateTime.Utc;
  readonly projectId: ProjectId;
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly sourceProviderThreadId: ProviderThreadId;
  readonly targetProviderThreadId: ProviderThreadId;
  readonly sourceRun1Id: RunId;
  readonly sourceRun2Id: RunId;
}

export const runForkWindowScenarios = (
  ctx: ForkWindowContext,
): Effect.Effect<void, SqlError.SqlError | ProjectionStore.ProjectionStoreV2Error, never> =>
  Effect.gen(function* () {
    const {
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
    } = ctx;
    const nowIso = DateTime.formatIso(now);
    const emptyBoundaryRunId = RunId.make(
      "run:projection-fork-source-rollback:source:empty-boundary",
    );
    yield* projectionStore.apply({
      id: EventId.make("event:projection-fork-source-rollback:empty-boundary-run"),
      type: "run.updated",
      threadId: sourceThreadId,
      runId: emptyBoundaryRunId,
      nodeId: NodeId.make("node:projection-fork-source-rollback:source:empty-boundary"),
      driver,
      occurredAt: now,
      payload: {
        id: emptyBoundaryRunId,
        threadId: sourceThreadId,
        ordinal: 3,
        providerInstanceId,
        modelSelection,
        providerThreadId: sourceProviderThreadId,
        userMessageId: MessageId.make(
          "message:projection-fork-source-rollback:user:empty-boundary",
        ),
        rootNodeId: NodeId.make("node:projection-fork-source-rollback:source:empty-boundary"),
        activeAttemptId: null,
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.forkedFrom.runId', ${emptyBoundaryRunId})
      WHERE thread_id = ${targetThreadId}
    `;
    const emptyBoundaryFork = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
      rowLimit: 2,
    });
    assert.deepEqual(
      emptyBoundaryFork.projection.visibleTurnItems.map((row) =>
        row.item.type === "user_message" || row.item.type === "assistant_message"
          ? row.item.text
          : row.item.type,
      ),
      ["source two", "two", "fork"],
    );
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.forkedFrom.runId', ${sourceRun2Id})
      WHERE thread_id = ${targetThreadId}
    `;

    const targetRunId = RunId.make("run:projection-fork-source-rollback:target:1");
    const targetNodeId = NodeId.make("node:projection-fork-source-rollback:target:1");
    yield* projectionStore.apply({
      id: EventId.make("event:projection-fork-source-rollback:target-run"),
      type: "run.updated",
      threadId: targetThreadId,
      runId: targetRunId,
      nodeId: targetNodeId,
      driver,
      occurredAt: now,
      payload: {
        id: targetRunId,
        threadId: targetThreadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: targetProviderThreadId,
        userMessageId: MessageId.make("message:projection-fork-source-rollback:target:1"),
        rootNodeId: targetNodeId,
        activeAttemptId: null,
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    for (let ordinal = 1; ordinal <= 102; ordinal += 1) {
      const id = `turn-item:projection-fork-source-rollback:target:${ordinal}`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${id}, ${targetThreadId}, ${targetRunId}, ${targetNodeId}, ${targetProviderThreadId},
          NULL, NULL, ${ordinal}, 'command_execution', 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            id,
            threadId: targetThreadId,
            runId: targetRunId,
            nodeId: targetNodeId,
            providerThreadId: targetProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: `target ${ordinal}`,
            input: `echo target ${ordinal}`,
            output: "target",
            exitCode: 0,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "command_execution",
          })}
        )
      `;
    }
    const nestedThreadId = ThreadId.make("thread:projection-fork-source-rollback:nested");
    for (const ordinal of [
      ...Array.from({ length: 99 }, (_, index) => index + 1),
      ...Array.from({ length: 99 }, (_, index) => index + 101),
    ]) {
      const runId = ordinal < 100 ? sourceRun1Id : sourceRun2Id;
      const id = `turn-item:projection-fork-source-rollback:lineage:${ordinal}`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${id}, ${sourceThreadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
          'command_execution', 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            id,
            threadId: sourceThreadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: `lineage ${ordinal}`,
            input: "echo lineage",
            output: "lineage",
            exitCode: 0,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "command_execution",
          })}
        )
      `;
    }
    const inheritedSupersededNodeId = NodeId.make(
      "node:projection-fork-source-rollback:inherited-superseded",
    );
    yield* sql`
      INSERT INTO orchestration_v2_projection_run_attempts (
        attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
        provider_instance_id, provider_thread_id, provider_turn_id, status, payload_json
      ) VALUES (
        'attempt:projection-fork-source-rollback:inherited-superseded',
        ${sourceThreadId}, ${sourceRun2Id}, 2, ${inheritedSupersededNodeId}, 'codex',
        ${providerInstanceId}, ${sourceProviderThreadId}, NULL, 'superseded',
        ${encodeUnknownJsonString({
          id: "attempt:projection-fork-source-rollback:inherited-superseded",
          runId: sourceRun2Id,
          attemptOrdinal: 2,
          rootNodeId: inheritedSupersededNodeId,
          providerInstanceId,
          providerThreadId: sourceProviderThreadId,
          providerTurnId: null,
          reason: "retry",
          status: "superseded",
          startedAt: nowIso,
          completedAt: nowIso,
        })}
      )
    `;
    for (let ordinal = 201; ordinal <= 300; ordinal += 1) {
      const id = `turn-item:projection-fork-source-rollback:hidden-interrupt:${ordinal}`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${id}, ${sourceThreadId}, ${sourceRun2Id}, ${inheritedSupersededNodeId},
          ${sourceProviderThreadId}, NULL, NULL, ${ordinal}, 'run_interrupt_result',
          'completed', ${nowIso},
          ${encodeUnknownJsonString({
            id,
            threadId: sourceThreadId,
            runId: sourceRun2Id,
            nodeId: inheritedSupersededNodeId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: "Stopped",
            message: "Stopped",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "run_interrupt_result",
          })}
        )
      `;
    }
    yield* projectionStore.apply({
      id: EventId.make("event:projection-fork-source-rollback:nested-thread"),
      type: "thread.created",
      threadId: nestedThreadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: nestedThreadId,
        projectId,
        title: "Nested bounded fork",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: targetThreadId,
          relationshipToParent: "fork",
          rootThreadId: sourceThreadId,
        },
        forkedFrom: { type: "run", threadId: targetThreadId, runId: targetRunId },
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    const boundedNested = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
      rowLimit: 2,
    });
    assert.deepEqual(
      boundedNested.projection.visibleTurnItems.map((row) => row.item.type),
      [
        "user_message",
        "assistant_message",
        "fork",
        "command_execution",
        "command_execution",
        "fork",
      ],
    );

    const nestedInitial = buildBoundedThreadProjection({
      policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
      projection: yield* projectionStore
        .getThreadSnapshotWindow(nestedThreadId, {
          rowLimit: THREAD_HISTORY_PAGE_POLICY.maxItems + 2,
        })
        .pipe(Effect.map((snapshot) => snapshot.projection)),
      snapshotSequence: 1,
    });
    const expectedNestedIds = (yield* projectionStore.getThreadProjection(
      nestedThreadId,
    )).visibleTurnItems.map((row) => String(row.sourceItemId));
    const nestedIds = nestedInitial.projection.visibleTurnItems.map((row) =>
      String(row.sourceItemId),
    );
    let nestedCursor = nestedInitial.historyCursor;
    let nestedPages = 1;
    while (nestedCursor !== null) {
      const decoded = decodeThreadHistoryCursor(nestedCursor);
      const snapshot = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
        rowLimit: THREAD_HISTORY_PAGE_POLICY.maxItems + 2,
        anchorItemId: TurnItemId.make(decoded.si),
        anchorThreadId: ThreadId.make(decoded.st),
      });
      const page = selectHistoryPageFromCursor({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        items: snapshot.projection.visibleTurnItems,
        cursor: nestedCursor,
        snapshotSequence: snapshot.snapshotSequence,
      });
      nestedIds.unshift(...page.items.map((row) => String(row.sourceItemId)));
      nestedCursor = page.nextCursor;
      nestedPages += 1;
    }
    assert.isAtLeast(nestedPages, 3);
    assert.lengthOf(nestedIds, expectedNestedIds.length);
    assert.deepEqual(nestedIds, expectedNestedIds);

    const nestedTurnWindow = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
      rowLimit: 77,
      userTurnLimit: 10,
    });
    const nestedTurnPage = buildBoundedThreadProjection({
      projection: nestedTurnWindow.projection,
      snapshotSequence: 1,
    });
    const turnPagedIds = nestedTurnPage.projection.visibleTurnItems.map((row) =>
      String(row.sourceItemId),
    );
    let turnCursor = nestedTurnPage.historyCursor;
    while (turnCursor !== null) {
      const anchor = decodeThreadHistoryCursor(turnCursor);
      const snapshot = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
        rowLimit: 77,
        userTurnLimit: 20,
        anchorItemId: TurnItemId.make(anchor.si),
        anchorThreadId: ThreadId.make(anchor.st),
      });
      const page = selectHistoryPageFromCursor({
        items: snapshot.projection.visibleTurnItems,
        cursor: turnCursor,
        snapshotSequence: 1,
      });
      turnPagedIds.unshift(...page.items.map((row) => String(row.sourceItemId)));
      turnCursor = page.nextCursor;
    }
    assert.deepEqual(turnPagedIds, expectedNestedIds);
    const fullNested = yield* projectionStore.getThreadProjection(nestedThreadId);
    const nestedForward = yield* projectionStore.getTimelinePage(nestedThreadId, {
      view: "activity",
      limit: expectedNestedIds.length + 1,
    });
    assert.deepEqual(nestedForward.items, fullNested.visibleTurnItems);
    const messagePage = yield* projectionStore.getTimelinePage(nestedThreadId, {
      view: "messages",
      limit: 2,
    });
    assert.deepEqual(
      messagePage.items,
      fullNested.visibleTurnItems
        .filter((row) =>
          ["user_message", "assistant_message", "proposed_plan"].includes(row.item.type),
        )
        .slice(0, 2),
    );

    const emptyMiddleThreadId = ThreadId.make(
      "thread:projection-fork-source-rollback:empty-middle",
    );
    const emptyMiddleRunId = RunId.make("run:projection-fork-source-rollback:empty-middle");
    yield* projectionStore.apply({
      id: EventId.make("event:projection-fork-source-rollback:empty-middle-thread"),
      type: "thread.created",
      threadId: emptyMiddleThreadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: emptyMiddleThreadId,
        projectId,
        title: "Empty middle fork",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: sourceThreadId,
          relationshipToParent: "fork",
          rootThreadId: sourceThreadId,
        },
        forkedFrom: { type: "run", threadId: sourceThreadId, runId: sourceRun2Id },
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
      id: EventId.make("event:projection-fork-source-rollback:empty-middle-run"),
      type: "run.updated",
      threadId: emptyMiddleThreadId,
      runId: emptyMiddleRunId,
      nodeId: NodeId.make("node:projection-fork-source-rollback:empty-middle"),
      driver,
      occurredAt: now,
      payload: {
        id: emptyMiddleRunId,
        threadId: emptyMiddleThreadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:projection-fork-source-rollback:empty-middle"),
        rootNodeId: NodeId.make("node:projection-fork-source-rollback:empty-middle"),
        activeAttemptId: null,
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    const emptyLeafThreadId = ThreadId.make("thread:projection-fork-source-rollback:empty-leaf");
    yield* projectionStore.apply({
      id: EventId.make("event:projection-fork-source-rollback:empty-leaf-thread"),
      type: "thread.created",
      threadId: emptyLeafThreadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: emptyLeafThreadId,
        projectId,
        title: "Leaf after empty fork",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: emptyMiddleThreadId,
          relationshipToParent: "fork",
          rootThreadId: sourceThreadId,
        },
        forkedFrom: {
          type: "run",
          threadId: emptyMiddleThreadId,
          runId: emptyMiddleRunId,
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
    const emptyMiddleSnapshot = yield* projectionStore.getThreadSnapshotWindow(
      emptyLeafThreadId,
      { rowLimit: 2 },
    );
    assert.deepEqual(
      emptyMiddleSnapshot.projection.visibleTurnItems.map((row) => [
        row.sourceThreadId,
        row.item.type,
      ]),
      [
        [sourceThreadId, "user_message"],
        [sourceThreadId, "assistant_message"],
        [sourceThreadId, "fork"],
        [emptyMiddleThreadId, "fork"],
      ],
    );

    yield* sql`
      DELETE FROM orchestration_v2_projection_turn_items
      WHERE run_id IN (${sourceRun1Id}, ${sourceRun2Id})
    `;
    const importedItemId = "turn-item:projection-fork-source-rollback:legacy-import";
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
        parent_item_id, ordinal, type, status, updated_at, payload_json
      ) VALUES (
        ${importedItemId}, ${sourceThreadId}, NULL, NULL, NULL, NULL, NULL, 50,
        'assistant_message', 'completed', ${nowIso}, ${encodeUnknownJsonString({
          id: importedItemId,
          threadId: sourceThreadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 50,
          status: "completed",
          title: null,
          startedAt: nowIso,
          completedAt: nowIso,
          updatedAt: nowIso,
          type: "assistant_message",
          messageId: MessageId.make("message:projection-fork-source-rollback:legacy-import"),
          text: "legacy import before empty fork",
          streaming: false,
          historyOrigin: "v1_import",
        })}
      )
    `;
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.historyOrigin', 'v1_import')
      WHERE thread_id = ${sourceThreadId}
    `;
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.forkedFrom.runId', ${emptyBoundaryRunId})
      WHERE thread_id = ${targetThreadId}
    `;
    const importedEmptyBoundary = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
      rowLimit: 2,
    });
    assert.deepEqual(
      importedEmptyBoundary.projection.visibleTurnItems.map((row) => [
        row.visibility,
        row.sourceThreadId,
        row.item.type === "assistant_message" ? row.item.text : row.item.type,
      ]),
      [
        ["inherited", sourceThreadId, "legacy import before empty fork"],
        ["synthetic", sourceThreadId, "fork"],
        ["local", targetThreadId, "command_execution"],
        ["local", targetThreadId, "command_execution"],
      ],
    );
  });
