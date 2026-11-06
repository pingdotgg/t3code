import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  runPoolFailoverCommandId,
  ThreadId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2StoredEvent,
  type ProviderPoolSettings,
  type ServerProvider,
  ClaudeSettings,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeProviderCapabilitiesV2, makeClaudeAdapterV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { ProviderPoolCatalog } from "./ProviderPoolCatalog.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { withProviderPools } from "../provider/providerPoolSnapshot.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

const driver = ProviderDriverKind.make("claudeAgent");
const first = ProviderInstanceId.make("claudeAgent");
const second = ProviderInstanceId.make("claudeAgent_work");
const poolId = ProviderInstanceId.make("pool_claudeAgent");
const projectId = ProjectId.make("project:pool-failover");
const model = "pool-model";
const minutes = (count: number) => count * 60_000;

interface PoolAdapterState {
  /** The next started turn fails with this reset time, whichever member starts it. */
  readonly failNextStart: string | null;
  readonly holdTurn: Deferred.Deferred<void> | null;
  readonly started: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly attemptId: string;
    readonly prompt: string;
  }>;
  /** Every session reports running background work; only the probes read this. */
  readonly backgroundWork?: boolean;
  readonly closedSessions?: ReadonlyArray<string>;
}

function makePoolAdapter(
  instanceId: ProviderInstanceId,
  state: Ref.Ref<PoolAdapterState>,
  capabilities: OrchestrationV2ProviderSession["capabilities"] = CodexProviderCapabilitiesV2,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* Effect.addFinalizer(() =>
          Ref.update(state, (current) => ({
            ...current,
            closedSessions: [...(current.closedSessions ?? []), sessionInput.providerSessionId],
          })),
        );
        const hasBackgroundWork = Ref.get(state).pipe(
          Effect.map((current) => current.backgroundWork === true),
        );
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? "/fallback",
          model: sessionInput.modelSelection.model,
          capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        return {
          instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromQueue(events),
          hasPendingBackgroundWork: hasBackgroundWork,
          hasPendingBackgroundWorkForThread: () => hasBackgroundWork,
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(`provider-thread:${instanceId}:${threadInput.threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: `native-thread:${instanceId}:${threadInput.threadId}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (input) =>
            Effect.gen(function* () {
              const prompt = input.message.text;
              const { failNextStart, holdTurn } = yield* Ref.getAndUpdate(state, (current) => ({
                ...current,
                failNextStart: null,
                started: [...current.started, { instanceId, attemptId: input.attemptId, prompt }],
              }));
              const providerTurnId = ProviderTurnId.make(`provider-turn:${input.attemptId}`);
              const occurredAt = yield* DateTime.now;
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: input.providerThread.id,
                  nodeId: input.rootNodeId,
                  runAttemptId: input.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${providerTurnId}`,
                    strength: "strong",
                  },
                  ordinal: input.providerTurnOrdinal,
                  status: "running",
                  startedAt: occurredAt,
                  completedAt: null,
                },
              });
              if (failNextStart !== null) {
                yield* Queue.offer(events, {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: input.providerThread.id,
                  providerTurnId,
                  runOrdinal: input.runOrdinal,
                  failureItemOrdinal: input.providerTurnOrdinal * 100 + 1,
                  status: "failed",
                  failure: {
                    class: "usage_limit",
                    message: "Usage limit reached.",
                    code: "api_error_429",
                    retryable: true,
                    resetAt: failNextStart,
                  },
                  threadDisposition: "reusable",
                });
                return;
              }
              if (holdTurn !== null) yield* Deferred.await(holdTurn);
              const completedAt = yield* DateTime.now;
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: input.providerThread.id,
                  nodeId: input.rootNodeId,
                  runAttemptId: input.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${providerTurnId}`,
                    strength: "strong",
                  },
                  ordinal: input.providerTurnOrdinal,
                  status: "completed",
                  startedAt: occurredAt,
                  completedAt,
                },
              });
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: input.providerThread.id,
                providerTurnId,
                runOrdinal: input.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

const makeInstance = (
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
  continuationKey: string,
): ProviderInstance => ({
  instanceId: adapter.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey },
  displayName: String(adapter.instanceId),
  enabled: true,
  snapshot: {} as ProviderInstance["snapshot"],
  orchestrationAdapter: adapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
});

const makeProvider = (
  instanceId: ProviderInstanceId,
  displayName: string,
  groupKey: string,
  limitedUntil?: string,
): ServerProvider => ({
  instanceId,
  driver,
  displayName,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-19T00:00:00.000Z",
  continuation: { groupKey },
  models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  ...(limitedUntil === undefined ? {} : { limitedUntil }),
});

const poolSettings: ProviderPoolSettings = {
  [driver]: { enabled: true, memberInstanceIds: [first, second] },
};

const settings = {
  providerInstances: {
    [first]: { driver, enabled: true },
    [second]: { driver, enabled: true },
  },
  providerPools: poolSettings,
};

const makeCatalog = (
  providers: Ref.Ref<ReadonlyArray<ServerProvider>>,
  providerPools: ProviderPoolSettings = poolSettings,
) =>
  Layer.succeed(ProviderPoolCatalog, {
    getPublishedProviders: Ref.get(providers).pipe(
      Effect.map((members) => withProviderPools({ providers: members, providerPools })),
    ),
    markLimited: ({ instanceId, until }) =>
      Ref.update(providers, (members) =>
        members.map((member) =>
          member.instanceId === instanceId ? { ...member, limitedUntil: until } : member,
        ),
      ),
  });

const makeRegistry = (
  keys: { readonly first: string; readonly second: string },
  state: Ref.Ref<PoolAdapterState>,
  missingInstanceId?: ProviderInstanceId,
  capabilities?: OrchestrationV2ProviderSession["capabilities"],
) => {
  const instances = [
    makeInstance(makePoolAdapter(first, state, capabilities), keys.first),
    makeInstance(makePoolAdapter(second, state, capabilities), keys.second),
  ].filter((instance) => instance.instanceId !== missingInstanceId);
  return ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (instanceId) =>
          Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
        listInstances: Effect.succeed(instances),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
  );
};

