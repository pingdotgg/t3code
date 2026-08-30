import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  CheckpointRestoreOutcomeUnknownError,
  CheckpointRestorePreflightError,
  CheckpointServiceV2,
} from "./CheckpointService.ts";
import {
  CheckpointRollbackServiceV2,
  layer as checkpointRollbackServiceLayer,
} from "./CheckpointRollbackService.ts";
import { EventSinkV2, EventSinkWriteError } from "./EventSink.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { threadDispatchLockLayer } from "./KeyedSerialExecutor.ts";
import { ProjectionStoreReadError, ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderSessionManagerV2, ProviderSessionOpenError } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

const checkpointRollbackServiceTestLayer = checkpointRollbackServiceLayer.pipe(
  Layer.provide(threadDispatchLockLayer),
);

function makeReadyRollbackProjection(input: {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly checkpointId: CheckpointId;
  readonly scopeId: CheckpointScopeId;
  readonly providerInstanceId: ProviderInstanceId;
}): OrchestrationV2ThreadProjection {
  const now = DateTime.makeUnsafe("2026-08-29T00:00:00.000Z");
  const driver = ProviderDriverKind.make("codex");
  const nodeId = NodeId.make(`node:${input.threadId}`);
  return {
    thread: {
      id: input.threadId,
      activeProviderThreadId: input.providerThreadId,
      modelSelection: { instanceId: input.providerInstanceId, model: "test-model" },
      archivedAt: null,
      deletedAt: null,
    },
    providerThreads: [
      {
        id: input.providerThreadId,
        providerSessionId: input.providerSessionId,
        providerInstanceId: input.providerInstanceId,
        driver,
        lastRunOrdinal: 1,
      },
    ],
    providerSessions: [{ id: input.providerSessionId }],
    checkpoints: [
      {
        id: input.checkpointId,
        threadId: input.threadId,
        scopeId: input.scopeId,
        runId: null,
        nodeId,
        parentCheckpointId: null,
        ordinalWithinScope: 0,
        appRunOrdinal: null,
        ref: CheckpointRef.make(`refs/t3/${input.checkpointId}`),
        status: "ready",
        files: [],
        capturedAt: now,
      },
    ],
    checkpointScopes: [
      {
        id: input.scopeId,
        threadId: input.threadId,
        runId: null,
        nodeId,
        parentScopeId: null,
        providerThreadId: input.providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo",
        createdAt: now,
      },
    ],
    runs: [
      {
        id: RunId.make(`run:${input.threadId}`),
        threadId: input.threadId,
        ordinal: 1,
        providerInstanceId: input.providerInstanceId,
        modelSelection: { instanceId: input.providerInstanceId, model: "test-model" },
        providerThreadId: input.providerThreadId,
        userMessageId: MessageId.make(`message:${input.threadId}`),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    nodes: [],
    attempts: [],
    providerTurns: [],
  } as unknown as OrchestrationV2ThreadProjection;
}

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
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [{ id: providerThreadId, providerSessionId, providerInstanceId }],
    checkpoints: [{ id: checkpointId, scopeId, status: "stale" }],
    checkpointScopes: [{ id: scopeId }],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceTestLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadSnapshot: () =>
            Effect.succeed({ schemaVersion: 1, snapshotSequence: 1, projection }),
        }),
        Layer.mock(ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
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
  }).pipe(Effect.provide(testLayer));
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
    checkpointScopes: [{ id: scopeId }],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceTestLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadSnapshot: () =>
            Effect.succeed({ schemaVersion: 1, snapshotSequence: 1, projection }),
        }),
        Layer.mock(ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
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
    checkpointScopes: [{ id: scopeId }],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceTestLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadSnapshot: () =>
            Effect.succeed({ schemaVersion: 1, snapshotSequence: 1, projection }),
        }),
        Layer.mock(ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
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
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [{ id: providerThreadId, providerSessionId, providerInstanceId }],
    providerSessions: [],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready", appRunOrdinal: 1 }],
    checkpointScopes: [{ id: scopeId }],
    runs: [],
    attempts: [],
    providerTurns: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceTestLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadSnapshot: () =>
            Effect.succeed({ schemaVersion: 1, snapshotSequence: 1, projection }),
        }),
        Layer.mock(ProviderSessionManagerV2)({
          open: () => Effect.succeed({} as never),
        }),
        Layer.mock(RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
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
  }).pipe(Effect.provide(testLayer));
});

