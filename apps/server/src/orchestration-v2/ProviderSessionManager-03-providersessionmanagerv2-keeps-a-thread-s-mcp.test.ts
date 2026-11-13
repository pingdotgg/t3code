import * as NetAddress from "effect/net/NetAddress";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AgentScope } from "@t3tools/shared/AgentScope";
import {
  EnvironmentId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpServer } from "effect/http";
import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import {
  CODEX_DRIVER,
  CodexCapabilities,
  ExclusiveCapabilities,
  emptyState,
  fakeEnvironment,
  fakeHttpServer,
  layerBeforeUnchangedWriteEventSink,
  layerFailingReleaseEventSink,
  layerFlakyReleaseEventSink,
  layerPausingAttachEventSink,
  layerPausingMcpRegistry,
  layerTest,
  layerTestDatabase,
  layerTestEventSink,
  layerTestMcpRegistry,
  layerTestStores,
  makeBrowserAccessProject,
  makeNativeChildFixture,
  makePendingRuntimeRequestEvents,
  makeProviderAdapter,
  makeProviderSession,
  makeProviderThread,
  makeThreadCreatedEvent,
  modelSelection,
  openSessionWithBackgroundCommand,
  runBrowserAccessScenario,
  runtimePolicy,
  unimplemented,
} from "./ProviderSessionManager-fixtures.testkit.ts";
import type {
  FlakyReleaseWrites,
  TestProviderRuntimeState,
} from "./ProviderSessionManager-fixtures.testkit.ts";

it.effect(
  "ProviderSessionManagerV2 keeps a thread's MCP credential stable across detach and re-attach on a shared session",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-stable-mcp");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        const original = (yield* Ref.get(mcpConfigs)).at(-1);
        assert.isDefined(original);
        const originalToken = original?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(originalToken);

        yield* manager.detach({ providerSessionId, threadId, detail: "Workspace changed." });
        assert.equal(
          (yield* registry.resolve(originalToken!))?.thread.threadId,
          threadId,
          "detach must not revoke the credential the live provider process still holds",
        );

        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        assert.equal(
          (yield* mcpSessions.read(threadId))?.providerSessionId,
          original?.providerSessionId,
          "re-attach must reuse the existing credential, not rotate it",
        );
        assert.equal((yield* registry.resolve(originalToken!))?.thread.threadId, threadId);

        yield* manager.close(providerSessionId);
        assert.isUndefined(yield* registry.resolve(originalToken!));
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 protects a reused credential from a predecessor release during open",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const duringOpen = yield* Ref.make<Effect.Effect<void>>(Effect.void);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-open-race");
        const s1 = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const s2 = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({ threadId, providerSessionId: s1, modelSelection, runtimePolicy });
        const original = (yield* Ref.get(mcpConfigs)).at(-1);
        const originalToken = original?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(originalToken);
        yield* manager.detach({ providerSessionId: s1, threadId });

        // ACP and OpenCode consume credentials during openSession; predecessor release must not revoke them before entry publication.
        yield* Ref.set(duringOpen, manager.close(s1).pipe(Effect.orDie));
        yield* manager.open({ threadId, providerSessionId: s2, modelSelection, runtimePolicy });

        const slot = yield* mcpSessions.read(threadId);
        assert.equal(
          slot?.providerSessionId,
          original?.providerSessionId,
          "the credential the adapter was configured with must remain current",
        );
        assert.equal(
          (yield* registry.resolve(originalToken!))?.thread.threadId,
          threadId,
          "the predecessor release must not revoke a credential reserved by an in-flight open",
        );
        yield* manager.close(s2);
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
            beforeOpen: (input) =>
              input.providerSessionId === undefined
                ? Effect.void
                : Ref.get(duringOpen).pipe(
                    Effect.flatten,
                    Effect.tap(() => Ref.set(duringOpen, Effect.void)),
                  ),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 terminal detach revokes the thread's MCP credential", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-terminal-detach");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      const issued = (yield* Ref.get(mcpConfigs)).at(-1);
      const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(yield* registry.resolve(token!));

      yield* manager.detach({
        providerSessionId,
        threadId,
        detail: "Thread deleted.",
        revokeMcpCredential: true,
      });
      assert.isUndefined(yield* registry.resolve(token!));
      assert.isUndefined(yield* mcpSessions.read(threadId));
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1_000, mcpConfigs })));
  }),
);

