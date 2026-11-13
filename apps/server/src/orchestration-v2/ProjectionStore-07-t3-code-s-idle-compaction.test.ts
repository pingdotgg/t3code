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
  assertShellIndexCoversShells,
  addRolledBackRecoveryCandidate,
  addOrphanedRecoveryCandidate,
} from "./ProjectionStore-fixtures.testkit.ts";

it.layer(layerTest)("ProjectionStoreV2", (it) => {
  it.effect.each([
    ["T3 Code's idle compaction", "agent", "server", undefined, true, "/compact"],
    ["compacting on return", "user", "web", "onReturn", true, "/compact"],
    ["a typed /compact", "user", "mobile", undefined, false, "/compact"],
    ["a normalized idle command", "agent", "server", undefined, true, " \t\u00a0/COMPACT\u3000\n"],
    ["an ordinary prompt with idle metadata", "user", "web", "onReturn", false, "Continue"],
  ] as const)(
    "keeps the shell on the user's last turn only during %s",
    ([name, createdBy, creationSource, idleCompaction, silent, text]) =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const key = name.replaceAll(/\W+/g, "-");
        const threadId = ThreadId.make(`thread:projection-shell-silent:${key}`);
        const runId = RunId.make(`run:projection-shell-silent:${key}`);
        const messageId = MessageId.make(`message:projection-shell-silent:${key}`);
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-shell-silent:${key}:thread`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:projection-shell-silent"),
            title: "Idle compaction",
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
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-shell-silent:${key}:message`),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            createdBy,
            creationSource,
            ...(idleCompaction === undefined ? {} : { idleCompaction }),
            id: messageId,
            threadId,
            runId,
            nodeId: null,
            role: "user",
            text,
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-shell-silent:${key}:run`),
          type: "run.created",
          threadId,
          runId,
          nodeId: NodeId.make(`node:projection-shell-silent:${key}`),
          driver,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: messageId,
            rootNodeId: null,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        });

        const presented = Effect.gen(function* () {
          const sqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
            (thread) => thread.id === threadId,
          );
          const memoryShell = ProjectionStore.threadShellFromProjection(
            yield* projectionStore.getThreadProjection(threadId),
          );
          return [sqlShell, memoryShell].map((shell) => ({
            latestRunId: shell?.latestRunId ?? null,
            activityRunStatus: shell?.activityRunStatus ?? null,
            activeRunId: shell?.activeRunId ?? null,
            latestUserMessageAt: shell?.latestUserMessageAt != null,
          }));
        });
        const visible = {
          latestRunId: runId,
          activityRunStatus: "running" as const,
          activeRunId: runId,
          latestUserMessageAt: true,
        };
        const hidden = {
          latestRunId: null,
          activityRunStatus: null,
          activeRunId: null,
          latestUserMessageAt: false,
        };
        assert.deepStrictEqual(yield* presented, [
          silent ? hidden : visible,
          silent ? hidden : visible,
        ]);

        // A run that fails outright, e.g. on a provider error, needs the user too.
        const running = (yield* projectionStore.getThreadProjection(threadId)).runs[0]!;
        const setRunStatus = (status: "failed" | "running") =>
          projectionStore.apply({
            id: EventId.make(`event:projection-shell-silent:${key}:run-${status}`),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...running, status, completedAt: status === "failed" ? now : null },
          });
        yield* setRunStatus("failed");
        assert.deepStrictEqual(
          (yield* presented).map((shell) => shell.latestRunId),
          [runId, runId],
        );
        yield* setRunStatus("running");

        // Claude can finish the run successfully even when its /compact failed.
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-shell-silent:${key}:failure`),
          type: "turn-item.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:projection-shell-silent:${key}:compaction`),
            threadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            type: "compaction",
            driver,
            status: "failed",
            title: "Context compaction failed",
            summary: "Not enough messages to compact.",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          },
        });
        // A failure needs the user, so it surfaces even though its prompt stays hidden.
        assert.deepStrictEqual(
          yield* presented,
          [visible, visible].map((shell) =>
            silent ? { ...shell, latestUserMessageAt: false } : shell,
          ),
        );
      }),
  );
  it.effect("only exposes interruptible runs through the shell activeRunId", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:projection-shell-interruptible");
      const projectId = ProjectId.make("project:projection-shell-interruptible");
      const runId = RunId.make("run:projection-shell-interruptible");
      const rootNodeId = NodeId.make("node:projection-shell-interruptible");
      const run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:projection-shell-interruptible"),
        rootNodeId,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Interruptible shell run",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
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
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:running"),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: run,
      });

      let shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.equal(shell?.status, "running");
      assert.equal(shell?.activeRunId, runId);
      assert.equal(
        shell?.latestRunRequestedAt && DateTime.toEpochMillis(shell.latestRunRequestedAt),
        DateTime.toEpochMillis(now),
      );
      assert.equal(
        shell?.latestRunStartedAt && DateTime.toEpochMillis(shell.latestRunStartedAt),
        DateTime.toEpochMillis(now),
      );
      assert.isNull(shell?.latestRunCompletedAt);

      const requestId = RuntimeRequestId.make("request:projection-shell-question");
      for (const [responseCapability, blocking] of [
        [{ type: "message" }, false],
        [{ type: "live", providerSessionId: ProviderSessionId.make("session:question") }, true],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-shell-question:${responseCapability.type}`),
          type: "runtime-request.updated",
          threadId,
          nodeId: rootNodeId,
          driver,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId: rootNodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability,
            createdAt: now,
            resolvedAt: null,
          },
        });
        const projection = yield* projectionStore.getThreadProjection(threadId);
        const sqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
          (row) => row.id === threadId,
        )!;
        yield* assertShellIndexCoversShells();
        for (const questionShell of [
          sqlShell,
          ProjectionStore.threadShellFromProjection(projection),
        ]) {
          assert.equal(questionShell.activeRunId, runId);
          assert.deepEqual(questionShell.pendingRuntimeRequest, {
            id: requestId,
            kind: "user_input",
            createdAt: now,
            blocking,
          });
        }
      }

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:waiting"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: { ...run, status: "waiting" },
      });

      shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.equal(shell?.status, "waiting");
      assert.isNull(shell?.activeRunId);
      const later = DateTime.add(now, { hours: 1 });
      for (const status of ["queued", "cancelled"] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:clock:newer:${status}`),
          type: "run.updated",
          threadId,
          occurredAt: later,
          payload: {
            ...run,
            id: RunId.make("run:clock:newer"),
            ordinal: 2,
            status,
            requestedAt: later,
            startedAt: null,
            completedAt: status === "cancelled" ? later : null,
          },
        });
        for (const activityStatus of ["preparing", "running", "waiting", "completed"] as const) {
          yield* projectionStore.apply({
            id: EventId.make(`event:clock:${status}:${activityStatus}`),
            type: "run.updated",
            threadId,
            occurredAt: later,
            payload: {
              ...run,
              status: activityStatus,
              startedAt: activityStatus === "preparing" ? null : now,
              completedAt: activityStatus === "completed" ? later : null,
            },
          });
          const projection = yield* projectionStore.getThreadProjection(threadId);
          const sqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
            (row) => row.id === threadId,
          )!;
          const memoryShell = ProjectionStore.threadShellFromProjection(projection);
          const expected = activityStatus === "completed" ? null : DateTime.toEpochMillis(now);
          const timestamp = (value: DateTime.Utc | null | undefined) =>
            value == null ? null : DateTime.toEpochMillis(value);
          assert.equal(timestamp(sqlShell.activityRunStartedAt), expected);
          assert.equal(timestamp(memoryShell.activityRunStartedAt), expected);
          assert.equal(sqlShell.latestRunId, "run:clock:newer");
        }
      }

      yield* projectionStore.apply({
        id: EventId.make("event:clock:newer:held"),
        type: "run.updated",
        threadId,
        occurredAt: later,
        payload: {
          ...run,
          id: RunId.make("run:clock:newer"),
          ordinal: 2,
          status: "queued",
          queueHeld: true,
          requestedAt: later,
          startedAt: null,
          completedAt: null,
        },
      });
      const heldProjection = yield* projectionStore.getThreadProjection(threadId);
      const heldSqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      for (const heldShell of [
        heldSqlShell,
        ProjectionStore.threadShellFromProjection(heldProjection),
      ]) {
        assert.equal(heldShell.latestRunId, runId);
        assert.equal(heldShell.status, "completed");
      }

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:held-first"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: later,
        payload: { ...run, status: "queued", queueHeld: true, startedAt: null, completedAt: null },
      });
      const onlyHeldProjection = yield* projectionStore.getThreadProjection(threadId);
      const onlyHeldSqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      for (const onlyHeldShell of [
        onlyHeldSqlShell,
        ProjectionStore.threadShellFromProjection(onlyHeldProjection),
      ]) {
        assert.isNull(onlyHeldShell.latestRunId);
        assert.equal(onlyHeldShell.status, "idle");
      }

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:wake"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: later,
        payload: {
          ...run,
          status: "running",
          requestedAt: later,
          startedAt: later,
          workStartedAt: now,
        },
      });
      const wakeProjection = yield* projectionStore.getThreadProjection(threadId);
      const wakeSqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      for (const wakeShell of [
        wakeSqlShell,
        ProjectionStore.threadShellFromProjection(wakeProjection),
      ]) {
        assert.equal(
          wakeShell.activityRunStartedAt && DateTime.toEpochMillis(wakeShell.activityRunStartedAt),
          DateTime.toEpochMillis(now),
        );
      }
    }),
  );
  it.effect("selects only threads with runtime state that needs recovery", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const settledThreadId = ThreadId.make("thread:recovery-candidates:settled");
      const runningThreadId = ThreadId.make("thread:recovery-candidates:running");
      const memberThreadId = ThreadId.make("thread:recovery-candidates:member");
      const childThreadId = ThreadId.make("thread:recovery-candidates:child");
      const rolledBackThreadId = yield* addRolledBackRecoveryCandidate("recovery-candidates");
      const orphanedThreadId = yield* addOrphanedRecoveryCandidate("recovery-candidates");
      const projectId = ProjectId.make("project:recovery-candidates");
      const makeThread = (threadId: ThreadId) => ({
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Recovery candidate",
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
      });

      for (const threadId of [settledThreadId, runningThreadId, memberThreadId, childThreadId]) {
        yield* projectionStore.apply({
          id: EventId.make(`event:recovery-candidates:${threadId}:created`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: makeThread(threadId),
        });
      }

      const runId = RunId.make("run:recovery-candidates:running");
      const rootNodeId = NodeId.make("node:recovery-candidates:running");
      yield* projectionStore.apply({
        id: EventId.make("event:recovery-candidates:run-created"),
        type: "run.created",
        threadId: runningThreadId,
        runId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId: runningThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:recovery-candidates:running"),
          rootNodeId,
          activeAttemptId: null,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const memberId = NodeId.make("node:recovery-candidates:member");
      const childRootNodeId = NodeId.make("node:recovery-candidates:child-root");
      const nativeTaskRef = { driver, nativeId: "workflow:agent:1", strength: "strong" as const };
      const memberNode = {
        id: memberId,
        threadId: memberThreadId,
        runId: null,
        parentNodeId: NodeId.make("node:recovery-candidates:coordinator-root"),
        rootNodeId: NodeId.make("node:recovery-candidates:coordinator-root"),
        kind: "subagent" as const,
        status: "running" as const,
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: nativeTaskRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:recovery-candidates:member"),
        type: "subagent.updated",
        threadId: memberThreadId,
        nodeId: memberId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: memberId,
          threadId: memberThreadId,
          runId: null,
          parentNodeId: memberNode.parentNodeId,
          origin: "provider_native",
          createdBy: "agent",
          driver,
          providerInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef,
          prompt: "Do the work",
          title: "Member",
          model: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      });
      for (const [threadId, node] of [
        [memberThreadId, memberNode],
        [
          childThreadId,
          {
            ...memberNode,
            id: childRootNodeId,
            threadId: childThreadId,
            parentNodeId: null,
            rootNodeId: childRootNodeId,
            kind: "root_turn" as const,
          },
        ],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:recovery-candidates:node:${node.id}`),
          type: "node.updated",
          threadId,
          nodeId: node.id,
          driver,
          occurredAt: now,
          payload: node,
        });
      }

      const recoveryThreadIds = yield* projectionStore.getRecoveryThreadIds("runtime");
      assert.include(recoveryThreadIds, runningThreadId);
      assert.include(recoveryThreadIds, orphanedThreadId);
      assert.include(recoveryThreadIds, memberThreadId);
      assert.include(recoveryThreadIds, childThreadId);
      assert.notInclude(recoveryThreadIds, settledThreadId);
      assert.notInclude(recoveryThreadIds, rolledBackThreadId);
      const memberRecovery = yield* projectionStore.getRuntimeRecoveryProjection(memberThreadId);
      const childRecovery = yield* projectionStore.getRuntimeRecoveryProjection(childThreadId);
      assert.deepEqual(
        memberRecovery.subagents.map((subagent) => subagent.id),
        [memberId],
      );
      assert.deepEqual(
        memberRecovery.nodes.map((node) => node.id),
        [memberId],
      );
      assert.deepEqual(
        childRecovery.nodes.map((node) => node.id),
        [childRootNodeId],
      );
      yield* projectionStore.apply({
        id: EventId.make("event:recovery-candidates:member-cancelled"),
        type: "subagent.updated",
        threadId: memberThreadId,
        nodeId: memberId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...memberRecovery.subagents[0]!,
          status: "cancelled",
          completedAt: now,
          updatedAt: now,
        },
      });
      assert.include(yield* projectionStore.getRecoveryThreadIds("runtime"), childThreadId);
    }),
  );
});
