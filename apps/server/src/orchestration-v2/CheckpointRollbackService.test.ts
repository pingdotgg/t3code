import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { resolveCodexRollbackTurnCount } from "./Adapters/CodexAdapterV2.ts";
import { isCheckpointRestoreIsolated } from "./CheckpointRestoreSafety.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import {
  buildBoundedThreadProjection,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "./threadHistoryPaging.ts";

// A root that does not exist never overlaps, so other owners decide isolation.
const unrelatedProject = Option.some({
  workspaceRoot: "/nonexistent/t3-rollback-project",
} as never);
const layerCheckpointRollbackService = CheckpointRollbackService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(unrelatedProject) }),
    ),
  ),
);

it.effect("rejects a non-ready checkpoint before opening a session or restoring files", () => {
  const threadId = ThreadId.make("thread:rollback-non-ready");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-non-ready");
  const providerSessionId = ProviderSessionId.make("provider-session:rollback-non-ready");
  const checkpointId = CheckpointId.make("checkpoint:rollback-non-ready");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-non-ready");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_non_ready");
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      worktreePath: process.cwd(),
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [{ id: providerThreadId, providerSessionId, providerInstanceId }],
    checkpoints: [{ id: checkpointId, scopeId, status: "stale" }],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
  } as unknown as OrchestrationV2ThreadProjection;
  const layerTest = layerCheckpointRollbackService.pipe(
    Layer.provide(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
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

    assert.equal(error.reason, "rollback-target-invalid");
    assert.equal(
      error.message,
      `Rollback target ${checkpointId} for provider thread ${providerThreadId} on thread ${threadId} is incomplete or invalid.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(layerTest));
});

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
  const layerTest = layerCheckpointRollbackService.pipe(
    Layer.provide(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
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
  }).pipe(Effect.provide(layerTest));
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
  const layerTest = layerCheckpointRollbackService.pipe(
    Layer.provide(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
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
  }).pipe(Effect.provide(layerTest));
});

it.effect("reports a missing provider turn as a structured rollback failure", () => {
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
  const projection = {
    thread: {
      worktreePath: process.cwd(),
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
  const layerTest = layerCheckpointRollbackService.pipe(
    Layer.provide(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
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
          open: () => Effect.succeed({} as never),
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
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "provider-turn-unavailable");
    assert.equal(
      error.message,
      `Provider turn for rollback target ${checkpointId} is unavailable on provider thread ${providerThreadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(layerTest));
});

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
  let lockedThreads = Effect.succeed<ReadonlyArray<ThreadId>>([]);
  const layerThreadCommands = Layer.effect(
    ThreadCommandExecutor.ThreadCommandExecutor,
    Effect.tap(KeyedLock.make<ThreadId>(), (lock) =>
      Effect.sync(() => {
        lockedThreads = lock.activeKeys;
      }),
    ),
  );
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
  const layerTest = layerCheckpointRollbackService.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreadCommands,
        Layer.mock(CheckpointService.CheckpointServiceV2)({
          restore: () =>
            Effect.sync(() => {
              calls.push("files");
            }),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: ({ events }) =>
            Effect.map(lockedThreads, (locked) => {
              // A thread command that planned against the old provider thread
              // must not commit after this and undo the rollback.
              assert.include(locked, threadId);
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
              rollbackThread: (input: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
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
  }).pipe(Effect.provide(layerTest));
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

it.layer(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "checkpointForRunOrdinal",
  (it) => {
    const seedThread = Effect.fn("seedThread")(function* (input: {
      readonly name: string;
      readonly runs: ReadonlyArray<
        readonly [ordinal: number, status: OrchestrationV2Run["status"]]
      >;
      /**
       * A run's checkpoint belongs to that run's root node. A baseline belongs
       * to `owner`, the run whose root node owned the scope when it was captured.
       */
      readonly checkpoints: ReadonlyArray<
        | readonly [
            ordinalWithinScope: number,
            appRunOrdinal: number,
            status: OrchestrationV2Checkpoint["status"],
          ]
        | readonly [
            ordinalWithinScope: number,
            appRunOrdinal: null,
            status: OrchestrationV2Checkpoint["status"],
            owner: number,
          ]
      >;
      /** Turn items for run 2, enough to push run 1 out of the bounded window. */
      readonly run2Items?: number;
    }) {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make(`thread:${input.name}`);
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
      const runId = (ordinal: number) => RunId.make(`run:${input.name}:${ordinal}`);
      const nodeId = (ordinal: number) => NodeId.make(`node:${input.name}:${ordinal}`);
      yield* store.apply({
        id: EventId.make(`event:${input.name}:thread`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make(`project:${input.name}`),
          title: input.name,
          providerInstanceId: modelSelection.instanceId,
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
      let itemOrdinal = 0;
      for (const [ordinal, status] of input.runs) {
        yield* store.apply({
          id: EventId.make(`event:${input.name}:run:${ordinal}`),
          type: "run.created",
          threadId,
          runId: runId(ordinal),
          nodeId: nodeId(ordinal),
          occurredAt: now,
          payload: {
            id: runId(ordinal),
            threadId,
            ordinal,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make(`message:${input.name}:${ordinal}`),
            rootNodeId: nodeId(ordinal),
            activeAttemptId: null,
            status,
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        const itemCount = ordinal === 2 ? (input.run2Items ?? 1) : 1;
        for (let index = 0; index < itemCount; index += 1) {
          itemOrdinal += 1;
          const itemId = TurnItemId.make(`item:${input.name}:${ordinal}:${index}`);
          yield* store.apply({
            id: EventId.make(`event:${input.name}:item:${ordinal}:${index}`),
            type: "turn-item.updated",
            threadId,
            runId: runId(ordinal),
            nodeId: nodeId(ordinal),
            occurredAt: now,
            payload: {
              id: itemId,
              threadId,
              runId: runId(ordinal),
              nodeId: nodeId(ordinal),
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: itemOrdinal,
              status: "completed",
              title: "command",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "command_execution",
              input: "true",
            },
          });
        }
      }
      for (const [ordinalWithinScope, appRunOrdinal, status, owner] of input.checkpoints) {
        yield* store.apply({
          id: EventId.make(`event:${input.name}:checkpoint:${ordinalWithinScope}`),
          type: "checkpoint.captured",
          threadId,
          occurredAt: now,
          payload: {
            id: CheckpointId.make(`checkpoint:${input.name}:${ordinalWithinScope}`),
            threadId,
            scopeId: CheckpointScopeId.make(`scope:${input.name}`),
            runId: appRunOrdinal === null ? null : runId(appRunOrdinal),
            nodeId: nodeId(appRunOrdinal ?? owner ?? 0),
            parentCheckpointId: null,
            ordinalWithinScope,
            appRunOrdinal,
            ref: CheckpointRef.make(`refs/t3/${input.name}/${ordinalWithinScope}`),
            status,
            files: [],
            capturedAt: now,
          },
        });
      }
      return threadId;
    });

    /** Resolves from the records the rollback command reads (`dispatchCheckpointRollback`). */
    const resolve = (threadId: ThreadId, runOrdinal: number) =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const records = yield* store.getThreadRecords(threadId, ["runs", "checkpoints"], {
          turnItemTypes: [],
          messageRoles: ["user"],
        });
        const checkpoint = CheckpointRollbackService.checkpointForRunOrdinal(records, runOrdinal);
        return checkpoint === undefined
          ? undefined
          : { id: String(checkpoint.id), status: checkpoint.status };
      });

    /** The projection clients receive from orchestration.getThreadProjection. */
    const bounded = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const snapshot = yield* store.getThreadSnapshotWindow(threadId, {
          rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
        });
        const { projection } = buildBoundedThreadProjection({
          projection: snapshot.projection,
          snapshotSequence: snapshot.snapshotSequence,
        });
        return {
          runOrdinals: projection.runs.map((run) => run.ordinal),
          checkpointSlots: projection.checkpoints.map(
            (checkpoint) => checkpoint.ordinalWithinScope,
          ),
        };
      });

    it.effect("restores the run before a prompt resent after a rewind", () =>
      Effect.gen(function* () {
        // The reporter's thread: run 6 was rewound, run 7 resent its prompt and
        // captured its baseline in slot 6, and a later run 8 was rewound too.
        const threadId = yield* seedThread({
          name: "issue",
          runs: [
            [1, "completed"],
            [2, "completed"],
            [3, "completed"],
            [4, "completed"],
            [5, "completed"],
            [6, "rolled_back"],
            [7, "interrupted"],
            [8, "rolled_back"],
          ],
          checkpoints: [
            [0, null, "ready", 1],
            [5, 5, "ready"],
            [6, null, "ready", 7],
            [7, 7, "ready"],
            [8, 8, "stale"],
          ],
          run2Items: 100,
        });

        // Clients cannot resolve this: the bounded projection omits run 6 and,
        // with run 1 outside the window, the thread-start baseline run 1 owns.
        assert.deepStrictEqual(yield* bounded(threadId), {
          runOrdinals: [2, 3, 4, 5, 7, 8],
          checkpointSlots: [5, 6, 7, 8],
        });
        // Edit from here on run 7 sends run ordinal 6.
        assert.deepStrictEqual(yield* resolve(threadId, 6), {
          id: "checkpoint:issue:5",
          status: "ready",
        });
      }),
    );

    it.effect("skips consecutive rewound runs", () =>
      Effect.gen(function* () {
        // Rewinding run 6 discarded runs 6 and 7. Run 8's baseline replaced run
        // 7's checkpoint; run 6's stale checkpoint is still in its slot.
        const threadId = yield* seedThread({
          name: "two-rewinds",
          runs: [
            [4, "completed"],
            [5, "completed"],
            [6, "rolled_back"],
            [7, "rolled_back"],
            [8, "completed"],
          ],
          checkpoints: [
            [0, null, "ready", 4],
            [5, 5, "ready"],
            [6, 6, "stale"],
            [7, null, "ready", 8],
            [8, 8, "ready"],
          ],
        });

        assert.deepStrictEqual((yield* bounded(threadId)).runOrdinals, [4, 5, 8]);
        assert.deepStrictEqual(yield* resolve(threadId, 7), {
          id: "checkpoint:two-rewinds:5",
          status: "ready",
        });
      }),
    );

    it.effect("does not skip a failed run that is still in the conversation", () =>
      Effect.gen(function* () {
        const threadId = yield* seedThread({
          name: "failed-predecessor",
          runs: [
            [5, "completed"],
            [6, "failed"],
            [7, "completed"],
          ],
          checkpoints: [
            [0, null, "ready", 5],
            [5, 5, "ready"],
            [6, null, "ready", 7],
            [7, 7, "ready"],
          ],
        });

        assert.isUndefined(yield* resolve(threadId, 6));
      }),
    );

    it.effect("restores thread start when every earlier run was rewound", () =>
      Effect.gen(function* () {
        const threadId = yield* seedThread({
          name: "all-rewound",
          runs: [
            [1, "rolled_back"],
            [2, "rolled_back"],
            [3, "completed"],
          ],
          checkpoints: [
            [0, null, "ready", 1],
            [1, 1, "stale"],
            [2, null, "ready", 3],
            [3, 3, "ready"],
          ],
        });

        assert.deepStrictEqual(yield* resolve(threadId, 2), {
          id: "checkpoint:all-rewound:0",
          status: "ready",
        });
      }),
    );

    it.effect("never resolves to the baseline left in a rewound run's slot", () =>
      Effect.gen(function* () {
        // The server treats a null app run ordinal as thread start, so the
        // slot 6 baseline would wipe the thread. Run 5's missing checkpoint is
        // returned instead and the rollback command rejects it.
        const threadId = yield* seedThread({
          name: "baseline-guard",
          runs: [
            [5, "completed"],
            [6, "rolled_back"],
            [7, "completed"],
          ],
          checkpoints: [
            [0, null, "ready", 5],
            [5, 5, "missing"],
            [6, null, "ready", 7],
            [7, 7, "ready"],
          ],
        });

        assert.deepStrictEqual(yield* resolve(threadId, 6), {
          id: "checkpoint:baseline-guard:5",
          status: "missing",
        });
      }),
    );
  },
);
