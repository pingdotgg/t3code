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

it.effect("ProviderSessionManagerV2 stops a session still opening when its layer shuts down", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const handshakeStarted = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-shutdown-during-open");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager
        .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
        .pipe(Effect.forkDetach);
      yield* Deferred.await(handshakeStarted);
      assert.equal((yield* Ref.get(state)).closeCount, 0);
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 60_000,
          beforeOpen: () =>
            Deferred.succeed(handshakeStarted, undefined).pipe(Effect.andThen(Effect.never)),
          spawnBeforeOpen: true,
        }),
      ),
    );

    assert.equal((yield* Ref.get(state)).closeCount, 1);
  }),
);

it.effect("ProviderSessionManagerV2 interrupts event subscriptions on server shutdown", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-shutdown-subscription");
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
      const bufferedSubscription = yield* runtime.subscribeEvents!;
      const activeSubscription = yield* runtime.subscribeEvents!;
      const adapterQueue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(adapterQueue);
      yield* Queue.offer(adapterQueue!, {
        type: "provider_session.updated",
        driver: CODEX_DRIVER,
        providerSession: runtime.providerSession,
      });
      assert.isTrue(Option.isSome(yield* activeSubscription.events.pipe(Stream.runHead)));

      yield* manager.shutdown;

      const exit = yield* bufferedSubscription.events.pipe(Stream.runCollect, Effect.exit);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 60_000 })));
  }),
);

it.effect("ProviderSessionManagerV2 drains subscribers when the provider stops", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-provider-stop");
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
      const subscription = yield* runtime.subscribeEvents!;
      const collected = yield* subscription.events.pipe(Stream.runCollect, Effect.forkScoped);
      const adapterQueue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(adapterQueue);
      const providerThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "provider-stop-thread",
      });
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: CODEX_DRIVER,
        nativeTurnId: "provider-stop-turn",
      });
      yield* Queue.offer(adapterQueue!, {
        type: "turn.terminal",
        driver: CODEX_DRIVER,
        providerThreadId,
        providerTurnId,
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* Queue.offer(adapterQueue!, {
        type: "provider_session.updated",
        driver: CODEX_DRIVER,
        providerSession: {
          ...runtime.providerSession,
          status: "stopped",
          updatedAt: now,
        },
      });
      yield* Queue.end(adapterQueue!);

      const events = Array.from(yield* Fiber.join(collected));
      assert.deepEqual(
        events.map((event) => event.type),
        ["turn.terminal", "provider_session.updated"],
      );
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 60_000 })));
  }),
);

it.effect(
  "ProviderSessionManagerV2 issues MCP credentials before opening and revokes them on close",
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
        const threadId = ThreadId.make("thread-provider-session-manager-mcp");
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

        const captured = (yield* Ref.get(mcpConfigs))[0];
        assert.isDefined(captured);
        assert.equal(captured?.threadId, threadId);
        assert.equal(captured?.providerInstanceId, modelSelection.instanceId);
        assert.equal(captured?.endpoint, "http://127.0.0.1:43123/mcp");
        const token = captured?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(token);
        const resolved = yield* registry.resolve(token!);
        assert.equal(resolved?.thread.threadId, threadId);
        assert.deepEqual(
          resolved?.capabilities,
          new Set(["preview", "orchestration", "worktree", "pull-requests"]),
        );

        yield* manager.close(providerSessionId);
        assert.isUndefined(yield* mcpSessions.read(threadId));
        assert.isUndefined(yield* registry.resolve(token!));
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

it.effect.each([
  { relationshipToParent: null, subagent: false },
  { relationshipToParent: "subagent", subagent: true },
] as const)(
  "ProviderSessionManagerV2 marks MCP credentials of delegated children ($relationshipToParent)",
  ({ relationshipToParent, subagent }) =>
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
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-mcp-lineage");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const created = yield* makeThreadCreatedEvent({ idAllocator, threadId, now });
        const parentThreadId = ThreadId.make("thread-provider-session-manager-mcp-parent");
        yield* eventSink.write({
          events: [
            {
              ...created,
              payload: {
                ...created.payload,
                lineage:
                  relationshipToParent === null
                    ? created.payload.lineage
                    : { parentThreadId, relationshipToParent, rootThreadId: parentThreadId },
              },
            },
          ],
        });
        yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });

        const token = (yield* Ref.get(mcpConfigs))[0]?.authorizationHeader.replace(
          /^Bearer\s+/,
          "",
        );
        assert.isDefined(token);
        assert.equal((yield* registry.resolve(token!))?.thread.subagent, subagent);
        yield* manager.close(providerSessionId);
      });

      yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1_000, mcpConfigs })));
    }),
);

