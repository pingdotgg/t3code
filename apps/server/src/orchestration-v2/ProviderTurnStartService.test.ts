import { expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
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
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

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
  readonly revival: "revived" | "unchanged";
  readonly revivalGate?: Effect.Effect<void>;
  readonly cancelOnOpen?: boolean;
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
  let runStatus: OrchestrationV2Run["status"] = "starting";
  const currentProjection = (): OrchestrationV2ThreadProjection => ({
    ...projection,
    runs: projection.runs.map((candidate) =>
      candidate.id === runId ? { ...candidate, status: runStatus } : candidate,
    ),
  });
  const ensureThread = vi.fn(() => Effect.succeed(providerThread));
  const session = {
    driver: "codex",
    instanceId: providerThread.providerInstanceId,
    providerSessionId,
    providerSession: { id: providerSessionId },
    ensureThread,
    resumeThread: () => Effect.succeed(providerThread),
    forkThread: () => Effect.succeed(providerThread),
  } as unknown as ProviderAdapterV2SessionRuntime;
  const open = vi.fn(() =>
    Effect.sync(() => {
      order.push("open");
      if (input.cancelOnOpen === true) runStatus = "cancelled";
    }).pipe(Effect.as(session)),
  );
  const close = vi.fn(() =>
    Effect.sync(() => {
      order.push("close");
    }),
  );
  const get = vi.fn(() => Effect.succeed(Option.none<ProviderAdapterV2SessionRuntime>()));
  const reviveForThread = vi.fn(() =>
    Effect.sync(() => {
      order.push("revive");
    }).pipe(
      Effect.andThen(input.revivalGate ?? Effect.void),
      Effect.andThen(
        Effect.succeed({
          revived: input.revival === "revived",
          generation: 0,
        }),
      ),
    ),
  );
  const worktreeLayer = Layer.mock(WorktreeRevivalService.WorktreeRevivalService)({
    reviveForThread,
  });
  const getThreadProjection = vi.fn(() => Effect.sync(currentProjection));
  const startRootRun = vi.fn(() =>
    Effect.sync(() => {
      order.push("start-root-run");
    }),
  );
  const providerLayer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] } as never),
        }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection,
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open, close, get }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({
          startRootRun,
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () =>
            Effect.succeed({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: projection.thread.worktreePath,
            }),
        }),
        worktreeLayer,
      ),
    ),
  );
  return {
    layer: providerLayer,
    order,
    open,
    close,
    reviveForThread,
    startRootRun,
    ensureThread,
    threadId,
    runId,
    setRunStatus: (status: OrchestrationV2Run["status"]) => {
      runStatus = status;
    },
  };
}