const createThread = (threadId: ThreadId, cwd: string, instanceId: ProviderInstanceId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId,
      title: "Pool failover",
      modelSelection: { instanceId, model },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
    });
  });

const sendMessage = (threadId: ThreadId, key: string, instanceId?: ProviderInstanceId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${threadId}:${key}`),
      threadId,
      messageId: MessageId.make(`${threadId}:${key}:message`),
      text: key,
      attachments: [],
      ...(instanceId === undefined ? {} : { modelSelection: { instanceId, model } }),
      dispatchMode: { type: "start_immediately" },
    });
  });

const awaitEvent = (
  threadId: ThreadId,
  matches: (event: OrchestrationV2StoredEvent["event"]) => boolean,
) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    return yield* eventSink
      .stream({ threadId, afterSequence: yield* eventSink.latestSequence({ threadId }) })
      .pipe(
        Stream.filter((stored) => matches(stored.event)),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
  });

const awaitRunStatus = (threadId: ThreadId, status: "completed" | "failed" | "running") =>
  awaitEvent(threadId, (event) => event.type === "run.updated" && event.payload.status === status);

/** The adapter records the start, and reads its fault, before the turn reports running. */
const awaitProviderTurnRunning = (threadId: ThreadId) =>
  awaitEvent(
    threadId,
    (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
  );

it.live("moves a limited Claude turn to the other account with a summary handoff", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("pool-failover-claude");
      const threadId = ThreadId.make("thread:pool-failover-claude");
      const resetAt = DateTime.formatIso(
        DateTime.makeUnsafe(DateTime.toEpochMillis(yield* DateTime.now) + minutes(30)),
      );
      const state = yield* Ref.make<PoolAdapterState>({
        failNextStart: resetAt,
        holdTurn: null,
        started: [],
      });
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
        makeProvider(first, "Claude", "claude:home:first"),
        makeProvider(second, "Claude - Work", "claude:home:second"),
      ]);
      const result = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* createThread(threadId, cwd, poolId);
        const firstCompleted = yield* awaitRunStatus(threadId, "completed");
        const hold = yield* Deferred.make<void>();
        yield* Ref.update(state, (current) => ({ ...current, holdTurn: hold }));
        yield* sendMessage(threadId, "first");
        const running = yield* awaitRunStatus(threadId, "running");
        yield* Fiber.join(running);
        yield* sendMessage(threadId, "second");
        yield* Deferred.succeed(hold, undefined);
        yield* Fiber.join(firstCompleted);
        const secondCompleted = yield* awaitRunStatus(threadId, "completed");
        yield* Ref.update(state, (current) => ({ ...current, holdTurn: null }));
        yield* Fiber.join(secondCompleted);
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        const failedAttemptId = projection.attempts[0]!.id;
        const replay = yield* orchestrator.dispatch({
          type: "run.pool-failover",
          commandId: runPoolFailoverCommandId(failedAttemptId),
          threadId,
          runId: projection.runs[0]!.id,
          attemptId: failedAttemptId,
          failure: {
            class: "usage_limit",
            message: "Usage limit reached.",
            code: "api_error_429",
            retryable: true,
            resetAt,
          },
        });
        yield* worker.drain();
        return {
          projection: yield* orchestrator.getThreadProjection(threadId),
          replayedEvents: replay.storedEvents.length,
          started: (yield* Ref.get(state)).started,
          members: yield* Ref.get(providers),
        };
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "pool-failover-claude" },
            makeRegistry({ first: "claude:home:first", second: "claude:home:second" }, state),
            { settings, poolCatalog: makeCatalog(providers) },
          ),
        ),
      );

      const { projection, started } = result;
      const [firstRun, secondRun] = projection.runs;
      assert.lengthOf(projection.runs, 2);
      assert.equal(firstRun?.status, "completed");
      const attempts = projection.attempts.filter((attempt) => attempt.runId === firstRun?.id);
      assert.deepEqual(
        attempts.map((attempt) => [attempt.status, attempt.reason]),
        [
          ["failed", "initial"],
          ["completed", "provider_recovery"],
        ],
      );
      const [limited, recovered] = attempts;
      assert.notEqual(limited?.providerInstanceId, recovered?.providerInstanceId);
      assert.equal(firstRun?.providerInstanceId, recovered?.providerInstanceId);
      assert.equal(projection.thread.providerInstanceId, recovered?.providerInstanceId);

      const handoff = projection.contextHandoffs.find(
        (candidate) => candidate.targetRunId === firstRun?.id,
      );
      assert.equal(handoff?.strategy, "full_thread_summary");
      assert.isFalse(handoff?.history?.messages.some((message) => message.kind === "error"));
      assert.lengthOf(
        projection.messages.filter((message) => message.runId === firstRun?.id),
        1,
      );
      assert.deepEqual(
        started.map((turn) => turn.instanceId),
        [limited?.providerInstanceId, recovered?.providerInstanceId, recovered?.providerInstanceId],
      );
      assert.isTrue(started[1]?.prompt.includes("first"));
      assert.isTrue(started[1]?.prompt.includes("Context handoff"));

      const notice = projection.turnItems.find((item) => item.type === "system_notice");
      const limitedName = result.members.find(
        (member) => member.instanceId === limited?.providerInstanceId,
      )?.displayName;
      const recoveredName = result.members.find(
        (member) => member.instanceId === recovered?.providerInstanceId,
      )?.displayName;
      assert.equal(
        notice?.type === "system_notice" ? notice.message : null,
        `${limitedName} reached its usage limit. Continuing on ${recoveredName}.`,
      );
      assert.equal(
        result.members.find((member) => member.instanceId === limited?.providerInstanceId)
          ?.limitedUntil,
        resetAt,
      );

      assert.equal(secondRun?.status, "completed");
      assert.equal(secondRun?.providerInstanceId, recovered?.providerInstanceId);
      assert.lengthOf(projection.attempts, 3);
      assert.isAbove(result.replayedEvents, 0);
    }),
  ),
);

it.live("moves a limited shared-home turn to the other account with a native resume", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("pool-failover-shared");
      const threadId = ThreadId.make("thread:pool-failover-shared");
      const resetAt = DateTime.formatIso(
        DateTime.makeUnsafe(DateTime.toEpochMillis(yield* DateTime.now) + minutes(30)),
      );
      const state = yield* Ref.make<PoolAdapterState>({
        failNextStart: null,
        holdTurn: null,
        started: [],
      });
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
        makeProvider(first, "Codex", "codex:home:shared"),
        makeProvider(second, "Codex 2", "codex:home:shared"),
      ]);
      const projection = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* createThread(threadId, cwd, poolId);
        const warmed = yield* awaitRunStatus(threadId, "completed");
        yield* sendMessage(threadId, "warm");
        yield* Fiber.join(warmed);
        yield* worker.drain();
        yield* Ref.update(state, (current) => ({ ...current, failNextStart: resetAt }));
        const completed = yield* awaitRunStatus(threadId, "completed");
        yield* sendMessage(threadId, "limited");
        yield* Fiber.join(completed);
        yield* worker.drain();
        return yield* orchestrator.getThreadProjection(threadId);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "pool-failover-shared" },
            makeRegistry({ first: "codex:home:shared", second: "codex:home:shared" }, state),
            { settings, poolCatalog: makeCatalog(providers) },
          ),
        ),
      );

      const run = projection.runs[1];
      assert.equal(run?.status, "completed");
      const attempts = projection.attempts.filter((attempt) => attempt.runId === run?.id);
      assert.deepEqual(
        attempts.map((attempt) => attempt.status),
        ["failed", "completed"],
      );
      assert.notEqual(attempts[0]?.providerInstanceId, attempts[1]?.providerInstanceId);
      assert.lengthOf(projection.contextHandoffs, 0);
      const resumed = projection.providerThreads.find(
        (candidate) => candidate.id === run?.providerThreadId,
      );
      assert.equal(resumed?.providerInstanceId, attempts[1]?.providerInstanceId);
      assert.equal(
        resumed?.nativeThreadRef?.nativeId,
        `native-thread:${attempts[0]?.providerInstanceId}:${threadId}`,
      );
    }),
  ),
);

it.live.each([
  [
    "hands a busy session off without closing it",
    { background: true, sharedHome: false, sharedSession: false },
  ],
  [
    "hands a busy shared session off without detaching it",
    { background: true, sharedHome: false, sharedSession: true },
  ],
  [
    "closes an idle session it hands off",
    { background: false, sharedHome: false, sharedSession: false },
  ],
  [
    "fails rather than resume a busy session's native thread",
    { background: true, sharedHome: true, sharedSession: false },
  ],
] as const)("%s", ([, { background, sharedHome, sharedSession }]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("pool-failover-background");
      const label = `${background}-${sharedHome}-${sharedSession}`;
      const threadId = ThreadId.make(`thread:pool-failover-background-${label}`);
      const resetAt = DateTime.formatIso(
        DateTime.makeUnsafe(DateTime.toEpochMillis(yield* DateTime.now) + minutes(30)),
      );
      const state = yield* Ref.make<PoolAdapterState>({
        failNextStart: null,
        holdTurn: null,
        started: [],
      });
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
        makeProvider(first, "Claude", "claude:home:first"),
        makeProvider(second, "Claude - Work", "claude:home:second"),
      ]);
      const keys = sharedHome
        ? { first: "claude:home:shared", second: "claude:home:shared" }
        : { first: "claude:home:first", second: "claude:home:second" };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* createThread(threadId, cwd, poolId);
        const warmed = yield* awaitRunStatus(threadId, "completed");
        yield* sendMessage(threadId, "warm");
        yield* Fiber.join(warmed);
        yield* worker.drain();
        const limitedSessionId = (yield* orchestrator.getThreadProjection(threadId))
          .providerSessions[0]!.id;
        yield* Ref.update(state, (current) => ({
          ...current,
          failNextStart: resetAt,
          backgroundWork: background,
        }));
        const settled = yield* awaitEvent(
          threadId,
          (event) =>
            event.type === "run.updated" &&
            event.payload.ordinal === 2 &&
            (event.payload.status === "failed" || event.payload.status === "completed"),
        );
        yield* sendMessage(threadId, "limited");
        yield* Fiber.join(settled);
        yield* worker.drain();
        const limited = yield* orchestrator.getThreadProjection(threadId);
        const limitedAttempts = limited.attempts.filter(
          (attempt) => attempt.runId === limited.runs[1]?.id,
        );
        const { closedSessions = [] } = yield* Ref.get(state);
        // A failed attempt's thread settles like any failed run's; failover must not skip it.
        assert.equal(
          limited.providerThreads.find(
            (candidate) => candidate.providerInstanceId === limitedAttempts[0]?.providerInstanceId,
          )?.status,
          "idle",
        );

        if (!background) {
          assert.equal(limited.runs[1]?.status, "completed");
          assert.deepEqual(closedSessions, [limitedSessionId]);
          return;
        }
        assert.deepEqual(closedSessions, []);
        assert.equal(
          limited.providerSessions.find((session) => session.id === limitedSessionId)?.status,
          "ready",
        );
        if (!sharedHome) {
          assert.equal(limited.runs[1]?.status, "completed");
          assert.deepEqual(
            limitedAttempts.map((attempt) => attempt.status),
            ["failed", "completed"],
          );
          assert.notEqual(
            limitedAttempts[0]?.providerInstanceId,
            limitedAttempts[1]?.providerInstanceId,
          );
          return;
        }

        // Resuming the native thread beside the busy session would fork its history.
        assert.equal(limited.runs[1]?.status, "failed");
        assert.deepEqual(
          limitedAttempts.map((attempt) => attempt.status),
          ["failed"],
        );
        assert.lengthOf((yield* Ref.get(state)).started, 2);
        const limitError = limited.turnItems.find((item) => item.type === "error");
        assert.equal(limitError?.type === "error" ? limitError.failure.class : null, "usage_limit");

        const refused = yield* sendMessage(threadId, "too-soon").pipe(Effect.flip);
        assert.equal(refused._tag, "OrchestratorDispatchError");
        assert.include(
          refused._tag === "OrchestratorDispatchError" ? String(refused.cause) : "",
          "still running background agents or commands",
        );
        assert.deepEqual((yield* Ref.get(state)).closedSessions ?? [], []);

        yield* Ref.update(state, (current) => ({ ...current, backgroundWork: false }));
        const continued = yield* awaitEvent(
          threadId,
          (event) =>
            event.type === "run.updated" &&
            event.payload.ordinal === 3 &&
            event.payload.status === "completed",
        );
        yield* sendMessage(threadId, "continue");
        yield* Fiber.join(continued);
        yield* worker.drain();
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        const resumedRun = resumed.runs[2];
        assert.notEqual(resumedRun?.providerInstanceId, limited.runs[1]?.providerInstanceId);
        assert.equal(
          resumed.providerThreads.find((candidate) => candidate.id === resumedRun?.providerThreadId)
            ?.nativeThreadRef?.nativeId,
          `native-thread:${limited.runs[1]?.providerInstanceId}:${threadId}`,
        );
        assert.deepEqual((yield* Ref.get(state)).closedSessions, [limitedSessionId]);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: `pool-failover-background-${label}` },
            makeRegistry(
              keys,
              state,
              undefined,
              sharedSession ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
            ),
            { settings, poolCatalog: makeCatalog(providers) },
          ),
        ),
      );
    }),
  ),
);

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const claudeSessionId = "pool-claude-native-session";
const claudeFrame = (frame: Record<string, unknown>) =>
  ({ session_id: claudeSessionId, ...frame }) as unknown as SDKMessage;
const claudeResult = (uuid: string, overrides: Record<string, unknown> = {}) =>
  claudeFrame({
    type: "result",
    subtype: "success",
    uuid,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "done",
    stop_reason: "end_turn",
    terminal_reason: "completed",
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    ...overrides,
  });

interface ClaudeMemberScript {
  readonly frames: Queue.Queue<SDKMessage>;
  readonly offers: Array<SDKUserMessage>;
  readonly resumes: Array<string | undefined>;
}

/** Real Claude adapters over scripted SDK streams, so the wake buffer and its probe are the real ones. */
const makeClaudeMemberRegistry = (scripts: ReadonlyMap<ProviderInstanceId, ClaudeMemberScript>) =>
  ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
    Layer.provide(
      Layer.effect(
        ProviderInstanceRegistry.ProviderInstanceRegistry,
        Effect.gen(function* () {
          const continuationRequests =
            yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const instances = yield* Effect.forEach([...scripts], ([instanceId, script]) =>
            Effect.gen(function* () {
              const adapter = yield* makeClaudeAdapterV2({
                instanceId,
                settings: decodeClaudeSettings({}),
                environment: {},
                attachmentsDir: "/tmp",
                fileSystem: yield* FileSystem.FileSystem,
                path: yield* Path.Path,
                random: yield* SecureRandom.SecureRandom,
                idAllocator: yield* IdAllocator.IdAllocatorV2,
                continuationRequests,
                queryRunner: {
                  allocateSessionId: Effect.succeed(claudeSessionId),
                  open: (input) =>
                    Effect.sync(() => {
                      script.resumes.push(input.options.resume);
                      return {
                        messages: Stream.fromQueue(script.frames),
                        offer: (message: SDKUserMessage) =>
                          Effect.sync(() => {
                            script.offers.push(message);
                          }),
                        setModel: () => Effect.void,
                        applyFlagSettings: () => Effect.void,
                        setPermissionMode: () => Effect.void,
                        backgroundTasks: () => Effect.succeed(false),
                        stopTask: () => Effect.void,
                        mcpServerStatus: Effect.die("unused MCP server status"),
                        readMcpResource: () => Effect.die("unused MCP resource read"),
                        callMcpTool: () => Effect.die("unused MCP tool call"),
                        listPermissionRules: Effect.die("unused permission rules read"),
                        interrupt: Effect.void,
                        close: Effect.void,
                      };
                    }),
                  forkSession: () => Effect.die("unused forkSession"),
                  subagentLaunchToolUseId: () => Effect.succeed(null),
                  assertComplete: Effect.void,
                },
              });
              return makeInstance(adapter, "claude:home:shared");
            }),
          );
          return {
            getInstance: (instanceId: ProviderInstanceId) =>
              Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
            listInstances: Effect.succeed(instances),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.never,
          } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];
        }),
      ),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, IdAllocator.layer)),
  );

it.live("drains a refused failover's Claude wake on its own account, then moves the thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("pool-failover-claude-wake");
      const threadId = ThreadId.make("thread:pool-failover-claude-wake");
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const scripts = new Map<ProviderInstanceId, ClaudeMemberScript>();
      for (const instanceId of [first, second]) {
        scripts.set(instanceId, {
          frames: yield* Queue.unbounded<SDKMessage>(),
          offers: [],
          resumes: [],
        });
      }
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
        makeProvider(first, "Claude", "claude:home:shared"),
        makeProvider(second, "Claude - Work", "claude:home:shared"),
      ]);
      const offeredText = (script: ClaudeMemberScript | undefined) =>
        (script?.offers ?? []).flatMap((message) =>
          typeof message.message.content === "string"
            ? [message.message.content]
            : message.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
        );
      const runSettled = (threadRunOrdinal: number, status: "completed" | "failed") =>
        awaitEvent(
          threadId,
          (event) =>
            event.type === "run.updated" &&
            event.payload.ordinal === threadRunOrdinal &&
            event.payload.status === status,
        );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* createThread(threadId, cwd, poolId);
        const running = yield* awaitProviderTurnRunning(threadId);
        const limitedRun = yield* runSettled(1, "failed");
        yield* sendMessage(threadId, "limited");
        yield* Fiber.join(running);
        const limitedId = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!
          .providerInstanceId;
        const siblingId = limitedId === first ? second : first;
        const limited = scripts.get(limitedId)!;
        const sibling = scripts.get(siblingId)!;

        yield* Queue.offerAll(limited.frames, [
          claudeFrame({
            type: "system",
            subtype: "task_started",
            task_id: "bg-task",
            tool_use_id: "bg-tool",
            description: "Background agent",
            is_backgrounded: true,
            task_type: "local_agent",
            uuid: "00000000-0000-4000-8000-000000000a01",
          }),
          claudeFrame({
            type: "rate_limit_event",
            rate_limit_info: {
              status: "rejected",
              rateLimitType: "five_hour",
              resetsAt: Math.floor((nowMs + minutes(30)) / 1000),
            },
            uuid: "00000000-0000-4000-8000-000000000a02",
          }),
          claudeResult("00000000-0000-4000-8000-000000000a03", {
            is_error: true,
            result: "Usage limit reached.",
            api_error_status: 429,
            terminal_reason: "api_error",
          }),
        ]);
        yield* Fiber.join(limitedRun);
        const refused = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(refused.thread.providerInstanceId, limitedId);
        assert.lengthOf(sibling.resumes, 0);

        // The CLI wakes on its own once the task ends; the adapter buffers it and asks for a run.
        const drained = yield* runSettled(2, "completed");
        yield* Queue.offerAll(limited.frames, [
          claudeFrame({
            type: "system",
            subtype: "task_notification",
            task_id: "bg-task",
            tool_use_id: "bg-tool",
            status: "completed",
            output_file: "/tmp/bg-task.output",
            summary: "Background agent completed",
            uuid: "00000000-0000-4000-8000-000000000a04",
          }),
          claudeFrame({
            type: "system",
            subtype: "init",
            uuid: "00000000-0000-4000-8000-000000000a05",
          }),
          claudeResult("00000000-0000-4000-8000-000000000a06", {
            result: "WAKE_DONE",
            origin: { kind: "task-notification" },
          }),
        ]);
        yield* Fiber.join(drained);
        const afterWake = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(afterWake.runs[1]?.providerInstanceId, limitedId);
        assert.lengthOf(limited.offers, 1, "a drain must not prompt the cooling account");
        assert.lengthOf(sibling.resumes, 0);

        const moved = yield* runSettled(3, "completed");
        const movedTurnRunning = yield* awaitProviderTurnRunning(threadId);
        yield* sendMessage(threadId, "next");
        yield* Fiber.join(movedTurnRunning);
        yield* Queue.offer(sibling.frames, claudeResult("00000000-0000-4000-8000-000000000a07"));
        yield* Fiber.join(moved);
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(resumed.runs[2]?.providerInstanceId, siblingId);
        assert.deepEqual(sibling.resumes, [claudeSessionId]);
        assert.include(offeredText(sibling).join("\n"), "next");
        assert.lengthOf(limited.offers, 1);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "pool-failover-claude-wake" },
            makeClaudeMemberRegistry(scripts),
            { settings, poolCatalog: makeCatalog(providers), runContinuationWorker: true },
          ),
        ),
      );
    }),
  ),
);

it.live("keeps a wake queued behind another wake on the cooling account", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("pool-failover-queued-wake");
      const threadId = ThreadId.make("thread:pool-failover-queued-wake");
      const resetAt = DateTime.formatIso(
        DateTime.makeUnsafe(DateTime.toEpochMillis(yield* DateTime.now) + minutes(30)),
      );
      const hold = yield* Deferred.make<void>();
      const state = yield* Ref.make<PoolAdapterState>({
        failNextStart: null,
        holdTurn: null,
        started: [],
      });
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
        makeProvider(first, "Claude", "claude:home:shared"),
        makeProvider(second, "Claude - Work", "claude:home:shared"),
      ]);
      const sendWake = (key: string) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "agent",
            creationSource: "provider",
            commandId: CommandId.make(`${threadId}:${key}`),
            threadId,
            messageId: MessageId.make(`${threadId}:${key}:message`),
            text: "Background task completed.",
            notification: {
              source: { kind: "background_task" },
              outcome: "updated",
              summary: "Background activity updated",
            },
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
          });
        });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* createThread(threadId, cwd, poolId);
        const warmed = yield* awaitRunStatus(threadId, "completed");
        yield* sendMessage(threadId, "warm");
        yield* Fiber.join(warmed);
        yield* worker.drain();
        yield* Ref.update(state, (current) => ({
          ...current,
          failNextStart: resetAt,
          backgroundWork: true,
        }));
        const refused = yield* awaitRunStatus(threadId, "failed");
        yield* sendMessage(threadId, "limited");
        yield* Fiber.join(refused);
        yield* worker.drain();

        yield* Ref.update(state, (current) => ({ ...current, holdTurn: hold }));
        const draining = yield* awaitProviderTurnRunning(threadId);
        yield* sendWake("first-wake");
        yield* Fiber.join(draining);
        const queuedDrained = yield* awaitEvent(
          threadId,
          (event) =>
            event.type === "run.updated" &&
            event.payload.ordinal === 4 &&
            event.payload.status === "completed",
        );
        yield* sendWake("second-wake");
        yield* Deferred.succeed(hold, undefined);
        yield* Fiber.join(queuedDrained);

        const projection = yield* orchestrator.getThreadProjection(threadId);
        const limitedInstance = projection.runs[1]?.providerInstanceId;
        assert.deepEqual(
          projection.runs.slice(2).map((run) => [run.status, run.providerInstanceId]),
          [
            ["completed", limitedInstance],
            ["completed", limitedInstance],
          ],
        );
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "pool-failover-queued-wake" },
            makeRegistry(
              { first: "claude:home:shared", second: "claude:home:shared" },
              state,
              undefined,
              ClaudeProviderCapabilitiesV2,
            ),
            { settings, poolCatalog: makeCatalog(providers) },
          ),
        ),
      );
    }),
  ),
);

it.live("fails the run with the pool's earliest reset when every account is cooling", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("pool-failover-cooling");
      const threadId = ThreadId.make("thread:pool-failover-cooling");
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const failureResetAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs + minutes(30)));
      const siblingResetAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs + minutes(10)));
      const state = yield* Ref.make<PoolAdapterState>({
        failNextStart: failureResetAt,
        holdTurn: null,
        started: [],
      });
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
        makeProvider(first, "Claude", "claude:home:first"),
        makeProvider(second, "Claude - Work", "claude:home:second", siblingResetAt),
      ]);
      const { projection, shell } = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* createThread(threadId, cwd, poolId);
        const failed = yield* awaitRunStatus(threadId, "failed");
        yield* sendMessage(threadId, "limited");
        yield* Fiber.join(failed);
        yield* worker.drain();
        return {
          projection: yield* orchestrator.getThreadProjection(threadId),
          shell: yield* orchestrator.getThreadShell(threadId),
        };
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "pool-failover-cooling" },
            makeRegistry({ first: "claude:home:first", second: "claude:home:second" }, state),
            { settings, poolCatalog: makeCatalog(providers) },
          ),
        ),
      );

      assert.equal(projection.runs[0]?.providerInstanceId, first);
      assert.equal(projection.runs[0]?.status, "failed");
      assert.lengthOf(projection.attempts, 1);
      const error = projection.turnItems.find((item) => item.type === "error");
      assert.equal(error?.type === "error" ? error.failure.resetAt : null, siblingResetAt);
      assert.equal(shell?.usageLimitResetAt, siblingResetAt);
      const armed = limitRecoveryCommand(shell!, true, nowMs);
      assert.equal(armed?.type, "thread.metadata.update");
      assert.equal(
        armed?.type === "thread.metadata.update" ? armed.limitRecovery?.resetAt : null,
        siblingResetAt,
      );
    }),
  ),
);

it.live.each(["cooling", "unregistered"] as const)(
  "routes a selection naming a %s account to its healthy sibling",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("pool-failover-cooling-member");
        const threadId = ThreadId.make("thread:pool-failover-cooling-member");
        const state = yield* Ref.make<PoolAdapterState>({
          failNextStart: null,
          holdTurn: null,
          started: [],
        });
        const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
          makeProvider(
            first,
            "Claude",
            "claude:home:first",
            scenario === "cooling"
              ? DateTime.formatIso(
                  DateTime.makeUnsafe(DateTime.toEpochMillis(yield* DateTime.now) + minutes(10)),
                )
              : undefined,
          ),
          {
            ...makeProvider(second, "Claude - Work", "claude:home:second"),
            usageLimits: {
              checkedAt: "2026-10-01T00:00:00.000Z",
              windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 50 }],
            },
          },
        ]);
        const projection = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* createThread(threadId, cwd, first);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).thread.providerInstanceId,
            second,
          );
          const completed = yield* awaitRunStatus(threadId, "completed");
          yield* sendMessage(threadId, "hello", first);
          yield* Fiber.join(completed);
          yield* worker.drain();
          return yield* orchestrator.getThreadProjection(threadId);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "pool-failover-cooling-member" },
              makeRegistry(
                { first: "claude:home:first", second: "claude:home:second" },
                state,
                scenario === "unregistered" ? first : undefined,
              ),
              { settings, poolCatalog: makeCatalog(providers) },
            ),
          ),
        );
        assert.equal(projection.runs[0]?.providerInstanceId, second);
        assert.equal(projection.runs[0]?.status, "completed");
      }),
    ),
);

it.live("holds queued work when every pooled account becomes signed out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("pool-failover-queued-exhausted");
      const threadId = ThreadId.make("thread:pool-failover-queued-exhausted");
      const state = yield* Ref.make<PoolAdapterState>({
        failNextStart: null,
        holdTurn: null,
        started: [],
      });
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
        makeProvider(first, "Claude", "claude:home:first"),
        makeProvider(second, "Claude - Work", "claude:home:second"),
      ]);
      const projection = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* createThread(threadId, cwd, poolId);
        const firstCompleted = yield* awaitRunStatus(threadId, "completed");
        const hold = yield* Deferred.make<void>();
        yield* Ref.update(state, (current) => ({ ...current, holdTurn: hold }));
        yield* sendMessage(threadId, "first");
        const running = yield* awaitRunStatus(threadId, "running");
        yield* Fiber.join(running);
        yield* sendMessage(threadId, "queued");
        yield* Ref.update(providers, (members) =>
          members.map((member) => ({ ...member, auth: { status: "unauthenticated" as const } })),
        );
        const queuedDisposition = yield* awaitEvent(
          threadId,
          (event) =>
            event.type === "run.updated" &&
            (event.payload.queueHeld === true || event.payload.status === "starting"),
        );
        yield* Deferred.succeed(hold, undefined);
        yield* Fiber.join(firstCompleted);
        yield* Ref.update(state, (current) => ({ ...current, holdTurn: null }));
        yield* Fiber.join(queuedDisposition);
        yield* worker.drain();
        return yield* orchestrator.getThreadProjection(threadId);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "pool-failover-queued-exhausted" },
            makeRegistry({ first: "claude:home:first", second: "claude:home:second" }, state),
            { settings, poolCatalog: makeCatalog(providers) },
          ),
        ),
      );

      const [firstRun, queuedRun] = projection.runs;
      assert.equal(queuedRun?.status, "queued");
      assert.equal(queuedRun?.queueHeld, true);
      assert.lengthOf((yield* Ref.get(state)).started, 1);
      assert.equal(queuedRun?.providerInstanceId, firstRun?.providerInstanceId);
    }),
  ),
);

it.live("refuses a pool whose every member the project turned off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("pool-failover-disabled");
      const threadId = ThreadId.make("thread:pool-failover-disabled");
      const state = yield* Ref.make<PoolAdapterState>({
        failNextStart: null,
        holdTurn: null,
        started: [],
      });
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
        makeProvider(first, "Claude", "claude:home:first"),
        makeProvider(second, "Claude - Work", "claude:home:second"),
      ]);
      const error = yield* createThread(threadId, cwd, poolId).pipe(
        Effect.flip,
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "pool-failover-disabled" },
            makeRegistry({ first: "claude:home:first", second: "claude:home:second" }, state),
            {
              settings: {
                ...settings,
                projectSettingsOverrides: {
                  [projectId]: {
                    providerInstances: {
                      [first]: { enabled: false },
                      [second]: { enabled: false },
                    },
                  },
                },
              },
              poolCatalog: makeCatalog(providers),
            },
          ),
        ),
      );
      assert.equal(error._tag, "OrchestratorDispatchError");
      assert.equal(
        error._tag === "OrchestratorDispatchError" ? error.cause : null,
        "No account in the Claude pool is enabled for this project.",
      );
    }),
  ),
);

const limitBehindQueue = (input: {
  readonly name: string;
  readonly pooled: boolean;
  readonly failoverDispatches: Ref.Ref<number>;
}) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(input.name);
    const threadId = ThreadId.make(`thread:${input.name}`);
    const resetAt = DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(yield* DateTime.now) + minutes(30)),
    );
    const state = yield* Ref.make<PoolAdapterState>({
      failNextStart: null,
      holdTurn: null,
      started: [],
    });
    const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
      makeProvider(first, "Claude", "claude:home:first"),
      makeProvider(second, "Claude - Work", "claude:home:second"),
    ]);
    const { projection, shell } = yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* createThread(threadId, cwd, input.pooled ? poolId : first);
      const hold = yield* Deferred.make<void>();
      yield* Ref.update(state, (current) => ({ ...current, holdTurn: hold }));
      const running = yield* awaitProviderTurnRunning(threadId);
      yield* sendMessage(threadId, "first");
      yield* Fiber.join(running);
      yield* sendMessage(threadId, "limited");
      yield* sendMessage(threadId, "queued");
      yield* Ref.update(state, (current) => ({ ...current, failNextStart: resetAt }));
      const failed = yield* awaitRunStatus(threadId, "failed");
      yield* Deferred.succeed(hold, undefined);
      yield* Fiber.join(failed);
      yield* worker.drain();
      return {
        projection: yield* orchestrator.getThreadProjection(threadId),
        shell: yield* orchestrator.getThreadShell(threadId),
      };
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: input.name },
          makeRegistry({ first: "claude:home:first", second: "claude:home:second" }, state),
          {
            settings: input.pooled ? settings : { ...settings, providerPools: {} },
            poolCatalog: makeCatalog(providers, input.pooled ? poolSettings : {}),
            poolFailoverDispatch: (dispatch) => (command) =>
              command.type === "run.pool-failover"
                ? Ref.update(input.failoverDispatches, (count) => count + 1).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new Orchestrator.OrchestratorDispatchError({
                          commandId: command.commandId,
                          commandType: command.type,
                          cause: "Simulated failover dispatch failure.",
                        }),
                      ),
                    ),
                  )
                : dispatch(command),
          },
        ),
      ),
    );
    const limitedRun = projection.runs[1];
    const members = yield* Ref.get(providers);
    const error = projection.turnItems.find((item) => item.type === "error");
    return {
      resetAt,
      runs: projection.runs.map((run) => run.status),
      startedTurns: (yield* Ref.get(state)).started.length,
      limitedRunAttempts: projection.attempts.filter((attempt) => attempt.runId === limitedRun?.id)
        .length,
      errorResetAt: error?.type === "error" ? error.failure.resetAt : null,
      shellResetAt: shell?.usageLimitResetAt ?? null,
      cooldown: members.find((member) => member.instanceId === limitedRun?.providerInstanceId)
        ?.limitedUntil,
    };
  });

it.live("fails a pooled run like an unpooled one when the failover dispatch fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pooledDispatches = yield* Ref.make(0);
      const unpooledDispatches = yield* Ref.make(0);
      const { resetAt: pooledResetAt, ...pooled } = yield* limitBehindQueue({
        name: "pool-failover-dispatch-fails",
        pooled: true,
        failoverDispatches: pooledDispatches,
      });
      const { resetAt: unpooledResetAt, ...unpooled } = yield* limitBehindQueue({
        name: "pool-failover-dispatch-fails-unpooled",
        pooled: false,
        failoverDispatches: unpooledDispatches,
      });

      assert.equal(yield* Ref.get(pooledDispatches), 1);
      assert.equal(yield* Ref.get(unpooledDispatches), 0);
      // With a healthy sibling the pool has no earliest reset, so the run keeps its own.
      assert.deepEqual(pooled, {
        runs: ["completed", "failed", "queued"],
        startedTurns: 2,
        limitedRunAttempts: 1,
        errorResetAt: pooledResetAt,
        shellResetAt: pooledResetAt,
        cooldown: pooledResetAt,
      });
      assert.deepEqual(unpooled, {
        ...pooled,
        errorResetAt: unpooledResetAt,
        shellResetAt: unpooledResetAt,
        cooldown: unpooledResetAt,
      });
    }),
  ),
);

it.live("fails a delegated child over before its parent hears of the limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("pool-failover-delegated");
      const parentThreadId = ThreadId.make("thread:pool-failover-delegated");
      const resetAt = DateTime.formatIso(
        DateTime.makeUnsafe(DateTime.toEpochMillis(yield* DateTime.now) + minutes(30)),
      );
      const state = yield* Ref.make<PoolAdapterState>({
        failNextStart: null,
        holdTurn: null,
        started: [],
      });
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
        makeProvider(first, "Claude", "claude:home:first"),
        makeProvider(second, "Claude - Work", "claude:home:second"),
      ]);
      const result = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* createThread(parentThreadId, cwd, poolId);
        const hold = yield* Deferred.make<void>();
        yield* Ref.update(state, (current) => ({ ...current, holdTurn: hold }));
        const parentRunning = yield* awaitProviderTurnRunning(parentThreadId);
        yield* sendMessage(parentThreadId, "parent");
        yield* Fiber.join(parentRunning);

        const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
        const parentEvents = yield* Ref.make<ReadonlyArray<OrchestrationV2StoredEvent["event"]>>(
          [],
        );
        const delivered = yield* eventSink
          .stream({
            threadId: parentThreadId,
            afterSequence: yield* eventSink.latestSequence({ threadId: parentThreadId }),
          })
          .pipe(
            Stream.tap((stored) => Ref.update(parentEvents, (events) => [...events, stored.event])),
            Stream.takeUntil(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.status === "completed" &&
                stored.event.payload.userMessageId !== parentRun.userMessageId,
            ),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* Ref.update(state, (current) => ({ ...current, failNextStart: resetAt }));
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make(`${parentThreadId}:delegate`),
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "child task",
          modelSelection: { instanceId: poolId, model },
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* Deferred.succeed(hold, undefined);
        yield* Fiber.join(delivered);
        yield* worker.drain();
        const parent = yield* orchestrator.getThreadProjection(parentThreadId);
        const childThreadId = parent.subagents.find(
          (task) => task.prompt === "child task",
        )?.childThreadId;
        return {
          parent,
          child: yield* orchestrator.getThreadProjection(childThreadId!),
          subagentStatuses: (yield* Ref.get(parentEvents)).flatMap((event) =>
            event.type === "subagent.updated" ? [event.payload.status] : [],
          ),
        };
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "pool-failover-delegated" },
            makeRegistry({ first: "claude:home:first", second: "claude:home:second" }, state),
            // The continuation worker dispatches the parent's completion delivery.
            { settings, poolCatalog: makeCatalog(providers), runContinuationWorker: true },
          ),
        ),
      );

      const childRun = result.child.runs[0];
      assert.lengthOf(result.child.runs, 1);
      assert.equal(childRun?.status, "completed");
      const attempts = result.child.attempts.filter((attempt) => attempt.runId === childRun?.id);
      assert.deepEqual(
        attempts.map((attempt) => [attempt.status, attempt.reason]),
        [
          ["failed", "initial"],
          ["completed", "provider_recovery"],
        ],
      );
      assert.notEqual(attempts[0]?.providerInstanceId, attempts[1]?.providerInstanceId);

      assert.notInclude(result.subagentStatuses, "failed");
      assert.equal(result.subagentStatuses.at(-1), "completed");
      const task = result.parent.subagents.find((candidate) => candidate.prompt === "child task");
      assert.equal(task?.status, "completed");
      assert.lengthOf(
        result.parent.messages.filter((message) => message.delegatedCompletion !== undefined),
        1,
      );
    }),
  ),
);

it.live("leaves a crash between the cooldown and the failover to restart recovery", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const databaseLayer = SqlitePersistence.layerFromPath(
        path.join(yield* fs.makeTempDirectoryScoped({ prefix: "t3-pool-crash-" }), "state.sqlite"),
      ).pipe(Layer.provide(NodeServices.layer));
      const cwd = yield* checkpointWorkspace("pool-failover-crash");
      const threadId = ThreadId.make("thread:pool-failover-crash");
      const resetAt = DateTime.formatIso(
        DateTime.makeUnsafe(DateTime.toEpochMillis(yield* DateTime.now) + minutes(30)),
      );
      const state = yield* Ref.make<PoolAdapterState>({
        failNextStart: resetAt,
        holdTurn: null,
        started: [],
      });
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
        makeProvider(first, "Claude", "claude:home:first"),
        makeProvider(second, "Claude - Work", "claude:home:second"),
      ]);
      const layerRuntime = (
        name: string,
        options: Parameters<typeof ProviderReplayHarness.layerWithRegistry>[2],
      ) =>
        ProviderReplayHarness.layerWithRegistry(
          { name },
          makeRegistry({ first: "claude:home:first", second: "claude:home:second" }, state),
          { databaseLayer, settings, poolCatalog: makeCatalog(providers), ...options },
        );
      const failoverReached = yield* Deferred.make<void>();
      const crashed = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* createThread(threadId, cwd, poolId);
        yield* sendMessage(threadId, "limited");
        yield* Deferred.await(failoverReached);
        return yield* orchestrator.getThreadProjection(threadId);
      }).pipe(
        Effect.provide(
          layerRuntime("pool-failover-crash", {
            // The process dies here: the cooldown is published, the command never lands.
            poolFailoverDispatch: (dispatch) => (command) =>
              command.type === "run.pool-failover"
                ? Deferred.succeed(failoverReached, undefined).pipe(Effect.andThen(Effect.never))
                : dispatch(command),
          }),
        ),
      );
      const restarted = yield* Effect.gen(function* () {
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
        return yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId);
      }).pipe(
        Effect.provide(layerRuntime("pool-failover-crash-restart", { recoverOnStartup: true })),
      );

      assert.deepEqual(
        crashed.runs.map((run) => run.status),
        ["running"],
      );
      const limitError = crashed.turnItems.find((item) => item.type === "error");
      assert.equal(limitError?.type === "error" ? limitError.failure.class : null, "usage_limit");
      assert.equal(
        (yield* Ref.get(providers)).find(
          (member) => member.instanceId === crashed.runs[0]?.providerInstanceId,
        )?.limitedUntil,
        resetAt,
      );
      // Startup recovery settles the run before any scheduled sweep can see it.
      assert.deepEqual(
        restarted.runs.map((run) => run.status),
        ["cancelled"],
      );
      assert.deepEqual(
        restarted.attempts.map((attempt) => attempt.status),
        ["cancelled"],
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
