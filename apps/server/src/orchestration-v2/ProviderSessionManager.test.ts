import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpServer } from "effect/unstable/http";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { EventSinkV2, EventSinkWriteError, layer as eventSinkLayer } from "./EventSink.ts";
import { layer as eventStoreLayer } from "./EventStore.ts";
import {
  IdAllocatorV2,
  type IdAllocatorV2Shape,
  layer as idAllocatorLayer,
} from "./IdAllocator.ts";
import { ProjectionStoreV2, layer as projectionStoreLayer } from "./ProjectionStore.ts";
import {
  ProviderAdapterEventStreamError,
  type ProviderAdapterV2Event,
  ProviderAdapterProtocolError,
  type ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
} from "./ProviderAdapter.ts";
import { makeSingleLayer as makeProviderAdapterRegistryLayer } from "./ProviderAdapterRegistry.ts";
import {
  ProviderSessionManagerV2,
  layerWithOptions as providerSessionManagerLayerWithOptions,
} from "./ProviderSessionManager.ts";

const TestDatabaseLayer = SqlitePersistenceMemory;
const TestStoresLayer = Layer.merge(eventStoreLayer, projectionStoreLayer).pipe(
  Layer.provide(TestDatabaseLayer),
);
const TestEventSinkLayer = eventSinkLayer.pipe(
  Layer.provide(Layer.mergeAll(TestStoresLayer, TestDatabaseLayer)),
);
const FailingReleaseEventSinkLayer = Layer.effect(
  EventSinkV2,
  Effect.gen(function* () {
    const delegate = yield* EventSinkV2;
    return EventSinkV2.of({
      ...delegate,
      write: (input) =>
        input.events.some(
          (event) =>
            event.type === "provider-session.updated" &&
            (event.payload.status === "stopped" || event.payload.status === "error"),
        )
          ? Effect.fail(new EventSinkWriteError({ eventCount: input.events.length }))
          : delegate.write(input),
    });
  }),
).pipe(Layer.provide(TestEventSinkLayer));

const CodexCapabilities: OrchestrationV2ProviderCapabilities = CodexProviderCapabilitiesV2;
const ExclusiveCapabilities: OrchestrationV2ProviderCapabilities = {
  ...CodexCapabilities,
  sessions: {
    ...CodexCapabilities.sessions,
    supportsMultipleProviderThreadsPerSession: false,
  },
};

interface TestProviderRuntimeState {
  readonly openCount: number;
  readonly closeCount: number;
  readonly interruptCount: number;
  readonly resumeCount: number;
  readonly eventQueues: ReadonlyMap<string, Queue.Queue<ProviderAdapterV2Event>>;
}

const emptyState: TestProviderRuntimeState = {
  openCount: 0,
  closeCount: 0,
  interruptCount: 0,
  resumeCount: 0,
  eventQueues: new Map(),
};

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");

const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
} satisfies ProviderAdapterV2RuntimePolicy;

function makeProviderSession(input: {
  readonly providerSessionId: ProviderSessionId;
  readonly now: DateTime.Utc;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    driver: CODEX_DRIVER,
    providerInstanceId: modelSelection.instanceId,
    status: "ready",
    cwd: process.cwd(),
    model: "gpt-5.4",
    capabilities: input.capabilities ?? CodexCapabilities,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  };
}

function makeThreadCreatedEvent(input: {
  readonly idAllocator: IdAllocatorV2Shape;
  readonly threadId: ThreadId;
  readonly now: DateTime.Utc;
}) {
  return Effect.gen(function* () {
    const projectId = yield* input.idAllocator.allocate.project({
      fixtureName: "provider-session-manager",
    });
    const providerThreadId = input.idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "native-thread",
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId,
      title: "Provider session manager",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      deletedAt: null,
    };
    return {
      id: yield* input.idAllocator.allocate.event({ threadId: input.threadId }),
      type: "thread.created" as const,
      threadId: input.threadId,
      occurredAt: input.now,
      payload: thread,
    };
  });
}