const makeSharedProviderSessionFixture = Effect.gen(function* () {
  const providerSessionId = ProviderSessionId.make(
    "provider_session_provider_turn_start_shared_generation",
  );
  const providerInstanceId = ProviderInstanceId.make(
    "provider_instance_provider_turn_start_shared_generation",
  );
  const projectId = ProjectId.make("project_provider_turn_start_shared_generation");
  const worktreePath = "/tmp/t3-worktrees/shared-generation";
  const branch = "feature/shared-generation";
  const makeProjection = (key: "first" | "second") => {
    const threadId = ThreadId.make(`thread_provider_turn_start_shared_generation_${key}`);
    const runId = RunId.make(`run_provider_turn_start_shared_generation_${key}`);
    const attemptId = RunAttemptId.make(`attempt_provider_turn_start_shared_generation_${key}`);
    const rootNodeId = NodeId.make(`node_provider_turn_start_shared_generation_${key}`);
    const providerThreadId = ProviderThreadId.make(
      `provider_thread_provider_turn_start_shared_generation_${key}`,
    );
    const messageId = MessageId.make(`message_provider_turn_start_shared_generation_${key}`);
    const checkpointScopeId = CheckpointScopeId.make(
      `checkpoint_scope_provider_turn_start_shared_generation_${key}`,
    );
    const providerThread = {
      id: providerThreadId,
      providerSessionId,
      providerInstanceId,
      nativeThreadRef: null,
      handoffIds: [],
      forkedFrom: null,
      appThreadId: threadId,
    };
    const projection = {
      thread: {
        id: threadId,
        projectId,
        branch,
        worktreePath,
      },
      runs: [
        {
          id: runId,
          status: "starting",
          rootNodeId,
          activeAttemptId: attemptId,
          providerThreadId,
          userMessageId: messageId,
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "test-model" },
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
          text: `continue ${key}`,
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
    return { key, threadId, runId, providerThread, projection };
  };
  const first = makeProjection("first");
  const second = makeProjection("second");
  const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>([
    [first.threadId, first.projection],
    [second.threadId, second.projection],
  ]);
  const providerThreads = new Map([
    [first.threadId, first.providerThread],
    [second.threadId, second.providerThread],
  ]);
  const keyByThreadId = new Map<ThreadId, "first" | "second">([
    [first.threadId, "first"],
    [second.threadId, "second"],
  ]);
  const order: string[] = [];
  const firstStartRootRunEntered = yield* Deferred.make<void>();
  const releaseFirstStartRootRun = yield* Deferred.make<void>();
  const secondRevivalCompleted = yield* Deferred.make<void>();
  const secondStartRootRunEntered = yield* Deferred.make<void>();

  const session = {
    driver: "codex",
    instanceId: providerInstanceId,
    providerSessionId,
    providerSession: { id: providerSessionId },
    ensureThread: (input: { readonly threadId: ThreadId }) =>
      Effect.sync(() => {
        const providerThread = providerThreads.get(input.threadId);
        if (providerThread === undefined) {
          throw new Error(`Missing provider thread for ${input.threadId}.`);
        }
        return providerThread;
      }),
    resumeThread: () => Effect.succeed(first.providerThread),
    forkThread: () => Effect.succeed(first.providerThread),
  } as unknown as ProviderAdapterV2SessionRuntime;
  let liveSession: ProviderAdapterV2SessionRuntime | undefined;
  const open = vi.fn((input: { readonly threadId: ThreadId }) =>
    Effect.sync(() => {
      order.push(`open:${keyByThreadId.get(input.threadId)}`);
      liveSession = session;
      return session;
    }),
  );
  const close = vi.fn(() =>
    Effect.sync(() => {
      order.push("close");
      liveSession = undefined;
    }),
  );
  const get = vi.fn(() => Effect.succeed(Option.fromNullishOr(liveSession)));
  const reviveForThread = vi.fn((input: { readonly threadId: ThreadId }) => {
    const key = keyByThreadId.get(input.threadId);
    return Effect.sync(() => {
      order.push(`revive:${key}`);
    }).pipe(
      Effect.andThen(
        key === "second" ? Deferred.succeed(secondRevivalCompleted, undefined) : Effect.void,
      ),
      Effect.as({ revived: false, generation: key === "second" ? 1 : 0 }),
    );
  });
  const startRootRun = vi.fn((input: { readonly appThread: { readonly id: ThreadId } }) => {
    const key = keyByThreadId.get(input.appThread.id);
    return Effect.sync(() => {
      order.push(`start-root-run:${key}`);
    }).pipe(
      Effect.andThen(
        key === "first"
          ? Deferred.succeed(firstStartRootRunEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirstStartRootRun)),
              Effect.andThen(
                Effect.sync(() => {
                  order.push("start-root-run:first:completed");
                }),
              ),
            )
          : Deferred.succeed(secondStartRootRunEntered, undefined),
      ),
    );
  });
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] } as never),
        }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: (threadId) =>
            Effect.sync(() => {
              const projection = projections.get(threadId);
              if (projection === undefined) {
                throw new Error(`Missing projection for ${threadId}.`);
              }
              return projection;
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open, close, get }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () =>
            Effect.succeed({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: worktreePath,
            }),
        }),
        Layer.mock(WorktreeRevivalService.WorktreeRevivalService)({ reviveForThread }),
      ),
    ),
  );

  return {
    first,
    second,
    layer,
    order,
    open,
    close,
    firstStartRootRunEntered,
    releaseFirstStartRootRun,
    secondRevivalCompleted,
    secondStartRootRunEntered,
  };
});

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

  await Effect.flatMap(ProviderTurnStart.ProviderTurnStartServiceV2, (service) =>
    service.start({ threadId: fixture.threadId, runId: fixture.runId }),
  ).pipe(Effect.provide(fixture.layer), Effect.runPromise);

  expect(fixture.order).toEqual(["revive", "close", "open", "start-root-run"]);
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.open).toHaveBeenCalledOnce();
  expect(fixture.reviveForThread).toHaveBeenCalledOnce();
});