it.effect(
  "ProviderSessionManagerV2 clears the background roster of a session a detach releases",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const { threadId, providerSessionId, rosters } = yield* openSessionWithBackgroundCommand(
          "provider-session-manager-detach-roster",
        );
        assert.deepStrictEqual(yield* rosters, [["dev-server"], ["dev-server"]]);

        yield* manager.detach({ providerSessionId, threadId, detail: "Thread settled." });

        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        assert.deepStrictEqual(yield* rosters, [[], ["dev-server"]]);
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({ state, idleTimeoutMs: 60_000, capabilities: ExclusiveCapabilities }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 keeps the roster of a runtime whose tasks can outlive it", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const { providerSessionId, rosters } = yield* openSessionWithBackgroundCommand(
        "provider-session-manager-outliving-roster",
      );

      yield* manager.close(providerSessionId);

      assert.deepStrictEqual(yield* rosters, [["dev-server"], ["dev-server"]]);
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({ state, idleTimeoutMs: 60_000, backgroundTasksEndWithProcess: false }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 keeps a provider update that lands while release clears", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const beforeUnchangedWrite = yield* Ref.make<Effect.Effect<void>>(Effect.void);
    const effect = Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const { providerSessionId, providerThreads, writeProviderThread, rosters } =
        yield* openSessionWithBackgroundCommand("provider-session-manager-raced-roster");
      const seeded = providerThreads[0]!;
      yield* Ref.set(
        beforeUnchangedWrite,
        writeProviderThread({
          ...seeded,
          pendingBackgroundTasks: [
            ...seeded.pendingBackgroundTasks,
            { taskId: "replacement-task", kind: "command" },
          ],
        }).pipe(Effect.orDie),
      );

      yield* manager.close(providerSessionId);

      assert.deepStrictEqual(yield* rosters, [["replacement-task"], ["dev-server"]]);
    });

    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, beforeUnchangedWrite })),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 does not idle-release a session that turns busy during the pending-work check",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const firstCheck = yield* Ref.make(true);
      const checkEntered = yield* Deferred.make<void>();
      const checkGate = yield* Deferred.make<void>();
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-busy-during-check",
        });
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-busy-during-check",
          projectId,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const providerThread = makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now,
        });
        const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
        const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
        const rootNodeId = idAllocator.derive.rootNode({ runId });
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "native-turn-busy-during-check",
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.events.pipe(Stream.runDrain, Effect.forkScoped);
        const appThread = (yield* projectionStore.getThreadProjection(threadId)).thread;

        yield* TestClock.adjust("1 second");
        yield* Deferred.await(checkEntered);

        const turnFiber = yield* runtime
          .startTurn({
            appThread,
            threadId,
            runId,
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId,
            rootNodeId,
            providerThread,
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
              text: "hello",
              attachments: [],
            },
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.forkDetach);
        for (let i = 0; i < 10; i += 1) {
          yield* Effect.yieldNow;
        }
        yield* Deferred.succeed(checkGate, undefined);
        yield* Fiber.join(turnFiber);
        yield* Effect.yieldNow;

        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 0);

        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(queue);
        yield* Queue.offer(queue!, {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId: providerThread.id,
          providerTurnId,
          runOrdinal: 1,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            hasPendingBackgroundWork: Effect.uninterruptible(
              Effect.gen(function* () {
                if (yield* Ref.getAndSet(firstCheck, false)) {
                  yield* Deferred.succeed(checkEntered, undefined);
                  yield* Deferred.await(checkGate);
                }
                return false;
              }),
            ),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 releases sessions when provider event streams fail", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-stream-error",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-stream-error",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.events.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
      yield* Effect.yieldNow;

      const liveSession = yield* manager.get(providerSessionId);
      const runtimeState = yield* Ref.get(state);
      const projection = yield* projectionStore.getThreadProjection(threadId);

      assert.isTrue(Option.isNone(liveSession));
      assert.equal(runtimeState.closeCount, 1);
      assert.equal(projection.providerSessions.at(-1)?.status, "error");
      assert.equal(
        projection.providerSessions.at(-1)?.lastError,
        "The provider event stream closed unexpectedly. Retry the turn; if it keeps failing, check the provider and server logs.",
      );
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1000,
          failEventStream: true,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 marks pending runtime requests non-live on release", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-request-expire",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-request-expire",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({
        idAllocator,
        threadId,
        providerSessionId,
        now,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const pendingRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId,
        providerSessionId,
        providerThread,
        now,
      });
      yield* eventSink.write({ events: pendingRequest.events });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.release({
        providerSessionId,
        reason: "runtime_error",
        detail: "process exited",
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const request = projection.runtimeRequests.at(-1);
      const requestNode = projection.nodes.find((node) => node.id === request?.nodeId);
      const requestTurnItem = projection.turnItems.find(
        (item) => item.type === "approval_request" && item.requestId === request?.id,
      );

      assert.equal(request?.status, "expired");
      assert.equal(request?.responseCapability.type, "not_resumable");
      assert.equal(requestNode?.status, "failed");
      assert.equal(requestTurnItem?.status, "failed");
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
  }),
);

