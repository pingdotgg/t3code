import { assert, expect, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
  VcsDriverKind,
  VcsProcessOutputLimitError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import {
  CLAUDE_PROVIDER,
  ClaudeProviderCapabilitiesV2,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import type { OrchestrationEffectV2 } from "../orchestration-v2/EffectOutbox.ts";
import { CommandReceiptStoreReadError } from "../orchestration-v2/CommandReceiptStore.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import {
  ThreadManagementProjectionLoadError,
  ThreadManagementService,
  ThreadManagementThreadNotFoundError,
} from "../orchestration-v2/ThreadManagementService.ts";
import {
  ProjectionStoreReadError,
  ProjectionStoreThreadNotFoundError,
} from "../orchestration-v2/ProjectionStore.ts";
import { CheckpointMcpService, layer } from "./CheckpointMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const threadId = ThreadId.make("thread:checkpoint-mcp");
const otherThreadId = ThreadId.make("thread:checkpoint-mcp-other");
const projectId = ProjectId.make("project:checkpoint-mcp");
const providerInstanceId = ProviderInstanceId.make("claudeAgent");
const providerSessionId = ProviderSessionId.make("provider-session:checkpoint-mcp");
const providerThreadId = ProviderThreadId.make("provider-thread:checkpoint-mcp");
const nodeId = NodeId.make("node:checkpoint-mcp");
const scopeId = CheckpointScopeId.make("scope:checkpoint-mcp");
const now = DateTime.makeUnsafe("2026-08-29T12:00:00.000Z");

const invocation: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:checkpoint-mcp"),
  threadId,
  providerSessionId: "mcp-provider-session:checkpoint-mcp",
  providerInstanceId,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

function makeThread(id = threadId): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId,
    title: "Checkpoint MCP test",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "claude-sonnet" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature/checkpoint-mcp",
    worktreePath: "/repo",
    activeProviderThreadId: providerThreadId,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: now,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function makeScope(id = scopeId): OrchestrationV2CheckpointScope {
  return {
    id,
    threadId,
    runId: null,
    nodeId,
    parentScopeId: null,
    providerThreadId,
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: "/repo",
    createdAt: now,
  };
}

function makeCheckpoint(index: number, overrides: Partial<OrchestrationV2Checkpoint> = {}) {
  return {
    id: CheckpointId.make(`checkpoint:checkpoint-mcp:${index}`),
    threadId,
    scopeId,
    runId: null,
    nodeId,
    parentCheckpointId:
      index === 0 ? null : CheckpointId.make(`checkpoint:checkpoint-mcp:${index - 1}`),
    ordinalWithinScope: index,
    appRunOrdinal: index === 0 ? null : index,
    ref: CheckpointRef.make(`refs/t3/checkpoint-mcp/${index}`),
    status: "ready" as const,
    files: [
      { path: `file-${index}.ts`, kind: "modified", additions: index + 1, deletions: 0 },
      { path: `extra-${index}.ts`, kind: "added", additions: 1, deletions: 0 },
    ],
    capturedAt: DateTime.add(now, { seconds: index }),
    ...overrides,
  } satisfies OrchestrationV2Checkpoint;
}

function makeProjection(
  input: {
    readonly checkpoints?: ReadonlyArray<OrchestrationV2Checkpoint>;
    readonly scopes?: ReadonlyArray<OrchestrationV2CheckpointScope>;
    readonly id?: ThreadId;
  } = {},
): OrchestrationV2ThreadProjection {
  const id = input.id ?? threadId;
  return {
    thread: makeThread(id),
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [
      {
        id: providerSessionId,
        driver: CLAUDE_PROVIDER,
        providerInstanceId,
        status: "ready",
        cwd: "/repo",
        model: "claude-sonnet",
        capabilities: ClaudeProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        driver: CLAUDE_PROVIDER,
        providerInstanceId,
        providerSessionId,
        appThreadId: id,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: input.scopes ?? [makeScope()],
    checkpoints: input.checkpoints ?? [makeCheckpoint(0)],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  };
}

function makeHarness(
  input: {
    readonly projection?: OrchestrationV2ThreadProjection;
    readonly callerError?: OrchestratorProjectionError;
    readonly targetError?: ThreadManagementProjectionLoadError;
    readonly hasCheckpointRef?: CheckpointStore.CheckpointStore["Service"]["hasCheckpointRef"];
    readonly diffCheckpoints?: CheckpointStore.CheckpointStore["Service"]["diffCheckpoints"];
    readonly readWorkspaceFingerprint?: CheckpointStore.CheckpointStore["Service"]["readWorkspaceFingerprint"];
    readonly effectStatus?: OrchestrationEffectV2["status"];
    readonly effectError?: string | null;
    readonly effectFailureCode?: OrchestrationEffectV2["failureCode"];
    readonly receiptReadFailsAfterDispatch?: boolean;
  } = {},
) {
  const projection = input.projection ?? makeProjection();
  const hasCheckpointRef = vi.fn(input.hasCheckpointRef ?? (() => Effect.succeed(true)));
  const diffCheckpoints = vi.fn(
    input.diffCheckpoints ?? (() => Effect.succeed("diff --git a/file b/file")),
  );
  const readWorkspaceFingerprint = vi.fn(
    input.readWorkspaceFingerprint ?? (() => Effect.succeed("tree:checkpoint-mcp")),
  );
  let acceptedCommandId: CommandId | undefined;
  const dispatch = vi.fn(
    (command: Parameters<ThreadManagementService["Service"]["dispatch"]>[0]) =>
      command.type !== "checkpoint.rollback"
        ? Effect.die("Checkpoint MCP test only dispatches checkpoint.rollback")
        : Effect.sync(() => {
            acceptedCommandId = command.commandId;
            return {
              sequence: 7,
              storedEvents: [
                {
                  sequence: 7,
                  commandId: command.commandId,
                  event: {
                    id: EventId.make(`event:${command.commandId}`),
                    type: "checkpoint.rollback-requested" as const,
                    threadId: command.threadId,
                    occurredAt: now,
                    payload: {
                      scopeId: command.scopeId,
                      checkpointId: command.checkpointId,
                      requestedAt: now,
                    },
                  },
                },
              ],
            };
          }),
  );
  const serviceLayer = layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService)({
          getThreadProjection: () =>
            input.callerError === undefined
              ? Effect.succeed(projection)
              : Effect.fail(input.callerError),
          getProjectThread: ({ threadId: requested }) =>
            requested === projection.thread.id
              ? Effect.succeed(projection)
              : input.targetError !== undefined
                ? Effect.fail(input.targetError)
                : Effect.fail(
                    new ThreadManagementThreadNotFoundError({
                      projectId,
                      threadId: requested,
                    }),
                  ),
          dispatch,
          getCommandReceipt: (commandId) =>
            input.receiptReadFailsAfterDispatch === true && acceptedCommandId !== undefined
              ? Effect.fail(
                  new CommandReceiptStoreReadError({
                    commandId,
                    cause: "simulated receipt read failure",
                  }),
                )
              : Effect.succeed(
                  acceptedCommandId === commandId
                    ? Option.some({
                        commandId,
                        threadId: projection.thread.id,
                        commandType: "checkpoint.rollback",
                        acceptedAt: now,
                        resultSequence: 7,
                        status: "accepted",
                        error: null,
                      })
                    : Option.none(),
                ),
          listCommandEffects: (commandId) =>
            Effect.succeed([
              {
                id: `effect:${commandId}:rollback`,
                commandId,
                threadId: projection.thread.id,
                request: {
                  type: "provider-thread.rollback",
                  providerThreadId,
                  checkpointId: makeCheckpoint(0).id,
                  scopeId,
                  expectedIdle: true,
                  expectedWorkspaceFingerprint: "tree:checkpoint-mcp",
                },
                status: input.effectStatus ?? "pending",
                attemptCount: 0,
                availableAt: "2026-08-29T12:00:00.000Z",
                leaseOwner: null,
                leaseExpiresAt: null,
                createdAt: "2026-08-29T12:00:00.000Z",
                updatedAt: "2026-08-29T12:00:00.000Z",
                completedAt: null,
                lastError: input.effectError ?? null,
                ...(input.effectFailureCode === undefined
                  ? {}
                  : { failureCode: input.effectFailureCode }),
              },
            ]),
        }),
        Layer.mock(CheckpointStore.CheckpointStore)({
          hasCheckpointRef,
          diffCheckpoints,
          readWorkspaceFingerprint,
        }),
      ),
    ),
  );
  return { serviceLayer, hasCheckpointRef, diffCheckpoints, readWorkspaceFingerprint, dispatch };
}

