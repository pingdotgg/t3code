import { expect, it, vi } from "vite-plus/test";
import {
  CheckpointScopeId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  WorktreeMutationError,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as WorktreeRevivalService from "../vcs/WorktreeRevivalService.ts";
import type { ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";

function makeProviderTurnStartFixture(input: {
  readonly revival: "revived" | "unchanged" | "failed";
}) {
  const threadId = ThreadId.make(`thread_provider_turn_start_worktree_${input.revival}`);
  const runId = RunId.make(`run_provider_turn_start_worktree_${input.revival}`);
  const attemptId = RunAttemptId.make(`attempt_provider_turn_start_worktree_${input.revival}`);
  const rootNodeId = NodeId.make(`node_provider_turn_start_worktree_${input.revival}`);
  const providerThreadId = ProviderThreadId.make(
    `provider_thread_provider_turn_start_worktree_${input.revival}`,
  );
  const providerSessionId = ProviderSessionId.make(
    `provider_session_provider_turn_start_worktree_${input.revival}`,
  );
  const messageId = MessageId.make(`message_provider_turn_start_worktree_${input.revival}`);
  const checkpointScopeId = CheckpointScopeId.make(
    `checkpoint_scope_provider_turn_start_worktree_${input.revival}`,
  );
  const projectId = ProjectId.make(`project_provider_turn_start_worktree_${input.revival}`);
  const order: string[] = [];
  const providerThread = {
    id: providerThreadId,
    providerSessionId,
    providerInstanceId: ProviderInstanceId.make(`provider_instance_${input.revival}`),
    nativeThreadRef: null,
    handoffIds: [],
    forkedFrom: null,
    appThreadId: threadId,
  };
  const projection = {
    thread: {
      id: threadId,
      projectId,
      branch: "feature/revival",
      worktreePath: "/tmp/t3-worktrees/feature-revival",
    },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        providerInstanceId: providerThread.providerInstanceId,
        modelSelection: { instanceId: providerThread.providerInstanceId, model: "test-model" },
        ordinal: 1,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId, providerTurnId: null }],
    providerThreads: [providerThread],
    providerSessions: [{ id: providerSessionId }],
    providerTurns: [],
    messages: [
      {
        id: messageId,
        text: "continue",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
    ],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
    subagents: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const session = {
    driver: "codex",
    instanceId: providerThread.providerInstanceId,
    providerSessionId,
    providerSession: { id: providerSessionId },
    ensureThread: () => Effect.succeed(providerThread),
    resumeThread: () => Effect.succeed(providerThread),
    forkThread: () => Effect.succeed(providerThread),
  } as unknown as ProviderAdapterV2SessionRuntime;
  const open = vi.fn(() =>
    Effect.sync(() => {
      order.push("open");
      return session;
    }),
  );
  const close = vi.fn(() =>
    Effect.sync(() => {
      order.push("close");
    }),
  );
  const reviveForThread = vi.fn(() =>
    Effect.sync(() => {
      order.push("revive");
    }).pipe(
      Effect.andThen(
        input.revival === "failed"
          ? Effect.fail(
              new WorktreeMutationError({
                operation: "revive",
                message: "simulated revival failure",
              }),
            )
          : Effect.succeed({ revived: input.revival === "revived" }),
      ),
    ),
  );
  const worktreeLayer = Layer.mock(WorktreeRevivalService.WorktreeRevivalService)({
    reviveForThread,
  });
  const providerLayer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] } as never),
        }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open, close }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({
          startRootRun: () =>
            Effect.sync(() => {
              order.push("start-root-run");
            }),
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () =>
            Effect.succeed({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: projection.thread.worktreePath,
            }),
        }),
      ),
    ),
  );
  const layer = Layer.merge(providerLayer, worktreeLayer);
  return { layer, order, open, close, reviveForThread, threadId, runId };
}

it("does not commit running state when inherited background routing cannot be read", async () => {
  const threadId = ThreadId.make("thread_provider_turn_start_projection_failure");
  const runId = RunId.make("run_provider_turn_start_projection_failure");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_projection_failure");
  const rootNodeId = NodeId.make("node_provider_turn_start_projection_failure");
  const providerThreadId = ProviderThreadId.make(
    "provider_thread_provider_turn_start_projection_failure",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider_session_provider_turn_start_projection_failure",
  );
  const messageId = MessageId.make("message_provider_turn_start_projection_failure");
  const checkpointScopeId = CheckpointScopeId.make(
    "checkpoint_scope_provider_turn_start_projection_failure",
  );
  const projection = {
    thread: { id: threadId },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        ordinal: 2,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerThreads: [{ id: providerThreadId, providerSessionId }],
    messages: [{ id: messageId }],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  let projectionReadCount = 0;
  const writeIfRunCurrent = vi.fn(() =>
    Effect.succeed({ committed: true, storedEvents: [] } as never),
  );
  const startRootRun = vi.fn(() => Effect.void);
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => {
            projectionReadCount += 1;
            return projectionReadCount === 1
              ? Effect.succeed(projection)
              : Effect.fail(
                  new ProjectionStore.ProjectionStoreReadError({
                    threadId,
                    cause: "simulated inherited-background projection failure",
                  }),
                );
          },
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
        Layer.mock(WorktreeRevivalService.WorktreeRevivalService)({}),
      ),
    ),
  );

  await Effect.gen(function* () {
    const error = yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
      .start({ threadId, runId })
      .pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(projectionReadCount).toBe(2);
    expect(writeIfRunCurrent).not.toHaveBeenCalled();
    expect(startRootRun).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("restarts the provider session after reviving a missing worktree", async () => {
  const fixture = makeProviderTurnStartFixture({ revival: "revived" });

  await Effect.gen(function* () {
    yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
      threadId: fixture.threadId,
      runId: fixture.runId,
    });
  }).pipe(Effect.provide(fixture.layer), Effect.runPromise);

  expect(fixture.order).toEqual(["revive", "close", "open", "start-root-run"]);
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.open).toHaveBeenCalledOnce();
  expect(fixture.reviveForThread).toHaveBeenCalledOnce();
});

it("keeps the provider session when the worktree is already present", async () => {
  const fixture = makeProviderTurnStartFixture({ revival: "unchanged" });

  await Effect.gen(function* () {
    yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
      threadId: fixture.threadId,
      runId: fixture.runId,
    });
  }).pipe(Effect.provide(fixture.layer), Effect.runPromise);

  expect(fixture.order).toEqual(["revive", "open", "start-root-run"]);
  expect(fixture.close).not.toHaveBeenCalled();
  expect(fixture.open).toHaveBeenCalledOnce();
});

it("fails provider start before opening when worktree revival fails", async () => {
  const fixture = makeProviderTurnStartFixture({ revival: "failed" });

  await Effect.gen(function* () {
    const error = yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
      .start({ threadId: fixture.threadId, runId: fixture.runId })
      .pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
  }).pipe(Effect.provide(fixture.layer), Effect.runPromise);

  expect(fixture.order).toEqual(["revive"]);
  expect(fixture.close).not.toHaveBeenCalled();
  expect(fixture.open).not.toHaveBeenCalled();
});
