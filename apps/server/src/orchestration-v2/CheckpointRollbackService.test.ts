import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Layer from "effect/Layer";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";
import { resolveCodexRollbackTurnCount } from "./Adapters/CodexAdapterV2.ts";
import { isCheckpointRestoreIsolated } from "./CheckpointRestoreSafety.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { ProviderAdapterV2RollbackThreadInput } from "./ProviderAdapter.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

// A root that does not exist never overlaps, so other owners decide isolation.
const unrelatedProject = Option.some({
  workspaceRoot: "/nonexistent/t3-rollback-project",
} as never);
const checkpointRollbackServiceLayer = CheckpointRollbackService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
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
    let readCount = 0;
    let projection = {
      thread: {
        worktreePath: process.cwd(),
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId: providerInstanceId, model: "test-model" },
      },
      providerThreads: [{ id: providerThreadId, providerSessionId, providerInstanceId }],
      checkpoints: [
        {
          id: checkpointId,
          scopeId,
          status: state === "waiting" ? "ready" : "stale",
          appRunOrdinal: 0,
        },
      ],
      checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
    } as unknown as OrchestrationV2ThreadProjection;
    const getThreadRecords = vi.fn<ProjectionStore.ProjectionStoreV2Shape["getThreadRecords"]>(
      () => {
        const current = projection;
        readCount++;
        return readCount === 1
          ? Deferred.succeed(readEntered, undefined).pipe(Effect.as(current))
          : Effect.succeed(current);
      },
    );
    const testLayer = checkpointRollbackServiceLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointService.CheckpointServiceV2)({ restore }),
          Layer.mock(EventSink.EventSinkV2)({}),
          IdAllocator.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadRecords,
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
          checkpoints: projection.checkpoints.map((checkpoint) => ({
            ...checkpoint,
            status: "stale",
          })),
        };
        yield* Deferred.succeed(release, undefined);
        if (holder !== undefined) yield* Fiber.join(holder);
      }
      const error = yield* Fiber.join(rollback);

      assert.equal(getThreadRecords.mock.calls.length, 2);
      assert.deepEqual(getThreadRecords.mock.calls[0]?.[1], []);
      assert.equal(getThreadRecords.mock.calls[1]?.[1].includes("checkpoints"), true);
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

