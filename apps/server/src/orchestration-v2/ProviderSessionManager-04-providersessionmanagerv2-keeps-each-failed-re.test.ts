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

it.effect("ProviderSessionManagerV2 keeps each failed release's cleanup", () =>
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
      const now = yield* DateTime.now;
      const firstThreadId = ThreadId.make("thread-provider-session-manager-release-each-a");
      const secondThreadId = ThreadId.make("thread-provider-session-manager-release-each-b");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: firstThreadId,
      });
      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
          yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
        ],
      });
      const secondThreadRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId: secondThreadId,
        providerSessionId,
        providerThread: makeProviderThread({
          idAllocator,
          threadId: secondThreadId,
          providerSessionId,
          now,
        }),
        now,
      });
      yield* eventSink.write({ events: secondThreadRequest.events });
      const failRelease = (failedWrites: number) =>
        Effect.gen(function* () {
          yield* Ref.set(flaky.failing, "session-and-requests");
          assert.isTrue(Exit.isFailure(yield* Effect.exit(manager.close(providerSessionId))));
          yield* Effect.repeat(Queue.take(flaky.failures), { times: failedWrites - 1 });
          yield* Ref.set(flaky.failing, "none");
        });

      yield* manager.open({
        threadId: firstThreadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.open({
        threadId: secondThreadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* failRelease(2);
      yield* TestClock.adjust("500 millis");
      yield* manager.open({
        threadId: firstThreadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* failRelease(1);

      const settled = yield* eventSink
        .stream({
          threadId: secondThreadId,
          afterSequence: yield* eventSink.latestSequence({ threadId: secondThreadId }),
          eventType: "runtime-request.updated",
        })
        .pipe(Stream.runHead, Effect.forkScoped);
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(settled);

      const projection = yield* projectionStore.getThreadProjection(secondThreadId);
      assert.equal(projection.runtimeRequests.at(-1)?.responseCapability.type, "not_resumable");
    });

    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, flakyReleaseWrites: flaky })),
    );
  }),
);

it.effect("ProviderSessionManagerV2 settles a request the event pump persists during release", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const flaky: FlakyReleaseWrites = {
      failing: yield* Ref.make<"none" | "session" | "session-and-requests">("none"),
      failures: yield* Queue.unbounded<void>(),
      pauseRequestWrites: {
        paused: yield* Deferred.make<void>(),
        resume: yield* Deferred.make<void>(),
      },
    };
    const pause = flaky.pauseRequestWrites!;
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-release-pump");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      const createdAt = DateTime.add(now, { seconds: 1 });
      const pendingRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId,
        providerSessionId,
        providerThread: makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now: createdAt,
        }),
        now: createdAt,
      });
      const adapterEvents = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(adapterEvents);
      yield* Queue.offerAll(adapterEvents!, pendingRequest.providerEvents);
      yield* Deferred.await(pause.paused);
      const closed = yield* manager
        .close(providerSessionId)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* TestClock.adjust("1 second");
      yield* Deferred.succeed(pause.resume, undefined);
      yield* Fiber.join(closed);

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const request = projection.runtimeRequests.find(
        (candidate) => candidate.id === pendingRequest.requestId,
      );
      assert.equal(request?.responseCapability.type, "not_resumable");
    });

    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, flakyReleaseWrites: flaky })),
    );
  }),
);

it.effect.each(["manual_shutdown", "server_shutdown"] as const)(
  "ProviderSessionManagerV2 preserves questions only for server shutdown (%s)",
  (reason) =>
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
        yield* eventSink.write({
          events: pendingRequest.events.map((event) =>
            event.type === "turn-item.updated"
              ? {
                  ...event,
                  payload: {
                    ...event.payload,
                    type: "user_input_request",
                    questions: [
                      { id: "color", header: "Color", question: "Which color?", options: [] },
                    ],
                  },
                }
              : event.type === "runtime-request.updated"
                ? { ...event, payload: { ...event.payload, kind: "user_input" } }
                : event,
          ),
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.release({
          providerSessionId,
          reason,
        });

        const projection = yield* projectionStore.getThreadProjection(threadId);
        const request = projection.runtimeRequests.at(-1);
        const requestNode = projection.nodes.find((node) => node.id === request?.nodeId);
        const requestTurnItem = projection.turnItems.find(
          (item) => item.type === "user_input_request" && item.requestId === request?.id,
        );

        const preserved = reason === "server_shutdown";
        assert.equal(request?.status, preserved ? "pending" : "cancelled");
        assert.equal(request?.responseCapability.type, preserved ? "live" : "not_resumable");
        assert.equal(requestNode?.status, preserved ? "waiting" : "cancelled");
        assert.equal(requestTurnItem?.status, preserved ? "waiting" : "cancelled");
      });

      yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
    }),
);