it("stops superseded restart work after restoring the shared provider session", async () => {
  const fixture = makeProviderTurnStartFixture({ revival: "revived", cancelOnOpen: true });

  await Effect.flatMap(ProviderTurnStart.ProviderTurnStartServiceV2, (service) =>
    service.start({ threadId: fixture.threadId, runId: fixture.runId }),
  ).pipe(Effect.provide(fixture.layer), Effect.runPromise);

  expect(fixture.order).toEqual(["revive", "close", "open"]);
  expect(fixture.ensureThread).not.toHaveBeenCalled();
  expect(fixture.startRootRun).not.toHaveBeenCalled();
});

effectIt.effect("does not close a provider session after the starting attempt is superseded", () =>
  Effect.gen(function* () {
    const revivalStarted = yield* Deferred.make<void>();
    const releaseRevival = yield* Deferred.make<void>();
    const fixture = makeProviderTurnStartFixture({
      revival: "revived",
      revivalGate: Deferred.succeed(revivalStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRevival)),
      ),
    });

    const start = yield* ProviderTurnStart.ProviderTurnStartServiceV2.pipe(
      Effect.flatMap((service) =>
        service.start({
          threadId: fixture.threadId,
          runId: fixture.runId,
        }),
      ),
      Effect.provide(fixture.layer),
      Effect.forkChild,
    );
    yield* Deferred.await(revivalStarted);
    fixture.setRunStatus("cancelled");
    yield* Deferred.succeed(releaseRevival, undefined);
    yield* Fiber.join(start);

    expect(fixture.order).toEqual(["revive"]);
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
  }),
);

effectIt.effect(
  "serializes shared-session generation transitions through provider turn startup",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeSharedProviderSessionFixture;
      yield* Effect.gen(function* () {
        const service = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
        const firstStart = yield* service
          .start({ threadId: fixture.first.threadId, runId: fixture.first.runId })
          .pipe(Effect.forkChild);
        yield* Deferred.await(fixture.firstStartRootRunEntered);

        const secondStart = yield* service
          .start({ threadId: fixture.second.threadId, runId: fixture.second.runId })
          .pipe(Effect.forkChild);
        yield* Deferred.await(fixture.secondRevivalCompleted);

        expect(fixture.order).toEqual([
          "revive:first",
          "open:first",
          "start-root-run:first",
          "revive:second",
        ]);
        expect(fixture.close).not.toHaveBeenCalled();
        expect(fixture.open).toHaveBeenCalledOnce();

        yield* Deferred.succeed(fixture.releaseFirstStartRootRun, undefined);
        yield* Deferred.await(fixture.secondStartRootRunEntered);
        yield* Fiber.join(firstStart);
        yield* Fiber.join(secondStart);

        expect(fixture.order).toEqual([
          "revive:first",
          "open:first",
          "start-root-run:first",
          "revive:second",
          "start-root-run:first:completed",
          "close",
          "open:second",
          "start-root-run:second",
        ]);
      }).pipe(Effect.provide(fixture.layer));

      expect(fixture.close).toHaveBeenCalledOnce();
      expect(fixture.open).toHaveBeenCalledTimes(2);
    }),
);
