import { assert, expect, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EnvironmentId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  VcsDriverKind,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import {
  CLAUDE_PROVIDER,
  ClaudeProviderCapabilitiesV2,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  ThreadManagementService,
  ThreadManagementThreadNotFoundError,
} from "../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreReadError } from "../orchestration-v2/ProjectionStore.ts";
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
    readonly hasCheckpointRef?: CheckpointStore.CheckpointStore["Service"]["hasCheckpointRef"];
    readonly diffCheckpoints?: CheckpointStore.CheckpointStore["Service"]["diffCheckpoints"];
  } = {},
) {
  const projection = input.projection ?? makeProjection();
  const hasCheckpointRef = vi.fn(input.hasCheckpointRef ?? (() => Effect.succeed(true)));
  const diffCheckpoints = vi.fn(
    input.diffCheckpoints ?? (() => Effect.succeed("diff --git a/file b/file")),
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
              : Effect.fail(
                  new ThreadManagementThreadNotFoundError({
                    projectId,
                    threadId: requested,
                  }),
                ),
        }),
        Layer.mock(CheckpointStore.CheckpointStore)({ hasCheckpointRef, diffCheckpoints }),
      ),
    ),
  );
  return { serviceLayer, hasCheckpointRef, diffCheckpoints };
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

it.effect("keeps optional thread reads inside the caller's project", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const service = yield* CheckpointMcpService;
    const error = yield* service.list(invocation, { threadId: otherThreadId }).pipe(Effect.flip);
    expect(error.code).toBe("thread_not_found");
  }).pipe(Effect.provide(harness.serviceLayer));
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
