import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { expect, vi } from "vite-plus/test";

import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import type { ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

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

const driver = ProviderDriverKind.make("codex");
const threadId = ThreadId.make("thread:provider-turn-start");
const childThreadId = ThreadId.make("thread:provider-turn-start:child");
const runId = RunId.make("run:provider-turn-start");
const rootNodeId = NodeId.make("node:provider-turn-start:root");
const subagentId = NodeId.make("node:provider-turn-start:subagent");
const attemptId = RunAttemptId.make("attempt:provider-turn-start");
const providerThreadId = ProviderThreadId.make("provider-thread:provider-turn-start");
const childProviderThreadId = ProviderThreadId.make("provider-thread:provider-turn-start:child");
const providerSessionId = ProviderSessionId.make("provider-session:provider-turn-start");
const providerInstanceId = ProviderInstanceId.make("codex");
const messageId = MessageId.make("message:provider-turn-start");
const checkpointScopeId = CheckpointScopeId.make("checkpoint-scope:provider-turn-start");

function makeRootProjection(now: DateTime.Utc): OrchestrationV2ThreadProjection {
  return {
    thread: {
      id: threadId,
      runtimeMode: "full-access",
      interactionMode: "default",
      worktreePath: "/tmp/provider-turn-start",
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        providerInstanceId,
        userMessageId: messageId,
        modelSelection: { instanceId: providerInstanceId },
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        checkpointScopeId,
      },
    ],
    attempts: [
      {
        id: attemptId,
        providerTurnId: null,
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        providerSessionId,
        nativeThreadRef: {
          driver,
          nativeId: "native-root-thread",
          strength: "strong",
        },
        ownerNodeId: rootNodeId,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
      },
    ],
    messages: [
      {
        id: messageId,
        text: "continue the agent",
        attachments: [],
        createdBy: "user",
        creationSource: "user",
      },
    ],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    providerSessions: [],
    subagents: [
      {
        id: subagentId,
        status: "idle",
        childThreadId,
        providerThreadId: childProviderThreadId,
      },
    ],
    turnItems: [
      {
        id: TurnItemId.make("turn-item:provider-turn-start:subagent"),
        type: "subagent",
        subagentId,
        ordinal: 1,
      },
    ],
    providerTurns: [],
  } as unknown as OrchestrationV2ThreadProjection;
}

function makeChildProjection(now: DateTime.Utc): OrchestrationV2ThreadProjection {
  return {
    thread: { id: childThreadId },
    providerThreads: [
      {
        id: childProviderThreadId,
        nativeThreadRef: {
          driver,
          nativeId: "native-child-thread",
          strength: "strong",
        },
        createdAt: now,
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
}

function makeTestLayer(input: {
  readonly rootProjection: OrchestrationV2ThreadProjection;
  readonly childProjection: Effect.Effect<
    OrchestrationV2ThreadProjection,
    ProjectionStore.ProjectionStoreV2Error
  >;
  readonly existingSubagentCounts: Ref.Ref<ReadonlyArray<number>>;
  readonly providerSessionOpens: Ref.Ref<number>;
  readonly runningWrites: Ref.Ref<number>;
}) {
  const session = {
    driver,
    providerSession: { id: providerSessionId },
    resumeThread: ({ providerThread }: { readonly providerThread: unknown }) =>
      Effect.succeed(providerThread),
  } as unknown as ProviderAdapterV2SessionRuntime;

  return ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent: () =>
            Ref.update(input.runningWrites, (count) => count + 1).pipe(
              Effect.as({ committed: true, storedEvents: [] }),
            ),
        }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: (requestedThreadId) =>
            requestedThreadId === threadId
              ? Effect.succeed(input.rootProjection)
              : input.childProjection,
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () =>
            Ref.update(input.providerSessionOpens, (count) => count + 1).pipe(Effect.as(session)),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({
          startRootRun: (startInput) =>
            Ref.update(input.existingSubagentCounts, (counts) => [
              ...counts,
              startInput.existingSubagents?.length ?? 0,
            ]),
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () =>
            Effect.succeed({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/tmp/provider-turn-start",
            }),
        }),
      ),
    ),
  );
}

it.effect("fails before provider turn start when child projection rehydration cannot be read", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const existingSubagentCounts = yield* Ref.make<ReadonlyArray<number>>([]);
    const providerSessionOpens = yield* Ref.make(0);
    const runningWrites = yield* Ref.make(0);
    const readError = new ProjectionStore.ProjectionStoreReadError({
      threadId: childThreadId,
      cause: "temporary database failure",
    });
    const error = yield* Effect.gen(function* () {
      const service = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
      return yield* service.start({ threadId, runId }).pipe(Effect.flip);
    }).pipe(
      Effect.provide(
        makeTestLayer({
          rootProjection: makeRootProjection(now),
          childProjection: Effect.fail(readError),
          existingSubagentCounts,
          providerSessionOpens,
          runningWrites,
        }),
      ),
    );

    assert.equal(error._tag, "ProviderTurnStartError");
    assert.strictEqual(error.cause, readError);
    assert.deepEqual(yield* Ref.get(existingSubagentCounts), []);
    assert.equal(yield* Ref.get(providerSessionOpens), 0);
    assert.equal(yield* Ref.get(runningWrites), 0);
  }),
);

it.effect("skips a missing child projection and still starts the provider turn", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const existingSubagentCounts = yield* Ref.make<ReadonlyArray<number>>([]);
    const providerSessionOpens = yield* Ref.make(0);
    const runningWrites = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const service = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
      yield* service.start({ threadId, runId });
    }).pipe(
      Effect.provide(
        makeTestLayer({
          rootProjection: makeRootProjection(now),
          childProjection: Effect.fail(
            new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId: childThreadId }),
          ),
          existingSubagentCounts,
          providerSessionOpens,
          runningWrites,
        }),
      ),
    );

    assert.deepEqual(yield* Ref.get(existingSubagentCounts), [0]);
    assert.equal(yield* Ref.get(providerSessionOpens), 1);
    assert.equal(yield* Ref.get(runningWrites), 1);
  }),
);

it.effect("rehydrates an existing child projection before starting the provider turn", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const existingSubagentCounts = yield* Ref.make<ReadonlyArray<number>>([]);
    const providerSessionOpens = yield* Ref.make(0);
    const runningWrites = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const service = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
      yield* service.start({ threadId, runId });
    }).pipe(
      Effect.provide(
        makeTestLayer({
          rootProjection: makeRootProjection(now),
          childProjection: Effect.succeed(makeChildProjection(now)),
          existingSubagentCounts,
          providerSessionOpens,
          runningWrites,
        }),
      ),
    );

    assert.deepEqual(yield* Ref.get(existingSubagentCounts), [1]);
    assert.equal(yield* Ref.get(providerSessionOpens), 1);
    assert.equal(yield* Ref.get(runningWrites), 1);
  }),
);
