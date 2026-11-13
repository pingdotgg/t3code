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

it.layer(layerTest)("ProjectionStoreV2", (it) => {
  it.effect("reads a run's turn-start items by thread and run, not by walking thread history", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:turn-start-items");
      const otherThreadId = ThreadId.make("thread:turn-start-items:other");
      const selectedRunId = RunId.make("run:turn-start-items:selected");
      const emptyRunId = RunId.make("run:turn-start-items:empty");
      const siblingRunId = RunId.make("run:turn-start-items:sibling");

      for (const id of [threadId, otherThreadId]) {
        yield* projectionStore.apply({
          id: EventId.make(`event:${id}:created`),
          type: "thread.created",
          threadId: id,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id,
            projectId: ProjectId.make("project:turn-start-items"),
            title: id,
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
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
      }
      for (const [ordinal, runId] of [selectedRunId, emptyRunId, siblingRunId].entries()) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status,
            requested_at, completed_at, payload_json
          ) VALUES (
            ${runId}, ${threadId}, ${ordinal + 1}, 'codex', NULL, 'completed', ${nowIso}, ${nowIso},
            ${encodeUnknownJsonString({
              id: runId,
              threadId,
              ordinal: ordinal + 1,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: `message:${runId}`,
              rootNodeId: `node:${runId}`,
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
      }

      const insertItem = (
        id: string,
        itemThreadId: ThreadId,
        runId: string | null,
        ordinal: number,
      ) =>
        sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${itemThreadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId: itemThreadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: id,
              input: "echo",
              output: "ok",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      const addHistory = (from: number, to: number) => sql`
        WITH RECURSIVE history(position) AS (
          SELECT ${from} UNION ALL SELECT position + 1 FROM history WHERE position < ${to}
        )
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        )
        SELECT 'item:turn-start-items:history:' || position, ${threadId},
          'run:turn-start-items:history:' || (position % 100), NULL, NULL, NULL, NULL, position,
          'command_execution', 'completed', ${nowIso},
          json_object(
            'id', 'item:turn-start-items:history:' || position,
            'threadId', ${threadId},
            'runId', 'run:turn-start-items:history:' || (position % 100),
            'nodeId', NULL, 'providerThreadId', NULL, 'providerTurnId', NULL,
            'nativeItemRef', NULL, 'parentItemId', NULL, 'ordinal', position,
            'status', 'completed', 'title', 'history', 'input', 'echo', 'output', 'ok',
            'exitCode', 0, 'startedAt', ${nowIso}, 'completedAt', ${nowIso},
            'updatedAt', ${nowIso}, 'type', 'command_execution'
          )
        FROM history
      `;

      // Twelve ordinals with two items each, inserted in reverse id order.
      const selectedIds: Array<string> = [];
      for (let slot = 1; slot <= 12; slot += 1) {
        for (const suffix of ["b", "a"]) {
          yield* insertItem(
            `item:turn-start-items:selected:${String(slot).padStart(2, "0")}:${suffix}`,
            threadId,
            selectedRunId,
            slot * 100,
          );
        }
        selectedIds.push(
          `item:turn-start-items:selected:${String(slot).padStart(2, "0")}:a`,
          `item:turn-start-items:selected:${String(slot).padStart(2, "0")}:b`,
        );
      }
      yield* insertItem("item:turn-start-items:no-run", threadId, null, 100);
      yield* insertItem("item:turn-start-items:sibling:1", threadId, siblingRunId, 100);
      yield* insertItem("item:turn-start-items:sibling:2", threadId, siblingRunId, 101);
      yield* insertItem("item:turn-start-items:other-thread:b", otherThreadId, selectedRunId, 100);
      yield* insertItem("item:turn-start-items:other-thread:a", otherThreadId, selectedRunId, 100);

      const readItems = Effect.fn("readTurnStartItems")(function* (
        readThreadId: ThreadId,
        readRunId: RunId,
      ) {
        const { statements, tracer } = traceSqlStatements();
        const context = yield* projectionStore
          .getTurnStartContext(readThreadId, readRunId)
          .pipe(Effect.withTracer(tracer));
        const lookups = statements.filter((statement) =>
          statement.includes("FROM orchestration_v2_projection_turn_items"),
        );
        assert.lengthOf(lookups, 1);
        const plan = (yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${lookups[0]}`,
          [readThreadId, readRunId],
        )).map((row) => row.detail);
        return { ids: context.turnItems.map((item) => item.id), plan };
      });

      const lookupPlans: Array<ReadonlyArray<string>> = [];
      for (const [from, to] of [
        [1, 1_000],
        [1_001, 10_000],
      ] as const) {
        yield* addHistory(from, to);
        const { ids, plan } = yield* readItems(threadId, selectedRunId);
        assert.deepEqual(ids, selectedIds);
        lookupPlans.push(plan);
      }

      assert.deepEqual((yield* readItems(threadId, emptyRunId)).ids, []);
      assert.deepEqual(
        (yield* readItems(threadId, RunId.make("run:turn-start-items:missing"))).ids,
        [],
      );
      assert.deepEqual((yield* readItems(threadId, siblingRunId)).ids, [
        "item:turn-start-items:sibling:1",
        "item:turn-start-items:sibling:2",
      ]);
      assert.deepEqual((yield* readItems(otherThreadId, selectedRunId)).ids, [
        "item:turn-start-items:other-thread:a",
        "item:turn-start-items:other-thread:b",
      ]);
      assert.deepEqual((yield* readItems(otherThreadId, siblingRunId)).ids, []);

      for (const plan of lookupPlans) {
        const lookup = plan.filter((detail) =>
          detail.includes("orchestration_v2_projection_turn_items"),
        );
        assert.lengthOf(lookup, 1);
        assert.match(
          lookup[0]!,
          /^SEARCH .*\((?:thread_id=\? AND )?run_id=\?(?: AND thread_id=\?)?\)$/,
        );
      }
    }),
  );
  it.effect(
    "counts each shell's own runless and live-run items, skipping rolled back and missing runs",
    () =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const projectId = ProjectId.make("project:shell-item-counts");
        const busyThreadId = ThreadId.make("thread:shell-item-counts:busy");
        const emptyThreadId = ThreadId.make("thread:shell-item-counts:empty");
        const otherThreadId = ThreadId.make("thread:shell-item-counts:other");
        for (const threadId of [busyThreadId, emptyThreadId, otherThreadId]) {
          yield* projectionStore.apply({
            id: EventId.make(`event:${threadId}:created`),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId,
              title: threadId,
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
        }
        const applyRun = (
          threadId: ThreadId,
          suffix: string,
          ordinal: number,
          rolledBack: boolean,
        ) => {
          const runId = RunId.make(`run:shell-item-counts:${suffix}`);
          const rootNodeId = NodeId.make(`node:shell-item-counts:${suffix}`);
          return projectionStore
            .apply({
              id: EventId.make(`event:shell-item-counts:${suffix}:run`),
              type: "run.created",
              threadId,
              runId,
              nodeId: rootNodeId,
              driver,
              occurredAt: now,
              payload: {
                id: runId,
                threadId,
                ordinal,
                providerInstanceId,
                modelSelection,
                providerThreadId: null,
                userMessageId: MessageId.make(`message:shell-item-counts:${suffix}:user`),
                rootNodeId,
                activeAttemptId: null,
                status: rolledBack ? "rolled_back" : "completed",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            })
            .pipe(Effect.as(runId));
        };
        let ordinal = 0;
        const applyItem = (threadId: ThreadId, runId: RunId | null) => {
          ordinal += 1;
          return projectionStore.apply({
            id: EventId.make(`event:shell-item-counts:item:${ordinal}`),
            type: "turn-item.updated",
            threadId,
            ...(runId === null ? {} : { runId }),
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`turn-item:shell-item-counts:${ordinal}`),
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "assistant_message",
              messageId: MessageId.make(`message:shell-item-counts:${ordinal}`),
              text: `item ${ordinal}`,
              streaming: false,
            },
          });
        };

        const completedRunId = yield* applyRun(busyThreadId, "busy-completed", 1, false);
        const rolledBackRunId = yield* applyRun(busyThreadId, "busy-rolled-back", 2, true);
        const otherRunId = yield* applyRun(otherThreadId, "other", 1, false);
        yield* applyItem(busyThreadId, null);
        yield* applyItem(busyThreadId, null);
        yield* applyItem(busyThreadId, completedRunId);
        yield* applyItem(busyThreadId, completedRunId);
        yield* applyItem(busyThreadId, rolledBackRunId);
        yield* applyItem(busyThreadId, RunId.make("run:shell-item-counts:missing"));
        yield* applyItem(otherThreadId, otherRunId);

        const snapshot = yield* projectionStore.getShellSnapshot({ projectId });
        const expected = [
          [busyThreadId, 4],
          [emptyThreadId, 0],
          [otherThreadId, 1],
        ] as const;
        for (const [threadId, itemCount] of expected) {
          const shell = yield* projectionStore.getThreadShell(threadId);
          assert.deepEqual(
            snapshot.threads.find((thread) => thread.id === threadId),
            shell ?? undefined,
          );
          assert.equal(shell?.itemCount, itemCount);
        }
      }),
  );
  it.effect("does not treat visited or marked-unread state as thread activity", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const createdAt = yield* DateTime.now;
      const visitedOccurredAt = DateTime.add(createdAt, { seconds: 1 });
      const markedUnreadOccurredAt = DateTime.add(createdAt, { seconds: 2 });
      const threadId = ThreadId.make("thread:projection-read-state");
      const projectId = ProjectId.make("project:projection-read-state");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Projection read state",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-read-state:created"),
        type: "thread.created",
        threadId,
        occurredAt: createdAt,
        payload: thread,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-read-state:visited"),
        type: "thread.visited",
        threadId,
        occurredAt: visitedOccurredAt,
        payload: { ...thread, lastVisitedAt: createdAt },
      });

      const visited = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(visited.thread.lastVisitedAt, createdAt);
      assert.deepEqual(visited.thread.updatedAt, createdAt);

      yield* projectionStore.apply({
        id: EventId.make("event:projection-read-state:marked-unread"),
        type: "thread.marked-unread",
        threadId,
        occurredAt: markedUnreadOccurredAt,
        payload: thread,
      });

      const markedUnread = yield* projectionStore.getThreadProjection(threadId);
      assert.isNull(markedUnread.thread.lastVisitedAt);
      assert.deepEqual(markedUnread.thread.updatedAt, createdAt);
    }),
  );
  it.effect("dates thread activity by a run event and leaves the rest of the thread alone", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const createdAt = yield* DateTime.now;
      const runOccurredAt = DateTime.add(createdAt, { seconds: 5 });
      const threadId = ThreadId.make("thread:projection-activity");
      const runId = RunId.make("run:projection-activity");
      const rootNodeId = NodeId.make("node:projection-activity");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId: ProjectId.make("project:projection-activity"),
        title: "Projection activity",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: "feature/activity",
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: createdAt,
        deletedAt: null,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-activity:created"),
        type: "thread.created",
        threadId,
        occurredAt: createdAt,
        payload: thread,
      });
      const created = (yield* projectionStore.getThreadProjection(threadId)).thread;

      const { statements, tracer } = traceSqlStatements();
      yield* projectionStore
        .apply({
          id: EventId.make("event:projection-activity:run-created"),
          type: "run.created",
          threadId,
          runId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId,
          occurredAt: runOccurredAt,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message:projection-activity"),
            rootNodeId,
            activeAttemptId: null,
            status: "running" as const,
            requestedAt: runOccurredAt,
            startedAt: runOccurredAt,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        })
        .pipe(Effect.withTracer(tracer));
      assert.isEmpty(
        statements.filter(
          (statement) =>
            /^\s*SELECT/i.test(statement) &&
            statement.includes("orchestration_v2_projection_threads"),
        ),
      );

      const active = (yield* projectionStore.getThreadProjection(threadId)).thread;
      assert.deepEqual(active, { ...created, updatedAt: runOccurredAt });
      const shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (candidate) => candidate.id === threadId,
      );
      assert.deepEqual(shell?.updatedAt, runOccurredAt);
    }),
  );
  it.effect("preserves delegated completion ownership across stale run and task updates", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const later = DateTime.add(now, { seconds: 1 });
      const threadId = ThreadId.make("thread:projection-delegated-completion");
      const projectId = ProjectId.make("project:projection-delegated-completion");
      const runId = RunId.make("run:projection-delegated-completion");
      const rootNodeId = NodeId.make("node:projection-delegated-completion-root");
      const taskId = NodeId.make("node:projection-delegated-completion-task");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Delegated completion projection",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:projection-delegated-completion"),
        rootNodeId,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
        delegatedCompletion: {
          disposition: "stopped" as const,
          nextGeneration: 2,
          delivery: null,
        },
      };
      const task = {
        id: taskId,
        threadId,
        runId,
        parentNodeId: rootNodeId,
        origin: "app_owned" as const,
        createdBy: "agent" as const,
        driver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt: "Inspect the stop barrier.",
        title: null,
        model: null,
        completionWake: "always" as const,
        completionDelivery: {
          state: "disposed" as const,
          observedByRunId: null,
        },
        status: "running" as const,
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:run"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: run,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:task"),
        type: "subagent.updated",
        threadId,
        runId,
        nodeId: taskId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: task,
      });

      const { delegatedCompletion: _delegatedCompletion, ...staleRun } = run;
      const { completionDelivery: _completionDelivery, ...staleTask } = task;
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:stale-run"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: later,
        payload: { ...staleRun, status: "interrupted", completedAt: later },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:stale-task"),
        type: "subagent.updated",
        threadId,
        runId,
        nodeId: taskId,
        driver,
        providerInstanceId,
        occurredAt: later,
        payload: {
          ...staleTask,
          status: "interrupted",
          completedAt: later,
          updatedAt: later,
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(projection.runs[0]?.delegatedCompletion, run.delegatedCompletion);
      assert.deepEqual(projection.subagents[0]?.completionDelivery, task.completionDelivery);
      assert.deepEqual(
        (yield* projectionStore.getThreadRecords(threadId, ["subagents"], {
          omitSettledSubagents: true,
        })).subagents,
        [],
      );
    }),
  );
});