function makeProviderThread(input: {
  readonly idAllocator: IdAllocatorV2Shape;
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  return {
    id: input.idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "native-thread",
    }),
    driver: CODEX_DRIVER,
    providerInstanceId: modelSelection.instanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: CODEX_DRIVER,
      nativeId: "native-thread",
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function unimplemented(detail: string) {
  return Effect.fail(
    new ProviderAdapterProtocolError({
      driver: CODEX_DRIVER,
      detail,
    }),
  );
}

function makeProviderAdapter(
  state: Ref.Ref<TestProviderRuntimeState>,
  options: {
    readonly failEventStream?: boolean;
    readonly capabilities?: OrchestrationV2ProviderCapabilities;
    readonly mcpConfigs?: Ref.Ref<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >;
    readonly beforeOpen?: (input: {
      readonly providerSessionId: ProviderSessionId;
    }) => Effect.Effect<void>;
    readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
    readonly hangSessionScopeClose?: boolean;
  } = {},
): ProviderAdapterV2Shape {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: CODEX_DRIVER,
    getCapabilities: () => Effect.succeed(options.capabilities ?? CodexCapabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        if (options.beforeOpen !== undefined) {
          yield* options.beforeOpen({ providerSessionId: input.providerSessionId });
        }
        if (options.mcpConfigs !== undefined) {
          yield* Ref.update(options.mcpConfigs, (configs) => [
            ...configs,
            McpProviderSession.readMcpProviderSession(input.threadId),
          ]);
        }
        const now = yield* DateTime.now;
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const session = makeProviderSession({
          providerSessionId: input.providerSessionId,
          now,
          ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
        });
        yield* Ref.update(state, (current) => {
          const eventQueues = new Map(current.eventQueues);
          eventQueues.set(String(input.providerSessionId), events);
          return {
            ...current,
            openCount: current.openCount + 1,
            eventQueues,
          };
        });
        yield* Effect.addFinalizer(() =>
          Ref.update(state, (current) => ({
            ...current,
            closeCount: current.closeCount + 1,
          })),
        );
        if (options.hangSessionScopeClose === true) {
          // Registered last so it runs first on scope close, wedging the
          // close before the closeCount finalizer, like a provider process
          // that never yields its message stream.
          yield* Effect.addFinalizer(() => Effect.never);
        }

        return {
          instanceId: ProviderInstanceId.make("codex"),
          driver: CODEX_DRIVER,
          providerSessionId: input.providerSessionId,
          providerSession: session,
          events: options.failEventStream
            ? Stream.fail(
                new ProviderAdapterEventStreamError({
                  driver: CODEX_DRIVER,
                  providerSessionId: input.providerSessionId,
                  cause: "process exited",
                }),
              )
            : Stream.fromQueue(events),
          ...(options.hasPendingBackgroundWork === undefined
            ? {}
            : { hasPendingBackgroundWork: options.hasPendingBackgroundWork }),
          ensureThread: () => unimplemented("ensureThread unused in test"),
          resumeThread: (threadInput) =>
            Ref.update(state, (current) => ({
              ...current,
              resumeCount: current.resumeCount + 1,
            })).pipe(Effect.as(threadInput.providerThread)),
          startTurn: () => Effect.void,
          steerTurn: () => Effect.void,
          interruptTurn: () =>
            Ref.update(state, (current) => ({
              ...current,
              interruptCount: current.interruptCount + 1,
            })),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unimplemented("readThreadSnapshot unused in test"),
          rollbackThread: () => unimplemented("rollbackThread unused in test"),
          forkThread: () => unimplemented("forkThread unused in test"),
        } satisfies ProviderAdapterV2SessionRuntime;
      }),
  };
}