it.effect("pages before checking checkpoint refs and bounds file summaries", () => {
  const checkpoints = Array.from({ length: 30 }, (_, index) => makeCheckpoint(index));
  const harness = makeHarness({ projection: makeProjection({ checkpoints }) });
  return Effect.gen(function* () {
    const service = yield* CheckpointMcpService;
    const result = yield* service.list(invocation, { cursor: 2, limit: 3, fileLimit: 1 });

    assert.equal(result.checkpoints.length, 3);
    assert.equal(result.total, 30);
    assert.equal(result.nextCursor, 5);
    assert.equal(harness.hasCheckpointRef.mock.calls.length, 3);
    assert.equal(result.checkpoints[0]?.fileCount, 2);
    assert.isTrue(result.checkpoints[0]?.filesTruncated);
    assert.include(result.checkpoints[0]?.restoreSupport.blockers ?? [], "provider_turn_missing");
  }).pipe(Effect.provide(harness.serviceLayer));
});

it.effect("keeps an unreadable checkpoint entry from failing the whole list page", () => {
  const harness = makeHarness({
    hasCheckpointRef: () =>
      Effect.fail(
        new VcsUnsupportedOperationError({
          operation: "CheckpointMcpService.test",
          kind: VcsDriverKind.make("git"),
          detail: "git metadata unavailable",
        }),
      ),
  });
  return Effect.gen(function* () {
    const service = yield* CheckpointMcpService;
    const result = yield* service.list(invocation, {});
    assert.equal(result.checkpoints[0]?.availability, "unreadable");
    assert.include(result.checkpoints[0]?.availabilityDetail ?? "", "git metadata unavailable");
    assert.include(result.checkpoints[0]?.restoreSupport.blockers ?? [], "ref_unavailable");
  }).pipe(Effect.provide(harness.serviceLayer));
});

