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
  addRolledBackRecoveryCandidate,
} from "./ProjectionStore-fixtures.testkit.ts";

it.layer(layerTest)("ProjectionStoreV2", (it) => {
  it.effect("projects only the latest failed root turn's limit into SQL and memory shells", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("limit-shell");
      const otherThreadId = yield* addRolledBackRecoveryCandidate("other-limit-shell");
      const original = (yield* store.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      const limitItem = {
        id: TurnItemId.make("limit-shell:error"),
        threadId,
        runId: original.id,
        nodeId: original.rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "failed" as const,
        title: "Usage limit reached",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "error" as const,
        failure: {
          class: "usage_limit" as const,
          message: "Plan limit reached.",
          resetAt: "2099-01-01T00:00:00.000Z",
          code: "usageLimitExceeded",
          retryable: null,
        },
      };
      const applyRun = (status: typeof original.status, rootNodeId = original.rootNodeId) =>
        store.apply({
          id: EventId.make(`event:limit-shell:run:${status}:${rootNodeId}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...original, rootNodeId, status },
        });
      const assertSummary = Effect.fnUntraced(function* (
        lastError: string | null,
        lastErrorClass: string | null,
      ) {
        const projection = yield* store.getThreadProjection(threadId);
        const memoryShell = ProjectionStore.threadShellFromProjection(projection);
        const shells = yield* store.getShellSnapshot();
        const sqlShell = shells.threads.find((row) => row.id === threadId)!;
        for (const shell of [memoryShell, sqlShell]) {
          assert.equal(shell.lastError, lastError);
          assert.equal(shell.lastErrorClass, lastErrorClass);
          assert.equal(
            shell.usageLimitResetAt,
            lastErrorClass === "usage_limit" ? "2099-01-01T00:00:00.000Z" : null,
          );
        }
        assert.isNull(shells.threads.find((row) => row.id === otherThreadId)!.lastErrorClass);
        const candidates = yield* store.getLimitRecoveryCandidates({
          now,
          autoResume: true,
          snooze: false,
        });
        const candidate = candidates.find((row) => row.id === threadId);
        if (lastErrorClass === "usage_limit") {
          assert.deepEqual(candidate, {
            id: sqlShell.id,
            status: sqlShell.status,
            lastErrorClass: sqlShell.lastErrorClass,
            usageLimitResetAt: sqlShell.usageLimitResetAt,
            latestRunId: sqlShell.latestRunId,
            latestRunCompletedAt: sqlShell.latestRunCompletedAt,
            updatedAt: sqlShell.updatedAt,
            archivedAt: sqlShell.archivedAt,
            settledOverride: sqlShell.settledOverride,
            pendingRuntimeRequest: null,
            limitRecovery: sqlShell.limitRecovery,
            snoozedUntil: sqlShell.snoozedUntil,
          });
        } else assert.isUndefined(candidate);
        assert.isUndefined(candidates.find((row) => row.id === otherThreadId));
      });
      yield* store.apply({
        id: EventId.make("event:limit-shell:error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: limitItem,
      });
      yield* applyRun("failed");
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const queuedRunId = RunId.make("run:limit-shell:queued");
      yield* store.apply({
        id: EventId.make("event:limit-shell:queued"),
        type: "run.created",
        threadId,
        runId: queuedRunId,
        nodeId: NodeId.make("node:limit-shell:queued"),
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...original,
          id: queuedRunId,
          ordinal: original.ordinal + 1,
          rootNodeId: NodeId.make("node:limit-shell:queued"),
          userMessageId: MessageId.make("message:limit-shell:queued"),
          status: "queued",
          startedAt: null,
          completedAt: null,
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const queuedProjection = yield* store.getThreadProjection(threadId);
      const queuedMemoryShell = ProjectionStore.threadShellFromProjection(queuedProjection);
      const queuedSqlShell = (yield* store.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      assert.equal(queuedMemoryShell.status, "failed");
      assert.equal(queuedMemoryShell.latestRunId, original.id);
      assert.equal(queuedSqlShell.status, "failed");
      assert.equal(queuedSqlShell.latestRunId, original.id);
      assert.equal(queuedProjection.runs.find((run) => run.id === queuedRunId)?.status, "queued");
      const cancelledRunId = RunId.make("run:limit-shell:cancelled-queued");
      yield* store.apply({
        id: EventId.make("event:limit-shell:cancelled-queued"),
        type: "run.created",
        threadId,
        runId: cancelledRunId,
        nodeId: NodeId.make("node:limit-shell:cancelled-queued"),
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...original,
          id: cancelledRunId,
          ordinal: original.ordinal + 2,
          rootNodeId: NodeId.make("node:limit-shell:cancelled-queued"),
          userMessageId: MessageId.make("message:limit-shell:cancelled-queued"),
          status: "cancelled",
          startedAt: null,
          completedAt: now,
        },
      });
      yield* store.apply({
        id: EventId.make("event:limit-shell:cancelled-queued-message"),
        type: "turn-item.updated",
        threadId,
        runId: cancelledRunId,
        nodeId: NodeId.make("node:limit-shell:cancelled-queued"),
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: TurnItemId.make("limit-shell:cancelled-queued-message"),
          threadId,
          runId: cancelledRunId,
          nodeId: NodeId.make("node:limit-shell:cancelled-queued"),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 3,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: MessageId.make("message:limit-shell:cancelled-queued"),
          inputIntent: "turn_start",
          text: "cancelled before the provider started",
          attachments: [],
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const aheadRunId = RunId.make("run:limit-shell:ran-ahead");
      yield* store.apply({
        id: EventId.make("event:limit-shell:ran-ahead"),
        type: "run.created",
        threadId,
        runId: aheadRunId,
        nodeId: NodeId.make("node:limit-shell:ran-ahead"),
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...original,
          id: aheadRunId,
          ordinal: original.ordinal + 3,
          rootNodeId: NodeId.make("node:limit-shell:ran-ahead"),
          userMessageId: MessageId.make("message:limit-shell:ran-ahead"),
          status: "completed",
          startedAt: DateTime.subtract(now, { minutes: 10 }),
          completedAt: DateTime.subtract(now, { minutes: 5 }),
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${aheadRunId}`;
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${queuedRunId}`;
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${cancelledRunId}`;
      const [originalRow] = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
      for (const [field, value] of [
        ["archivedAt", DateTime.formatIso(now)],
        ["settledOverride", "settled"],
      ]) {
        yield* sql`UPDATE orchestration_v2_projection_threads
          SET payload_json = json_set(payload_json, ${`$.${field}`}, ${value})
          WHERE thread_id = ${threadId}`;
        assert.isUndefined(
          (yield* store.getLimitRecoveryCandidates({ now, autoResume: true, snooze: false })).find(
            (row) => row.id === threadId,
          ),
        );
        yield* sql`UPDATE orchestration_v2_projection_threads
          SET payload_json = ${originalRow!.payload_json} WHERE thread_id = ${threadId}`;
      }
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${DateTime.formatIso(now)} WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ now, autoResume: true, snooze: false })).find(
          (row) => row.id === threadId,
        ),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = NULL WHERE thread_id = ${threadId}`;
      const recoveryOptions = { now, autoResume: false, snooze: false };
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates(recoveryOptions)).find(
          (row) => row.id === threadId,
        ),
      );
      const reset = DateTime.makeUnsafe(limitItem.failure.resetAt);
      const recovery = {
        runId: original.id,
        resetAt: limitItem.failure.resetAt,
        autoResume: true,
        requestId: CommandId.make("recovery:choice"),
      };
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.limitRecovery', json(${encodeUnknownJsonString(recovery)}))
        WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, autoResume: true })).find(
          (row) => row.id === threadId,
        ),
      );
      assert.strictEqual(yield* store.getLimitRecoveryWakeAt(now), DateTime.toEpochMillis(reset));
      assert.isNull(yield* store.getLimitRecoveryWakeAt(reset));
      const due = (yield* store.getLimitRecoveryCandidates({
        ...recoveryOptions,
        now: reset,
      })).find((row) => row.id === threadId)!;
      assert.deepEqual(due.limitRecovery, recovery);
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
        (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
        VALUES ('limit-shell:pending-request', ${threadId}, ${original.rootNodeId}, 'approval', 'pending', ${DateTime.formatIso(now)}, '{}')`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, now: reset })).find(
          (row) => row.id === threadId,
        ),
      );
      yield* sql`DELETE FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id = 'limit-shell:pending-request'`;
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.snoozedUntil', ${DateTime.formatIso(DateTime.add(reset, { minutes: 1 }))})
        WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, now: reset })).find(
          (row) => row.id === threadId,
        ),
      );
      assert.strictEqual(
        yield* store.getLimitRecoveryWakeAt(reset),
        DateTime.toEpochMillis(DateTime.add(reset, { minutes: 1 })),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.snoozedUntil', NULL, '$.limitRecovery.autoResume', json('false'))
        WHERE thread_id = ${threadId}`;
      assert.isNull(yield* store.getLimitRecoveryWakeAt(now));
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({
          ...recoveryOptions,
          now: reset,
          autoResume: true,
        })).find((row) => row.id === threadId),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${originalRow!.payload_json} WHERE thread_id = ${threadId}`;
      const session = {
        id: ProviderSessionId.make("session:limit-shell:shared"),
        driver,
        providerInstanceId,
        status: "ready" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      for (const boundThreadId of [threadId, otherThreadId]) {
        yield* store.apply({
          id: EventId.make(`event:limit-shell:bind:${boundThreadId}`),
          type: "provider-session.attached",
          threadId: boundThreadId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: session,
        });
      }
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* store.apply({
        id: EventId.make("event:limit-shell:session-failed"),
        type: "provider-session.updated",
        threadId,
        occurredAt: now,
        payload: { ...session, status: "error", lastError: "Provider process exited." },
      });
      yield* assertSummary("Provider process exited.", null);
      yield* store.apply({
        id: EventId.make("event:limit-shell:session-recovered"),
        type: "provider-session.updated",
        threadId,
        occurredAt: now,
        payload: session,
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* store.apply({
        id: EventId.make("event:limit-shell:child-error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...limitItem,
          id: TurnItemId.make("limit-shell:child-error"),
          nodeId: NodeId.make("child-node"),
          ordinal: 3,
          failure: { ...limitItem.failure, class: "provider_error", message: "Child failed." },
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* store.apply({
        id: EventId.make("event:limit-shell:replacement"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...limitItem,
          id: TurnItemId.make("limit-shell:replacement"),
          ordinal: 4,
          failure: { ...limitItem.failure, class: "provider_error", message: "Provider failed." },
        },
      });
      yield* assertSummary("Provider failed.", "provider_error");
      for (const status of [
        "running",
        "completed",
        "interrupted",
        "cancelled",
        "rolled_back",
      ] as const) {
        yield* applyRun(status);
        yield* assertSummary(null, null);
      }
      yield* applyRun("failed", NodeId.make("new-attempt-root"));
      yield* assertSummary(null, null);
    }),
  );
  it.effect("does not freshly arm limit recovery for a subagent of a settled parent", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const resetAt = DateTime.formatIso(DateTime.add(now, { hours: 1 }));
      const threadPayload = (
        threadId: ThreadId,
        parentThreadId: ThreadId | null,
        settledOverride: "settled" | null,
      ) =>
        ({
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:settled-parent-limit"),
          title: "Settled parent limit recovery",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId,
            relationshipToParent: parentThreadId === null ? null : "subagent",
            rootThreadId: parentThreadId ?? threadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride,
          settledAt: settledOverride === null ? null : now,
          lastVisitedAt: null,
          deletedAt: null,
        }) as const;
      const createThread = (
        threadId: ThreadId,
        parentThreadId: ThreadId | null,
        settledOverride: "settled" | null,
      ) =>
        store.apply({
          id: EventId.make(`event:${threadId}:created`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: threadPayload(threadId, parentThreadId, settledOverride),
        });
      const addLimitedChild = Effect.fnUntraced(function* (name: string, parentSettled: boolean) {
        const parentId = ThreadId.make(`thread:settled-parent-limit:${name}:parent`);
        const childId = ThreadId.make(`thread:settled-parent-limit:${name}:child`);
        const runId = RunId.make(`run:settled-parent-limit:${name}`);
        const rootNodeId = NodeId.make(`node:settled-parent-limit:${name}`);
        yield* createThread(parentId, null, parentSettled ? "settled" : null);
        yield* createThread(childId, parentId, null);
        const run = {
          id: runId,
          threadId: childId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`message:settled-parent-limit:${name}`),
          rootNodeId,
          activeAttemptId: null,
          status: "failed" as const,
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        };
        yield* store.apply({
          id: EventId.make(`event:settled-parent-limit:${name}:run`),
          type: "run.created",
          threadId: childId,
          runId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: run,
        });
        yield* store.apply({
          id: EventId.make(`event:settled-parent-limit:${name}:error`),
          type: "turn-item.updated",
          threadId: childId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:settled-parent-limit:${name}:error`),
            threadId: childId,
            runId,
            nodeId: rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "failed",
            title: "Usage limit reached",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "error",
            failure: {
              class: "usage_limit",
              message: "Plan limit reached.",
              resetAt,
              code: "usageLimitExceeded",
              retryable: null,
            },
          },
        });
        return childId;
      });
      const settledParentChild = yield* addLimitedChild("settled", true);
      const activeParentChild = yield* addLimitedChild("active", false);
      for (const options of [
        { now, autoResume: true, snooze: false },
        { now, autoResume: false, snooze: true },
      ]) {
        const armed = (yield* store.getLimitRecoveryCandidates(options))
          .filter((row) => row.id === settledParentChild || row.id === activeParentChild)
          .filter(
            (row) =>
              limitRecoveryCommand(
                row,
                options.autoResume,
                DateTime.toEpochMillis(now),
                options.snooze,
              )?.type === "thread.metadata.update",
          )
          .map((row) => row.id);
        assert.deepEqual(
          armed,
          [activeParentChild],
          `only the child of the unsettled parent is armed (${JSON.stringify(options)})`,
        );
      }
      // A recovery armed before the parent settled still resumes at its reset.
      yield* store.apply({
        id: EventId.make("event:settled-parent-limit:settled:armed"),
        type: "thread.metadata-updated",
        threadId: settledParentChild,
        occurredAt: now,
        payload: {
          ...threadPayload(
            settledParentChild,
            ThreadId.make("thread:settled-parent-limit:settled:parent"),
            null,
          ),
          limitRecovery: {
            runId: RunId.make("run:settled-parent-limit:settled"),
            resetAt,
            autoResume: true,
          },
        },
      });
      const afterReset = DateTime.add(now, { hours: 2 });
      const resumed = (yield* store.getLimitRecoveryCandidates({
        now: afterReset,
        autoResume: true,
        snooze: false,
      })).find((row) => row.id === settledParentChild);
      assert.isDefined(resumed);
      assert.isTrue(
        limitRecoveryCommand(
          resumed,
          true,
          DateTime.toEpochMillis(afterReset),
          false,
        )?.commandId.startsWith("limit-resume:"),
      );
    }),
  );
});