function makeTestLayer(input: {
  readonly state: Ref.Ref<TestProviderRuntimeState>;
  readonly idleTimeoutMs: number;
  readonly maxIdlePinMs?: number;
  readonly failEventStream?: boolean;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
  readonly mcpConfigs?: Ref.Ref<
    ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
  >;
  readonly beforeOpen?: (input: {
    readonly providerSessionId: ProviderSessionId;
  }) => Effect.Effect<void>;
  readonly failReleaseEventWrites?: boolean;
  readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
  readonly hangSessionScopeClose?: boolean;
}) {
  const configuredEventSinkLayer = input.failReleaseEventWrites
    ? FailingReleaseEventSinkLayer
    : TestEventSinkLayer;
  const registryLayer = makeProviderAdapterRegistryLayer(
    makeProviderAdapter(input.state, {
      failEventStream: input.failEventStream ?? false,
      ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
      ...(input.mcpConfigs === undefined ? {} : { mcpConfigs: input.mcpConfigs }),
      ...(input.beforeOpen === undefined ? {} : { beforeOpen: input.beforeOpen }),
      ...(input.hasPendingBackgroundWork === undefined
        ? {}
        : { hasPendingBackgroundWork: input.hasPendingBackgroundWork }),
      ...(input.hangSessionScopeClose === undefined
        ? {}
        : { hangSessionScopeClose: input.hangSessionScopeClose }),
    }),
  );
  return Layer.mergeAll(
    TestStoresLayer,
    configuredEventSinkLayer,
    idAllocatorLayer,
    TestMcpRegistryLayer,
    providerSessionManagerLayerWithOptions({
      idleTimeoutMs: input.idleTimeoutMs,
      ...(input.maxIdlePinMs === undefined ? {} : { maxIdlePinMs: input.maxIdlePinMs }),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          registryLayer,
          configuredEventSinkLayer,
          idAllocatorLayer,
          TestMcpRegistryLayer,
          TestStoresLayer,
        ),
      ),
    ),
  );
}

const fakeHttpServer = HttpServer.HttpServer.of({
  address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

const fakeEnvironment = ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-provider-session-manager")),
  getDescriptor: Effect.die("unused"),
});

const TestMcpRegistryLayer = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.__testing.make(),
).pipe(
  Layer.provide(Layer.succeed(HttpServer.HttpServer, fakeHttpServer)),
  Layer.provide(Layer.succeed(ServerEnvironment, fakeEnvironment)),
  Layer.provide(NodeServices.layer),
);

