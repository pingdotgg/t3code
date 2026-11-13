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
  traceSqlStatements,
  assertShellIndexCoversShells,
} from "./ProjectionStore-fixtures.testkit.ts";

it.layer(layerTest)("ProjectionStoreV2", (it) => {
  it.effect("a pull request watch keeps a finished thread working until it ends", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:watched-pull-request");
      const runId = RunId.make("run:watched-pull-request");
      const at = DateTime.makeUnsafe("2026-10-05T12:00:00.000Z");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId: ProjectId.make("project:watched-pull-request"),
        title: "Babysit the PR",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* store.apply({
        id: EventId.make("event:watched-pull-request:thread"),
        type: "thread.created",
        threadId,
        occurredAt: at,
        payload: thread,
      });
      yield* store.apply({
        id: EventId.make("event:watched-pull-request:run"),
        type: "run.created",
        threadId,
        runId,
        driver,
        providerInstanceId,
        occurredAt: at,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:watched-pull-request"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: at,
          startedAt: at,
          completedAt: at,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const link = {
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 7,
        url: "https://github.com/pingdotgg/t3code/pull/7",
        source: "agent" as const,
        linkedAt: DateTime.formatIso(at),
        snapshot: null,
        stack: null,
      };
      const syncPullRequests = (id: string, pullRequests: ReadonlyArray<ThreadPullRequestLink>) =>
        store.apply({
          id: EventId.make(`event:watched-pull-request:${id}`),
          type: "thread.pull-request-synced",
          threadId,
          occurredAt: at,
          payload: { ...thread, pullRequests },
        });
      const project = { title: "Project" };
      const environmentId = EnvironmentId.make("environment:watched-pull-request");
      const phase = Effect.gen(function* () {
        const shell = yield* store.getThreadShell(threadId);
        const listed = (yield* store.getShellSnapshot()).threads.find(
          (candidate) => candidate.id === threadId,
        );
        assert.deepEqual(listed?.pendingBackgroundTasks, shell?.pendingBackgroundTasks);
        yield* assertShellIndexCoversShells();
        return shell && projectThreadAwarenessV2({ environmentId, project, thread: shell })?.phase;
      });

      yield* syncPullRequests("watched", [
        {
          ...link,
          watch: {
            startedAt: DateTime.formatIso(at),
            headSha: null,
            failedChecks: [],
            passed: false,
            passedChecks: [],
            remarksThrough: DateTime.formatIso(at),
            remarkIds: [],
            conflicting: false,
            wakes: 0,
          },
        },
      ]);
      assert.deepEqual((yield* store.getThreadShell(threadId))?.pendingBackgroundTasks, [
        {
          taskId: "pull-request-watch:github.com/pingdotgg/t3code#7",
          description: "Watching pull request #7",
          kind: "monitor",
          awaited: true,
        },
      ]);
      assert.equal(yield* phase, "running");

      yield* syncPullRequests("unwatched", [link]);
      assert.deepEqual((yield* store.getThreadShell(threadId))?.pendingBackgroundTasks, []);
      assert.equal(yield* phase, "completed");
    }),
  );
  it.effect("dates a completion released by held background work at the release", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:held-completion");
      const runId = RunId.make("run:held-completion");
      const providerThreadId = ProviderThreadId.make("provider-thread:held-completion");
      const completedAt = DateTime.makeUnsafe("2026-09-28T12:00:00.000Z");
      const releasedAt = DateTime.makeUnsafe("2026-09-28T12:05:00.000Z");
      const providerThread = {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [
          { taskId: "watch", kind: "monitor" as const, awaited: true as const },
        ],
        createdAt: completedAt,
        updatedAt: completedAt,
      };
      yield* store.apply({
        id: EventId.make("event:held-completion:thread"),
        type: "thread.created",
        threadId,
        occurredAt: completedAt,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:held-completion"),
          title: "Watch the build",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: completedAt,
          updatedAt: completedAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("event:held-completion:run"),
        type: "run.created",
        threadId,
        runId,
        driver,
        providerInstanceId,
        occurredAt: completedAt,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("message:held-completion"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: completedAt,
          startedAt: completedAt,
          completedAt,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* store.apply({
        id: EventId.make("event:held-completion:monitor-running"),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: completedAt,
        payload: providerThread,
      });
      const project = { title: "Project" };
      const environmentId = EnvironmentId.make("environment:held-completion");
      const held = yield* store.getThreadShell(threadId);
      assert.equal(
        held && projectThreadAwarenessV2({ environmentId, project, thread: held })?.phase,
        "running",
      );

      yield* store.apply({
        id: EventId.make("event:held-completion:monitor-ended"),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: releasedAt,
        payload: { ...providerThread, pendingBackgroundTasks: [], updatedAt: releasedAt },
      });
      const released = yield* store.getThreadShell(threadId);
      const state =
        released && projectThreadAwarenessV2({ environmentId, project, thread: released });
      assert.equal(state?.phase, "completed");
      assert.equal(state?.updatedAt, DateTime.formatIso(releasedAt));

      yield* store.apply({
        id: EventId.make("event:held-completion:monitor-restarted"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: releasedAt,
        payload: { ...providerThread, updatedAt: releasedAt },
      });
      const newerRunId = RunId.make("run:held-completion:new-provider");
      yield* store.apply({
        id: EventId.make("event:held-completion:new-provider"),
        type: "run.created",
        threadId,
        runId: newerRunId,
        occurredAt: releasedAt,
        payload: {
          ...(yield* store.getThreadProjection(threadId)).runs[0]!,
          id: newerRunId,
          ordinal: 2,
          providerThreadId: ProviderThreadId.make("provider-thread:held-completion:new-provider"),
          requestedAt: releasedAt,
          startedAt: releasedAt,
          completedAt: releasedAt,
        },
      });
      const { statements, tracer } = traceSqlStatements();
      assert.deepEqual(
        (yield* store
          .getRuntimeRecoveryProjection(threadId)
          .pipe(Effect.withTracer(tracer))).runs.map((run) => run.id),
        [runId, newerRunId],
      );
      // Live-item filters must hit the active partial indexes, not walk the thread's history.
      const sql = yield* SqlClient.SqlClient;
      for (const statement of statements.filter((query) => query.includes("turn_items"))) {
        const plan = (yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${statement}`,
        )).map((row) => row.detail);
        for (const detail of plan) {
          assert.notMatch(detail, /turn_items_(thread_ordinal|thread_run)_idx \(thread_id=\?\)$/);
        }
      }
    }),
  );
});
