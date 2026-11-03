import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  ProviderDriverKind,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  CheckpointScopeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { TaskFolderStore } from "../workspace/TaskFolders.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";
import { resolveCodexRollbackTurnCount } from "./Adapters/CodexAdapterV2.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const unrelatedProject = Option.some({
  workspaceRoot: "/nonexistent/t3-rollback-project",
} as never);
const layerCheckpointRollbackService = CheckpointRollbackService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ServerConfig.ServerConfig)({ worktreesDir: "/synthetic-worktrees" } as never),
      ServerSettings.layerTest(),
      Layer.mock(GitWorkflow.GitWorkflowService)({}),
      Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(unrelatedProject) }),
    ),
  ),
);

it.effect.each(["initial", "waiting"])(
  "rejects a non-ready checkpoint from %s before opening a session or restoring files",
  (state) => {
    const threadId = ThreadId.make("thread:rollback-non-ready");
    const providerThreadId = ProviderThreadId.make("provider-thread:rollback-non-ready");
    const providerSessionId = ProviderSessionId.make("provider-session:rollback-non-ready");
    const checkpointId = CheckpointId.make("checkpoint:rollback-non-ready");
    const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-non-ready");
    const providerInstanceId = ProviderInstanceId.make("provider_rollback_non_ready");
    const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
    const open = vi.fn(() => Effect.die("provider session open must not run"));
    const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
    const readEntered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    let projection = {
      thread: {
        worktreePath: process.cwd(),
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId: providerInstanceId, model: "test-model" },
      },
      providerThread: { id: providerThreadId, providerSessionId, providerInstanceId },
      checkpoint: {
        id: checkpointId,
        scopeId,
        status: state === "waiting" ? "ready" : "stale",
        appRunOrdinal: 0,
      },
      scope: { id: scopeId, cwd: process.cwd() },
    } as unknown as ProjectionStore.ProjectionCheckpointRollbackContext;
    const getThread = vi.fn<ProjectionStore.ProjectionStoreV2Shape["getThread"]>(() =>
      Deferred.succeed(readEntered, undefined).pipe(Effect.as(projection.thread)),
    );
    const getCheckpointRollbackContext = vi.fn(() => Effect.succeed(projection));
    const testLayer = layerCheckpointRollbackService.pipe(
      Layer.provide(
        Layer.mergeAll(
          ThreadCommandExecutor.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({ restore }),
          Layer.mock(EventSink.EventSinkV2)({}),
          IdAllocator.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThread,
            getCheckpointRollbackContext,
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: [],
                archivedThreads: [],
              }),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
          Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
      const holder =
        state === "waiting"
          ? yield* withWorkspaceLease(process.cwd(), Deferred.await(release)).pipe(
              Effect.forkChild({ startImmediately: true }),
            )
          : undefined;
      const rollback = yield* service
        .execute({
          threadId,
          providerThreadId,
          checkpointId,
          scopeId,
        })
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      if (state === "waiting") {
        yield* Deferred.await(readEntered);
        projection = {
          ...projection,
          checkpoint: { ...projection.checkpoint!, status: "stale" },
        };
        yield* Deferred.succeed(release, undefined);
        if (holder !== undefined) yield* Fiber.join(holder);
      }
      const error = yield* Fiber.join(rollback);

      assert.deepEqual(getThread.mock.calls, [[threadId]]);
      assert.deepEqual(getCheckpointRollbackContext.mock.calls, [
        [
          threadId,
          {
            threadId,
            providerThreadId,
            checkpointId,
            scopeId,
          },
        ],
      ]);
      assert.equal(error.reason, "rollback-target-invalid");
      assert.equal(
        error.message,
        `Rollback target ${checkpointId} for provider thread ${providerThreadId} on thread ${threadId} is incomplete or invalid.`,
      );
      assert.equal(error.cause, undefined);
      assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
      assert.equal(open.mock.calls.length, 0);
      assert.equal(restore.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  },
);

it.effect.each([
  { order: "cleanup-first", restoreFiles: true },
  { order: "rollback-first", restoreFiles: true },
  { order: "cleanup-first", restoreFiles: false, unmanaged: true },
])("locks rollback with %s", ({ order, restoreFiles, unmanaged = false }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-rollback-" }),
    );
    const worktreesDir = path.join(workspaceRoot, "worktrees");
    const worktreePath = unmanaged
      ? path.join(workspaceRoot, "elsewhere", "feature")
      : path.join(worktreesDir, "repo", "feature");
    yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
    const threadId = ThreadId.make("rollback-worktree");
    const projectId = ProjectId.make("rollback-worktree-project");
    const providerThreadId = ProviderThreadId.make("rollback-worktree-provider-thread");
    const providerSessionId = ProviderSessionId.make("rollback-worktree-provider-session");
    const providerInstanceId = ProviderInstanceId.make("rollback-worktree-provider-instance");
    const checkpointId = CheckpointId.make("rollback-worktree-checkpoint");
    const scopeId = CheckpointScopeId.make("rollback-worktree-scope");
    const branch = "feature/rollback";
    const release = Deferred.makeUnsafe<void>();
    const openEntered = Deferred.makeUnsafe<void>();
    const calls: string[] = [];
    let cleanupEntered = false;
    const providerThread = { id: providerThreadId, providerSessionId, providerInstanceId };
    const projection = {
      thread: {
        id: threadId,
        projectId,
        worktreePath,
        branch,
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId: providerInstanceId, model: "test-model" },
      },
      providerThread,
      providerSession: undefined,
      checkpoint: { id: checkpointId, scopeId, status: "ready", appRunOrdinal: 0 },
      scope: { id: scopeId, cwd: worktreePath },
      runsToRollback: [],
      targetAttempt: undefined,
      rolledBackAttemptIds: [],
      staleCheckpoints: [],
      rootNodes: [],
      providerTurns: [],
      repositoryScopes: [],
      repositoryCheckpoints: [],
    } as unknown as ProjectionStore.ProjectionCheckpointRollbackContext;
    const testLayer = CheckpointRollbackService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ThreadCommandExecutor.layer,
          NodeServices.layer,
          Layer.mock(ServerConfig.ServerConfig)({ worktreesDir } as never),
          ServerSettings.layerTest(),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: (id) => {
              assert.equal(id, projectId);
              return Effect.succeedSome({ workspaceRoot } as never);
            },
          }),
          Layer.mock(GitWorkflow.GitWorkflowService)({
            pruneWorktrees: (input) =>
              Effect.sync(() => {
                assert.deepEqual(input, { cwd: workspaceRoot });
                calls.push("prune");
              }),
            createWorktree: (input) =>
              Effect.gen(function* () {
                assert.deepEqual(input, {
                  cwd: workspaceRoot,
                  refName: branch,
                  path: worktreePath,
                });
                calls.push("create");
                yield* fileSystem.makeDirectory(worktreePath).pipe(Effect.orDie);
                return {} as never;
              }),
          }),
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            restore: () =>
              Effect.gen(function* () {
                assert.isTrue(yield* fileSystem.exists(worktreePath).pipe(Effect.orDie));
                calls.push("files");
              }),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: () =>
              Effect.sync(() => {
                calls.push("projection");
                return [];
              }),
          }),
          IdAllocator.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThread: () => Effect.succeed(projection.thread),
            getCheckpointRollbackContext: () => Effect.succeed(projection),
            getCheckpointContext: () =>
              Effect.succeed({ runs: [], checkpointScopes: [], checkpoints: [] }),
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: [],
                archivedThreads: [],
              }),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            open: (input) =>
              Effect.gen(function* () {
                assert.equal(input.runtimePolicy.cwd, worktreePath);
                if (!(yield* fileSystem.exists(worktreePath).pipe(Effect.orDie))) {
                  return yield* new ProviderWorkspaceMissingError({ threadId, cwd: worktreePath });
                }
                calls.push("session");
                yield* Deferred.succeed(openEntered, undefined);
                if (order === "rollback-first") yield* Deferred.await(release);
                return {} as never;
              }),
          }),
          Layer.mock(RuntimePolicy.RuntimePolicyV2)({
            resolve: ({ thread }) => {
              assert.equal(thread.worktreePath, worktreePath);
              return Effect.succeed({ cwd: thread.worktreePath } as never);
            },
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
      const cleanupEffect = withWorkspaceLease(
        worktreePath,
        Effect.gen(function* () {
          cleanupEntered = true;
          if (order === "cleanup-first") yield* Deferred.await(release);
          yield* fileSystem.remove(worktreePath, { recursive: true, force: true });
          calls.push("cleanup");
        }),
      );
      const cleanup =
        order === "cleanup-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      const rollback = yield* service
        .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles })
        .pipe(Effect.forkChild({ startImmediately: true }));
      if (order === "cleanup-first") assert.deepEqual(calls, []);
      if (order === "rollback-first") yield* Deferred.await(openEntered);
      const laterCleanup =
        order === "rollback-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      if (order === "rollback-first") assert.isFalse(cleanupEntered);
      yield* Deferred.succeed(release, undefined);
      if (cleanup !== undefined) yield* Fiber.join(cleanup);
      if (unmanaged) {
        const error = yield* Fiber.join(rollback).pipe(Effect.flip);
        assert.equal(error._tag, "CheckpointRollbackExecutionError");
        assert.deepEqual(calls, ["cleanup"]);
        return;
      }
      yield* Fiber.join(rollback);
      if (laterCleanup !== undefined) yield* Fiber.join(laterCleanup);
      const rollbackCalls = restoreFiles
        ? ["session", "files", "projection"]
        : ["session", "projection"];
      assert.deepEqual(
        calls,
        order === "cleanup-first"
          ? ["cleanup", "prune", "create", ...rollbackCalls]
          : [...rollbackCalls, "cleanup"],
      );
    }).pipe(Effect.provide(testLayer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const seedRollbackHistory = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("rollback-history");
  const providerThreadId = ProviderThreadId.make("rollback-history-provider");
  const providerSessionId = ProviderSessionId.make("rollback-history-session");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const driver = ProviderDriverKind.make("codex");
  const modelSelection = { instanceId: providerInstanceId, model: "test" };
  const scopeId = CheckpointScopeId.make("rollback-history-root");
  const otherScopeId = CheckpointScopeId.make("rollback-history-child");
  const runId = (ordinal: number) => RunId.make(`rollback-history-run-${ordinal}`);
  const nodeId = (ordinal: number) => NodeId.make(`rollback-history-node-${ordinal}`);
  const attemptId = (ordinal: number) => RunAttemptId.make(`rollback-history-attempt-${ordinal}`);
  const turnId = (ordinal: number) => ProviderTurnId.make(`rollback-history-turn-${ordinal}`);
  const checkpointId = (ordinal: number) =>
    CheckpointId.make(`rollback-history-checkpoint-${ordinal}`);
  type EventInput<Event = OrchestrationV2DomainEvent> = Event extends OrchestrationV2DomainEvent
    ? Omit<Event, "id" | "occurredAt" | "threadId">
    : never;
  let sequence = 0;
  const apply = (event: EventInput) =>
    store.apply({
      ...event,
      id: EventId.make(`rollback-history-event-${sequence++}`),
      threadId,
      occurredAt: now,
    } as OrchestrationV2DomainEvent);
  yield* apply({
    type: "thread.created",
    payload: {
      id: threadId,
      createdBy: "user",
      creationSource: "web",
      projectId: ProjectId.make("rollback-history-project"),
      title: "Rollback history",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: process.cwd(),
      activeProviderThreadId: providerThreadId,
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
  const providerThread = {
    id: providerThreadId,
    driver,
    providerInstanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle" as const,
    firstRunOrdinal: 1,
    lastRunOrdinal: 6,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  yield* apply({ type: "provider-thread.updated", payload: providerThread });
  for (const id of [scopeId, otherScopeId]) {
    yield* apply({
      type: "checkpoint-scope.created",
      payload: {
        id,
        threadId,
        runId: runId(1),
        nodeId: nodeId(1),
        parentScopeId: id === scopeId ? null : scopeId,
        providerThreadId,
        kind: id === scopeId ? "root_run" : "subagent",
        ordinalWithinParent: 0,
        advancesAppRunCount: id === scopeId,
        cwd: process.cwd(),
        createdAt: now,
      },
    });
  }
  const statuses = [
    "completed",
    "completed",
    "completed",
    "interrupted",
    "failed",
    "cancelled",
    "rolled_back",
  ] as const;
  for (const [index, status] of statuses.entries()) {
    const ordinal = index + 1;
    yield* apply({
      type: "run.created",
      payload: {
        id: runId(ordinal),
        threadId,
        ordinal,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`rollback-history-message-${ordinal}`),
        rootNodeId: nodeId(ordinal),
        activeAttemptId: attemptId(ordinal),
        status,
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: checkpointId(ordinal),
        contextHandoffId: null,
      },
    });
    yield* apply({
      type: "node.updated",
      payload: {
        id: nodeId(ordinal),
        threadId,
        runId: runId(ordinal),
        parentNodeId: null,
        rootNodeId: nodeId(ordinal),
        kind: "root_turn",
        status,
        countsForRun: true,
        providerThreadId,
        providerTurnId: turnId(ordinal),
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: scopeId,
        startedAt: now,
        completedAt: now,
      },
    });
    // Rollback must exclude every attempt of discarded runs, including an inactive retry.
    for (const attemptOrdinal of ordinal === 7 ? [6.5, 7] : [ordinal]) {
      yield* apply({
        type: "run-attempt.created",
        runId: runId(ordinal),
        payload: {
          id: attemptId(attemptOrdinal),
          runId: runId(ordinal),
          attemptOrdinal: attemptOrdinal === ordinal ? 2 : 1,
          rootNodeId: nodeId(ordinal),
          providerInstanceId,
          providerThreadId,
          providerTurnId: turnId(attemptOrdinal),
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* apply({
        type: "provider-turn.updated",
        payload: {
          id: turnId(attemptOrdinal),
          providerThreadId,
          nodeId: nodeId(ordinal),
          runAttemptId: attemptId(attemptOrdinal),
          nativeTurnRef: { driver, nativeId: `native-turn-${attemptOrdinal}`, strength: "strong" },
          ordinal: attemptOrdinal * 2,
          status: status === "rolled_back" ? "completed" : status,
          startedAt: now,
          completedAt: now,
        },
      });
    }
  }
  // A continuation shares the target attempt; its first provider turn is no longer the boundary.
  yield* apply({
    type: "provider-turn.updated",
    payload: {
      id: turnId(2.5),
      providerThreadId,
      nodeId: nodeId(2),
      runAttemptId: attemptId(2),
      nativeTurnRef: { driver, nativeId: "native-turn-2-continuation", strength: "strong" },
      ordinal: 5,
      status: "completed",
      startedAt: now,
      completedAt: now,
    },
  });
  for (let ordinal = 0; ordinal <= 8; ordinal++) {
    yield* apply({
      type: "checkpoint.captured",
      payload: {
        id: checkpointId(ordinal),
        threadId,
        scopeId: ordinal === 8 ? otherScopeId : scopeId,
        runId: ordinal === 0 ? null : runId(Math.min(ordinal, 7)),
        nodeId: nodeId(Math.max(1, Math.min(ordinal, 7))),
        parentCheckpointId: null,
        ordinalWithinScope: ordinal,
        appRunOrdinal: ordinal === 0 ? null : ordinal,
        ref: CheckpointRef.make(`refs/t3/rollback-history/${ordinal}`),
        status: ordinal === 7 ? "stale" : "ready",
        files: [],
        capturedAt: now,
      },
    });
  }

  const rollbackCounts: number[] = [];
  const restored: CheckpointId[] = [];
  const deletedRefs: CheckpointId[] = [];
  const committed: OrchestrationV2DomainEvent[] = [];
  const serviceLayer = layerCheckpointRollbackService.pipe(
    Layer.provide(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        IdAllocator.layer,
        Layer.mock(CheckpointService.CheckpointServiceV2)({
          restore: ({ checkpoint }) =>
            Effect.sync(() => {
              restored.push(checkpoint.id);
            }),
          deleteStaleRefs: ({ checkpoints }) =>
            Effect.sync(() => {
              deletedRefs.push(...checkpoints.map((checkpoint) => checkpoint.id));
            }),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: ({ events }) =>
            Effect.gen(function* () {
              for (const event of events) yield* store.apply(event);
              committed.push(...events);
              return [];
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new EventSink.EventSinkWriteError({
                    eventCount: events.length,
                    cause,
                  }),
              ),
            ),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              rollbackThread: (input: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
                Effect.gen(function* () {
                  rollbackCounts.push(yield* resolveCodexRollbackTurnCount(input));
                  return { providerThread: input.providerThread };
                }),
            } as never),
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
      ),
    ),
  );
  const rollback = (ordinal: number) =>
    Effect.gen(function* () {
      const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
      yield* service.execute({
        threadId,
        providerThreadId,
        scopeId,
        checkpointId: checkpointId(ordinal),
      });
    }).pipe(Effect.provide(serviceLayer));

  return {
    store,
    now,
    threadId,
    runId,
    nodeId,
    checkpointId,
    rollback,
    rollbackCounts,
    restored,
    deletedRefs,
    committed,
  };
});

it.layer(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "rollback history reads",
  (it) => {
    it.effect("rolls back later terminal runs despite obsolete unrelated SQLite payloads", () =>
      Effect.gen(function* () {
        const history = yield* seedRollbackHistory;
        const sql = yield* SqlClient.SqlClient;
        const { threadId, runId, nodeId, checkpointId } = history;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES ('rollback-obsolete-transcript', ${threadId}, ${runId(1)}, ${nodeId(1)},
            NULL, NULL, NULL, 1, 'assistant_message', 'completed', ${DateTime.formatIso(history.now)},
            '{"obsolete":"transcript"}')`;
        yield* sql`UPDATE orchestration_v2_projection_runs
          SET payload_json = '{"obsolete":"run"}' WHERE run_id = ${runId(1)}`;
        yield* sql`UPDATE orchestration_v2_projection_nodes
          SET payload_json = '{"obsolete":"node"}' WHERE node_id = ${nodeId(1)}`;
        yield* sql`UPDATE orchestration_v2_projection_checkpoints
          SET payload_json = json_set(payload_json, '$.files', 'obsolete file summary')
          WHERE checkpoint_id IN (${checkpointId(0)}, ${checkpointId(1)}, ${checkpointId(7)}, ${checkpointId(8)})`;
        assert.equal(
          (yield* Effect.exit(history.store.getThreadProjection(threadId)))._tag,
          "Failure",
        );

        yield* history.rollback(2);

        assert.deepEqual(history.rollbackCounts, [4]);
        assert.deepEqual(history.restored, [checkpointId(2)]);
        assert.sameMembers(history.deletedRefs, [3, 4, 5, 6].map(checkpointId));
        const runs = yield* sql<{ ordinal: number; status: string }>`
          SELECT ordinal, status FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId} ORDER BY ordinal`;
        assert.deepEqual(
          runs.map((run) => run.status),
          [
            "completed",
            "completed",
            "rolled_back",
            "rolled_back",
            "rolled_back",
            "rolled_back",
            "rolled_back",
          ],
        );
        const nodes = yield* sql<{ status: string }>`
          SELECT status FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId} ORDER BY node_id`;
        assert.deepEqual(
          nodes.map((node) => node.status),
          runs.map((run) => run.status),
        );
        const checkpoints = yield* sql<{ status: string }>`
          SELECT status FROM orchestration_v2_projection_checkpoints
          WHERE thread_id = ${threadId} ORDER BY ordinal_within_scope`;
        assert.deepEqual(
          checkpoints.map((checkpoint) => checkpoint.status),
          ["ready", "ready", "ready", "stale", "stale", "stale", "stale", "stale", "ready"],
        );
      }),
    );

    it.effect(
      "rewinds stopped runs repeatedly without counting discarded provider turns again",
      () =>
        Effect.gen(function* () {
          const history = yield* seedRollbackHistory;
          yield* history.rollback(5);
          yield* history.rollback(2);
          yield* history.rollback(0);
          yield* history.rollback(0);

          assert.deepEqual(history.rollbackCounts, [1, 3, 3]);
          assert.sameMembers(history.deletedRefs, [1, 2, 3, 4, 5, 6].map(history.checkpointId));
          assert.sameMembers(
            history.committed
              .filter((event) => event.type === "run.updated")
              .map((event) => event.payload.id),
            [1, 2, 3, 4, 5, 6].map(history.runId),
          );
          const records = yield* history.store.getThreadRecords(history.threadId, [
            "runs",
            "nodes",
            "checkpoints",
          ]);
          assert.isTrue(records.runs.every((run) => run.status === "rolled_back"));
          assert.isTrue(records.nodes.every((node) => node.status === "rolled_back"));
          assert.sameMembers(
            records.checkpoints
              .filter((checkpoint) => checkpoint.status === "ready")
              .map((checkpoint) => checkpoint.id),
            [history.checkpointId(0), history.checkpointId(8)],
          );
        }),
    );
  },
);

const layerVcsProcessTest = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerRealCheckpoints = CheckpointService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      CheckpointStore.layer.pipe(
        Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcessTest))),
        Layer.provide(NodeServices.layer),
      ),
      IdAllocator.layer,
      NodeCrypto.layer,
      NodeServices.layer,
    ),
  ),
);

it.effect.each(["restores", "undo", "missing-ref"] as const)(
  "rewinds every repo of a task folder, scenario=%s",
  (scenario) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const now = yield* DateTime.now;
      const task = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-rollback-task-folder-" }),
      );
      const home = path.join(task, "home");
      const git = (cwd: string, args: ReadonlyArray<string>) =>
        vcsProcess
          .run({ operation: "CheckpointRollbackService.test.git", command: "git", cwd, args })
          .pipe(Effect.map((result) => result.stdout.trim()));
      const write = (cwd: string, text: string) =>
        fileSystem.writeFileString(path.join(cwd, "a.txt"), `${text}\n`);
      const read = (cwd: string) =>
        fileSystem.readFileString(path.join(cwd, "a.txt")).pipe(Effect.map((text) => text.trim()));
      for (const repository of [home, path.join(home, "api"), path.join(task, "web")]) {
        yield* fileSystem.makeDirectory(repository, { recursive: true });
        yield* git(repository, ["init", "--quiet"]);
        yield* git(repository, ["config", "user.email", "test@test.com"]);
        yield* git(repository, ["config", "user.name", "Test"]);
        yield* write(repository, "initial");
        yield* git(repository, ["add", "a.txt"]);
        yield* git(repository, ["commit", "--quiet", "-m", "initial"]);
      }

      const threadId = ThreadId.make("rollback-task-folder");
      const providerThreadId = ProviderThreadId.make("rollback-task-folder-provider");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const runId = (ordinal: number) => RunId.make(`rollback-task-folder-run-${ordinal}`);
      const nodeId = NodeId.make("rollback-task-folder-node");
      const rootScope = yield* checkpoints.prepareRootRunScope({
        threadId,
        runId: runId(2),
        rootNodeId: nodeId,
        providerThreadId,
        cwd: home,
        createdAt: now,
      });
      const [apiScope, webScope] = yield* checkpoints.prepareRepositoryScopes({
        rootScope,
        repositories: [
          { name: "api", cwd: path.join(home, "api"), originalPath: "/tracked/api" },
          { name: "web", cwd: path.join(task, "web"), originalPath: "/tracked/web" },
        ],
      });
      if (apiScope === undefined || webScope === undefined) return yield* Effect.die("no scopes");
      const repositoryScopes = [apiScope, webScope];
      const records: Array<OrchestrationV2Checkpoint> = [];
      const baseline = (scope: OrchestrationV2CheckpointScope, ordinalWithinScope: number) =>
        Effect.gen(function* () {
          yield* checkpoints.captureBaseline({
            scope,
            ordinalWithinScope,
            ...(scope === rootScope ? { repositoryScopes } : {}),
          });
          const record = yield* checkpoints.materializeBaselineCheckpoint({
            scope,
            ordinalWithinScope,
          });
          if (record !== null) records.push(record);
        });
      const capture = (scope: OrchestrationV2CheckpointScope, ordinal: number) =>
        checkpoints
          .capture({
            scope,
            runId: runId(ordinal),
            nodeId,
            ordinalWithinScope: ordinal,
            appRunOrdinal: scope === rootScope ? ordinal : null,
            capturedAt: now,
            ...(scope === rootScope ? { repositoryScopes } : {}),
          })
          .pipe(Effect.tap((checkpoint) => Effect.sync(() => records.push(checkpoint))));

      // Run 1 edits home and api; web joins at run 2 after the user edited it.
      yield* baseline(rootScope, 0);
      yield* baseline(apiScope, 0);
      yield* write(home, "turn 1");
      yield* write(apiScope.cwd, "turn 1");
      yield* capture(rootScope, 1);
      yield* capture(apiScope, 1);
      yield* write(webScope.cwd, "before run 2");
      yield* baseline(webScope, 1);
      for (const scope of [rootScope, apiScope, webScope]) yield* write(scope.cwd, "turn 2");
      for (const scope of [rootScope, apiScope, webScope]) yield* capture(scope, 2);
      const refOf = (scope: OrchestrationV2CheckpointScope, ordinal: number) =>
        records.find(
          (record) => record.scopeId === scope.id && record.ordinalWithinScope === ordinal,
        )!.ref;
      if (scenario === "missing-ref") {
        yield* git(webScope.cwd, ["update-ref", "-d", refOf(webScope, 1)]);
      }

      const target = records.find(
        (record) => record.scopeId === rootScope.id && record.ordinalWithinScope === 0,
      )!;
      const thread = {
        id: threadId,
        projectId: ProjectId.make("rollback-task-folder-project"),
        worktreePath: home,
        branch: null,
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId: providerInstanceId, model: "test" },
      };
      const providerThread = {
        id: providerThreadId,
        driver: ProviderDriverKind.make("codex"),
        providerSessionId: ProviderSessionId.make("rollback-task-folder-session"),
        providerInstanceId,
        nativeThreadRef: null,
      };
      const context = {
        thread,
        providerThread,
        providerSession: undefined,
        checkpoint: target,
        scope: rootScope,
        targetAttempt: undefined,
        providerTurns: [],
        rolledBackAttemptIds: [],
        runsToRollback: [1, 2].map((ordinal) => ({
          id: runId(ordinal),
          ordinal,
          status: "completed",
          rootNodeId: NodeId.make(`rollback-task-folder-node-${ordinal}`),
          providerInstanceId,
        })),
        rootNodes: [],
        staleCheckpoints: records.filter(
          (record) => record.scopeId === rootScope.id && record.ordinalWithinScope > 0,
        ),
        repositoryScopes,
        repositoryCheckpoints: records.filter((record) => record.scopeId !== rootScope.id),
      } as unknown as ProjectionStore.ProjectionCheckpointRollbackContext;
      const calls: Array<string> = [];
      const written: Array<OrchestrationV2DomainEvent> = [];
      let failWebRestore = scenario === "undo";
      const layerTest = layerCheckpointRollbackService.pipe(
        Layer.provide(
          Layer.mergeAll(
            ThreadCommandExecutor.layer,
            IdAllocator.layer,
            Layer.succeed(CheckpointService.CheckpointServiceV2, {
              ...checkpoints,
              restore: (input) => {
                calls.push(`restore:${input.scope.label ?? "home"}`);
                if (input.scope.id === webScope.id && failWebRestore) {
                  failWebRestore = false;
                  return Effect.fail(
                    new CheckpointService.CheckpointRestoreError({
                      scopeId: input.scope.id,
                      checkpointId: input.checkpoint.id,
                      cause: "disk full",
                    }),
                  );
                }
                return checkpoints.restore(input);
              },
            }),
            Layer.mock(EventSink.EventSinkV2)({
              write: ({ events }) => Effect.sync(() => (written.push(...events), [])),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThread: () => Effect.succeed(thread as never),
              getCheckpointRollbackContext: () => Effect.succeed(context),
              getCheckpointContext: () =>
                Effect.succeed({
                  runs: [],
                  checkpoints: [],
                  checkpointScopes: [rootScope, ...repositoryScopes],
                }),
              getShellSnapshot: () =>
                Effect.succeed({
                  schemaVersion: 1,
                  snapshotSequence: 0,
                  threads: [],
                  archivedThreads: [],
                }),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              open: () =>
                Effect.succeed({
                  rollbackThread: () =>
                    Effect.sync(() => {
                      calls.push("provider");
                      return { providerThread };
                    }),
                } as never),
            }),
            Layer.mock(RuntimePolicy.RuntimePolicyV2)({
              resolve: () => Effect.succeed({} as never),
            }),
            Layer.mock(TaskFolderStore)({
              findContaining: () => Effect.succeedSome({ root: task } as never),
            }),
          ),
        ),
      );
      const result = yield* CheckpointRollbackService.CheckpointRollbackServiceV2.pipe(
        Effect.flatMap((service) =>
          service
            .execute({
              threadId,
              providerThreadId,
              checkpointId: target.id,
              scopeId: rootScope.id,
            })
            .pipe(Effect.flip, Effect.option),
        ),
        Effect.provide(layerTest),
      );

      const contents = yield* Effect.forEach([home, apiScope.cwd, webScope.cwd], read);
      const hasRef = (scope: OrchestrationV2CheckpointScope, ordinal: number) =>
        git(scope.cwd, ["rev-parse", "--verify", "--quiet", refOf(scope, ordinal)]).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      if (scenario === "restores") {
        assert.isTrue(Option.isNone(result));
        // web goes back to its first baseline, taken when it joined at run 2.
        assert.deepEqual(contents, ["initial", "initial", "before run 2"]);
        assert.deepEqual(calls, ["provider", "restore:home", "restore:api", "restore:web"]);
        assert.deepEqual(
          yield* Effect.forEach(
            [
              [apiScope, 1],
              [apiScope, 2],
              [webScope, 1],
              [webScope, 2],
            ] as const,
            ([scope, ordinal]) => hasRef(scope, ordinal),
          ),
          [false, false, true, false],
        );
        assert.sameMembers(
          written.flatMap((event) =>
            event.type === "checkpoint.captured" && event.payload.status === "stale"
              ? [
                  `${event.payload.scopeId === rootScope.id ? "home" : event.payload.scopeId === apiScope.id ? "api" : "web"}:${event.payload.ordinalWithinScope}`,
                ]
              : [],
          ),
          ["home:1", "home:2", "api:1", "api:2", "web:2"],
        );
        return;
      }
      const error = Option.getOrThrow(result);
      assert.isEmpty(written);
      assert.deepEqual(contents, ["turn 2", "turn 2", "turn 2"]);
      if (scenario === "undo") {
        assert.equal(error.reason, "repository-restore-failed");
        assert.deepEqual(calls, [
          "provider",
          "restore:home",
          "restore:api",
          "restore:web",
          "restore:home",
          "restore:api",
          "restore:web",
        ]);
        assert.equal(
          CheckpointRollbackService.rollbackFailureClientMessage(error),
          "Could not restore files in web. Every repo is back to how it was before the rewind.",
        );
        return;
      }
      assert.equal(error.reason, "repository-checkpoint-unavailable");
      assert.deepEqual(calls, []);
      assert.equal(
        CheckpointRollbackService.rollbackFailureClientMessage(error),
        "Cannot restore files: web has no checkpoint for that turn. Rewind the conversation without restoring files instead.",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(layerRealCheckpoints, layerVcsProcessTest, NodeServices.layer)),
    ),
);