function makePendingRuntimeRequestEvents(input: {
  readonly idAllocator: IdAllocatorV2Shape;
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}) {
  return Effect.gen(function* () {
    const requestId = yield* input.idAllocator.allocate.runtimeRequest({
      driver: CODEX_DRIVER,
      nativeRequestId: "pending-approval",
    });
    const nodeId = input.idAllocator.derive.approvalNode({ requestId });
    const node = {
      id: nodeId,
      threadId: input.threadId,
      runId: null,
      parentNodeId: null,
      rootNodeId: nodeId,
      kind: "approval_request" as const,
      status: "waiting" as const,
      countsForRun: false,
      providerThreadId: input.providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: input.now,
      completedAt: null,
    };
    const request = {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: {
        driver: CODEX_DRIVER,
        nativeId: "pending-approval",
        strength: "strong" as const,
      },
      kind: "command" as const,
      status: "pending" as const,
      responseCapability: {
        type: "live" as const,
        providerSessionId: input.providerSessionId,
      },
      createdAt: input.now,
      resolvedAt: null,
    };
    const turnItem = {
      id: input.idAllocator.derive.approvalTurnItem({ requestId }),
      threadId: input.threadId,
      runId: null,
      nodeId,
      providerThreadId: input.providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "waiting" as const,
      title: null,
      startedAt: input.now,
      completedAt: null,
      updatedAt: input.now,
      type: "approval_request" as const,
      requestId,
      requestKind: "command" as const,
    };
    return [
      {
        id: yield* input.idAllocator.allocate.event({
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        }),
        type: "node.updated" as const,
        threadId: input.threadId,
        nodeId,
        driver: CODEX_DRIVER,
        occurredAt: input.now,
        payload: node,
      },
      {
        id: yield* input.idAllocator.allocate.event({
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        }),
        type: "runtime-request.updated" as const,
        threadId: input.threadId,
        nodeId,
        driver: CODEX_DRIVER,
        occurredAt: input.now,
        payload: request,
      },
      {
        id: yield* input.idAllocator.allocate.event({
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        }),
        type: "turn-item.updated" as const,
        threadId: input.threadId,
        nodeId,
        driver: CODEX_DRIVER,
        occurredAt: input.now,
        payload: turnItem,
      },
    ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
  });
}

it.effect("ProviderSessionManagerV2 opens independent sessions concurrently", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const openStartedCount = yield* Ref.make(0);
    const firstOpenStarted = yield* Deferred.make<void>();
    const secondOpenStarted = yield* Deferred.make<void>();
    const releaseOpens = yield* Deferred.make<void>();
    const beforeOpen = () =>
      Effect.gen(function* () {
        const openNumber = yield* Ref.modify(openStartedCount, (count) => [count + 1, count + 1]);
        yield* Deferred.succeed(openNumber === 1 ? firstOpenStarted : secondOpenStarted, undefined);
        yield* Deferred.await(releaseOpens);
      });

    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const firstThreadId = ThreadId.make("thread-provider-session-manager-concurrent-a");
      const secondThreadId = ThreadId.make("thread-provider-session-manager-concurrent-b");
      const firstProviderSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: firstThreadId,
      });
      const secondProviderSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: secondThreadId,
      });

      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
          yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
        ],
      });
      const firstFiber = yield* manager
        .open({
          threadId: firstThreadId,
          providerSessionId: firstProviderSessionId,
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstOpenStarted);
      const secondFiber = yield* manager
        .open({
          threadId: secondThreadId,
          providerSessionId: secondProviderSessionId,
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkScoped);

      yield* Deferred.await(secondOpenStarted);
      assert.equal(yield* Ref.get(openStartedCount), 2);
      yield* Deferred.succeed(releaseOpens, undefined);
      const [firstRuntime, secondRuntime] = yield* Effect.all([
        Fiber.join(firstFiber),
        Fiber.join(secondFiber),
      ]);
      assert.notStrictEqual(firstRuntime, secondRuntime);
      assert.equal((yield* Ref.get(state)).openCount, 2);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          beforeOpen,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 opens a duplicate session only once", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const openStartedCount = yield* Ref.make(0);
    const firstOpenStarted = yield* Deferred.make<void>();
    const releaseOpen = yield* Deferred.make<void>();
    const beforeOpen = () =>
      Ref.updateAndGet(openStartedCount, (count) => count + 1).pipe(
        Effect.tap(() => Deferred.succeed(firstOpenStarted, undefined)),
        Effect.andThen(Deferred.await(releaseOpen)),
      );

    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-single-flight");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const open = manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const firstFiber = yield* open.pipe(Effect.forkScoped);
      yield* Deferred.await(firstOpenStarted);
      const secondFiber = yield* open.pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(openStartedCount), 1);

      yield* Deferred.succeed(releaseOpen, undefined);
      const [firstRuntime, secondRuntime] = yield* Effect.all([
        Fiber.join(firstFiber),
        Fiber.join(secondFiber),
      ]);
      assert.strictEqual(firstRuntime, secondRuntime);
      assert.equal((yield* Ref.get(state)).openCount, 1);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          beforeOpen,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 releases live sessions when its layer shuts down", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-shutdown");
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

      const liveState = yield* Ref.get(state);
      assert.equal(liveState.openCount, 1);
      assert.equal(liveState.closeCount, 0);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
        }),
      ),
    );

    assert.equal((yield* Ref.get(state)).closeCount, 1);
  }),
);