it.effect("ProviderSessionManagerV2 persists session-scoped runtime requests without a run", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-session-request",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-session-request",
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
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const pendingRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId,
        providerSessionId,
        providerThread,
        now,
      });
      const afterSequence = yield* eventSink.latestSequence({ threadId });
      const persistedFiber = yield* eventSink.stream({ threadId, afterSequence }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "runtime-request.updated" ||
            stored.event.type === "node.updated" ||
            stored.event.type === "turn-item.updated",
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const adapterEvents = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(adapterEvents);
      yield* Queue.offerAll(adapterEvents!, pendingRequest.providerEvents);
      const persisted = Array.from(yield* Fiber.join(persistedFiber));

      assert.sameMembers(
        persisted.map((stored) => stored.event.type),
        ["runtime-request.updated", "node.updated", "turn-item.updated"],
      );
      const projection = yield* projectionStore.getThreadProjection(threadId);
      const request = projection.runtimeRequests.find(
        (candidate) => candidate.id === pendingRequest.requestId,
      );
      const node = projection.nodes.find((candidate) => candidate.id === pendingRequest.nodeId);
      const turnItem = projection.turnItems.find(
        (candidate) =>
          candidate.type === "approval_request" && candidate.requestId === pendingRequest.requestId,
      );
      assert.equal(request?.status, "pending");
      assert.equal(request?.providerTurnId, null);
      assert.equal(node?.runId, null);
      assert.equal(node?.status, "waiting");
      assert.equal(turnItem?.runId, null);
      assert.equal(turnItem?.status, "waiting");
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
  }),
);

it.effect(
  "ProviderSessionManagerV2 opens one shared runtime, broadcasts events, and detaches threads independently",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-shared-runtime",
        });
        const firstThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-shared-runtime-a",
          projectId,
        });
        const secondThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-shared-runtime-b",
          projectId,
        });
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });

        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
          ],
        });
        const firstProviderThread = makeProviderThread({
          idAllocator,
          threadId: firstThreadId,
          providerSessionId,
          now,
        });
        const secondProviderThread = makeProviderThread({
          idAllocator,
          threadId: secondThreadId,
          providerSessionId,
          now,
        });
        const firstRunId = idAllocator.derive.run({ threadId: firstThreadId, ordinal: 1 });
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId: firstThreadId }),
              type: "provider-thread.updated",
              threadId: firstThreadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: firstProviderThread,
            },
            {
              id: yield* idAllocator.allocate.event({ threadId: firstThreadId }),
              type: "provider-turn.updated",
              threadId: firstThreadId,
              runId: firstRunId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: {
                id: idAllocator.derive.providerTurn({
                  driver: CODEX_DRIVER,
                  nativeTurnId: "native-turn-shared-runtime-a",
                }),
                providerThreadId: firstProviderThread.id,
                nodeId: idAllocator.derive.rootNode({ runId: firstRunId }),
                runAttemptId: null,
                nativeTurnRef: null,
                ordinal: 1,
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            },
          ],
        });
        const firstRuntime = yield* manager.open({
          threadId: firstThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const secondRuntime = yield* manager.open({
          threadId: secondThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        assert.strictEqual(firstRuntime, secondRuntime);
        assert.equal((yield* Ref.get(state)).openCount, 1);
        const resumeSecondThread = secondRuntime.resumeThread({
          providerThread: secondProviderThread,
          threadId: secondThreadId,
          modelSelection,
          runtimePolicy,
        });
        yield* resumeSecondThread;
        yield* resumeSecondThread;
        assert.equal((yield* Ref.get(state)).resumeCount, 1);
        yield* secondRuntime.resumeThread({
          providerThread: secondProviderThread,
          threadId: secondThreadId,
          modelSelection: { ...modelSelection, model: "gpt-5.4-mini" },
          runtimePolicy,
        });
        assert.equal((yield* Ref.get(state)).resumeCount, 2);
        yield* resumeSecondThread;
        assert.equal((yield* Ref.get(state)).resumeCount, 3);
        const subscribe = firstRuntime.subscribeEvents;
        assert.isDefined(subscribe);
        if (subscribe === undefined) return;
        const firstSubscription = yield* subscribe;
        const secondSubscription = yield* subscribe;
        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(queue);
        yield* Queue.offer(queue!, {
          type: "provider_session.updated",
          driver: CODEX_DRIVER,
          providerSession: firstRuntime.providerSession,
        });
        const received = yield* Effect.all([
          firstSubscription.events.pipe(Stream.runHead),
          secondSubscription.events.pipe(Stream.runHead),
        ]);
        assert.isTrue(received.every(Option.isSome));
        assert.isTrue(
          received.every(
            (event) => Option.isSome(event) && event.value.type === "provider_session.updated",
          ),
        );

        yield* manager.detach({ providerSessionId, threadId: secondThreadId });
        yield* manager.open({
          threadId: secondThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* resumeSecondThread;
        assert.equal((yield* Ref.get(state)).resumeCount, 4);

        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);

        yield* manager.detach({ providerSessionId, threadId: firstThreadId });
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        assert.equal((yield* Ref.get(state)).interruptCount, 1);
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, ["native-thread"]);

        yield* manager.detach({ providerSessionId, threadId: secondThreadId });
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      });

      yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
    }),
);