it.effect("validates scope and ref identity before returning an empty diff", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const service = yield* CheckpointMcpService;
    const checkpoint = makeCheckpoint(0);
    const result = yield* service.diff(invocation, {
      scopeId,
      checkpointId: checkpoint.id,
    });
    assert.equal(result.diff, "");
    assert.equal(harness.hasCheckpointRef.mock.calls.length, 1);

    const error = yield* service
      .diff(invocation, {
        scopeId: CheckpointScopeId.make("scope:foreign"),
        checkpointId: checkpoint.id,
      })
      .pipe(Effect.flip);
    assert.equal(error.code, "scope_mismatch");
    assert.equal(harness.hasCheckpointRef.mock.calls.length, 1);
  }).pipe(Effect.provide(harness.serviceLayer));
});

it.effect("paginates diff content on valid UTF-16 boundaries", () => {
  const from = makeCheckpoint(0);
  const target = makeCheckpoint(1);
  const harness = makeHarness({
    projection: makeProjection({ checkpoints: [from, target] }),
    diffCheckpoints: () => Effect.succeed("a😀b"),
  });
  return Effect.gen(function* () {
    const service = yield* CheckpointMcpService;
    const result = yield* service.diff(invocation, {
      scopeId,
      checkpointId: target.id,
      fromCheckpointId: from.id,
      cursor: 0,
      limit: 2,
    });
    assert.equal(result.diff, "a😀");
    assert.equal(result.nextCursor, 3);
    assert.equal(result.totalLength, 4);

    const error = yield* service
      .diff(invocation, {
        scopeId,
        checkpointId: target.id,
        fromCheckpointId: from.id,
        cursor: 2,
      })
      .pipe(Effect.flip);
    assert.equal(error.code, "invalid_request");
  }).pipe(Effect.provide(harness.serviceLayer));
});