it.effect("ProviderSessionManagerV2 closes event subscriptions normally on server shutdown", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
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

      assert.isEmpty(yield* bufferedSubscription.events.pipe(Stream.runCollect));
    });

    yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000 })));
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
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
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
        assert.equal(resolved?.threadId, threadId);
        assert.deepEqual(resolved?.capabilities, new Set(["preview", "orchestration"]));

        yield* manager.close(providerSessionId);
        assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
        assert.isUndefined(yield* registry.resolve(token!));
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 revokes MCP credentials when release persistence fails", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
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
      assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
      assert.isUndefined(yield* registry.resolve(token!));
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1_000,
          mcpConfigs,
          failReleaseEventWrites: true,
        }),
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
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
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
        McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId,
        replacement?.providerSessionId,
      );

      yield* manager.detach({ providerSessionId: oldSessionId, threadId });

      assert.equal(
        McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId,
        replacement?.providerSessionId,
      );
      assert.equal((yield* registry.resolve(replacementToken!))?.threadId, threadId);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1_000,
          capabilities: ExclusiveCapabilities,
          mcpConfigs,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 releases idle sessions without sweeping all sessions", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-idle",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-idle",
        projectId,
      });
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

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;

      const liveSession = yield* manager.get(providerSessionId);
      const runtimeState = yield* Ref.get(state);
      const projection = yield* projectionStore.getThreadProjection(threadId);

      assert.isTrue(Option.isNone(liveSession));
      assert.equal(runtimeState.openCount, 1);
      assert.equal(runtimeState.closeCount, 1);
      assert.equal(projection.providerSessions.at(-1)?.status, "stopped");
    });

    yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
  }),
);

it.effect("ProviderSessionManagerV2 persists release when session scope close hangs", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-hung-close",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-hung-close",
        }),
      });
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

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));

      yield* TestClock.adjust("30 seconds");
      yield* Effect.yieldNow;
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(projection.providerSessions.at(-1)?.status, "stopped");
      assert.equal((yield* Ref.get(state)).closeCount, 0);
    });

    yield* effect.pipe(
      Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000, hangSessionScopeClose: true })),
    );
  }),
);

it.effect("ProviderSessionManagerV2 defers idle release while background work is pending", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const pendingWork = yield* Ref.make(true);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-idle-pin",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-idle-pin",
        }),
      });
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

      yield* TestClock.adjust("3 seconds");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 0);

      yield* Ref.set(pendingWork, false);
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1000,
          hasPendingBackgroundWork: Ref.get(pendingWork),
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 releases pinned idle sessions once the pin cap expires", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-pin-cap",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-pin-cap",
        }),
      });
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

      yield* TestClock.adjust("3 seconds");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1000,
          maxIdlePinMs: 3000,
          hasPendingBackgroundWork: Effect.succeed(true),
        }),
      ),
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
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const manager = yield* ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStoreV2;
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

        // The release fiber is parked inside the pending-work check, so the
        // idle decision it already made is stale once this turn marks the
        // session busy.
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
          makeTestLayer({
            state,
            idleTimeoutMs: 1000,
            // Uninterruptible so the markBusy-triggered interrupt cannot land
            // inside the check, mirroring an adapter that masks interruption
            // while inspecting its own state.
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

it.effect(
  "ProviderSessionManagerV2 keeps active sessions alive until the provider turn terminates",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const manager = yield* ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStoreV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-active",
        });
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-active",
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
          nativeTurnId: "native-turn",
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
        yield* runtime.startTurn({
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
        });

        yield* TestClock.adjust("2 seconds");
        yield* Effect.yieldNow;
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

        const liveSession = yield* manager.get(providerSessionId);
        const projection = yield* projectionStore.getThreadProjection(threadId);
        assert.isTrue(Option.isNone(liveSession));
        assert.equal((yield* Ref.get(state)).closeCount, 1);
        assert.equal(projection.providerSessions.at(-1)?.status, "stopped");
      });

      yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
    }),
);

it.effect("ProviderSessionManagerV2 uses the same release path for runtime failures", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-runtime-error",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-runtime-error",
        projectId,
      });
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
      yield* manager.release({
        providerSessionId,
        reason: "runtime_error",
        detail: "process exited",
      });

      const liveSession = yield* manager.get(providerSessionId);
      const runtimeState = yield* Ref.get(state);
      const projection = yield* projectionStore.getThreadProjection(threadId);

      assert.isTrue(Option.isNone(liveSession));
      assert.equal(runtimeState.closeCount, 1);
      assert.equal(projection.providerSessions.at(-1)?.status, "error");
      assert.equal(projection.providerSessions.at(-1)?.lastError, "process exited");
    });

    yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
  }),
);