it.effect("ProviderSessionManagerV2 retries release records that failed to persist", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const flaky: FlakyReleaseWrites = {
      failing: yield* Ref.make<"none" | "session" | "session-and-requests">("session"),
      failures: yield* Queue.unbounded<void>(),
    };
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-release-retry");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({ idAllocator, threadId, providerSessionId, now });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const pendingRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId,
        providerSessionId,
        providerThread,
        now,
      });
      yield* eventSink.write({ events: pendingRequest.events });
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });

      assert.isTrue(Exit.isFailure(yield* Effect.exit(manager.close(providerSessionId))));
      yield* Queue.take(flaky.failures);
      const afterClose = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(afterClose.runtimeRequests.at(-1)?.responseCapability.type, "not_resumable");
      assert.equal(afterClose.providerSessions.at(-1)?.status, "ready");

      yield* TestClock.adjust("1 second");
      yield* Queue.take(flaky.failures);
      yield* Ref.set(flaky.failing, "none");
      const stopped = yield* eventSink
        .stream({
          threadId,
          afterSequence: yield* eventSink.latestSequence({ threadId }),
          eventType: "provider-session.updated",
        })
        .pipe(Stream.runHead, Effect.forkScoped);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(stopped);

      const afterRetry = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(afterRetry.providerSessions.at(-1)?.status, "stopped");
    });

    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, flakyReleaseWrites: flaky })),
    );
  }),
);

it.effect("ProviderSessionManagerV2 release retries leave a replacement session alone", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const flaky: FlakyReleaseWrites = {
      failing: yield* Ref.make<"none" | "session" | "session-and-requests">("none"),
      failures: yield* Queue.unbounded<void>(),
    };
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread-provider-session-manager-release-replacement");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const writePendingRequest = Effect.gen(function* () {
        const now = yield* DateTime.now;
        const request = yield* makePendingRuntimeRequestEvents({
          idAllocator,
          threadId,
          providerSessionId,
          providerThread: makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
          now,
        });
        yield* eventSink.write({ events: request.events });
        return request.requestId;
      });
      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId, now: yield* DateTime.now }),
        ],
      });
      const oldRequestId = yield* writePendingRequest;
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      yield* Ref.set(flaky.failing, "session-and-requests");
      assert.isTrue(Exit.isFailure(yield* Effect.exit(manager.close(providerSessionId))));
      yield* Queue.take(flaky.failures);
      yield* Queue.take(flaky.failures);
      yield* Ref.set(flaky.failing, "none");

      yield* TestClock.adjust("500 millis");
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      const newRequestId = yield* writePendingRequest;
      const replacementStatus = (yield* projectionStore.getThreadProjection(
        threadId,
      )).providerSessions.at(-1)?.status;
      const settled = yield* eventSink
        .stream({
          threadId,
          afterSequence: yield* eventSink.latestSequence({ threadId }),
          eventType: "runtime-request.updated",
        })
        .pipe(Stream.runHead, Effect.forkScoped);
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(settled);

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const request = (id: typeof oldRequestId) =>
        projection.runtimeRequests.find((candidate) => candidate.id === id);
      assert.equal(request(oldRequestId)?.responseCapability.type, "not_resumable");
      assert.equal(request(newRequestId)?.responseCapability.type, "live");
      assert.equal(projection.providerSessions.at(-1)?.status, replacementStatus);
    });

    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, flakyReleaseWrites: flaky })),
    );
  }),
);