it.effect(
  "ProviderSessionManagerV2 withholds the preview capability when agent browser access is off",
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
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-no-browser");
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

        const captured = (yield* Ref.get(mcpConfigs))[0];
        assert.isDefined(captured);
        assert.equal(captured?.browserToolsAvailable, false);
        const token = captured?.authorizationHeader.replace(/^Bearer\s+/, "");
        const resolved = yield* registry.resolve(token!);
        assert.deepEqual(
          resolved?.capabilities,
          new Set(["orchestration", "worktree", "pull-requests"]),
        );

        yield* manager.close(providerSessionId);
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
            serverSettingsLayer: ServerSettings.layerTest({
              enableAgentBrowserAccess: false,
            }).pipe(Layer.orDie),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 honors a project browser-access opt-out", () =>
  Effect.gen(function* () {
    const captured = yield* runBrowserAccessScenario({
      enableAgentBrowserAccess: true,
      projectOverride: false,
    });
    assert.isDefined(captured);
    assert.equal(captured?.browserToolsAvailable, false);
  }),
);

it.effect("ProviderSessionManagerV2 fails browser access closed for a missing project", () =>
  Effect.gen(function* () {
    const captured = yield* runBrowserAccessScenario({
      enableAgentBrowserAccess: true,
      projectOverride: true,
      projectExists: false,
    });
    assert.isDefined(captured);
    assert.equal(captured?.browserToolsAvailable, false);
  }),
);