it.effect("requires complete bounded diff output and reports overflow safely", () => {
  const from = makeCheckpoint(0);
  const target = makeCheckpoint(1);
  const harness = makeHarness({
    projection: makeProjection({ checkpoints: [from, target] }),
    diffCheckpoints: (input) =>
      Effect.gen(function* () {
        assert.equal(input.requireCompleteOutput, true);
        return yield* new VcsProcessOutputLimitError({
          operation: "GitVcsDriver.checkpoints.diffCheckpoints",
          command: "git diff",
          cwd: "/private/workspace",
          stream: "stdout",
          maxBytes: 10_000_000,
          observedBytes: 10_000_001,
        });
      }),
  });

  return Effect.gen(function* () {
    const service = yield* CheckpointMcpService;
    const error = yield* service
      .diff(invocation, {
        scopeId,
        checkpointId: target.id,
        fromCheckpointId: from.id,
      })
      .pipe(Effect.flip);

    assert.equal(error.code, "operation_failed");
    assert.equal(error.message, "Unable to compute checkpoint diff.");
  }).pipe(Effect.provide(harness.serviceLayer));
});

it.effect("keeps optional thread reads inside the caller's project", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const service = yield* CheckpointMcpService;
    const error = yield* service.list(invocation, { threadId: otherThreadId }).pipe(Effect.flip);
    expect(error.code).toBe("thread_not_found");
  }).pipe(Effect.provide(harness.serviceLayer));
});

it.effect("distinguishes a missing target projection from an operational failure", () => {
  const missingHarness = makeHarness({
    targetError: new ThreadManagementProjectionLoadError({
      projectId,
      threadId: otherThreadId,
      cause: new OrchestratorProjectionError({
        threadId: otherThreadId,
        cause: new ProjectionStoreThreadNotFoundError({ threadId: otherThreadId }),
      }),
    }),
  });
  const failedHarness = makeHarness({
    targetError: new ThreadManagementProjectionLoadError({
      projectId,
      threadId: otherThreadId,
      cause: new OrchestratorProjectionError({
        threadId: otherThreadId,
        cause: new ProjectionStoreReadError({
          threadId: otherThreadId,
          cause: new Error("projection store unavailable"),
        }),
      }),
    }),
  });

  return Effect.gen(function* () {
    const missing = yield* Effect.gen(function* () {
      const service = yield* CheckpointMcpService;
      return yield* service.list(invocation, { threadId: otherThreadId }).pipe(Effect.flip);
    }).pipe(Effect.provide(missingHarness.serviceLayer));
    assert.equal(missing.code, "thread_not_found");
    assert.equal(missingHarness.dispatch.mock.calls.length, 0);

    const failed = yield* Effect.gen(function* () {
      const service = yield* CheckpointMcpService;
      return yield* service.list(invocation, { threadId: otherThreadId }).pipe(Effect.flip);
    }).pipe(Effect.provide(failedHarness.serviceLayer));
    assert.equal(failed.code, "operation_failed");
    assert.equal(failedHarness.dispatch.mock.calls.length, 0);
  });
});