it.effect(
  "ProviderSessionManagerV2 invalidates only errored threads and keeps reusable session errors cached",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const openCachedRuntime = Effect.fnUntraced(function* (
          threadId: ThreadId,
          sharedSessionId?: ProviderSessionId,
        ) {
          const providerSessionId =
            sharedSessionId ??
            (yield* idAllocator.allocate.providerSession({
              providerInstanceId: modelSelection.instanceId,
              threadId,
            }));
          yield* eventSink.write({
            events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
          });
          const runtime = yield* manager.open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          });
          const providerThread = makeProviderThread({
            idAllocator,
            threadId,
            providerSessionId,
            now,
            nativeThreadId: String(threadId),
          });
          const resume = runtime.resumeThread({
            providerThread,
            threadId,
            modelSelection,
            runtimePolicy,
          });
          yield* resume;
          yield* resume;
          return { runtime, providerThread, resume };
        });
        const failed = yield* openCachedRuntime(ThreadId.make("idle-failed-runtime"));
        const healthy = yield* openCachedRuntime(ThreadId.make("idle-healthy-runtime"));
        const sibling = yield* openCachedRuntime(
          ThreadId.make("idle-healthy-sibling"),
          failed.runtime.providerSessionId,
        );
        assert.strictEqual(sibling.runtime, failed.runtime);
        assert.equal((yield* Ref.get(state)).openCount, 2);
        assert.equal((yield* Ref.get(state)).resumeCount, 3);

        const queue = (yield* Ref.get(state)).eventQueues.get(
          String(failed.runtime.providerSessionId),
        );
        assert.isDefined(queue);
        const publish = Effect.fnUntraced(function* (
          event: ProviderAdapter.ProviderAdapterV2Event,
        ) {
          const subscription = yield* failed.runtime.subscribeEvents!;
          yield* Queue.offer(queue!, event);
          // Observing the exact event ensures the manager has handled it before resuming.
          assert.deepEqual(yield* subscription.events.pipe(Stream.runHead), Option.some(event));
        });
        const countRawResumes = Effect.fnUntraced(function* (cached: typeof failed) {
          const before = (yield* Ref.get(state)).resumeCount;
          yield* cached.resume;
          return (yield* Ref.get(state)).resumeCount - before;
        });
        yield* publish({
          type: "provider_thread.updated",
          driver: CODEX_DRIVER,
          providerThread: failed.providerThread,
        });
        yield* publish({
          type: "provider_session.updated",
          driver: CODEX_DRIVER,
          providerSession: {
            ...failed.runtime.providerSession,
            status: "error",
            lastError: "Reusable turn failure",
          },
        });
        const afterSessionError = {
          reusableThread: yield* countRawResumes(failed),
          siblingThread: yield* countRawResumes(sibling),
        };

        yield* publish({
          type: "provider_thread.updated",
          driver: CODEX_DRIVER,
          providerThread: { ...failed.providerThread, status: "error" },
        });
        const afterThreadError = {
          healthyRuntime: yield* countRawResumes(healthy),
          siblingThread: yield* countRawResumes(sibling),
          failedThread: yield* countRawResumes(failed),
          failedThreadAgain: yield* countRawResumes(failed),
        };
        assert.deepEqual(
          { afterSessionError, afterThreadError },
          {
            afterSessionError: { reusableThread: 0, siblingThread: 0 },
            afterThreadError: {
              healthyRuntime: 0,
              siblingThread: 0,
              failedThread: 1,
              failedThreadAgain: 0,
            },
          },
        );
      });

      yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps an attached native child loaded when its parent detaches",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const { manager, parent, resumeChild } = yield* makeNativeChildFixture();
        yield* resumeChild;
        yield* manager.detach(parent);

        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);
        // The child's next turn trusts the manager's loaded cache, so the
        // native thread must still be loaded for that turn to be heard.
        yield* resumeChild;
        assert.equal((yield* Ref.get(state)).resumeCount, 1);
        assert.isTrue(yield* manager.isLive(parent.providerSessionId));
      }).pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })), Effect.scoped);
    }),
);

it.effect(
  "ProviderSessionManagerV2 unloads an unattached native child when its parent detaches",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const { manager, parent } = yield* makeNativeChildFixture();
        yield* manager.detach(parent);

        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, ["native-child-thread"]);
      }).pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })), Effect.scoped);
    }),
);