it.effect("wraps underlying failures with an unexpected-failure reason and cause", () => {
  const threadId = ThreadId.make("thread:rollback-unexpected-failure");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-unexpected-failure");
  const checkpointId = CheckpointId.make("checkpoint:rollback-unexpected-failure");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-unexpected-failure");
  const projectionError = new ProjectionStoreReadError({
    threadId,
    cause: new Error("database read failed"),
  });
  const testLayer = checkpointRollbackServiceTestLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({}),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadSnapshot: () => Effect.fail(projectionError),
        }),
        Layer.mock(ProviderSessionManagerV2)({}),
        Layer.mock(RuntimePolicyV2)({}),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "unexpected-failure");
    assert.equal(
      error.message,
      `Failed to execute rollback target ${checkpointId} on provider thread ${providerThreadId} for thread ${threadId}.`,
    );
    assert.strictEqual(error.cause, projectionError);
  }).pipe(Effect.provide(testLayer));
});

it.effect("opens the provider session before restoring files for legacy rollback", () => {
  const threadId = ThreadId.make("thread:rollback-open-before-files");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-open-before-files");
  const providerSessionId = ProviderSessionId.make("provider-session:rollback-open-before-files");
  const checkpointId = CheckpointId.make("checkpoint:rollback-open-before-files");
  const scopeId = CheckpointScopeId.make("scope:rollback-open-before-files");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_open_before_files");
  const projection = makeReadyRollbackProjection({
    threadId,
    providerThreadId,
    providerSessionId,
    checkpointId,
    scopeId,
    providerInstanceId,
  });
  const restore = vi.fn(() => Effect.die("session failure must preserve files"));
  const openError = new ProviderSessionOpenError({
    instanceId: providerInstanceId,
    providerSessionId,
    cause: "simulated transient provider open failure",
  });
  const testLayer = checkpointRollbackServiceTestLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadSnapshot: () =>
            Effect.succeed({ schemaVersion: 1, snapshotSequence: 1, projection }),
        }),
        Layer.mock(ProviderSessionManagerV2)({ open: () => Effect.fail(openError) }),
        Layer.mock(RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({ threadId, providerThreadId, checkpointId, scopeId })
      .pipe(Effect.flip);

    assert.equal(error.reason, "unexpected-failure");
    assert.strictEqual(error.cause, openError);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("reports an uncertain filesystem restore as partial before provider rollback", () => {
  const threadId = ThreadId.make("thread:rollback-filesystem-partial");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-filesystem-partial");
  const providerSessionId = ProviderSessionId.make("provider-session:rollback-filesystem-partial");
  const checkpointId = CheckpointId.make("checkpoint:rollback-filesystem-partial");
  const scopeId = CheckpointScopeId.make("scope:rollback-filesystem-partial");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_filesystem_partial");
  const projection = makeReadyRollbackProjection({
    threadId,
    providerThreadId,
    providerSessionId,
    checkpointId,
    scopeId,
    providerInstanceId,
  });
  const rollbackThread = vi.fn(() => Effect.void);
  const restoreError = new CheckpointRestoreOutcomeUnknownError({
    scopeId,
    checkpointId,
    cause: "Git restore failed after its first mutating command",
  });
  const testLayer = checkpointRollbackServiceTestLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore: () => Effect.fail(restoreError) }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadSnapshot: () =>
            Effect.succeed({ schemaVersion: 1, snapshotSequence: 1, projection }),
        }),
        Layer.mock(ProviderSessionManagerV2)({
          open: () => Effect.succeed({ rollbackThread } as never),
        }),
        Layer.mock(RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
        expectedIdle: true,
        expectedWorkspaceFingerprint: "workspace-before",
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "post-restore-finalization-failed");
    assert.strictEqual(error.cause, restoreError);
    assert.equal(rollbackThread.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("keeps a proven pre-restore failure retryable", () => {
  const threadId = ThreadId.make("thread:rollback-restore-preflight");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-restore-preflight");
  const providerSessionId = ProviderSessionId.make("provider-session:rollback-restore-preflight");
  const checkpointId = CheckpointId.make("checkpoint:rollback-restore-preflight");
  const scopeId = CheckpointScopeId.make("scope:rollback-restore-preflight");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_restore_preflight");
  const projection = makeReadyRollbackProjection({
    threadId,
    providerThreadId,
    providerSessionId,
    checkpointId,
    scopeId,
    providerInstanceId,
  });
  const rollbackThread = vi.fn(() => Effect.void);
  const restoreError = new CheckpointRestorePreflightError({
    scopeId,
    checkpointId,
    cause: "Unable to read the workspace fingerprint before restoring files",
  });
  const testLayer = checkpointRollbackServiceTestLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore: () => Effect.fail(restoreError) }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadSnapshot: () =>
            Effect.succeed({ schemaVersion: 1, snapshotSequence: 1, projection }),
        }),
        Layer.mock(ProviderSessionManagerV2)({
          open: () => Effect.succeed({ rollbackThread } as never),
        }),
        Layer.mock(RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
        expectedIdle: true,
        expectedWorkspaceFingerprint: "workspace-before",
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "unexpected-failure");
    assert.strictEqual(error.cause, restoreError);
    assert.equal(rollbackThread.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("rejects an ambiguous null-ordinal target inside the worker boundary", () => {
  const threadId = ThreadId.make("thread:rollback-ambiguous-target");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-ambiguous-target");
  const providerSessionId = ProviderSessionId.make("provider-session:rollback-ambiguous-target");
  const checkpointId = CheckpointId.make("checkpoint:rollback-ambiguous-target");
  const scopeId = CheckpointScopeId.make("scope:rollback-ambiguous-target");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_ambiguous_target");
  const ready = makeReadyRollbackProjection({
    threadId,
    providerThreadId,
    providerSessionId,
    checkpointId,
    scopeId,
    providerInstanceId,
  });
  const projection = {
    ...ready,
    checkpoints: ready.checkpoints.map((checkpoint) => ({
      ...checkpoint,
      ordinalWithinScope: 2,
      appRunOrdinal: null,
    })),
  };
  const restore = vi.fn(() => Effect.die("ambiguous restore must not touch files"));
  const open = vi.fn(() => Effect.die("ambiguous restore must not open a provider session"));
  const testLayer = checkpointRollbackServiceTestLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadSnapshot: () =>
            Effect.succeed({ schemaVersion: 1, snapshotSequence: 1, projection }),
        }),
        Layer.mock(ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({ threadId, providerThreadId, checkpointId, scopeId })
      .pipe(Effect.flip);
    assert.equal(error.reason, "rollback-target-ambiguous");
    assert.equal(restore.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("reports persistence failure after provider rollback as partial", () => {
  const threadId = ThreadId.make("thread:rollback-persistence-partial");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-persistence-partial");
  const providerSessionId = ProviderSessionId.make("provider-session:rollback-persistence-partial");
  const checkpointId = CheckpointId.make("checkpoint:rollback-persistence-partial");
  const scopeId = CheckpointScopeId.make("scope:rollback-persistence-partial");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_persistence_partial");
  const projection = makeReadyRollbackProjection({
    threadId,
    providerThreadId,
    providerSessionId,
    checkpointId,
    scopeId,
    providerInstanceId,
  });
  const providerThread = projection.providerThreads[0]!;
  const rollbackThread = vi.fn(() =>
    Effect.succeed({ providerThread, providerTurns: [], messages: [], runtimeRequests: [] }),
  );
  const persistenceError = new EventSinkWriteError({
    eventCount: 2,
    cause: "simulated event persistence failure",
  });
  const testLayer = checkpointRollbackServiceTestLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({
          restore: () => Effect.void,
          deleteStaleRefs: () => Effect.void,
        }),
        Layer.mock(EventSinkV2)({ write: () => Effect.fail(persistenceError) }),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadSnapshot: () =>
            Effect.succeed({ schemaVersion: 1, snapshotSequence: 1, projection }),
        }),
        Layer.mock(ProviderSessionManagerV2)({
          open: () => Effect.succeed({ rollbackThread } as never),
        }),
        Layer.mock(RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
        expectedIdle: true,
        expectedWorkspaceFingerprint: "workspace-before",
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "post-restore-finalization-failed");
    assert.strictEqual(error.cause, persistenceError);
    assert.equal(rollbackThread.mock.calls.length, 1);
  }).pipe(Effect.provide(testLayer));
});