it.effect("marks null provider targets ambiguous outside the root baseline", () => {
  const nonzeroBaseline = makeCheckpoint(1, { appRunOrdinal: null });
  const manualScope = { ...makeScope(), kind: "manual" as const, advancesAppRunCount: false };
  const harness = makeHarness({
    projection: makeProjection({
      checkpoints: [makeCheckpoint(0), nonzeroBaseline],
      scopes: [makeScope()],
    }),
  });
  const manualHarness = makeHarness({
    projection: makeProjection({ checkpoints: [makeCheckpoint(0)], scopes: [manualScope] }),
  });

  return Effect.gen(function* () {
    const service = yield* CheckpointMcpService;
    const result = yield* service.list(invocation, {});
    assert.deepEqual(result.checkpoints[0]?.restoreSupport, {
      supported: false,
      blockers: ["rollback_target_ambiguous"],
    });

    const manualResult = yield* Effect.gen(function* () {
      const manualService = yield* CheckpointMcpService;
      return yield* manualService.list(invocation, {});
    }).pipe(Effect.provide(manualHarness.serviceLayer));
    assert.include(
      manualResult.checkpoints[0]?.restoreSupport.blockers ?? [],
      "rollback_target_ambiguous",
    );
  }).pipe(Effect.provide(harness.serviceLayer));
});

it.effect("does not advertise restore after the active provider selection changes", () => {
  const projection = makeProjection();
  const harness = makeHarness({
    projection: {
      ...projection,
      thread: {
        ...projection.thread,
        modelSelection: {
          ...projection.thread.modelSelection,
          instanceId: ProviderInstanceId.make("different-provider"),
        },
      },
    },
  });

  return Effect.gen(function* () {
    const service = yield* CheckpointMcpService;
    const result = yield* service.list(invocation, {});
    assert.include(
      result.checkpoints[0]?.restoreSupport.blockers ?? [],
      "provider_thread_mismatch",
    );
  }).pipe(Effect.provide(harness.serviceLayer));
});

it.effect("distinguishes caller projection failures from missing target threads", () => {
  const harness = makeHarness({
    callerError: new OrchestratorProjectionError({
      threadId,
      cause: new ProjectionStoreReadError({
        threadId,
        cause: new Error("projection store unavailable"),
      }),
    }),
  });
  return Effect.gen(function* () {
    const service = yield* CheckpointMcpService;
    const error = yield* service.list(invocation, {}).pipe(Effect.flip);
    assert.equal(error.code, "operation_failed");
    assert.include(error.message, "Unable to load calling thread");
  }).pipe(Effect.provide(harness.serviceLayer));
});

it.effect("accepts an exact restore and reuses the same command identity", () => {
  const harness = makeHarness();
  const checkpointId = makeCheckpoint(0).id;
  return Effect.gen(function* () {
    const service = yield* CheckpointMcpService;
    const input = {
      scopeId,
      checkpointId,
      discardChanges: true as const,
      clientRequestId: "restore-exact-target",
    };
    const first = yield* service.restore(invocation, input);
    const retry = yield* service.restore(invocation, input);
    const conflict = yield* service
      .restore(invocation, {
        ...input,
        checkpointId: CheckpointId.make("checkpoint:checkpoint-mcp:different"),
      })
      .pipe(Effect.flip);

    assert.equal(first.status, "REQUESTED");
    assert.equal(first.effectStatus, "pending");
    assert.equal(retry.commandId, first.commandId);
    assert.equal(conflict.code, "idempotency_conflict");
    assert.equal(harness.dispatch.mock.calls.length, 1);
    assert.equal(harness.dispatch.mock.calls[0]?.[0].type, "checkpoint.rollback");
    assert.deepInclude(harness.dispatch.mock.calls[0]?.[0], {
      expectedIdle: true,
      expectedWorkspaceFingerprint: "tree:checkpoint-mcp",
    });
  }).pipe(Effect.provide(harness.serviceLayer));
});