it.effect("ProviderSessionManagerV2 revokes MCP credentials when release persistence fails", () =>
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
      const threadId = ThreadId.make("thread-provider-session-manager-mcp-release-failure");
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

      const captured = (yield* Ref.get(mcpConfigs))[0];
      const token = captured?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(token);
      assert.isDefined(yield* registry.resolve(token!));

      const closeError = yield* manager.close(providerSessionId).pipe(Effect.flip);
      assert.equal(closeError._tag, "ProviderSessionCloseError");
      assert.isUndefined(yield* mcpSessions.read(threadId));
      assert.isUndefined(yield* registry.resolve(token!));
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1_000,
          mcpConfigs,
          failReleaseEventWrites: true,
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a thread attached when an earlier attach of it is interrupted",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const armed = yield* Ref.make(false);
      const paused = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const owner = ThreadId.make("thread-provider-session-manager-attach-race-owner");
        const threadId = ThreadId.make("thread-provider-session-manager-attach-race");
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: owner, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
          ],
        });
        const runtime = yield* manager.open({
          threadId: owner,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const resume = runtime.resumeThread({
          threadId,
          providerThread: makeProviderThread({
            idAllocator,
            threadId,
            providerSessionId,
            now,
            nativeThreadId: "native-attach-race",
          }),
        });

        yield* Ref.set(armed, true);
        const first = yield* resume.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(paused);
        const second = yield* resume.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.interrupt(first);
        yield* Fiber.join(second);

        const config = yield* mcpSessions.read(threadId);
        assert.isDefined(config);
        const token = config!.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.equal((yield* registry.resolve(token))?.thread.threadId, threadId);
      }).pipe(
        Effect.provide(
          layerTest({ state, idleTimeoutMs: 60_000, pauseAttachWrite: { armed, paused } }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a replacement session's attachment when a stale attach is interrupted",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const armed = yield* Ref.make(false);
      const paused = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const eventStore = yield* EventStore.EventStoreV2;
        const now = yield* DateTime.now;
        const owner = ThreadId.make("thread-provider-session-manager-stale-attach-owner");
        const threadId = ThreadId.make("thread-provider-session-manager-stale-attach");
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: owner, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
          ],
        });
        const runtime = yield* manager.open({
          threadId: owner,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        yield* Ref.set(armed, true);
        const stale = yield* runtime
          .resumeThread({
            threadId,
            providerThread: makeProviderThread({
              idAllocator,
              threadId,
              providerSessionId,
              now,
              nativeThreadId: "native-stale-attach",
            }),
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(paused);

        yield* manager.release({ providerSessionId, reason: "runtime_error" });
        const replacement = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const config = yield* mcpSessions.read(threadId);
        assert.isDefined(config);

        yield* Fiber.interrupt(stale);

        assert.equal(
          (yield* mcpSessions.read(threadId))?.providerSessionId,
          config!.providerSessionId,
        );
        const token = config!.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.equal((yield* registry.resolve(token))?.thread.threadId, threadId);
        const attachedEvents = eventStore
          .read({ threadId, eventType: "provider-session.attached" })
          .pipe(
            Stream.runCollect,
            Effect.map((events) => events.length),
          );
        const attachedBefore = yield* attachedEvents;
        yield* replacement.resumeThread({
          threadId,
          providerThread: makeProviderThread({
            idAllocator,
            threadId,
            providerSessionId,
            now,
            nativeThreadId: "native-stale-attach",
          }),
        });
        assert.equal(yield* attachedEvents, attachedBefore);
      }).pipe(
        Effect.provide(
          layerTest({ state, idleTimeoutMs: 60_000, pauseAttachWrite: { armed, paused } }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 revokes a reused credential after a resume stopped while checking it",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const armed = yield* Ref.make(false);
      const paused = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const owner = ThreadId.make("thread-provider-session-manager-resolve-stop-owner");
        const threadId = ThreadId.make("thread-provider-session-manager-resolve-stop");
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: owner, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
          ],
        });
        const runtime = yield* manager.open({
          threadId: owner,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const resume = runtime.resumeThread({
          threadId,
          providerThread: makeProviderThread({
            idAllocator,
            threadId,
            providerSessionId,
            now,
            nativeThreadId: "native-resolve-stop",
          }),
        });
        yield* resume;
        yield* manager.detach({ providerSessionId, threadId });
        const config = yield* mcpSessions.read(threadId);
        assert.isDefined(config);
        const token = config!.authorizationHeader.replace(/^Bearer\s+/, "");

        yield* Ref.set(armed, true);
        const stopped = yield* resume.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(paused);
        yield* Fiber.interrupt(stopped);

        yield* manager.release({ providerSessionId, reason: "manual_shutdown" });
        assert.isUndefined(yield* registry.resolve(token));
      }).pipe(
        Effect.provide(
          layerTest({ state, idleTimeoutMs: 60_000, pauseResolve: { armed, paused } }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 duplicate detach preserves replacement MCP credentials", () =>
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
      const threadId = ThreadId.make("thread-provider-session-manager-replacement-mcp");
      const oldSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const replacementSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId: oldSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.detach({ providerSessionId: oldSessionId, threadId });
      yield* manager.open({
        threadId,
        providerSessionId: replacementSessionId,
        modelSelection,
        runtimePolicy,
      });

      const replacement = (yield* Ref.get(mcpConfigs)).at(-1);
      assert.isDefined(replacement);
      const replacementToken = replacement?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(replacementToken);
      assert.equal(
        (yield* mcpSessions.read(threadId))?.providerSessionId,
        replacement?.providerSessionId,
      );

      yield* manager.detach({ providerSessionId: oldSessionId, threadId });

      assert.equal(
        (yield* mcpSessions.read(threadId))?.providerSessionId,
        replacement?.providerSessionId,
      );
      assert.equal((yield* registry.resolve(replacementToken!))?.thread.threadId, threadId);
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1_000,
          capabilities: ExclusiveCapabilities,
          mcpConfigs,
        }),
      ),
    );
  }),
);