it.effect("rejects a rollback when another provider thread became active", () => {
  const threadId = ThreadId.make("thread:rollback-inactive-provider-thread");
  const requestedProviderThreadId = ProviderThreadId.make(
    "provider-thread:rollback-inactive-provider-thread:requested",
  );
  const activeProviderThreadId = ProviderThreadId.make(
    "provider-thread:rollback-inactive-provider-thread:active",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-inactive-provider-thread",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-inactive-provider-thread");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-inactive-provider-thread");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_inactive_provider_thread");
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      activeProviderThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [
      {
        id: requestedProviderThreadId,
        providerSessionId,
        providerInstanceId,
      },
    ],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready" }],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointService.CheckpointServiceV2)({ restore }),
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
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
    const error = yield* service
      .execute({
        threadId,
        providerThreadId: requestedProviderThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "active-provider-changed");
    assert.equal(
      error.message,
      `Active provider changed before rollback target ${checkpointId} could execute on thread ${threadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("rejects a rollback when provider selection changed before execution", () => {
  const threadId = ThreadId.make("thread:rollback-provider-selection-changed");
  const providerThreadId = ProviderThreadId.make(
    "provider-thread:rollback-provider-selection-changed",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-provider-selection-changed",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-provider-selection-changed");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-provider-selection-changed");
  const originalProviderInstanceId = ProviderInstanceId.make(
    "provider_rollback_provider_selection_changed_original",
  );
  const selectedProviderInstanceId = ProviderInstanceId.make(
    "provider_rollback_provider_selection_changed_selected",
  );
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      worktreePath: process.cwd(),
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: selectedProviderInstanceId, model: "test-model" },
    },
    providerThreads: [
      {
        id: providerThreadId,
        providerSessionId,
        providerInstanceId: originalProviderInstanceId,
      },
    ],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready" }],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointService.CheckpointServiceV2)({ restore }),
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
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
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "active-provider-changed");
    assert.equal(
      error.message,
      `Active provider changed before rollback target ${checkpointId} could execute on thread ${threadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("rejects an unavailable rollback target before opening a session", () => {
  const threadId = ThreadId.make("thread:rollback-provider-turn-unavailable");
  const providerThreadId = ProviderThreadId.make(
    "provider-thread:rollback-provider-turn-unavailable",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-provider-turn-unavailable",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-provider-turn-unavailable");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-provider-turn-unavailable");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_provider_turn_unavailable");
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const projection = {
    thread: {
      worktreePath: "/tmp/missing-invalid-rollback-worktree",
      branch: "feature/rollback",
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [{ id: providerThreadId, providerSessionId, providerInstanceId }],
    providerSessions: [],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready", appRunOrdinal: 1 }],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
    runs: [],
    attempts: [],
    providerTurns: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointService.CheckpointServiceV2)({ restore }),
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open,
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles: false })
      .pipe(Effect.flip);
    assert.equal(open.mock.calls.length, 0);
    assert.equal(error.reason, "provider-turn-unavailable");
    assert.equal(
      error.message,
      `Provider turn for rollback target ${checkpointId} is unavailable on provider thread ${providerThreadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect.each(
  [
    { order: "normal", restoreFiles: true, mutation: "none", alias: "none" },
    { order: "cleanup-first", restoreFiles: true, mutation: "none", alias: "none" },
    { order: "cleanup-first", restoreFiles: false, mutation: "none", alias: "none" },
    { order: "rollback-first", restoreFiles: true, mutation: "none", alias: "none" },
    { order: "cleanup-first", restoreFiles: true, mutation: "none", alias: "direct" },
    { order: "cleanup-first", restoreFiles: false, mutation: "none", alias: "parent" },
    { order: "cleanup-first", restoreFiles: true, mutation: "none", alias: "missing-parent" },
    { order: "cleanup-first", restoreFiles: false, mutation: "none", alias: "dangling" },
    { order: "rollback-first", restoreFiles: true, mutation: "none", alias: "direct" },
    { order: "rollback-first", restoreFiles: false, mutation: "none", alias: "parent" },
    { order: "rollback-first", restoreFiles: true, mutation: "none", alias: "missing-parent" },
    { order: "rollback-first", restoreFiles: false, mutation: "none", alias: "dangling" },
    { order: "cleanup-first", restoreFiles: true, mutation: "worktree", alias: "none" },
    { order: "cleanup-first", restoreFiles: true, mutation: "root", alias: "none" },
  ].filter(({ alias }) => alias === "none" || symlinksSupported),
)("locks rollback with %s", ({ order, restoreFiles, alias, mutation }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-rollback-" });
    let worktreePath = path.join(workspaceRoot, "worktree");
    const initialWorktreePath = worktreePath;
    yield* fileSystem.makeDirectory(worktreePath);
    const aliasPath = path.join(workspaceRoot, "alias");
    const parentAlias = alias === "parent" || alias === "missing-parent";
    if (alias !== "none") {
      yield* fileSystem.symlink(parentAlias ? workspaceRoot : worktreePath, aliasPath);
    }
    const threadPath =
      alias === "none" ? worktreePath : parentAlias ? path.join(aliasPath, "worktree") : aliasPath;
    if (alias === "missing-parent" || alias === "dangling") {
      yield* fileSystem.remove(worktreePath, { recursive: true });
    }
    const threadId = ThreadId.make("rollback-worktree");
    const projectId = ProjectId.make("rollback-worktree-project");
    const providerThreadId = ProviderThreadId.make("rollback-worktree-provider-thread");
    const providerSessionId = ProviderSessionId.make("rollback-worktree-provider-session");
    const providerInstanceId = ProviderInstanceId.make("rollback-worktree-provider-instance");
    const checkpointId = CheckpointId.make("rollback-worktree-checkpoint");
    const scopeId = CheckpointScopeId.make("rollback-worktree-scope");
    const branch = "feature/rollback";
    const release = Deferred.makeUnsafe<void>();
    const releaseNew = Deferred.makeUnsafe<void>();
    const readEntered = Deferred.makeUnsafe<void>();
    let readCount = 0;
    let newLeaseReleased = false;
    const openEntered = Deferred.makeUnsafe<void>();
    const calls: string[] = [];
    let cleanupEntered = false;
    const providerThread = { id: providerThreadId, providerSessionId, providerInstanceId };
    let projection = {
      thread: {
        id: threadId,
        projectId,
        worktreePath: mutation === "root" ? null : threadPath,
        branch,
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId: providerInstanceId, model: "test-model" },
      },
      providerThreads: [providerThread],
      providerSessions: [],
      checkpoints: [{ id: checkpointId, scopeId, status: "ready", appRunOrdinal: 0 }],
      checkpointScopes: [{ id: scopeId, cwd: worktreePath }],
      runs: [],
      attempts: [],
      nodes: [],
      providerTurns: [],
    } as unknown as OrchestrationV2ThreadProjection;
    const testLayer = CheckpointRollbackService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: (id) => {
              assert.equal(id, projectId);
              return Effect.succeed(Option.some({ workspaceRoot } as never));
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
            getThreadRecords: () => {
              const current = projection;
              readCount++;
              return readCount === 1 && mutation !== "none"
                ? Deferred.succeed(readEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.as(current),
                  )
                : Effect.succeed(current);
            },
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
                if (mutation !== "none") assert.isTrue(newLeaseReleased);
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
        initialWorktreePath,
        Effect.gen(function* () {
          cleanupEntered = true;
          if (order === "cleanup-first") yield* Deferred.await(release);
          yield* fileSystem.remove(initialWorktreePath, { recursive: true, force: true });
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
      if (mutation !== "none") yield* Deferred.await(readEntered);
      const newPath = path.join(workspaceRoot, "new-worktree");
      const newHolder =
        mutation !== "none"
          ? yield* withWorkspaceLease(
              newPath,
              Deferred.await(releaseNew).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    newLeaseReleased = true;
                  }),
                ),
              ),
            ).pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      if (mutation !== "none") {
        worktreePath = newPath;
        projection = {
          ...projection,
          thread: { ...projection.thread, worktreePath },
          checkpointScopes: projection.checkpointScopes.map((scope) => ({
            ...scope,
            cwd: worktreePath,
          })),
        };
      }
      if (order === "cleanup-first") assert.deepEqual(calls, []);
      if (order === "rollback-first") yield* Deferred.await(openEntered);
      const laterCleanup =
        order === "rollback-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      if (order === "rollback-first") assert.isFalse(cleanupEntered);
      yield* Deferred.succeed(release, undefined);
      if (cleanup !== undefined) yield* Fiber.join(cleanup);
      if (newHolder !== undefined) {
        assert.deepEqual(calls, ["cleanup"]);
        yield* Deferred.succeed(releaseNew, undefined);
        yield* Fiber.join(newHolder);
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
          : order === "rollback-first"
            ? [
                ...(alias === "missing-parent" || alias === "dangling" ? ["prune", "create"] : []),
                ...rollbackCalls,
                "cleanup",
              ]
            : rollbackCalls,
      );
    }).pipe(Effect.provide(testLayer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { restoreFiles: true, shared: "none" },
  { restoreFiles: false, shared: "root" },
  { restoreFiles: true, shared: "root" },
  { restoreFiles: true, shared: "worktree" },
  { restoreFiles: false, shared: "worktree" },
  { restoreFiles: true, shared: "historical" },
  { restoreFiles: false, shared: "none", targetOrdinal: 1 },
])("rewinds safely with %s", ({ restoreFiles, shared, targetOrdinal = 0 }) => {
  const threadId = ThreadId.make("rewind-files");
  const providerThreadId = ProviderThreadId.make("rewind-provider");
  const providerSessionId = ProviderSessionId.make("rewind-session");
  const instanceId = ProviderInstanceId.make("rewind-instance");
  const checkpointId = CheckpointId.make("rewind-start");
  const scopeId = CheckpointScopeId.make("rewind-scope");
  const calls: string[] = [];
  const providerThread = {
    id: providerThreadId,
    providerSessionId,
    providerInstanceId: instanceId,
  };
  const projection = {
    thread: {
      worktreePath: shared === "root" ? null : process.cwd(),
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId, model: "test" },
    },
    providerThreads: [providerThread],
    providerSessions: [],
    // Turn 3 remains in the audit history after an earlier rollback.
    providerTurns: [1, 2, 3].map((ordinal) => ({
      id: `turn-${ordinal}`,
      providerThreadId,
      runAttemptId: `attempt-${ordinal}`,
      ordinal,
      status: "completed",
    })),
    nodes: [],
    attempts: [1, 2, 3].map((ordinal) => ({ id: `attempt-${ordinal}`, runId: `run-${ordinal}` })),
    checkpoints: [
      { id: checkpointId, scopeId, status: "ready", appRunOrdinal: targetOrdinal || null },
    ],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
    runs: [1, 2, 3].map((ordinal) => ({
      id: `run-${ordinal}`,
      ordinal,
      status: ordinal === 3 ? "rolled_back" : "completed",
      rootNodeId: null,
      activeAttemptId: `attempt-${ordinal}`,
    })),
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointService.CheckpointServiceV2)({
          restore: () =>
            Effect.sync(() => {
              calls.push("files");
            }),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: ({ events }) =>
            Effect.sync(() => {
              assert.ok(
                events.some(
                  (event) => event.type === "run.updated" && event.payload.status === "rolled_back",
                ),
              );
              calls.push("projection");
              return [];
            }),
        }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
          getThreadProviderContext: () => Effect.succeed({ providerSessions: [] } as never),
          getCheckpointContext: () =>
            Effect.succeed({
              checkpointScopes: [{ cwd: process.cwd() }],
              runs: [],
              checkpoints: [],
            } as never),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads:
                shared === "worktree" || shared === "historical"
                  ? [
                      {
                        id: ThreadId.make("other-thread"),
                        deletedAt: null,
                        worktreePath: shared === "worktree" ? process.cwd() : null,
                      } as never,
                    ]
                  : [],
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              rollbackThread: (input: ProviderAdapterV2RollbackThreadInput) =>
                Effect.gen(function* () {
                  const count = yield* resolveCodexRollbackTurnCount(input);
                  assert.equal(count, 2 - targetOrdinal);
                  calls.push("provider");
                  return { providerThread };
                }),
            } as never),
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
    if (restoreFiles && shared !== "none") {
      const error = yield* Effect.flip(
        service.execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles }),
      );
      assert.equal(error.reason, "shared-workspace");
      assert.deepEqual(calls, []);
      return;
    }
    yield* service.execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles });
    assert.deepEqual(
      calls,
      restoreFiles ? ["provider", "files", "projection"] : ["provider", "projection"],
    );
  }).pipe(Effect.provide(testLayer));
});

it.effect.skipIf(!symlinksSupported)(
  "rejects an archived thread sharing a worktree through a symlink",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-restore-isolation-" });
      const path = yield* Path.Path;
      const alias = path.join(cwd, "alias");
      yield* fileSystem.symlink(cwd, alias);
      const threadId = ThreadId.make("restore-alias-current");
      const otherId = ThreadId.make("restore-alias-archived");
      const projections = ProjectionStore.ProjectionStoreV2.of({
        getShellSnapshot: () =>
          Effect.succeed({
            schemaVersion: 1,
            snapshotSequence: 0,
            threads: [],
            archivedThreads: [{ id: otherId, deletedAt: null, worktreePath: alias } as never],
          }),
        getThreadProviderContext: () => Effect.succeed({ providerSessions: [] } as never),
        getCheckpointContext: () =>
          Effect.succeed({ runs: [], checkpointScopes: [], checkpoints: [] }),
      } as never);
      const isolated = yield* isCheckpointRestoreIsolated(
        { id: threadId, worktreePath: cwd },
        { cwd },
        {
          fileSystem,
          path,
          projections,
          projects: ProjectStore.ProjectStoreV2.of({
            get: () => Effect.succeed(unrelatedProject),
          } as never),
        },
      );
      assert.isFalse(isolated);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