it.effect("ProviderSessionManagerV2 releases sessions when provider event streams fail", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStoreV2;
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
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
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
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStoreV2;
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
      yield* eventSink.write({
        events: yield* makePendingRuntimeRequestEvents({
          idAllocator,
          threadId,
          providerSessionId,
          providerThread,
          now,
        }),
      });
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

    yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
  }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a multi-thread session alive until all turns finish",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const manager = yield* ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStoreV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-multi-thread-active",
        });
        const firstThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-multi-thread-active-a",
          projectId,
        });
        const secondThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-multi-thread-active-b",
          projectId,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: firstThreadId,
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
        const secondRunId = idAllocator.derive.run({ threadId: secondThreadId, ordinal: 1 });
        const firstProviderTurnId = idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "native-turn-a",
        });
        const secondProviderTurnId = idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "native-turn-b",
        });

        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
          ],
        });
        const runtime = yield* manager.open({
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
        yield* runtime.events.pipe(Stream.runDrain, Effect.forkScoped);
        const firstAppThread = (yield* projectionStore.getThreadProjection(firstThreadId)).thread;
        const secondAppThread = (yield* projectionStore.getThreadProjection(secondThreadId)).thread;
        yield* runtime.startTurn({
          appThread: firstAppThread,
          threadId: firstThreadId,
          runId: firstRunId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: idAllocator.derive.runAttempt({ runId: firstRunId, attemptOrdinal: 1 }),
          rootNodeId: idAllocator.derive.rootNode({ runId: firstRunId }),
          providerThread: firstProviderThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({ threadId: firstThreadId, ordinal: 1 }),
            text: "first",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn({
          appThread: secondAppThread,
          threadId: secondThreadId,
          runId: secondRunId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: idAllocator.derive.runAttempt({ runId: secondRunId, attemptOrdinal: 1 }),
          rootNodeId: idAllocator.derive.rootNode({ runId: secondRunId }),
          providerThread: secondProviderThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({
              threadId: secondThreadId,
              ordinal: 1,
            }),
            text: "second",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });

        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(queue);
        yield* Queue.offer(queue!, {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId: firstProviderThread.id,
          providerTurnId: firstProviderTurnId,
          runOrdinal: 1,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* TestClock.adjust("2 seconds");
        yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(state)).closeCount, 0);

        yield* Queue.offer(queue!, {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId: secondProviderThread.id,
          providerTurnId: secondProviderTurnId,
          runOrdinal: 1,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      });

      yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
    }),
);

it.effect(
  "ProviderSessionManagerV2 opens one shared runtime, broadcasts events, and detaches threads independently",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const manager = yield* ProviderSessionManagerV2;
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

        yield* manager.detach({ providerSessionId, threadId: firstThreadId });
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        assert.equal((yield* Ref.get(state)).interruptCount, 1);

        yield* manager.detach({ providerSessionId, threadId: secondThreadId });
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      });

      yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
    }),
);

it.effect(
  "ProviderSessionManagerV2 rejects a second thread when the provider runtime is exclusive",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const manager = yield* ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-exclusive-runtime",
        });
        const firstThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-exclusive-runtime-a",
          projectId,
        });
        const secondThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-exclusive-runtime-b",
          projectId,
        });
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

        yield* manager.open({
          threadId: firstThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const error = yield* manager
          .open({
            threadId: secondThreadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.flip);

        assert.equal(error._tag, "ProviderSessionOpenError");
        assert.equal((yield* Ref.get(state)).openCount, 1);
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({ state, idleTimeoutMs: 1000, capabilities: ExclusiveCapabilities }),
        ),
      );
    }),
);
