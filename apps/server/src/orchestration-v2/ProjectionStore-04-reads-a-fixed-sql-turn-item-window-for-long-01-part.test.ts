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
import { runSqlTurnWindowScenarios } from "./ProjectionStore-04-reads-a-fixed-sql-turn-item-window-for-long-01-part2.testkit.ts";

it.layer(layerTest)("ProjectionStoreV2", (it) => {
  it.effect("reads a fixed SQL turn-item window for long histories and repeated clients", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:bounded-sql-history");
      yield* projectionStore.apply({
        id: EventId.make("event:bounded-sql-history:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:bounded-sql-history"),
          title: "Bounded SQL history",
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
        },
      });

      for (let ordinal = 1; ordinal <= 1_000; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:${ordinal}`;
        const runId = `run:bounded-sql-history:${ordinal}`;
        const message = ordinal === 1 || ordinal === 1_000;
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status,
            requested_at, completed_at, payload_json
          ) VALUES (
            ${runId}, ${threadId}, ${ordinal}, 'codex', NULL, 'completed', ${nowIso}, ${nowIso},
            ${encodeUnknownJsonString({
              id: runId,
              threadId,
              ordinal,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: `message:bounded-sql-history:${ordinal}`,
              rootNodeId: `node:bounded-sql-history:${ordinal}`,
              activeAttemptId: null,
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
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
            ${message ? "user_message" : "command_execution"}, 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `command ${ordinal}`,
              input: `echo ${ordinal}`,
              output: "ok",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              ...(message
                ? {
                    type: "user_message",
                    createdBy: "user",
                    creationSource: "web",
                    messageId: `message:bounded-sql-history:${ordinal}`,
                    inputIntent: "turn_start",
                    text: `Turn ${ordinal}`,
                    attachments: [],
                  }
                : { type: "command_execution" }),
            })}
          )
        `;
      }

      for (const ordinal of [1, 1_000]) {
        yield* projectionStore.apply({
          id: EventId.make(`event:bounded-sql-history:message:${ordinal}`),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: MessageId.make(`message:bounded-sql-history:${ordinal}`),
            threadId,
            runId: RunId.make(`run:bounded-sql-history:${ordinal}`),
            nodeId: NodeId.make(`node:bounded-sql-history:${ordinal}`),
            role: "user",
            text: `Turn ${ordinal}`,
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });
      }
      const scopeId = CheckpointScopeId.make("scope:bounded-sql-history:root");
      const baselineId = CheckpointId.make("checkpoint:bounded-sql-history:baseline");
      yield* projectionStore.apply({
        id: EventId.make("event:bounded-sql-history:scope"),
        type: "checkpoint-scope.created",
        threadId,
        occurredAt: now,
        payload: {
          id: scopeId,
          threadId,
          runId: RunId.make("run:bounded-sql-history:1000"),
          nodeId: NodeId.make("node:bounded-sql-history:1000"),
          parentScopeId: null,
          providerThreadId: null,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/repo/worktree",
          createdAt: now,
        },
      });
      // A reused root scope can retain its original baseline on a node outside the window.
      yield* projectionStore.apply({
        id: EventId.make("event:bounded-sql-history:baseline"),
        type: "checkpoint.captured",
        threadId,
        occurredAt: now,
        payload: {
          id: baselineId,
          threadId,
          scopeId,
          runId: null,
          nodeId: NodeId.make("node:bounded-sql-history:1"),
          parentCheckpointId: null,
          ordinalWithinScope: 0,
          appRunOrdinal: null,
          ref: CheckpointRef.make("refs/t3/bounded-sql-history/0"),
          status: "ready",
          files: [],
          capturedAt: now,
        },
      });

      const snapshots = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          projectionStore.getThreadSnapshotWindow(threadId, { rowLimit: 76 }),
        ),
        { concurrency: 4 },
      );
      for (const snapshot of snapshots) {
        assert.lengthOf(snapshot.projection.turnItems, 76);
        assert.lengthOf(snapshot.projection.runs, 76);
        assert.lengthOf(snapshot.projection.visibleTurnItems, 76);
        assert.strictEqual(snapshot.projection.turnItems[0]?.ordinal, 925);
        assert.strictEqual(snapshot.projection.turnItems.at(-1)?.ordinal, 1_000);
        assert.deepEqual(
          snapshot.projection.messages.map((message) => message.id),
          [MessageId.make("message:bounded-sql-history:1000")],
        );
        assert.deepEqual(
          snapshot.projection.checkpointScopes.map((scope) => scope.id),
          [scopeId],
        );
        assert.deepEqual(
          snapshot.projection.checkpoints.map((checkpoint) => checkpoint.id),
          [baselineId],
        );
      }
      const humanWindow = () =>
        projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 77,
          userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
        });
      assert.lengthOf(
        (yield* humanWindow()).projection.turnItems,
        THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT,
      );
      // With the newest user turn 1,000 rows back, the window pages from inside it.
      const setNewestTurnType = (type: "command_execution" | "user_message") => sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = ${type}, payload_json = json_set(payload_json, '$.type', ${type})
        WHERE thread_id = ${threadId} AND ordinal = 1000
      `;
      yield* setNewestTurnType("command_execution");
      assert.lengthOf((yield* humanWindow()).projection.turnItems, 77);
      yield* setNewestTurnType("user_message");

      // Fewer than 75 rows still need a byte pass after materializing wire payloads.
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'assistant_message', payload_json = json_set(payload_json,
          '$.type', 'assistant_message', '$.text', ${"x".repeat(40_000)},
          '$.messageId', turn_item_id, '$.streaming', json('false'))
        WHERE thread_id = ${threadId} AND ordinal BETWEEN 2 AND 70
      `;
      const byteCursor = encodeThreadHistoryCursor({
        snapshotSequence: 0,
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:bounded-sql-history:71"),
        position: 70,
      });
      const bytePage = yield* projectionStore.getThreadHistoryPage(threadId, byteCursor);
      assert.isAbove(bytePage.items.length, 0);
      assert.isBelow(bytePage.items.length, 70);
      assert.isAtMost(
        Buffer.byteLength(JSON.stringify(bytePage.items), "utf8"),
        THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes,
      );
      const byteIds = bytePage.items.map((row) => String(row.sourceItemId));
      let byteNext = bytePage.nextCursor;
      for (let pages = 0; byteNext !== null; pages += 1) {
        assert.isBelow(pages, 70);
        const page = yield* projectionStore.getThreadHistoryPage(threadId, byteNext);
        assert.isAbove(page.items.length, 0);
        byteIds.unshift(...page.items.map((row) => String(row.sourceItemId)));
        byteNext = page.nextCursor;
      }
      assert.deepEqual(
        byteIds,
        Array.from({ length: 70 }, (_, index) => `turn-item:bounded-sql-history:${index + 1}`),
      );

      // Selected message reads recover ordinals for only the loaded messages, while 69
      // unloaded assistant messages remain in the thread's history.
      const firstMessageId = MessageId.make("message:bounded-sql-history:1");
      const lastMessageId = MessageId.make("message:bounded-sql-history:1000");
      const insertMessageItem = (
        suffix: string,
        itemThreadId: string,
        ordinal: number,
        messageId: string | null | undefined,
      ) => sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${`turn-item:bounded-sql-history:ordinal-${suffix}`}, ${itemThreadId}, NULL, NULL, NULL,
          NULL, NULL, ${ordinal}, 'assistant_message', 'completed', ${nowIso},
          ${encodeUnknownJsonString({ messageId })}
        )
      `;
      yield* insertMessageItem("duplicate", threadId, 0, lastMessageId);
      yield* insertMessageItem(
        "other-thread",
        "thread:bounded-sql-history:other",
        -1,
        firstMessageId,
      );
      yield* insertMessageItem("null-id", threadId, -2, null);
      yield* insertMessageItem("missing-id", threadId, -3, undefined);
      const readMessageIds = (filter?: ProjectionStore.ProjectionRecordFilter) =>
        projectionStore
          .getThreadRecords(threadId, ["messages"], filter)
          .pipe(Effect.map(({ messages }) => messages.map((message) => message.id)));
      assert.deepEqual(yield* readMessageIds(), [lastMessageId, firstMessageId]);
      assert.deepEqual(yield* readMessageIds({ messageRoles: ["user", "assistant"] }), [
        lastMessageId,
        firstMessageId,
      ]);
      for (const filter of [
        {
          messageIds: [
            firstMessageId,
            lastMessageId,
            MessageId.make("message:bounded-sql-history:absent"),
          ],
        },
        { messageRoles: ["user" as const] },
        {
          messageRunIds: [
            RunId.make("run:bounded-sql-history:1"),
            RunId.make("run:bounded-sql-history:1000"),
          ],
        },
      ]) {
        assert.deepEqual(yield* readMessageIds(filter), [lastMessageId, firstMessageId]);
      }
      assert.deepEqual(yield* readMessageIds({ messageIds: [] }), []);
      assert.deepEqual(yield* readMessageIds({ messageIds: [firstMessageId] }), [firstMessageId]);
      yield* sql`
        DELETE FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id LIKE 'turn-item:bounded-sql-history:ordinal-%'
      `;

      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'command_execution', payload_json = json_set(payload_json, '$.type', 'command_execution')
        WHERE thread_id = ${threadId} AND ordinal BETWEEN 2 AND 70
      `;

      // A targeted page that needs more than 20 human turns must still reach its target
      // after the byte pass re-bounds it.
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'user_message', payload_json = json_set(payload_json,
          '$.type', 'user_message', '$.createdBy', 'user', '$.creationSource', 'web',
          '$.inputIntent', 'turn_start', '$.messageId', turn_item_id, '$.text', 'Turn',
          '$.attachments', json('[]'))
        WHERE thread_id = ${threadId} AND ordinal BETWEEN 600 AND 624
      `;
      const targetedPage = yield* projectionStore.getThreadHistoryPage(
        threadId,
        encodeThreadHistoryCursor({
          snapshotSequence: 0,
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make("turn-item:bounded-sql-history:625"),
          position: 624,
        }),
        "turn-item:bounded-sql-history:600",
      );
      assert.strictEqual(
        String(targetedPage.items[0]?.sourceItemId),
        "turn-item:bounded-sql-history:600",
      );
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'command_execution', payload_json = json_set(payload_json, '$.type', 'command_execution')
        WHERE thread_id = ${threadId} AND ordinal BETWEEN 600 AND 624
      `;

      // A turn split by the row budget keeps an interrupt result's request on the same page.
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET run_id = 'run:bounded-sql-history:500',
          type = CASE ordinal WHEN 500 THEN 'run_interrupt_request' ELSE 'run_interrupt_result' END,
          payload_json = json_set(payload_json,
            '$.runId', 'run:bounded-sql-history:500', '$.message', 'Stop',
            '$.type', CASE ordinal WHEN 500 THEN 'run_interrupt_request' ELSE 'run_interrupt_result' END)
        WHERE thread_id = ${threadId} AND ordinal IN (500, 580)
      `;
      const interruptPage = yield* projectionStore.getThreadHistoryPage(
        threadId,
        encodeThreadHistoryCursor({
          snapshotSequence: 0,
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make("turn-item:bounded-sql-history:590"),
          position: 589,
        }),
      );
      const interruptIds = interruptPage.items.map((row) => String(row.sourceItemId));
      assert.include(interruptIds, "turn-item:bounded-sql-history:580");
      assert.include(interruptIds, "turn-item:bounded-sql-history:500");
      assert.notInclude(interruptIds, "turn-item:bounded-sql-history:501");
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET run_id = 'run:bounded-sql-history:' || ordinal, type = 'command_execution',
          payload_json = json_set(payload_json,
            '$.runId', 'run:bounded-sql-history:' || ordinal, '$.type', 'command_execution')
        WHERE thread_id = ${threadId} AND ordinal IN (500, 580)
      `;

      const retainedRequestPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        WITH selected AS (
          SELECT run_id, type
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId}
          ORDER BY ordinal DESC, turn_item_id DESC
          LIMIT 77
        )
        SELECT request.payload_json
        FROM orchestration_v2_projection_turn_items AS request
        WHERE request.run_id IN (
            SELECT run_id FROM selected
            WHERE type = 'run_interrupt_result' AND run_id IS NOT NULL
          )
          AND request.type = 'run_interrupt_request'
      `;
      assert.isTrue(
        retainedRequestPlan.some((row) =>
          row.detail.includes("orchestration_v2_projection_turn_items_run_ordinal_idx"),
        ),
      );

      const older = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 76,
        anchorItemId: TurnItemId.make("turn-item:bounded-sql-history:925"),
      });
      assert.lengthOf(older.projection.turnItems, 76);
      assert.lengthOf(older.projection.runs, 76);
      assert.strictEqual(older.projection.turnItems[0]?.ordinal, 850);
      assert.strictEqual(older.projection.turnItems.at(-1)?.ordinal, 925);

      const itemId = TurnItemId.make("turn-item:bounded-sql-history:925");
      const stored = yield* projectionStore.getTurnItem({ threadId, itemId });
      assert.strictEqual(stored?.type === "command_execution" ? stored.output : undefined, "ok");
      assert.isNull(
        yield* projectionStore.getTurnItem({ threadId: ThreadId.make("thread:other"), itemId }),
      );

      const sqlPageLimit = THREAD_HISTORY_PAGE_POLICY.maxItems + 2;
      const initialSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
      });
      const initialPage = buildBoundedThreadProjection({
        projection: initialSnapshot.projection,
        snapshotSequence: initialSnapshot.snapshotSequence,
      });
      const loadedIds = initialPage.projection.visibleTurnItems.map((row) =>
        String(row.sourceItemId),
      );
      let cursor = initialPage.historyCursor;
      let pageCount = 1;
      while (cursor !== null) {
        const anchorItemId = TurnItemId.make(decodeThreadHistoryCursor(cursor).si);
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: sqlPageLimit,
          userTurnLimit: 20,
          anchorItemId,
        });
        assert.isAtMost(
          snapshot.projection.visibleTurnItems.length,
          THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT,
        );
        const page = selectHistoryPageFromCursor({
          items: snapshot.projection.visibleTurnItems,
          cursor,
          snapshotSequence: snapshot.snapshotSequence,
        });
        loadedIds.push(...page.items.map((row) => String(row.sourceItemId)));
        pageCount += 1;
        cursor = page.nextCursor;
      }

      assert.isAtLeast(pageCount, 3);
      assert.lengthOf(loadedIds, 1_000);
      assert.strictEqual(new Set(loadedIds).size, 1_000);
      assert.deepEqual(
        loadedIds.toSorted(
          (left, right) => Number(left.split(":").at(-1)) - Number(right.split(":").at(-1)),
        ),
        Array.from({ length: 1_000 }, (_, index) => `turn-item:bounded-sql-history:${index + 1}`),
      );

      yield* setNewestTurnType("command_execution");
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET run_id = 'run:bounded-sql-history:1',
          payload_json = json_set(payload_json, '$.runId', 'run:bounded-sql-history:1')
        WHERE thread_id = ${threadId}
      `;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET ordinal = 1000,
        payload_json = json_set(payload_json, '$.ordinal', 1000)
        WHERE thread_id = ${threadId} AND ordinal = 999`;
      const promptId = TurnItemId.make("turn-item:bounded-sql-history:1");
      const { statements: deferredStatements, tracer: deferredTracer } = traceSqlStatements();
      const deferred = yield* projectionStore
        .getThreadSnapshotWindow(threadId, {
          rowLimit: sqlPageLimit,
          userTurnLimit: 10,
          deferWork: true,
        })
        .pipe(Effect.withTracer(deferredTracer));
      const deferredQuery = deferredStatements.find((statement) =>
        statement.includes("blocked_runs AS MATERIALIZED"),
      );
      assert.isDefined(deferredQuery);
      const deferredPlan = yield* sql.unsafe<{
        readonly id: number;
        readonly parent: number;
        readonly detail: string;
      }>(`EXPLAIN QUERY PLAN ${deferredQuery}`);
      const blockedRunsPlan = deferredPlan.find((row) => row.detail === "MATERIALIZE blocked_runs");
      assert.isDefined(blockedRunsPlan);
      const blockedLookup = deferredPlan.find(
        (row) => row.parent === blockedRunsPlan!.id && row.detail.startsWith("SEARCH "),
      );
      assert.include(blockedLookup?.detail ?? "", "run_id=?");
      assert.lengthOf(deferred.projection.visibleTurnItems, 3);
      assert.strictEqual(deferred.projection.visibleTurnItems[0]?.sourceItemId, promptId);
      const anchor = deferred.projection.visibleTurnItems[1]!;
      assert.strictEqual(anchor.item.deferredWork?.itemCount, 999);
      const workIds = new Set<TurnItemId>();
      let workCursor: string | null = anchor.item.deferredWork!.cursor;
      for (let pages = 0; workCursor !== null; pages += 1) {
        assert.isBelow(pages, 20);
        const page: OrchestrationV2ThreadHistoryPage = yield* projectionStore.getThreadHistoryPage(
          threadId,
          workCursor,
          anchor.sourceItemId,
          false,
          "work",
        );
        assert.isAtMost(page.items.length, 75);
        for (const row of page.items) workIds.add(row.sourceItemId);
        workCursor = page.nextCursor;
      }
      assert.strictEqual(workIds.size, 999);
      for (const toolName of ["t3-code.delegate_task", "mcp__t3_code__delegate_task"]) {
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET type = 'dynamic_tool',
          payload_json = json_set(payload_json, '$.type', 'dynamic_tool', '$.toolName', ${toolName})
          WHERE thread_id = ${threadId} AND ordinal = 2`;
        const window = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: sqlPageLimit,
          userTurnLimit: 10,
          deferWork: true,
        });
        assert.isUndefined(
          window.projection.visibleTurnItems.find((row) => row.item.ordinal === 2)?.item
            .deferredWork,
        );
        assert.strictEqual(
          window.projection.visibleTurnItems.find((row) => row.item.deferredWork)?.item.ordinal,
          3,
        );
        const page = yield* projectionStore.getThreadHistoryPage(
          threadId,
          encodeThreadHistoryCursor({
            snapshotSequence: 0,
            sourceThreadId: threadId,
            sourceItemId: "turn-item:bounded-sql-history:1000",
            position: 1000,
          }),
          undefined,
          false,
          "deferred",
        );
        assert.isUndefined(page.items.find((row) => row.item.ordinal === 2)?.item.deferredWork);
      }
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET type = 'command_execution',
        payload_json = json_set(payload_json, '$.type', 'command_execution') WHERE thread_id = ${threadId} AND ordinal = 2`;
      const sharedRunId = "run:bounded-sql-history:1";
      for (const [ordinal, status] of [
        [0, "completed"],
        [1, "superseded"],
        [2, "running"],
      ] as const) {
        const attempt = {
          id: `attempt:bounded-sql-history:${ordinal}`,
          runId: sharedRunId,
          attemptOrdinal: ordinal + 1,
          rootNodeId: `node:bounded-sql-history:attempt-${ordinal === 0 ? 1 : ordinal}`,
          providerInstanceId,
          providerThreadId: "provider-thread:bounded-sql-history",
          providerTurnId: null,
          reason: ordinal === 1 ? "initial" : "steering_restart",
          status,
          startedAt: nowIso,
          completedAt: status === "superseded" ? nowIso : null,
        };
        yield* sql`INSERT INTO orchestration_v2_projection_run_attempts
          (attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_instance_id, provider_thread_id, provider_turn_id, status, payload_json)
          VALUES (${attempt.id}, ${threadId}, ${sharedRunId}, ${attempt.attemptOrdinal}, ${attempt.rootNodeId}, ${providerInstanceId}, ${providerInstanceId}, ${attempt.providerThreadId}, NULL, ${status}, ${encodeUnknownJsonString(attempt)})`;
      }
      yield* sql`UPDATE orchestration_v2_projection_turn_items
        SET node_id = CASE WHEN ordinal < 990 AND ordinal <> 10 THEN 'node:bounded-sql-history:attempt-1' ELSE 'node:bounded-sql-history:attempt-2' END,
          payload_json = json_set(payload_json, '$.nodeId', CASE WHEN ordinal < 990 AND ordinal <> 10 THEN 'node:bounded-sql-history:attempt-1' ELSE 'node:bounded-sql-history:attempt-2' END)
        WHERE thread_id = ${threadId}`;
      for (const status of ["completed", "running"]) {
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = ${status},
          payload_json = json_set(payload_json, '$.status', ${status}) WHERE run_id = ${sharedRunId}`;
        const window = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: sqlPageLimit,
          userTurnLimit: 10,
          deferWork: true,
        });
        const oldWork = window.projection.visibleTurnItems.find((row) => row.item.deferredWork);
        assert.strictEqual(oldWork?.item.deferredWork?.itemCount, 987);
        let cursor: string | null = oldWork!.item.deferredWork!.cursor;
        const loaded = new Set<TurnItemId>();
        for (let pages = 0; cursor !== null; pages += 1) {
          assert.isBelow(pages, 20);
          const page: OrchestrationV2ThreadHistoryPage =
            yield* projectionStore.getThreadHistoryPage(
              threadId,
              cursor,
              oldWork!.sourceItemId,
              false,
              "work",
            );
          for (const row of page.items) loaded.add(row.sourceItemId);
          cursor = page.nextCursor;
        }
        assert.strictEqual(loaded.size, 987);
        assert.isFalse(loaded.has(TurnItemId.make("turn-item:bounded-sql-history:10")));
      }
      yield* sql`DELETE FROM orchestration_v2_projection_run_attempts WHERE thread_id = ${threadId}`;
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed',
        payload_json = json_set(payload_json, '$.status', 'completed') WHERE run_id = ${sharedRunId}`;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET node_id = NULL,
        payload_json = json_set(payload_json, '$.nodeId', NULL) WHERE thread_id = ${threadId}`;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET run_id = NULL,
        payload_json = json_set(payload_json, '$.runId', NULL)
        WHERE thread_id = ${threadId} AND ordinal > 1 AND ordinal < 851`;
      const inlineWindow = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        userTurnLimit: 10,
        deferWork: true,
      });
      assert.isFalse(inlineWindow.projection.visibleTurnItems.some((row) => row.item.deferredWork));
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET run_id = ${sharedRunId},
        payload_json = json_set(payload_json, '$.runId', ${sharedRunId})
        WHERE thread_id = ${threadId} AND ordinal = 850`;
      const deferredWindow = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        userTurnLimit: 10,
        deferWork: true,
      });
      assert.isTrue(
        deferredWindow.projection.visibleTurnItems.some(
          (row) => row.item.deferredWork?.itemCount === 151,
        ),
      );
      yield* sql`UPDATE orchestration_v2_projection_turn_items
        SET run_id = 'run:bounded-sql-history:1',
          payload_json = json_set(payload_json, '$.runId', 'run:bounded-sql-history:1')
        WHERE thread_id = ${threadId}`;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET ordinal = 999,
        payload_json = json_set(payload_json, '$.ordinal', 999)
        WHERE turn_item_id = 'turn-item:bounded-sql-history:999'`;
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'command_execution', payload_json = json_set(payload_json, '$.type', 'command_execution')
        WHERE thread_id = ${threadId} AND ordinal = 1
      `;
      const backgroundWindow = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        userTurnLimit: 10,
        deferWork: true,
      });
      assert.lengthOf(backgroundWindow.projection.visibleTurnItems, sqlPageLimit);
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'user_message', payload_json = json_set(payload_json, '$.type', 'user_message')
        WHERE thread_id = ${threadId} AND ordinal = 1
      `;
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET run_id = 'run:bounded-sql-history:' || ordinal,
          payload_json = json_set(payload_json, '$.runId', 'run:bounded-sql-history:' || ordinal)
        WHERE thread_id = ${threadId}
      `;
      yield* setNewestTurnType("user_message");

      const tiedIds = [
        TurnItemId.make("turn-item:bounded-sql-history:tie:b"),
        TurnItemId.make("turn-item:bounded-sql-history:tie:a"),
      ];
      for (const id of tiedIds) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          )
          SELECT ${id}, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, 2000, type, status, updated_at,
            json_set(payload_json, '$.id', ${id}, '$.ordinal', 2000)
          FROM orchestration_v2_projection_turn_items
          WHERE turn_item_id = ${itemId}
        `;
      }
      const tied = yield* projectionStore.getThreadSnapshotWindow(threadId, { rowLimit: 3 });
      assert.deepEqual(
        tied.projection.turnItems.map((item) => item.id),
        [TurnItemId.make("turn-item:bounded-sql-history:1000"), tiedIds[1], tiedIds[0]],
      );
      yield* sql`
        DELETE FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id IN ${sql.in(tiedIds)}
      `;


      yield* runSqlTurnWindowScenarios({ projectionStore, sql, threadId, nowIso, sqlPageLimit });
    }),
  );
});