it.effect("keeps the accepted outcome when post-commit observation fails", () => {
  const harness = makeHarness({ receiptReadFailsAfterDispatch: true });
  return Effect.gen(function* () {
    const service = yield* CheckpointMcpService;
    const result = yield* service.restore(invocation, {
      scopeId,
      checkpointId: makeCheckpoint(0).id,
      discardChanges: true,
      clientRequestId: "restore-observation-unavailable",
    });

    assert.equal(result.status, "REQUESTED");
    assert.equal(result.effectStatus, "unavailable");
    assert.equal(result.receipt.sequence, 7);
    assert.include(result.detail ?? "", "was accepted");
    assert.include(result.detail ?? "", "same clientRequestId");
    assert.equal(harness.dispatch.mock.calls.length, 1);
  }).pipe(Effect.provide(harness.serviceLayer));
});

it.effect("rejects missing checkpoints and unsupported provider rollback", () => {
  const missingHarness = makeHarness({
    projection: makeProjection({
      checkpoints: [makeCheckpoint(0, { status: "missing" })],
    }),
    hasCheckpointRef: () => Effect.succeed(false),
  });
  const supportedProjection = makeProjection();
  const unsupportedHarness = makeHarness({
    projection: {
      ...supportedProjection,
      providerSessions: supportedProjection.providerSessions.map((session) => ({
        ...session,
        capabilities: {
          ...session.capabilities,
          threads: { ...session.capabilities.threads, canRollbackThread: false },
        },
      })),
    },
  });
  const restoreInput = {
    scopeId,
    checkpointId: makeCheckpoint(0).id,
    discardChanges: true as const,
    clientRequestId: "restore-unavailable",
  };
  return Effect.gen(function* () {
    const missingService = yield* CheckpointMcpService;
    const missing = yield* missingService.restore(invocation, restoreInput).pipe(Effect.flip);
    assert.equal(missing.code, "checkpoint_unavailable");
  }).pipe(
    Effect.provide(missingHarness.serviceLayer),
    Effect.andThen(
      Effect.gen(function* () {
        const unsupportedService = yield* CheckpointMcpService;
        const unsupported = yield* unsupportedService
          .restore(invocation, { ...restoreInput, clientRequestId: "restore-unsupported" })
          .pipe(Effect.flip);
        assert.equal(unsupported.code, "unsupported");
      }).pipe(Effect.provide(unsupportedHarness.serviceLayer)),
    ),
  );
});

it.effect("rejects queued work before capturing or dispatching a restore", () => {
  const queuedRun: OrchestrationV2Run = {
    id: RunId.make("run:checkpoint-mcp:queued"),
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "claude-sonnet" },
    providerThreadId,
    userMessageId: MessageId.make("message:checkpoint-mcp:queued"),
    rootNodeId: null,
    activeAttemptId: null,
    status: "queued",
    queuePosition: 1,
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const harness = makeHarness({
    projection: { ...makeProjection(), runs: [queuedRun] },
  });
  return Effect.gen(function* () {
    const service = yield* CheckpointMcpService;
    const error = yield* service
      .restore(invocation, {
        scopeId,
        checkpointId: makeCheckpoint(0).id,
        discardChanges: true,
        clientRequestId: "restore-while-queued",
      })
      .pipe(Effect.flip);

    assert.equal(error.code, "thread_active");
    assert.equal(harness.readWorkspaceFingerprint.mock.calls.length, 0);
    assert.equal(harness.dispatch.mock.calls.length, 0);
  }).pipe(Effect.provide(harness.serviceLayer));
});

it.effect("reports provider failure after filesystem restore as partial", () => {
  const harness = makeHarness({
    effectStatus: "failed",
    effectFailureCode: "checkpoint_restore_partial",
    effectError:
      "Provider conversation rollback failed after the filesystem checkpoint was restored; the result is partial.",
  });
  return Effect.gen(function* () {
    const service = yield* CheckpointMcpService;
    const result = yield* service.restore(invocation, {
      scopeId,
      checkpointId: makeCheckpoint(0).id,
      discardChanges: true,
      clientRequestId: "restore-partial",
    });
    assert.equal(result.status, "PARTIAL");
    assert.equal(result.effectStatus, "failed");
  }).pipe(Effect.provide(harness.serviceLayer));
});
