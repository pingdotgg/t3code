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
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpServer } from "effect/unstable/http";

import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
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
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2TurnInput,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
} from "./ProviderAdapter.ts";
import { makeLayer as makeProviderAdapterRegistryLayerFor } from "./ProviderAdapterRegistry.ts";
import { layer as providerEventIngestorLayer } from "./ProviderEventIngestor.ts";
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
  readonly eventQueues: ReadonlyMap<string, Queue.Queue<ProviderAdapterV2Event, Cause.Done>>;
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
  readonly providerInstanceId?: ProviderInstanceId;
  readonly driver?: ProviderDriverKind;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    driver: input.driver ?? CODEX_DRIVER,
    providerInstanceId: input.providerInstanceId ?? modelSelection.instanceId,
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
  readonly projectId?: ProjectId;
}) {
  return Effect.gen(function* () {
    const projectId =
      input.projectId ??
      (yield* input.idAllocator.allocate.project({
        fixtureName: "provider-session-manager",
      }));
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
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
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
    readonly instanceId?: ProviderInstanceId;
    readonly driver?: ProviderDriverKind;
    readonly failEventStream?: boolean;
    readonly capabilities?: OrchestrationV2ProviderCapabilities;
    readonly mcpConfigs?: Ref.Ref<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >;
    readonly beforeOpen?: (input: {
      readonly providerSessionId: ProviderSessionId;
      readonly initialProviderItemIdentityVersion?: 2;
    }) => Effect.Effect<void>;
    readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
    readonly hangSessionScopeClose?: Deferred.Deferred<void>;
    readonly beforeClose?: Effect.Effect<void>;
    readonly beforeInterrupt?: Effect.Effect<void>;
    readonly afterOpen?: Effect.Effect<void>;
    readonly startTurn?: (
      input: ProviderAdapterV2TurnInput,
    ) => Effect.Effect<void, ProviderAdapterTurnStartError>;
    readonly resumeThread?: (
      input: Parameters<ProviderAdapterV2SessionRuntime["resumeThread"]>[0],
    ) => ReturnType<ProviderAdapterV2SessionRuntime["resumeThread"]>;
    readonly ensureThread?: (
      input: Parameters<ProviderAdapterV2SessionRuntime["ensureThread"]>[0],
    ) => ReturnType<ProviderAdapterV2SessionRuntime["ensureThread"]>;
  } = {},
): ProviderAdapterV2Shape {
  const instanceId = options.instanceId ?? ProviderInstanceId.make("codex");
  const driver = options.driver ?? CODEX_DRIVER;
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(options.capabilities ?? CodexCapabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        if (options.beforeOpen !== undefined) {
          yield* options.beforeOpen(input);
        }
        if (options.mcpConfigs !== undefined) {
          yield* Ref.update(options.mcpConfigs, (configs) => [
            ...configs,
            McpProviderSession.readMcpProviderSession(input.threadId),
          ]);
        }
        const now = yield* DateTime.now;
        const events = yield* Queue.unbounded<ProviderAdapterV2Event, Cause.Done>();
        const session = makeProviderSession({
          providerSessionId: input.providerSessionId,
          now,
          providerInstanceId: instanceId,
          driver,
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
        const hangSessionScopeClose = options.hangSessionScopeClose;
        if (hangSessionScopeClose !== undefined) {
          // Registered last so it runs first on scope close, wedging the
          // close before the closeCount finalizer, like a provider process
          // that never yields its message stream. The gate exists so a test
          // can let teardown finish: layer shutdown joins pending releases
          // and would otherwise park on this finalizer forever.
          yield* Effect.addFinalizer(() => Deferred.await(hangSessionScopeClose));
        }
        const beforeClose = options.beforeClose;
        if (beforeClose !== undefined) {
          yield* Effect.addFinalizer(() => beforeClose);
        }
        if (options.afterOpen !== undefined) {
          yield* options.afterOpen;
        }

        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: session,
          events: options.failEventStream
            ? Stream.fail(
                new ProviderAdapterEventStreamError({
                  driver,
                  providerSessionId: input.providerSessionId,
                  cause: "process exited",
                }),
              )
            : Stream.fromQueue(events),
          ...(options.hasPendingBackgroundWork === undefined
            ? {}
            : { hasPendingBackgroundWork: options.hasPendingBackgroundWork }),
          ensureThread: (threadInput) =>
            options.ensureThread === undefined
              ? unimplemented("ensureThread unused in test")
              : options.ensureThread(threadInput),
          resumeThread: (threadInput) =>
            options.resumeThread === undefined
              ? Ref.update(state, (current) => ({
                  ...current,
                  resumeCount: current.resumeCount + 1,
                })).pipe(Effect.as(threadInput.providerThread))
              : options.resumeThread(threadInput),
          startTurn: (turnInput) =>
            options.startTurn === undefined ? Effect.void : options.startTurn(turnInput),
          steerTurn: () => Effect.void,
          interruptTurn: () =>
            (options.beforeInterrupt ?? Effect.void).pipe(
              Effect.andThen(
                Ref.update(state, (current) => ({
                  ...current,
                  interruptCount: current.interruptCount + 1,
                })),
              ),
            ),
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
  readonly driver?: ProviderDriverKind;
  readonly failEventStream?: boolean;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
  readonly mcpConfigs?: Ref.Ref<
    ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
  >;
  readonly beforeOpen?: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly initialProviderItemIdentityVersion?: 2;
  }) => Effect.Effect<void>;
  readonly failReleaseEventWrites?: boolean;
  readonly eventSinkLayer?: typeof TestEventSinkLayer;
  readonly mcpRegistryLayer?: typeof TestMcpRegistryLayer;
  readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
  readonly hangSessionScopeClose?: Deferred.Deferred<void>;
  readonly beforeClose?: Effect.Effect<void>;
  readonly beforeInterrupt?: Effect.Effect<void>;
  readonly afterOpen?: Effect.Effect<void>;
  readonly startTurn?: (
    input: ProviderAdapterV2TurnInput,
  ) => Effect.Effect<void, ProviderAdapterTurnStartError>;
  readonly resumeThread?: (
    input: Parameters<ProviderAdapterV2SessionRuntime["resumeThread"]>[0],
  ) => ReturnType<ProviderAdapterV2SessionRuntime["resumeThread"]>;
  readonly ensureThread?: (
    input: Parameters<ProviderAdapterV2SessionRuntime["ensureThread"]>[0],
  ) => ReturnType<ProviderAdapterV2SessionRuntime["ensureThread"]>;
  readonly serverSettingsLayer?: ReturnType<typeof ServerSettings.layerTest>;
  readonly projectServiceLayer?: Layer.Layer<ProjectService.ProjectService>;
  readonly fileSystemLayer?: Layer.Layer<FileSystem.FileSystem>;
  readonly extraAdapters?: ReadonlyArray<ProviderAdapterV2Shape>;
}) {
  const mcpRegistryLayer = input.mcpRegistryLayer ?? TestMcpRegistryLayer;
  const configuredEventSinkLayer =
    input.eventSinkLayer ??
    (input.failReleaseEventWrites ? FailingReleaseEventSinkLayer : TestEventSinkLayer);
  const adapters = [
    makeProviderAdapter(input.state, {
      ...(input.driver === undefined ? {} : { driver: input.driver }),
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
      ...(input.beforeClose === undefined ? {} : { beforeClose: input.beforeClose }),
      ...(input.beforeInterrupt === undefined ? {} : { beforeInterrupt: input.beforeInterrupt }),
      ...(input.afterOpen === undefined ? {} : { afterOpen: input.afterOpen }),
      ...(input.startTurn === undefined ? {} : { startTurn: input.startTurn }),
      ...(input.resumeThread === undefined ? {} : { resumeThread: input.resumeThread }),
      ...(input.ensureThread === undefined ? {} : { ensureThread: input.ensureThread }),
    }),
    ...(input.extraAdapters ?? []),
  ];
  const registryLayer = makeProviderAdapterRegistryLayerFor(adapters);
  const providerEventIngestorTestLayer = providerEventIngestorLayer.pipe(
    Layer.provide(Layer.mergeAll(configuredEventSinkLayer, idAllocatorLayer, TestStoresLayer)),
  );
  return Layer.mergeAll(
    TestStoresLayer,
    configuredEventSinkLayer,
    idAllocatorLayer,
    mcpRegistryLayer,
    providerSessionManagerLayerWithOptions({
      idleTimeoutMs: input.idleTimeoutMs,
      ...(input.maxIdlePinMs === undefined ? {} : { maxIdlePinMs: input.maxIdlePinMs }),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          registryLayer,
          configuredEventSinkLayer,
          idAllocatorLayer,
          providerEventIngestorTestLayer,
          mcpRegistryLayer,
          TestStoresLayer,
          ...(input.serverSettingsLayer === undefined ? [] : [input.serverSettingsLayer]),
          ...(input.projectServiceLayer === undefined ? [] : [input.projectServiceLayer]),
          ...(input.fileSystemLayer === undefined ? [] : [input.fileSystemLayer]),
        ),
      ),
    ),
  ).pipe(Layer.provide(NodeServices.layer));
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

function makeBrowserAccessProject(projectId: ProjectId): Project {
  return {
    id: projectId,
    title: "Browser access project",
    workspaceRoot: process.cwd(),
    repositoryIdentity: null,
    faviconPath: null,
    projectIcon: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

function runBrowserAccessScenario(input: {
  readonly enableAgentBrowserAccess: boolean;
  readonly projectOverride: boolean;
  readonly deviceOverride?: boolean;
  readonly createThread?: boolean;
  readonly projectExists?: boolean;
}) {
  return Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const projectId = ProjectId.make("project-provider-session-manager-browser-access");
    const threadId = ThreadId.make("thread-provider-session-manager-browser-access");
    const projectServiceLayer = Layer.mock(ProjectService.ProjectService)({
      getById: (requestedProjectId) =>
        Effect.succeed(
          input.projectExists === false
            ? Option.none()
            : Option.some(makeBrowserAccessProject(requestedProjectId)),
        ),
    });

    yield* Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      if (input.createThread !== false) {
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now, projectId })],
        });
      }
      yield* manager
        .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
        .pipe(Effect.ignore);
    }).pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1_000,
          mcpConfigs,
          projectServiceLayer,
          serverSettingsLayer: ServerSettings.layerTest({
            enableAgentBrowserAccess: input.enableAgentBrowserAccess,
            projectSettingsOverrides: {
              [projectId]: {
                enableAgentBrowserAccess: input.projectOverride,
                ...(input.deviceOverride === undefined
                  ? {}
                  : { enableAgentDeviceAccess: input.deviceOverride }),
              },
            },
          }),
        }),
      ),
    );

    return (yield* Ref.get(mcpConfigs))[0];
  });
}

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
    const events = [
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
    const providerEvents = [
      {
        type: "runtime_request.updated" as const,
        driver: CODEX_DRIVER,
        threadId: input.threadId,
        runtimeRequest: request,
      },
      {
        type: "node.updated" as const,
        driver: CODEX_DRIVER,
        node,
      },
      {
        type: "turn_item.updated" as const,
        driver: CODEX_DRIVER,
        turnItem,
      },
    ] satisfies ReadonlyArray<ProviderAdapterV2Event>;
    return { events, providerEvents, requestId, nodeId };
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

it.effect("ProviderSessionManagerV2 closes every live session for a provider instance", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const firstThreadId = ThreadId.make("thread-provider-session-manager-logout-a");
      const secondThreadId = ThreadId.make("thread-provider-session-manager-logout-b");
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
      yield* manager.open({
        threadId: firstThreadId,
        providerSessionId: firstProviderSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.open({
        threadId: secondThreadId,
        providerSessionId: secondProviderSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* manager.closeInstance(modelSelection.instanceId);

      assert.isTrue(Option.isNone(yield* manager.get(firstProviderSessionId)));
      assert.isTrue(Option.isNone(yield* manager.get(secondProviderSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 2);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
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

it.effect("ProviderSessionManagerV2 drains subscribers when the provider stops", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
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
        assert.deepEqual(
          resolved?.capabilities,
          new Set(["preview", "orchestration", "worktree", "pull-requests"]),
        );

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

it.effect(
  "ProviderSessionManagerV2 withholds the preview capability when agent browser access is off",
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
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
            // orDie: the test layer's settings-normalization error cannot
            // occur for a literal override and the slot requires error never.
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

it.effect("ProviderSessionManagerV2 honors a project browser-access opt-in", () =>
  Effect.gen(function* () {
    const captured = yield* runBrowserAccessScenario({
      enableAgentBrowserAccess: false,
      projectOverride: true,
    });
    assert.isDefined(captured);
    assert.equal(captured?.browserToolsAvailable, true);
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

it.effect("ProviderSessionManagerV2 fails browser access closed for a missing thread", () =>
  Effect.gen(function* () {
    const captured = yield* runBrowserAccessScenario({
      enableAgentBrowserAccess: true,
      projectOverride: true,
      createThread: false,
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
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      assert.equal((yield* Ref.get(state)).openCount, 2);
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

it.effect(
  "ProviderSessionManagerV2 detach of a superseded live session preserves replacement MCP credentials",
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
        const threadId = ThreadId.make("thread-provider-session-manager-superseded-mcp");
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
        // The replacement opens while the old session is still attached: this is
        // the workspace-handoff sequence, where the queued continuation run can
        // start its session before the outbox executes the old session's detach.
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

        // First (non-duplicate) detach of the superseded session must not revoke
        // the replacement's credential or clear its config slot.
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

it.effect(
  "ProviderSessionManagerV2 keeps a thread's MCP credential stable across detach and re-attach on a shared session",
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

        // Workspace-change handoff on a shared multi-thread session (codex):
        // the thread detaches while the provider process keeps running, and the
        // process's MCP client keeps using the credential it was started with.
        yield* manager.detach({ providerSessionId, threadId, detail: "Workspace changed." });
        assert.equal(
          (yield* registry.resolve(originalToken!))?.threadId,
          threadId,
          "detach must not revoke the credential the live provider process still holds",
        );

        // The continuation run re-attaches the same thread to the same session;
        // the credential must be reused, not rotated, so the provider process's
        // long-lived MCP client stays authorized.
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        assert.equal(
          McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId,
          original?.providerSessionId,
          "re-attach must reuse the existing credential, not rotate it",
        );
        assert.equal((yield* registry.resolve(originalToken!))?.threadId, threadId);

        // Releasing the session (provider process gone) still revokes.
        yield* manager.close(providerSessionId);
        assert.isUndefined(yield* registry.resolve(originalToken!));
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

it.effect(
  "ProviderSessionManagerV2 revokes a rotated credential despite a stale record on another live session",
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
        const threadId = ThreadId.make("thread-provider-session-manager-stale-record");
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
        // S1 (shared session) records credential C1 for the thread, then the
        // thread detaches; S1 stays alive with the stale record.
        yield* manager.open({ threadId, providerSessionId: s1, modelSelection, runtimePolicy });
        yield* manager.detach({ providerSessionId: s1, threadId });

        // The credential dies externally, so S2's attach must rotate to C2.
        yield* registry.revokeThread(threadId);
        yield* manager.open({ threadId, providerSessionId: s2, modelSelection, runtimePolicy });
        const rotated = McpProviderSession.readMcpProviderSession(threadId);
        assert.isDefined(rotated);
        const rotatedToken = rotated?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(yield* registry.resolve(rotatedToken!));

        // Releasing S2 must revoke C2 even though S1 still carries a stale
        // record (of dead C1) for the same thread.
        yield* manager.close(s2);
        assert.isUndefined(
          yield* registry.resolve(rotatedToken!),
          "stale record on S1 must not veto revoking S2's rotated credential",
        );
        yield* manager.close(s1);
      });

      yield* effect.pipe(
        Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1_000, mcpConfigs })),
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
      const openEntered = yield* Deferred.make<void>();
      const openGate = yield* Deferred.make<void>();
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
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

        // While S2's provider process is spawning (after prepare reused the
        // credential, before the entry is visible), the predecessor session
        // releases. Eager adapters (ACP, OpenCode) bake the credential into
        // the process during openSession, so the release must not revoke it;
        // rotating afterwards cannot repair those adapters.
        yield* Ref.set(
          duringOpen,
          Deferred.succeed(openEntered, undefined).pipe(Effect.andThen(Deferred.await(openGate))),
        );
        const opening = yield* manager
          .open({ threadId, providerSessionId: s2, modelSelection, runtimePolicy })
          .pipe(Effect.forkChild);
        yield* Deferred.await(openEntered);
        const closing = yield* manager.close(s1).pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        assert.equal((yield* Fiber.join(closing))._tag, "Failure");
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        yield* Deferred.succeed(openGate, undefined);
        yield* Fiber.join(opening);
        yield* manager.close(s1);

        const slot = McpProviderSession.readMcpProviderSession(threadId);
        assert.equal(
          slot?.providerSessionId,
          original?.providerSessionId,
          "the credential the adapter was configured with must remain current",
        );
        assert.equal(
          (yield* registry.resolve(originalToken!))?.threadId,
          threadId,
          "the predecessor release must not revoke a credential reserved by an in-flight open",
        );
        yield* manager.close(s2);
      });

      yield* effect.pipe(
        Effect.ensuring(Deferred.succeed(openGate, undefined)),
        Effect.provide(
          makeTestLayer({
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
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
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

      // Archive/delete detaches carry revokeMcpCredential: the token must die
      // with the thread even though the shared provider process lives on.
      yield* manager.detach({
        providerSessionId,
        threadId,
        detail: "Thread deleted.",
        revokeMcpCredential: true,
      });
      assert.isUndefined(yield* registry.resolve(token!));
      assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
    });

    yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1_000, mcpConfigs })));
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

it.effect("ProviderSessionManagerV2 reports an error when session scope close hangs", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const hangClose = yield* Deferred.make<void>();
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
      assert.equal(projection.providerSessions.at(-1)?.status, "error");
      assert.include(projection.providerSessions.at(-1)?.lastError ?? "", "30 seconds");
      assert.equal((yield* Ref.get(state)).closeCount, 0);
    });

    yield* effect.pipe(
      Effect.ensuring(Deferred.succeed(hangClose, undefined)),
      Effect.provide(
        makeTestLayer({ state, idleTimeoutMs: 1000, hangSessionScopeClose: hangClose }),
      ),
    );
  }),
);

function makeThreadSessionFixture(threadId: ThreadId) {
  return Effect.gen(function* () {
    const idAllocator = yield* IdAllocatorV2;
    const eventSink = yield* EventSinkV2;
    const manager = yield* ProviderSessionManagerV2;
    yield* eventSink.write({
      events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now: yield* DateTime.now })],
    });
    return {
      allocate: idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      }),
      open: (providerSessionId: ProviderSessionId, attachedThreadId = threadId) =>
        manager.open({
          threadId: attachedThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        }),
    };
  });
}

// A scheduler that yields a fiber exactly once — when it reaches a chosen op
// boundary — and queues the continuations it would run in `tasks`, so a test
// can suspend a fiber between two adjacent runtime instructions and interrupt
// it there. That is the only way to reach windows like "after `opening.set`
// but before the unwind handler", which have no suspension for ordinary
// fork/interrupt choreography to land in. `shouldYield` must fire once: the
// resumed fiber rechecks it before evaluating the deferred op, so returning
// true repeatedly would suspend the same op forever without making progress.
function makeSteppingScheduler() {
  const tasks: Array<() => void> = [];
  const counts = new Map<Fiber.Fiber<unknown, unknown>, number>();
  const targets = new Map<Fiber.Fiber<unknown, unknown>, number>();
  // Resume tasks of fibers suspended through `spawnedTarget`, keyed by fiber so
  // a `drain` cannot accidentally release them — a spawned fiber stays parked
  // until `resumeSpawned` requeues its continuation.
  const held = new Map<Fiber.Fiber<unknown, unknown>, () => void>();
  // When set, a fiber with no explicit target suspends once its own op count
  // reaches this value. The runtime consults `shouldYield` synchronously inside
  // the yielding task, so the next scheduled task is that fiber's resume —
  // capture it instead of queueing.
  let spawnedTarget: number | undefined;
  let capture: Fiber.Fiber<unknown, unknown> | undefined;
  const scheduler: Scheduler.Scheduler = {
    executionMode: "sync",
    shouldYield: (fiber) => {
      const count = (counts.get(fiber) ?? 0) + 1;
      counts.set(fiber, count);
      if (targets.has(fiber)) return count === targets.get(fiber);
      if (spawnedTarget === undefined || count !== spawnedTarget) return false;
      // The arming is consumed by the first spawned fiber to reach the offset:
      // later forks (the scope-close grandchild, settle-phase workers) must
      // run free or the sweep deadlocks on its own bookkeeping.
      spawnedTarget = undefined;
      capture = fiber;
      return true;
    },
    makeDispatcher: () => ({
      scheduleTask: (task) => {
        if (capture !== undefined) {
          held.set(capture, task);
          capture = undefined;
          return;
        }
        tasks.push(task);
      },
      flush: () => {
        while (tasks.length > 0) tasks.shift()!();
      },
    }),
  };
  // Runs `fiber` until it has reached `ops` op checks — at which point it is
  // suspended with its resume task queued — then returns true. Returns true
  // for a fiber that exits before `ops`; returns false when the fiber parks
  // on work outside this dispatcher (e.g. an async fileSystem call or a
  // deferred nobody completes), which caps the sweep at that boundary.
  const step = (fiber: Fiber.Fiber<unknown, unknown>, ops: number) =>
    Effect.gen(function* () {
      targets.set(fiber, ops);
      for (let emptyRounds = 0; (counts.get(fiber) ?? 0) < ops;) {
        const task = tasks.shift();
        if (task !== undefined) {
          task();
          emptyRounds = 0;
          continue;
        }
        if (fiber.pollUnsafe() !== undefined) return true;
        // The fiber's initial evaluation is dispatched through the forking
        // fiber's scheduler, so give the default dispatcher turns before
        // concluding it is parked.
        yield* Effect.yieldNow;
        if (tasks.length === 0 && ++emptyRounds > 32) return false;
      }
      return true;
    });
  // Runs every queued continuation, yielding so default-scheduler work can
  // resolve deferreds the stepped fibers are waiting on.
  const drain = Effect.gen(function* () {
    for (let round = 0; round < 64; round++) {
      while (tasks.length > 0) tasks.shift()!();
      yield* Effect.yieldNow;
      if (tasks.length === 0) return;
    }
  });
  // Registers `fiber` as an explicit target so `spawnedTarget` ignores it;
  // `ops` beyond its lifetime means it never suspends on a target.
  const aim = (fiber: Fiber.Fiber<unknown, unknown>, ops: number) => {
    targets.set(fiber, ops);
  };
  // Suspends the first spawned (non-targeted) fiber to reach its own op `ops`;
  // the arming is consumed by that hold.
  const holdSpawnedAt = (ops: number) => {
    spawnedTarget = ops;
  };
  // Requeues the captured resume tasks of all suspended spawned fibers.
  const resumeSpawned = () => {
    for (const task of held.values()) tasks.push(task);
    held.clear();
  };
  return { scheduler, tasks, counts, step, drain, aim, holdSpawnedAt, resumeSpawned, held };
}

for (const operation of ["close", "detach", "closeInstance"] as const) {
  it.effect(
    `ProviderSessionManagerV2 blocks replacement after ${operation} times out until cleanup completes`,
    () =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        const closeEntered = yield* Deferred.make<void>();
        const closeGate = yield* Deferred.make<void>();
        const mcpConfigs = yield* Ref.make<
          ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
        >([]);
        yield* Effect.gen(function* () {
          const manager = yield* ProviderSessionManagerV2;
          const projectionStore = yield* ProjectionStoreV2;
          const registry = yield* McpSessionRegistry.McpSessionRegistry;
          const threadId = ThreadId.make(`thread-release-timeout-${operation}`);
          const { allocate, open } = yield* makeThreadSessionFixture(threadId);
          const providerSessionId = yield* allocate;
          const replacementId = yield* allocate;
          const release =
            operation === "close"
              ? manager.close(providerSessionId)
              : operation === "closeInstance"
                ? manager.closeInstance(modelSelection.instanceId)
                : manager.detach({ providerSessionId, threadId });
          yield* open(providerSessionId);
          const cancelledClose = yield* release.pipe(Effect.forkChild);
          yield* Deferred.await(closeEntered);
          yield* Fiber.interrupt(cancelledClose);
          const firstClose = yield* release.pipe(Effect.result, Effect.forkChild);
          assert.equal(
            (yield* open(replacementId).pipe(Effect.flip))._tag,
            "ProviderSessionOpenError",
          );
          yield* TestClock.adjust("30 seconds");
          assert.equal((yield* Fiber.join(firstClose))._tag, "Failure");
          assert.equal(
            (yield* projectionStore.getThreadProjection(threadId)).providerSessions.at(-1)?.status,
            "error",
          );
          assert.equal(
            (yield* open(providerSessionId).pipe(Effect.flip))._tag,
            "ProviderSessionOpenError",
          );
          assert.equal(
            (yield* open(replacementId).pipe(Effect.flip))._tag,
            "ProviderSessionOpenError",
          );
          assert.equal((yield* Ref.get(state)).openCount, 1);
          assert.equal((yield* Ref.get(state)).closeCount, 0);
          const token = (yield* Ref.get(mcpConfigs))[0]?.authorizationHeader.replace(
            /^Bearer\s+/,
            "",
          );
          assert.isDefined(yield* registry.resolve(token!));

          // Retrying must wait for the original cleanup, not treat the removed entry as stopped.
          const retry = yield* manager
            .detach({ providerSessionId, threadId, revokeMcpCredential: true })
            .pipe(Effect.result, Effect.forkChild);
          yield* TestClock.adjust("30 seconds");
          assert.equal((yield* Fiber.join(retry))._tag, "Failure");
          // The pending cleanup still holds the credential; the timed-out
          // detach defers revocation to it instead of revoking under it.
          assert.isDefined(yield* registry.resolve(token!));
          yield* Deferred.succeed(closeGate, undefined);
          yield* release;
          assert.equal((yield* Ref.get(state)).closeCount, 1);
          assert.isUndefined(yield* registry.resolve(token!));
          const stopped = (yield* projectionStore.getThreadProjection(
            threadId,
          )).providerSessions.at(-1);
          assert.equal(stopped?.status, "stopped");
          assert.isNull(stopped?.lastError);
          yield* open(replacementId);
          assert.equal((yield* Ref.get(state)).openCount, 2);
        }).pipe(
          Effect.ensuring(Deferred.succeed(closeGate, undefined)),
          Effect.provide(
            makeTestLayer({
              state,
              idleTimeoutMs: 3_600_000,
              capabilities: ExclusiveCapabilities,
              mcpConfigs,
              beforeClose: Deferred.succeed(closeEntered, undefined).pipe(
                Effect.andThen(Deferred.await(closeGate)),
              ),
            }),
          ),
        );
      }),
  );
}

for (const cleanupOutcome of ["success", "failure"] as const) {
  it.effect(
    `ProviderSessionManagerV2 reuses a live peer and preserves cleanup ${cleanupOutcome} semantics`,
    () =>
      Effect.gen(function* () {
        const cleanupDefect = "private adapter output that must not reach the client";
        const state = yield* Ref.make(emptyState);
        const closes = yield* Ref.make(0);
        const closeEntered = yield* Deferred.make<void>();
        const closeGate = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          const manager = yield* ProviderSessionManagerV2;
          const projectionStore = yield* ProjectionStoreV2;
          const threadId = ThreadId.make(`thread-live-peer-${cleanupOutcome}`);
          const otherThreadId = ThreadId.make(`thread-new-attachment-${cleanupOutcome}`);
          const { allocate, open } = yield* makeThreadSessionFixture(threadId);
          yield* makeThreadSessionFixture(otherThreadId);
          const oldId = yield* allocate;
          const liveId = yield* allocate;
          const newId = yield* allocate;
          yield* open(oldId);
          yield* open(oldId, otherThreadId);
          const liveRuntime = yield* open(liveId);
          const closing = yield* manager.close(oldId).pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(closeEntered);
          assert.strictEqual(yield* open(liveId), liveRuntime);
          assert.equal((yield* open(newId).pipe(Effect.flip))._tag, "ProviderSessionOpenError");
          assert.equal((yield* open(oldId).pipe(Effect.flip))._tag, "ProviderSessionOpenError");
          assert.equal(
            (yield* open(liveId, otherThreadId).pipe(Effect.flip))._tag,
            "ProviderSessionOpenError",
          );
          yield* TestClock.adjust("30 seconds");
          assert.equal((yield* Fiber.join(closing))._tag, "Failure");
          assert.strictEqual(yield* open(liveId), liveRuntime);
          assert.equal((yield* Ref.get(state)).openCount, 2);
          assert.equal((yield* Ref.get(state)).closeCount, 0);
          yield* Deferred.succeed(closeGate, undefined);
          const completed = yield* manager.close(oldId).pipe(Effect.result);
          assert.equal(completed._tag, cleanupOutcome === "success" ? "Success" : "Failure");
          assert.strictEqual(yield* open(liveId), liveRuntime);
          if (cleanupOutcome === "success") {
            assert.strictEqual(yield* open(liveId, otherThreadId), liveRuntime);
          } else {
            const session = (yield* projectionStore.getThreadProjection(
              threadId,
            )).providerSessions.find((session) => session.id === oldId);
            assert.equal(session?.status, "error");
            assert.equal(session?.lastError, "Provider session cleanup failed.");
            const release = manager.release({
              providerSessionId: oldId,
              reason: "manual_shutdown",
            });
            const releaseError = yield* release.pipe(Effect.flip);
            const cleanupCause = releaseError.cause;
            if (!Cause.isCause(cleanupCause)) assert.fail("Expected the original cleanup cause");
            assert.strictEqual(Cause.squash(cleanupCause), cleanupDefect);
            assert.strictEqual(yield* release.pipe(Effect.flip), releaseError);
            assert.equal((yield* open(oldId).pipe(Effect.flip))._tag, "ProviderSessionOpenError");
            assert.equal(
              (yield* open(liveId, otherThreadId).pipe(Effect.flip))._tag,
              "ProviderSessionOpenError",
            );
            assert.equal((yield* open(newId).pipe(Effect.flip))._tag, "ProviderSessionOpenError");
          }
          assert.equal((yield* Ref.get(state)).openCount, 2);
        }).pipe(
          Effect.ensuring(Deferred.succeed(closeGate, undefined)),
          Effect.provide(
            makeTestLayer({
              state,
              idleTimeoutMs: 3_600_000,
              beforeClose: Ref.getAndUpdate(closes, (n) => n + 1).pipe(
                Effect.flatMap((n) =>
                  n === 0
                    ? Deferred.succeed(closeEntered, undefined).pipe(
                        Effect.andThen(Deferred.await(closeGate)),
                        Effect.andThen(
                          cleanupOutcome === "failure" ? Effect.die(cleanupDefect) : Effect.void,
                        ),
                      )
                    : Effect.void,
                ),
              ),
            }),
          ),
        );
      }),
  );
}

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

it.effect("ProviderSessionManagerV2 does not apply a stale idle pin to a replacement session", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const firstCheck = yield* Ref.make(true);
    const checkEntered = yield* Deferred.make<void>();
    const checkGate = yield* Deferred.make<void>();
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-stale-pin",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-stale-pin",
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

      // Park the first idle fiber inside an uninterruptible pending-work probe.
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(checkEntered);

      // Cleanup waits for the uninterruptible probe. Replacement must wait too.
      const closeFiber = yield* manager.close(providerSessionId).pipe(Effect.forkDetach);
      for (let i = 0; i < 20; i += 1) {
        yield* Effect.yieldNow;
      }
      const replacement = manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      assert.equal((yield* replacement.pipe(Effect.flip))._tag, "ProviderSessionOpenError");
      assert.equal((yield* Ref.get(state)).openCount, 1);

      // Stale probe reports pending work against the old runtime; the pin
      // stamp must no-op on the replacement (runtime / generation mismatch).
      yield* Deferred.succeed(checkGate, undefined);
      yield* Fiber.join(closeFiber);
      yield* replacement;

      assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);

      // Replacement has no pending background work. After one idle window it
      // must release. A stale pin stamp would have deferred release until
      // maxIdlePinMs.
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 2);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1000,
          maxIdlePinMs: 60_000,
          hasPendingBackgroundWork: Effect.uninterruptible(
            Effect.gen(function* () {
              if (yield* Ref.getAndSet(firstCheck, false)) {
                yield* Deferred.succeed(checkEntered, undefined);
                yield* Deferred.await(checkGate);
                return true;
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

    yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
  }),
);
it.effect("ProviderSessionManagerV2 terminalizes a pending input transcript item on release", () =>
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
            ? { ...event, payload: { ...event.payload, type: "user_input_request", questions: [] } }
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
        reason: "runtime_error",
        detail: "process exited",
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const request = projection.runtimeRequests.at(-1);
      const requestNode = projection.nodes.find((node) => node.id === request?.nodeId);
      const requestTurnItem = projection.turnItems.find(
        (item) => item.type === "user_input_request" && item.requestId === request?.id,
      );

      assert.equal(request?.status, "expired");
      assert.equal(request?.responseCapability.type, "not_resumable");
      assert.equal(requestNode?.status, "failed");
      assert.equal(requestTurnItem?.status, "failed");
    });

    yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
  }),
);

it.effect("ProviderSessionManagerV2 persists session-scoped runtime requests without a run", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStoreV2;
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

    yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
  }),
);

it.effect(
  "ProviderSessionManagerV2 preserves item identity during eager native session activation",
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
          events: (yield* makePendingRuntimeRequestEvents({
            idAllocator,
            threadId,
            providerSessionId,
            providerThread,
            now,
          })).events,
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
          initialNativeThreadId: "native-import",
          initialProviderItemIdentityVersion: 2,
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

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1000,
            beforeOpen: (input) =>
              Effect.sync(() => assert.equal(input.initialProviderItemIdentityVersion, 2)),
          }),
        ),
      );
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

for (const workspaceState of ["missing", "file"] as const) {
  it.effect(`rejects a ${workspaceState} workspace before opening a provider session`, () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const cwd = `${root}/workspace`;
      if (workspaceState === "file") yield* fileSystem.writeFileString(cwd, "not a directory");
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const eventSink = yield* EventSinkV2;
        const projectionStore = yield* ProjectionStoreV2;
        const idAllocator = yield* IdAllocatorV2;
        const threadId = ThreadId.make(`thread-${workspaceState}-workspace`);
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({
              idAllocator,
              threadId,
              now: yield* DateTime.now,
            }),
          ],
        });
        const error = yield* manager
          .open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy: { ...runtimePolicy, cwd },
          })
          .pipe(Effect.flip);
        assert.instanceOf(error, ProviderWorkspaceMissingError);
        assert.include(error.message, cwd);
        assert.include(error.message, "Restore the folder at this path before retrying.");
        assert.equal((yield* Ref.get(state)).openCount, 0);
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        assert.deepEqual(
          (yield* projectionStore.getThreadProjection(threadId)).providerSessions,
          [],
        );
      }).pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000 })));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect(
  "rejects a deleted workspace before reusing a live session without changing its state",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const cwd = `${root}/workspace`;
      yield* fileSystem.makeDirectory(cwd);
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const eventSink = yield* EventSinkV2;
        const projectionStore = yield* ProjectionStoreV2;
        const idAllocator = yield* IdAllocatorV2;
        const threadId = ThreadId.make("thread-deleted-live-workspace");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({
              idAllocator,
              threadId,
              now: yield* DateTime.now,
            }),
          ],
        });
        const input = {
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy: { ...runtimePolicy, cwd },
        };
        const runtime = yield* manager.open(input);
        const before = yield* projectionStore.getThreadProjection(threadId);
        yield* fileSystem.remove(cwd, { recursive: true });
        const error = yield* manager.open(input).pipe(Effect.flip);
        assert.instanceOf(error, ProviderWorkspaceMissingError);
        assert.equal((yield* Ref.get(state)).openCount, 1);
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        assert.strictEqual(Option.getOrThrow(yield* manager.get(providerSessionId)), runtime);
        assert.deepEqual(
          (yield* projectionStore.getThreadProjection(threadId)).providerSessions,
          before.providerSessions,
        );
      }).pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000 })));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderSessionManagerV2 applies project device access independently of browser access",
  () =>
    Effect.gen(function* () {
      const enabled = yield* runBrowserAccessScenario({
        enableAgentBrowserAccess: false,
        projectOverride: false,
        deviceOverride: true,
      });
      assert.isTrue(enabled?.capabilities?.has("device"));
      assert.isFalse(enabled?.browserToolsAvailable);
      const denied = yield* runBrowserAccessScenario({
        enableAgentBrowserAccess: false,
        projectOverride: false,
        deviceOverride: true,
        projectExists: false,
      });
      assert.isFalse(denied?.capabilities?.has("device"));
    }),
);
for (const cleanupOutcome of ["success", "persistence_failure", "cleanup_failure"] as const) {
  it.effect(
    `ProviderSessionManagerV2 preserves shared credentials during overlapping cleanup with ${cleanupOutcome}`,
    () =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        const mcpConfigs = yield* Ref.make<
          ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
        >([]);
        const closeGates = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
        const closeEntered = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
        const closes = yield* Ref.make(0);
        yield* Effect.gen(function* () {
          const manager = yield* ProviderSessionManagerV2;
          const registry = yield* McpSessionRegistry.McpSessionRegistry;
          const threadId = ThreadId.make(`thread-pending-peer-${cleanupOutcome}`);
          const { allocate, open } = yield* makeThreadSessionFixture(threadId);
          const first = yield* allocate;
          const second = yield* allocate;
          yield* open(first);
          yield* open(second);
          const configs = yield* Ref.get(mcpConfigs);
          assert.equal(configs[0]?.authorizationHeader, configs[1]?.authorizationHeader);
          const token = configs[0]!.authorizationHeader.replace(/^Bearer\s+/, "");
          const firstClose = yield* manager.close(first).pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(closeEntered[0]!);
          const secondClose = yield* manager.close(second).pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(closeEntered[1]!);
          // The second cleanup can finish while the first still holds the shared token.
          yield* Deferred.succeed(closeGates[1]!, undefined);
          assert.equal(
            (yield* Fiber.join(secondClose))._tag,
            cleanupOutcome === "persistence_failure" ? "Failure" : "Success",
          );
          assert.equal((yield* Ref.get(state)).closeCount, 1);
          assert.isDefined(yield* registry.resolve(token));
          yield* Deferred.succeed(closeGates[0]!, undefined);
          assert.equal(
            (yield* Fiber.join(firstClose))._tag,
            cleanupOutcome === "success" ? "Success" : "Failure",
          );
          assert.equal((yield* Ref.get(state)).closeCount, 2);
          assert.isUndefined(yield* registry.resolve(token));
        }).pipe(
          Effect.ensuring(
            Effect.forEach(closeGates, (gate) => Deferred.succeed(gate, undefined), {
              discard: true,
            }),
          ),
          Effect.provide(
            makeTestLayer({
              state,
              mcpConfigs,
              failReleaseEventWrites: cleanupOutcome === "persistence_failure",
              idleTimeoutMs: 3_600_000,
              beforeClose: Ref.getAndUpdate(closes, (n) => n + 1).pipe(
                Effect.flatMap((n) =>
                  Deferred.succeed(closeEntered[n]!, undefined).pipe(
                    Effect.andThen(Deferred.await(closeGates[n]!)),
                    Effect.andThen(
                      n === 0 && cleanupOutcome === "cleanup_failure"
                        ? Effect.die("cleanup failed")
                        : Effect.void,
                    ),
                  ),
                ),
              ),
            }),
          ),
        );
      }),
  );
}

it.effect(
  "ProviderSessionManagerV2 queued opens recheck the pending cleanup after taking the lock",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const openEntered = yield* Deferred.make<void>();
      const openGate = yield* Deferred.make<void>();
      const closeEntered = yield* Deferred.make<void>();
      const closeGate = yield* Deferred.make<void>();
      const opens = yield* Ref.make(0);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const threadId = ThreadId.make("edge-queued-open");
        const { allocate, open } = yield* makeThreadSessionFixture(threadId);
        const first = yield* allocate;
        const second = yield* allocate;
        const third = yield* allocate;
        yield* open(first);
        const secondOpen = yield* open(second).pipe(Effect.forkChild);
        yield* Deferred.await(openEntered);
        const queuedOpen = yield* open(third).pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("0 seconds");
        const closing = yield* manager.close(first).pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        assert.equal((yield* Fiber.join(closing))._tag, "Failure");
        yield* Deferred.succeed(openGate, undefined);
        yield* Fiber.join(secondOpen);
        assert.equal((yield* Fiber.join(queuedOpen))._tag, "Failure");
        yield* Deferred.await(closeEntered);
        assert.equal((yield* Ref.get(state)).openCount, 2);
        yield* Deferred.succeed(closeGate, undefined);
        yield* manager.close(first);
        yield* open(third);
        assert.equal((yield* Ref.get(state)).openCount, 3);
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(openGate, undefined).pipe(
            Effect.andThen(Deferred.succeed(closeGate, undefined)),
          ),
        ),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            beforeOpen: () =>
              Ref.getAndUpdate(opens, (n) => n + 1).pipe(
                Effect.flatMap((n) =>
                  n === 1
                    ? Deferred.succeed(openEntered, undefined).pipe(
                        Effect.andThen(Deferred.await(openGate)),
                      )
                    : Effect.void,
                ),
              ),
            beforeClose: Deferred.succeed(closeEntered, undefined).pipe(
              Effect.andThen(Deferred.await(closeGate)),
            ),
          }),
        ),
      );
    }),
);

for (const credentialKind of ["fresh", "reused"] as const) {
  it.effect(
    `ProviderSessionManagerV2 rejects a closing session attachment with a ${credentialKind} credential`,
    () =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        const preparing = yield* Deferred.make<void>();
        const prepareGate = yield* Deferred.make<void>();
        const pauseSettings = yield* Ref.make(false);
        const issuedCredentials = yield* Ref.make<
          ReadonlyArray<McpProviderSession.McpProviderSessionConfig>
        >([]);
        const mcpRegistryLayer = Layer.effect(
          McpSessionRegistry.McpSessionRegistry,
          Effect.gen(function* () {
            const delegate = yield* McpSessionRegistry.McpSessionRegistry;
            return McpSessionRegistry.McpSessionRegistry.of({
              ...delegate,
              issue: (input) =>
                delegate
                  .issue(input)
                  .pipe(
                    Effect.tap((issued) =>
                      Ref.update(issuedCredentials, (configs) => [...configs, issued.config]),
                    ),
                  ),
            });
          }),
        ).pipe(Layer.provide(TestMcpRegistryLayer));
        const settingsLayer = Layer.effect(
          ServerSettings.ServerSettingsService,
          Effect.gen(function* () {
            const delegate = yield* ServerSettings.ServerSettingsService;
            return ServerSettings.ServerSettingsService.of({
              ...delegate,
              getSettings: Ref.get(pauseSettings).pipe(
                Effect.flatMap((pause) =>
                  pause
                    ? Deferred.succeed(preparing, undefined).pipe(
                        Effect.andThen(Deferred.await(prepareGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.getSettings),
              ),
            });
          }),
        ).pipe(Layer.provide(ServerSettings.layerTest({ enableAgentBrowserAccess: true })));
        yield* Effect.gen(function* () {
          const manager = yield* ProviderSessionManagerV2;
          const registry = yield* McpSessionRegistry.McpSessionRegistry;
          const firstThread = ThreadId.make(`thread-attach-first-${credentialKind}`);
          const attachingThread = ThreadId.make(`thread-attach-second-${credentialKind}`);
          const first = yield* makeThreadSessionFixture(firstThread);
          const peer = yield* makeThreadSessionFixture(attachingThread);
          const providerSessionId = yield* first.allocate;
          yield* first.open(providerSessionId);
          const peerId = yield* peer.allocate;
          if (credentialKind === "reused") yield* peer.open(peerId);
          const peerCredential = McpProviderSession.readMcpProviderSession(attachingThread);
          yield* Ref.set(pauseSettings, true);
          const attaching = yield* peer
            .open(providerSessionId)
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(preparing);
          const closing = yield* manager
            .close(providerSessionId)
            .pipe(Effect.result, Effect.forkChild);
          yield* TestClock.adjust("30 seconds");
          assert.equal((yield* Fiber.join(closing))._tag, "Failure");
          yield* Deferred.succeed(prepareGate, undefined);
          assert.equal((yield* Fiber.join(attaching))._tag, "Failure");
          yield* manager.close(providerSessionId);
          assert.equal((yield* Ref.get(state)).closeCount, 1);
          if (credentialKind === "reused") {
            assert.isDefined(peerCredential);
            const token = peerCredential!.authorizationHeader.replace(/^Bearer\s+/, "");
            assert.isDefined(yield* registry.resolve(token));
            yield* manager.close(peerId);
            assert.isUndefined(yield* registry.resolve(token));
          }
          const issued = (yield* Ref.get(issuedCredentials)).find(
            (config) => config.threadId === attachingThread,
          );
          assert.isDefined(issued);
          assert.isUndefined(
            yield* registry.resolve(issued!.authorizationHeader.replace(/^Bearer\s+/, "")),
          );
          assert.isUndefined(McpProviderSession.readMcpProviderSession(attachingThread));
        }).pipe(
          Effect.ensuring(Deferred.succeed(prepareGate, undefined)),
          Effect.provide(
            makeTestLayer({
              state,
              idleTimeoutMs: 3_600_000,
              serverSettingsLayer: settingsLayer,
              mcpRegistryLayer,
            }),
          ),
        );
      }),
  );
}

it.effect("ProviderSessionManagerV2 detach joins a cleanup that started mid-detach", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const interruptEntered = yield* Deferred.make<void>();
    const interruptGate = yield* Deferred.make<void>();
    const closeEntered = yield* Deferred.make<void>();
    const closeGate = yield* Deferred.make<void>();
    const detachReturned = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManagerV2;
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const now = yield* DateTime.now;
      const firstThreadId = ThreadId.make("thread-detach-race-first");
      const secondThreadId = ThreadId.make("thread-detach-race-second");
      const first = yield* makeThreadSessionFixture(firstThreadId);
      const second = yield* makeThreadSessionFixture(secondThreadId);
      const providerSessionId = yield* first.allocate;
      const providerThread = makeProviderThread({
        idAllocator,
        threadId: firstThreadId,
        providerSessionId,
        now,
      });
      const runId = idAllocator.derive.run({ threadId: firstThreadId, ordinal: 1 });
      yield* eventSink.write({
        events: [
          {
            id: yield* idAllocator.allocate.event({ threadId: firstThreadId }),
            type: "provider-thread.updated",
            threadId: firstThreadId,
            driver: CODEX_DRIVER,
            occurredAt: now,
            payload: providerThread,
          },
          {
            id: yield* idAllocator.allocate.event({ threadId: firstThreadId }),
            type: "provider-turn.updated",
            threadId: firstThreadId,
            runId,
            driver: CODEX_DRIVER,
            occurredAt: now,
            payload: {
              id: idAllocator.derive.providerTurn({
                driver: CODEX_DRIVER,
                nativeTurnId: "native-turn-detach-race",
              }),
              providerThreadId: providerThread.id,
              nodeId: idAllocator.derive.rootNode({ runId }),
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
      yield* first.open(providerSessionId);
      yield* second.open(providerSessionId);

      // Detach parks inside interruptTurn on the shared session; close wins
      // the race to `releasing` while detach is still in its async window.
      const detaching = yield* manager.detach({ providerSessionId, threadId: firstThreadId }).pipe(
        Effect.tap(() => Deferred.succeed(detachReturned, undefined)),
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(interruptEntered);
      const closing = yield* manager.close(providerSessionId).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(closeEntered);

      yield* Deferred.succeed(interruptGate, undefined);
      for (let i = 0; i < 10; i += 1) {
        yield* Effect.yieldNow;
      }
      assert.equal((yield* Ref.get(state)).interruptCount, 1);
      // The losing detach joined the pending cleanup instead of reporting
      // success over still-running work.
      assert.isFalse(yield* Deferred.isDone(detachReturned));

      // The join has the same timeout as any cleanup waiter: while the
      // finalizer stays gated, detach fails rather than returning early.
      yield* TestClock.adjust("30 seconds");
      assert.equal((yield* Fiber.join(detaching))._tag, "Failure");
      assert.equal((yield* Fiber.join(closing))._tag, "Failure");

      yield* Deferred.succeed(closeGate, undefined);
      yield* manager.close(providerSessionId);
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    }).pipe(
      Effect.ensuring(
        Deferred.succeed(interruptGate, undefined).pipe(
          Effect.andThen(Deferred.succeed(closeGate, undefined)),
        ),
      ),
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 3_600_000,
          beforeInterrupt: Deferred.succeed(interruptEntered, undefined).pipe(
            Effect.andThen(Deferred.await(interruptGate)),
          ),
          beforeClose: Deferred.succeed(closeEntered, undefined).pipe(
            Effect.andThen(Deferred.await(closeGate)),
          ),
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 blocks runtime thread attachments while a peer cleanup is pending",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const closeEntered = yield* Deferred.make<void>();
      const closeGate = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const threadId = ThreadId.make("thread-runtime-attach-blocked");
        const peerThreadId = ThreadId.make("thread-runtime-attach-peer");
        const first = yield* makeThreadSessionFixture(threadId);
        const peer = yield* makeThreadSessionFixture(peerThreadId);
        const firstId = yield* first.allocate;
        const peerId = yield* peer.allocate;
        yield* first.open(firstId);
        const peerRuntime = yield* peer.open(peerId);
        const closing = yield* manager.close(firstId).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(closeEntered);

        // Attaching the closing session's thread through a live peer runtime
        // must fail like a blocked `open`, not slip past `observeActivity`.
        const error = yield* peerRuntime
          .ensureThread({ threadId, modelSelection, runtimePolicy })
          .pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterProtocolError");
        assert.include(
          error._tag === "ProviderAdapterProtocolError" ? error.detail : "",
          "not finished cleanup",
        );

        yield* Deferred.succeed(closeGate, undefined);
        assert.equal((yield* Fiber.join(closing))._tag, "Success");
      }).pipe(
        Effect.ensuring(Deferred.succeed(closeGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            beforeClose: Deferred.succeed(closeEntered, undefined).pipe(
              Effect.andThen(Deferred.await(closeGate)),
            ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a busy peer busy when a blocked startTurn is rejected",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const closeEntered = yield* Deferred.make<void>();
      const closeGate = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const idAllocator = yield* IdAllocatorV2;
        const projectionStore = yield* ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-busy-peer-blocked");
        const peerThreadId = ThreadId.make("thread-busy-peer");
        const first = yield* makeThreadSessionFixture(threadId);
        const peer = yield* makeThreadSessionFixture(peerThreadId);
        const firstId = yield* first.allocate;
        const peerId = yield* peer.allocate;
        yield* first.open(firstId);
        const peerRuntime = yield* peer.open(peerId);
        yield* peerRuntime.events.pipe(Stream.runDrain, Effect.forkScoped);
        const peerProviderThread = makeProviderThread({
          idAllocator,
          threadId: peerThreadId,
          providerSessionId: peerId,
          now,
        });
        const peerAppThread = (yield* projectionStore.getThreadProjection(peerThreadId)).thread;
        const peerRunId = idAllocator.derive.run({ threadId: peerThreadId, ordinal: 1 });

        // The peer turn never terminates, so the session must stay busy and
        // ineligible for idle release.
        yield* peerRuntime.startTurn({
          appThread: peerAppThread,
          threadId: peerThreadId,
          runId: peerRunId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: idAllocator.derive.runAttempt({ runId: peerRunId, attemptOrdinal: 1 }),
          rootNodeId: idAllocator.derive.rootNode({ runId: peerRunId }),
          providerThread: peerProviderThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({ threadId: peerThreadId, ordinal: 1 }),
            text: "keep me busy",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });

        const closing = yield* manager.close(firstId).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(closeEntered);

        const blockedRunId = idAllocator.derive.run({ threadId, ordinal: 1 });
        const error = yield* peerRuntime
          .startTurn({
            appThread: peerAppThread,
            threadId,
            runId: blockedRunId,
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: idAllocator.derive.runAttempt({ runId: blockedRunId, attemptOrdinal: 1 }),
            rootNodeId: idAllocator.derive.rootNode({ runId: blockedRunId }),
            providerThread: makeProviderThread({
              idAllocator,
              threadId,
              providerSessionId: firstId,
              now,
            }),
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
              text: "blocked",
              attachments: [],
            },
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterProtocolError");

        yield* Deferred.succeed(closeGate, undefined);
        assert.equal((yield* Fiber.join(closing))._tag, "Success");
        assert.equal((yield* Ref.get(state)).closeCount, 1);

        // A rejected attachment must not run the busy/idle pipeline: if it
        // decremented the peer's busy count, the idle release scheduled past
        // this point would close the peer mid-turn.
        yield* TestClock.adjust("2 seconds");
        yield* Effect.yieldNow;
        assert.isTrue(Option.isSome(yield* manager.get(peerId)));
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      }).pipe(
        Effect.ensuring(Deferred.succeed(closeGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            beforeClose: Deferred.succeed(closeEntered, undefined).pipe(
              Effect.andThen(Deferred.await(closeGate)),
            ),
          }),
        ),
      );
    }),
);
it.effect("ProviderSessionManagerV2 rejects runtime thread attachments on a released session", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManagerV2;
      const threadId = ThreadId.make("thread-released-attach");
      const otherThreadId = ThreadId.make("thread-released-attach-other");
      const { allocate, open } = yield* makeThreadSessionFixture(threadId);
      const providerSessionId = yield* allocate;
      const runtime = yield* open(providerSessionId);
      yield* manager.close(providerSessionId);
      assert.equal((yield* Ref.get(state)).closeCount, 1);

      // The session entry is gone and cleanup finished: a stale runtime
      // must not hand work to the released provider process.
      const error = yield* runtime
        .ensureThread({ threadId: otherThreadId, modelSelection, runtimePolicy })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterProtocolError");
      assert.include(
        error._tag === "ProviderAdapterProtocolError" ? error.detail : "",
        "no longer running",
      );
    }).pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 3_600_000 })));
  }),
);

it.effect(
  "ProviderSessionManagerV2 rejects a runtime attachment whose session closed mid-prepare",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const preparing = yield* Deferred.make<void>();
      const prepareGate = yield* Deferred.make<void>();
      const pauseSettings = yield* Ref.make(false);
      const issuedCredentials = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig>
      >([]);
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            issue: (input) =>
              delegate
                .issue(input)
                .pipe(
                  Effect.tap((issued) =>
                    Ref.update(issuedCredentials, (configs) => [...configs, issued.config]),
                  ),
                ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));
      const settingsLayer = Layer.effect(
        ServerSettings.ServerSettingsService,
        Effect.gen(function* () {
          const delegate = yield* ServerSettings.ServerSettingsService;
          return ServerSettings.ServerSettingsService.of({
            ...delegate,
            getSettings: Ref.get(pauseSettings).pipe(
              Effect.flatMap((pause) =>
                pause
                  ? Deferred.succeed(preparing, undefined).pipe(
                      Effect.andThen(Deferred.await(prepareGate)),
                    )
                  : Effect.void,
              ),
              Effect.andThen(delegate.getSettings),
            ),
          });
        }),
      ).pipe(Layer.provide(ServerSettings.layerTest({ enableAgentBrowserAccess: true })));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const threadId = ThreadId.make("thread-runtime-prepare-close-owner");
        const attachingThreadId = ThreadId.make("thread-runtime-prepare-close");
        const first = yield* makeThreadSessionFixture(threadId);
        yield* makeThreadSessionFixture(attachingThreadId);
        const providerSessionId = yield* first.allocate;
        const runtime = yield* first.open(providerSessionId);
        yield* Ref.set(pauseSettings, true);
        // The attach records, then suspends inside prepareMcpSession. The
        // adapter's ensureThread is unimplemented and dies if reached, so a
        // clean ProviderAdapterProtocolError proves it was never called.
        const attaching = yield* runtime
          .ensureThread({ threadId: attachingThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(preparing);
        yield* manager.close(providerSessionId);
        assert.equal((yield* Ref.get(state)).closeCount, 1);
        yield* Deferred.succeed(prepareGate, undefined);
        const error = yield* Fiber.join(attaching);
        assert.equal(error._tag, "ProviderAdapterProtocolError");
        assert.include(
          error._tag === "ProviderAdapterProtocolError" ? error.detail : "",
          "no longer running",
        );
        const issued = (yield* Ref.get(issuedCredentials)).find(
          (config) => config.threadId === attachingThreadId,
        );
        assert.isDefined(issued);
        assert.isUndefined(
          yield* registry.resolve(issued!.authorizationHeader.replace(/^Bearer\s+/, "")),
        );
        assert.isUndefined(McpProviderSession.readMcpProviderSession(attachingThreadId));
      }).pipe(
        Effect.ensuring(Deferred.succeed(prepareGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            serverSettingsLayer: settingsLayer,
            mcpRegistryLayer,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 waits for an in-flight runtime ensureThread before closing the session scope",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const adapterEntered = yield* Deferred.make<void>();
      const adapterRelease = yield* Deferred.make<void>();
      const sessionIdSlot = yield* Ref.make<ProviderSessionId | undefined>(undefined);
      const allocatorSlot = yield* Ref.make<IdAllocatorV2Shape | undefined>(undefined);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        yield* Ref.set(allocatorSlot, yield* IdAllocatorV2);
        const threadId = ThreadId.make("thread-ensure-drain-owner");
        const attachingThreadId = ThreadId.make("thread-ensure-drain");
        const { allocate, open } = yield* makeThreadSessionFixture(threadId);
        yield* makeThreadSessionFixture(attachingThreadId);
        const providerSessionId = yield* allocate;
        yield* Ref.set(sessionIdSlot, providerSessionId);
        const runtime = yield* open(providerSessionId);
        // The adapter call is parked mid-flight after passing the ownership
        // recheck — the window where a resource-creating operation (Cursor's
        // awaited runner.open) has not yet installed its result.
        const ensuring = yield* runtime
          .ensureThread({ threadId: attachingThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.forkChild);
        yield* Deferred.await(adapterEntered);
        const closing = yield* manager.close(providerSessionId).pipe(Effect.forkChild);
        // The release must drain the admitted adapter operation before the
        // session scope closes: no resource may be installed after the
        // finalizer that would have closed it. Give the close fiber enough
        // turns to reach its park point — under the fix it stays parked on
        // the attach lock the in-flight ensureThread holds.
        for (let round = 0; round < 64 && closing.pollUnsafe() === undefined; round++) {
          yield* Effect.yieldNow;
        }
        const closedEarly = closing.pollUnsafe();
        const closesWhileParked = (yield* Ref.get(state)).closeCount;
        yield* Deferred.succeed(adapterRelease, undefined);
        const ensuredExit = yield* Fiber.await(ensuring);
        const closingExit = yield* Fiber.join(closing);
        assert.isUndefined(closedEarly);
        assert.equal(closesWhileParked, 0);
        assert.isTrue(Exit.isSuccess(ensuredExit));
        assert.equal(closingExit, undefined);
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      }).pipe(
        Effect.ensuring(Deferred.succeed(adapterRelease, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            ensureThread: (threadInput) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(adapterEntered, undefined);
                yield* Deferred.await(adapterRelease);
                return makeProviderThread({
                  idAllocator: (yield* Ref.get(allocatorSlot))!,
                  threadId: threadInput.threadId,
                  providerSessionId: (yield* Ref.get(sessionIdSlot))!,
                  now: yield* DateTime.now,
                });
              }),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 bounds the adapter-op drain for a long-lived turn call", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const turnEntered = yield* Deferred.make<void>();
    const turnGate = yield* Deferred.make<void>();
    const closes = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManagerV2;
      const idAllocator = yield* IdAllocatorV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-drain-bound");
      const first = yield* makeThreadSessionFixture(threadId);
      const providerSessionId = yield* first.allocate;
      const firstRuntime = yield* first.open(providerSessionId);
      yield* firstRuntime.events.pipe(Stream.runDrain, Effect.forkScoped);
      const providerThread = makeProviderThread({
        idAllocator,
        threadId,
        providerSessionId,
        now,
      });
      const appThread = (yield* projectionStore.getThreadProjection(threadId)).thread;
      const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
      // The admitted turn op parks inside the adapter call — the OpenCode
      // shape where the whole operation (session.summarize) runs inside the
      // call rather than being forked into the session scope. The fixture
      // reports the opencode driver so the in-band drain bound applies.
      const turn = yield* firstRuntime
        .startTurn({
          appThread,
          threadId,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
          rootNodeId: idAllocator.derive.rootNode({ runId }),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
            text: "long lived",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(turnEntered);
      const closing = yield* manager.close(providerSessionId).pipe(Effect.exit, Effect.forkChild);
      for (let i = 0; i < 16; i += 1) yield* Effect.yieldNow;
      // The drain waits on the admitted op, but only up to its bound: a
      // long-lived turn call must not wedge the release.
      assert.isUndefined(closing.pollUnsafe());
      yield* TestClock.adjust("19 seconds");
      for (let i = 0; i < 8; i += 1) yield* Effect.yieldNow;
      assert.isUndefined(closing.pollUnsafe());
      yield* TestClock.adjust("2 seconds");
      for (let i = 0; i < 16; i += 1) yield* Effect.yieldNow;
      const closeExit = closing.pollUnsafe();
      assert.isDefined(closeExit);
      assert.isTrue(
        closeExit !== undefined && Exit.isSuccess(closeExit) && Exit.isSuccess(closeExit.value),
      );
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal(yield* Ref.get(closes), 1);
      // The abandoned op is still parked — its uninterruptible acquisition
      // outlives the scope close and settles honestly when released.
      assert.isUndefined(turn.pollUnsafe());
      yield* Deferred.succeed(turnGate, undefined);
      yield* Fiber.await(turn);
    }).pipe(
      Effect.ensuring(Deferred.succeed(turnGate, undefined)),
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 3_600_000,
          driver: ProviderDriverKind.make("opencode"),
          beforeClose: Ref.getAndUpdate(closes, (n) => n + 1),
          startTurn: () =>
            Deferred.succeed(turnEntered, undefined).pipe(Effect.andThen(Deferred.await(turnGate))),
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 does not serialize a replacement behind an abandoned in-band call's attach lock",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const turnEntered = yield* Deferred.make<void>();
      const turnGate = yield* Deferred.make<void>();
      const secondTurnEntered = yield* Deferred.make<void>();
      const closes = yield* Ref.make(0);
      const startTurnCalls = yield* Ref.make(0);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const idAllocator = yield* IdAllocatorV2;
        const projectionStore = yield* ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-drain-lock");
        const first = yield* makeThreadSessionFixture(threadId);
        const providerSessionId = yield* first.allocate;
        const firstRuntime = yield* first.open(providerSessionId);
        yield* firstRuntime.events.pipe(Stream.runDrain, Effect.forkScoped);
        const appThread = (yield* projectionStore.getThreadProjection(threadId)).thread;
        const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
        // The first turn call parks inside the adapter (in-band OpenCode
        // shape) still holding its runtime's attach lock.
        const turn = yield* firstRuntime
          .startTurn({
            appThread,
            threadId,
            runId,
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
            rootNodeId: idAllocator.derive.rootNode({ runId }),
            providerThread: makeProviderThread({
              idAllocator,
              threadId,
              providerSessionId,
              now,
            }),
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
              text: "long lived",
              attachments: [],
            },
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(turnEntered);
        const closing = yield* manager.close(providerSessionId).pipe(Effect.exit, Effect.forkChild);
        yield* TestClock.adjust("25 seconds");
        for (let i = 0; i < 16; i += 1) yield* Effect.yieldNow;
        const closeExit = closing.pollUnsafe();
        assert.isDefined(closeExit);
        assert.isTrue(
          closeExit !== undefined && Exit.isSuccess(closeExit) && Exit.isSuccess(closeExit.value),
        );
        // The abandoned call still holds its lock, but a same-id reopen
        // installs a new runtime — the replacement's turn on the same
        // thread must not wait behind a lock the dead runtime may never
        // release.
        const replacementRuntime = yield* first.open(providerSessionId);
        yield* replacementRuntime.events.pipe(Stream.runDrain, Effect.forkScoped);
        const secondRunId = idAllocator.derive.run({ threadId, ordinal: 2 });
        const secondTurn = yield* replacementRuntime
          .startTurn({
            appThread,
            threadId,
            runId: secondRunId,
            runOrdinal: 2,
            providerTurnOrdinal: 2,
            attemptId: idAllocator.derive.runAttempt({
              runId: secondRunId,
              attemptOrdinal: 1,
            }),
            rootNodeId: idAllocator.derive.rootNode({ runId: secondRunId }),
            providerThread: makeProviderThread({
              idAllocator,
              threadId,
              providerSessionId,
              now,
            }),
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 2 }),
              text: "replacement turn",
              attachments: [],
            },
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.forkChild);
        for (let i = 0; i < 24; i += 1) yield* Effect.yieldNow;
        yield* Deferred.await(secondTurnEntered);
        yield* Fiber.await(secondTurn);
        // The original abandoned call is still parked and settles honestly
        // once released.
        assert.isUndefined(turn.pollUnsafe());
        yield* Deferred.succeed(turnGate, undefined);
        yield* Fiber.await(turn);
      }).pipe(
        Effect.ensuring(Deferred.succeed(turnGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            driver: ProviderDriverKind.make("opencode"),
            beforeClose: Ref.getAndUpdate(closes, (n) => n + 1),
            startTurn: () =>
              Ref.getAndUpdate(startTurnCalls, (n) => n + 1).pipe(
                Effect.flatMap((n) =>
                  n === 0
                    ? Deferred.succeed(turnEntered, undefined).pipe(
                        Effect.andThen(Deferred.await(turnGate)),
                      )
                    : Deferred.succeed(secondTurnEntered, undefined),
                ),
              ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 does not abandon an acquire-then-return turn call at the drain bound",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const turnEntered = yield* Deferred.make<void>();
      const turnGate = yield* Deferred.make<void>();
      const closes = yield* Ref.make(0);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const idAllocator = yield* IdAllocatorV2;
        const projectionStore = yield* ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-drain-acquire");
        const first = yield* makeThreadSessionFixture(threadId);
        const providerSessionId = yield* first.allocate;
        const firstRuntime = yield* first.open(providerSessionId);
        yield* firstRuntime.events.pipe(Stream.runDrain, Effect.forkScoped);
        const providerThread = makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now,
        });
        const appThread = (yield* projectionStore.getThreadProjection(threadId)).thread;
        const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
        // Same parked-call shape as the bounded test, but on a driver whose
        // turn call is acquire-then-return (Cursor's runner.open window):
        // abandoning it would let the acquisition install a resource after
        // the scope close has finished checking for one.
        const turn = yield* firstRuntime
          .startTurn({
            appThread,
            threadId,
            runId,
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
            rootNodeId: idAllocator.derive.rootNode({ runId }),
            providerThread,
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
              text: "acquiring",
              attachments: [],
            },
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(turnEntered);
        const closing = yield* manager.close(providerSessionId).pipe(Effect.exit, Effect.forkChild);
        for (let i = 0; i < 16; i += 1) yield* Effect.yieldNow;
        assert.isUndefined(closing.pollUnsafe());
        // Past the in-band drain bound: an acquire-then-return call is never
        // abandoned, so the release is still holding the scope open.
        yield* TestClock.adjust("25 seconds");
        for (let i = 0; i < 16; i += 1) yield* Effect.yieldNow;
        assert.isUndefined(closing.pollUnsafe());
        assert.equal(yield* Ref.get(closes), 0);
        // The caller's own wait is bounded — close reports the cleanup
        // timeout — but the detached worker still owns the session: the
        // scope close has not run and a same-id replacement is refused.
        yield* TestClock.adjust("40 seconds");
        for (let i = 0; i < 16; i += 1) yield* Effect.yieldNow;
        const closeExit = closing.pollUnsafe();
        assert.isDefined(closeExit);
        assert.isTrue(
          closeExit !== undefined && Exit.isSuccess(closeExit) && Exit.isFailure(closeExit.value),
        );
        assert.equal(yield* Ref.get(closes), 0);
        assert.isTrue(Exit.isFailure(yield* first.open(providerSessionId).pipe(Effect.exit)));
        // Once the acquisition settles, the drain completes and cleanup
        // finishes honestly after the caller's bounded wait — the scope
        // close runs and a same-id replacement can open.
        yield* Deferred.succeed(turnGate, undefined);
        yield* Fiber.await(turn);
        for (let i = 0; i < 24; i += 1) yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(closes), 1);
        const replacement = yield* first.open(providerSessionId);
        yield* replacement.events.pipe(Stream.runDrain, Effect.forkScoped);
      }).pipe(
        Effect.ensuring(Deferred.succeed(turnGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            beforeClose: Ref.getAndUpdate(closes, (n) => n + 1),
            startTurn: () =>
              Deferred.succeed(turnEntered, undefined).pipe(
                Effect.andThen(Deferred.await(turnGate)),
              ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 rejects a runtime attachment when its session is replaced mid-prepare",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const preparing = yield* Deferred.make<void>();
      const prepareGate = yield* Deferred.make<void>();
      const pauseSettings = yield* Ref.make(false);
      const issuedCredentials = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig>
      >([]);
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            issue: (input) =>
              delegate
                .issue(input)
                .pipe(
                  Effect.tap((issued) =>
                    Ref.update(issuedCredentials, (configs) => [...configs, issued.config]),
                  ),
                ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));
      const settingsLayer = Layer.effect(
        ServerSettings.ServerSettingsService,
        Effect.gen(function* () {
          const delegate = yield* ServerSettings.ServerSettingsService;
          return ServerSettings.ServerSettingsService.of({
            ...delegate,
            // Single-shot pause: the reopening open() must still read settings.
            getSettings: Ref.getAndSet(pauseSettings, false).pipe(
              Effect.flatMap((pause) =>
                pause
                  ? Deferred.succeed(preparing, undefined).pipe(
                      Effect.andThen(Deferred.await(prepareGate)),
                    )
                  : Effect.void,
              ),
              Effect.andThen(delegate.getSettings),
            ),
          });
        }),
      ).pipe(Layer.provide(ServerSettings.layerTest({ enableAgentBrowserAccess: true })));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const threadId = ThreadId.make("thread-runtime-replace-owner");
        const attachingThreadId = ThreadId.make("thread-runtime-replace-attach");
        const first = yield* makeThreadSessionFixture(threadId);
        yield* makeThreadSessionFixture(attachingThreadId);
        const providerSessionId = yield* first.allocate;
        const runtime = yield* first.open(providerSessionId);
        yield* Ref.set(pauseSettings, true);
        const attaching = yield* runtime
          .ensureThread({ threadId: attachingThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(preparing);
        yield* manager.close(providerSessionId);
        // Multi-thread providers derive a deterministic shared session id, so
        // a reopen legitimately reuses it. The replacement must not claim the
        // suspended attachment.
        yield* first.open(providerSessionId);
        yield* Deferred.succeed(prepareGate, undefined);
        const error = yield* Fiber.join(attaching);
        assert.equal(error._tag, "ProviderAdapterProtocolError");
        assert.include(
          error._tag === "ProviderAdapterProtocolError" ? error.detail : "",
          "no longer running",
        );
        const issued = (yield* Ref.get(issuedCredentials)).find(
          (config) => config.threadId === attachingThreadId,
        );
        assert.isDefined(issued);
        assert.isUndefined(
          yield* registry.resolve(issued!.authorizationHeader.replace(/^Bearer\s+/, "")),
        );
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      }).pipe(
        Effect.ensuring(Deferred.succeed(prepareGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            serverSettingsLayer: settingsLayer,
            mcpRegistryLayer,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 revokes an abandoned reused credential when the last holder closes",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const resolving = yield* Deferred.make<void>();
      const resolveGate = yield* Deferred.make<void>();
      const pauseResolve = yield* Ref.make(false);
      const issuedCredentials = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig>
      >([]);
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            issue: (input) =>
              delegate
                .issue(input)
                .pipe(
                  Effect.tap((issued) =>
                    Ref.update(issuedCredentials, (configs) => [...configs, issued.config]),
                  ),
                ),
            resolve: (token) =>
              Ref.get(pauseResolve).pipe(
                Effect.flatMap((pause) =>
                  pause
                    ? Deferred.succeed(resolving, undefined).pipe(
                        Effect.andThen(Deferred.await(resolveGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.resolve(token)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const ownerThreadId = ThreadId.make("thread-abandoned-reused-owner");
        const attachingThreadId = ThreadId.make("thread-abandoned-reused-peer");
        const owner = yield* makeThreadSessionFixture(ownerThreadId);
        const peer = yield* makeThreadSessionFixture(attachingThreadId);
        const peerId = yield* peer.allocate;
        yield* peer.open(peerId);
        const peerCredential = McpProviderSession.readMcpProviderSession(attachingThreadId);
        assert.isDefined(peerCredential);
        const ownerId = yield* owner.allocate;
        const runtime = yield* owner.open(ownerId);
        yield* Ref.set(pauseResolve, true);
        // The attach reuses the peer's credential, reserves it, then suspends
        // on resolve. Closing both sessions leaves the credential owned only
        // by that reservation; abandoning the attach must revoke it.
        const attaching = yield* runtime
          .ensureThread({ threadId: attachingThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(resolving);
        // The closes' credential sweeps park on the prepare lock the gated
        // attach still holds; fork them so the gate can be released.
        const peerClosing = yield* manager.close(peerId).pipe(Effect.forkChild);
        const ownerClosing = yield* manager.close(ownerId).pipe(Effect.forkChild);
        yield* Effect.forEach(Array.from({ length: 8 }), () => Effect.yieldNow, {
          discard: true,
        });
        assert.equal((yield* Ref.get(state)).closeCount, 2);
        yield* Deferred.succeed(resolveGate, undefined);
        const error = yield* Fiber.join(attaching);
        assert.equal(error._tag, "ProviderAdapterProtocolError");
        yield* Fiber.join(peerClosing);
        yield* Fiber.join(ownerClosing);
        const token = peerCredential!.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isUndefined(yield* registry.resolve(token));
        assert.isUndefined(McpProviderSession.readMcpProviderSession(attachingThreadId));
      }).pipe(
        Effect.ensuring(Deferred.succeed(resolveGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpRegistryLayer,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 revokes a reused credential when resolution is interrupted after the last holder closed",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const resolving = yield* Deferred.make<void>();
      const resolveGate = yield* Deferred.make<void>();
      const pauseResolve = yield* Ref.make(false);
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            resolve: (token) =>
              Ref.get(pauseResolve).pipe(
                Effect.flatMap((pause) =>
                  pause
                    ? Deferred.succeed(resolving, undefined).pipe(
                        Effect.andThen(Deferred.await(resolveGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.resolve(token)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const ownerThreadId = ThreadId.make("thread-failed-resolve-owner");
        const attachingThreadId = ThreadId.make("thread-failed-resolve-peer");
        const owner = yield* makeThreadSessionFixture(ownerThreadId);
        const peer = yield* makeThreadSessionFixture(attachingThreadId);
        const peerId = yield* peer.allocate;
        yield* peer.open(peerId);
        const peerCredential = McpProviderSession.readMcpProviderSession(attachingThreadId);
        assert.isDefined(peerCredential);
        const ownerId = yield* owner.allocate;
        const runtime = yield* owner.open(ownerId);
        yield* Ref.set(pauseResolve, true);
        // The attach reserves the peer's credential, then suspends inside the
        // resolve. Closing the credential holder leaves the reservation plus
        // the attaching session's provisional thread attachment as the only
        // claims; interrupting the attach must unwind the provisional
        // attachment and not leave the credential valid and unclaimed once
        // the attaching session closes too.
        const attaching = yield* runtime
          .ensureThread({ threadId: attachingThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(resolving);
        // The close's credential sweep parks on the prepare lock the gated
        // attach still holds; fork it so the interrupt can unwind the attach.
        const peerClosing = yield* manager.close(peerId).pipe(Effect.forkChild);
        yield* Fiber.interrupt(attaching);
        const exit = yield* Fiber.await(attaching);
        const ownerClosing = yield* manager.close(ownerId).pipe(Effect.forkChild);
        yield* Fiber.join(peerClosing);
        yield* Fiber.join(ownerClosing);
        assert.equal((yield* Ref.get(state)).closeCount, 2);
        assert.equal(exit._tag, "Failure");
        yield* Ref.set(pauseResolve, false);
        const token = peerCredential!.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isUndefined(yield* registry.resolve(token));
        assert.isUndefined(McpProviderSession.readMcpProviderSession(attachingThreadId));
      }).pipe(
        Effect.ensuring(Deferred.succeed(resolveGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpRegistryLayer,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 rejects a stale runtime whose same-id session was replaced",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const ownerThreadId = ThreadId.make("thread-stale-runtime-owner");
        const attachingThreadId = ThreadId.make("thread-stale-runtime-attach");
        const owner = yield* makeThreadSessionFixture(ownerThreadId);
        const attaching = yield* makeThreadSessionFixture(attachingThreadId);
        const providerSessionId = yield* owner.allocate;
        const runtimeA = yield* owner.open(providerSessionId);
        yield* attaching.open(providerSessionId);
        yield* manager.close(providerSessionId);
        // Multi-thread providers derive a deterministic shared session id, so
        // the reopen legitimately reuses it and re-attaches the same thread.
        yield* owner.open(providerSessionId);
        yield* attaching.open(providerSessionId);
        // A's stale handle must not reach the dead adapter through B's
        // already-attached thread record.
        const error = yield* runtimeA
          .ensureThread({ threadId: attachingThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterProtocolError");
        assert.include(
          error._tag === "ProviderAdapterProtocolError" ? error.detail : "",
          "no longer running",
        );
        // Non-attach entry points reject the stale runtime too instead of
        // invoking the closed adapter.
        const idAllocator = yield* IdAllocatorV2;
        const interruptError = yield* runtimeA
          .interruptTurn({
            providerThread: makeProviderThread({
              idAllocator,
              threadId: attachingThreadId,
              providerSessionId,
              now: yield* DateTime.now,
            }),
            providerTurnId: idAllocator.derive.providerTurn({
              driver: CODEX_DRIVER,
              nativeTurnId: "stale-turn",
            }),
          })
          .pipe(Effect.flip);
        assert.equal(interruptError._tag, "ProviderAdapterProtocolError");
        assert.equal((yield* Ref.get(state)).interruptCount, 0);
        const providerThread = makeProviderThread({
          idAllocator,
          threadId: attachingThreadId,
          providerSessionId,
          now: yield* DateTime.now,
        });
        // The spread-through entry points (snapshot, rollback, null-app-thread
        // resume) reject the stale handle too — a clean protocol error proves
        // the closed adapter was never invoked.
        const snapshotError = yield* runtimeA
          .readThreadSnapshot({ providerThread })
          .pipe(Effect.flip);
        assert.equal(snapshotError._tag, "ProviderAdapterProtocolError");
        const orphanResumeError = yield* runtimeA
          .resumeThread({ providerThread: { ...providerThread, appThreadId: null } })
          .pipe(Effect.flip);
        assert.equal(orphanResumeError._tag, "ProviderAdapterProtocolError");
        assert.equal((yield* Ref.get(state)).resumeCount, 0);
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      }).pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 3_600_000 })));
    }),
);

it.effect(
  "ProviderSessionManagerV2 rejects a runtime attachment whose session closed mid-event-write",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const writing = yield* Deferred.make<void>();
      const writeGate = yield* Deferred.make<void>();
      const closeReached = yield* Deferred.make<void>();
      const pauseWrite = yield* Ref.make(false);
      const issuedCredentials = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig>
      >([]);
      const ownerThreadId = ThreadId.make("thread-event-write-owner");
      const attachingThreadId = ThreadId.make("thread-event-write-attach");
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            issue: (input) =>
              delegate
                .issue(input)
                .pipe(
                  Effect.tap((issued) =>
                    Ref.update(issuedCredentials, (configs) => [...configs, issued.config]),
                  ),
                ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));
      const writtenEventTypes = yield* Ref.make<
        ReadonlyArray<{ readonly threadId: string; readonly type: string }>
      >([]);
      const eventSinkLayer = Layer.effect(
        EventSinkV2,
        Effect.gen(function* () {
          const delegate = yield* EventSinkV2;
          return EventSinkV2.of({
            ...delegate,
            write: (input) =>
              Ref.get(pauseWrite).pipe(
                Effect.flatMap((pause) =>
                  pause &&
                  input.events.some(
                    (event) =>
                      event.type === "provider-session.attached" &&
                      event.threadId === attachingThreadId,
                  )
                    ? Deferred.succeed(writing, undefined).pipe(
                        Effect.andThen(Deferred.await(writeGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(
                  Ref.update(writtenEventTypes, (types) => [
                    ...types,
                    ...input.events.map((event) => ({
                      threadId: event.threadId,
                      type: event.type,
                    })),
                  ]),
                ),
                Effect.andThen(delegate.write(input)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestEventSinkLayer));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const owner = yield* makeThreadSessionFixture(ownerThreadId);
        yield* makeThreadSessionFixture(attachingThreadId);
        const providerSessionId = yield* owner.allocate;
        const runtime = yield* owner.open(providerSessionId);
        yield* Ref.set(pauseWrite, true);
        // The attach records the credential, then suspends persisting the
        // attachment event. The adapter's ensureThread is unimplemented and
        // dies if reached, so a clean error proves it was never called.
        const attaching = yield* runtime
          .ensureThread({ threadId: attachingThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(writing);
        // beforeClose runs inside scope cleanup, after the release claimed the
        // session: awaiting it here guarantees the post-write recheck observes
        // the pending release. The suspended attach write also holds the
        // release-status lock, so the close's terminal event report queues
        // behind it until the gate opens.
        const closing = yield* manager.close(providerSessionId).pipe(Effect.forkChild);
        yield* Deferred.await(closeReached);
        yield* Deferred.succeed(writeGate, undefined);
        const error = yield* Fiber.join(attaching);
        assert.equal(error._tag, "ProviderAdapterProtocolError");
        assert.match(
          error._tag === "ProviderAdapterProtocolError" ? error.detail : "",
          /not finished cleanup|no longer running/,
        );
        yield* Fiber.join(closing);
        assert.equal((yield* Ref.get(state)).closeCount, 1);
        // The gated attach event still lands strictly before the release's
        // terminal status write.
        const eventTypes = yield* Ref.get(writtenEventTypes);
        const attachedIndex = eventTypes.findIndex(
          (event) =>
            event.threadId === attachingThreadId && event.type === "provider-session.attached",
        );
        const releasedIndex = eventTypes.findIndex(
          (event) => event.type === "provider-session.updated",
        );
        assert.isAtLeast(attachedIndex, 0);
        assert.isAtLeast(releasedIndex, 0);
        assert.isBelow(attachedIndex, releasedIndex);
        const issued = (yield* Ref.get(issuedCredentials)).find(
          (config) => config.threadId === attachingThreadId,
        );
        assert.isDefined(issued);
        assert.isUndefined(
          yield* registry.resolve(issued!.authorizationHeader.replace(/^Bearer\s+/, "")),
        );
        assert.isUndefined(McpProviderSession.readMcpProviderSession(attachingThreadId));
      }).pipe(
        Effect.ensuring(Deferred.succeed(writeGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpRegistryLayer,
            eventSinkLayer,
            beforeClose: Deferred.succeed(closeReached, undefined),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 rejects a runtime attachment whose attach event write fails after close",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const writing = yield* Deferred.make<void>();
      const writeGate = yield* Deferred.make<void>();
      const closeReached = yield* Deferred.make<void>();
      const pauseWrite = yield* Ref.make(false);
      const ownerThreadId = ThreadId.make("thread-event-write-fail-owner");
      const attachingThreadId = ThreadId.make("thread-event-write-fail-attach");
      const eventSinkLayer = Layer.effect(
        EventSinkV2,
        Effect.gen(function* () {
          const delegate = yield* EventSinkV2;
          return EventSinkV2.of({
            ...delegate,
            write: (input) =>
              Ref.get(pauseWrite).pipe(
                Effect.flatMap((pause) =>
                  pause &&
                  input.events.some(
                    (event) =>
                      event.type === "provider-session.attached" &&
                      event.threadId === attachingThreadId,
                  )
                    ? Deferred.succeed(writing, undefined).pipe(
                        Effect.andThen(Deferred.await(writeGate)),
                        Effect.andThen(
                          Effect.fail(new EventSinkWriteError({ eventCount: input.events.length })),
                        ),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.write(input)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestEventSinkLayer));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const owner = yield* makeThreadSessionFixture(ownerThreadId);
        yield* makeThreadSessionFixture(attachingThreadId);
        const providerSessionId = yield* owner.allocate;
        const runtime = yield* owner.open(providerSessionId);
        yield* Ref.set(pauseWrite, true);
        // The attach suspends inside the event write holding the
        // release-status lock; once the gate opens the write fails while the
        // close is already pending. The failed write must still surface the
        // ownership loss instead of invoking the closing adapter (the
        // adapter's ensureThread is unimplemented and dies if reached).
        const attaching = yield* runtime
          .ensureThread({ threadId: attachingThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(writing);
        const closing = yield* manager.close(providerSessionId).pipe(Effect.forkChild);
        yield* Deferred.await(closeReached);
        yield* Deferred.succeed(writeGate, undefined);
        const error = yield* Fiber.join(attaching);
        assert.equal(error._tag, "ProviderAdapterProtocolError");
        assert.match(
          error._tag === "ProviderAdapterProtocolError" ? error.detail : "",
          /not finished cleanup|no longer running/,
        );
        yield* Fiber.join(closing);
        assert.equal((yield* Ref.get(state)).closeCount, 1);
        assert.isUndefined(McpProviderSession.readMcpProviderSession(attachingThreadId));
      }).pipe(
        Effect.ensuring(Deferred.succeed(writeGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            eventSinkLayer,
            beforeClose: Deferred.succeed(closeReached, undefined),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 fails open when the session is claimed mid-attach-write", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const writing = yield* Deferred.make<void>();
    const writeGate = yield* Deferred.make<void>();
    const pauseWrite = yield* Ref.make(false);
    const threadId = ThreadId.make("thread-open-mid-write-close");
    const writtenEventTypes = yield* Ref.make<
      ReadonlyArray<{ readonly threadId: string; readonly type: string }>
    >([]);
    const eventSinkLayer = Layer.effect(
      EventSinkV2,
      Effect.gen(function* () {
        const delegate = yield* EventSinkV2;
        return EventSinkV2.of({
          ...delegate,
          write: (input) =>
            Ref.get(pauseWrite).pipe(
              Effect.flatMap((pause) =>
                pause &&
                input.events.some(
                  (event) =>
                    event.type === "provider-session.attached" && event.threadId === threadId,
                )
                  ? Deferred.succeed(writing, undefined).pipe(
                      Effect.andThen(Deferred.await(writeGate)),
                    )
                  : Effect.void,
              ),
              Effect.andThen(
                Ref.update(writtenEventTypes, (types) => [
                  ...types,
                  ...input.events.map((event) => ({
                    threadId: event.threadId,
                    type: event.type,
                  })),
                ]),
              ),
              Effect.andThen(delegate.write(input)),
            ),
        });
      }),
    ).pipe(Layer.provide(TestEventSinkLayer));
    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManagerV2;
      const { allocate } = yield* makeThreadSessionFixture(threadId);
      const providerSessionId = yield* allocate;
      yield* Ref.set(pauseWrite, true);
      const opening = yield* manager
        .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(writing);
      // The suspended write holds the sessionOpen and release-status locks;
      // the close claims the session and then parks waiting for them.
      const closing = yield* manager.close(providerSessionId).pipe(Effect.result, Effect.forkChild);
      for (let i = 0; i < 10; i += 1) {
        yield* Effect.yieldNow;
      }
      // Keeping the write gated past the timeout must still let the close
      // caller fail: the error-status report is ordered behind the attach
      // write through the release-status lock but does not block the
      // caller's bounded wait.
      yield* TestClock.adjust("30 seconds");
      const closeExit = yield* Fiber.join(closing);
      assert.equal(closeExit._tag, "Failure");
      yield* Deferred.succeed(writeGate, undefined);
      const error = yield* Fiber.join(opening);
      assert.equal(error._tag, "ProviderSessionOpenError");
      // The claimed cleanup still owns teardown; a retried close joins it.
      yield* manager.close(providerSessionId);
      assert.equal((yield* Ref.get(state)).closeCount, 1);
      // The attach event still lands strictly before the release's terminal
      // status write — never after it.
      const eventTypes = yield* Ref.get(writtenEventTypes);
      const attachedIndex = eventTypes.findIndex(
        (event) => event.threadId === threadId && event.type === "provider-session.attached",
      );
      const releasedIndex = eventTypes.findIndex(
        (event) => event.type === "provider-session.updated",
      );
      assert.isAtLeast(attachedIndex, 0);
      assert.isAtLeast(releasedIndex, 0);
      assert.isBelow(attachedIndex, releasedIndex);
    }).pipe(
      Effect.ensuring(Deferred.succeed(writeGate, undefined)),
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 3_600_000,
          eventSinkLayer,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 unwinds an open interrupted inside openSession", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const opening = yield* Deferred.make<void>();
    const openGate = yield* Deferred.make<void>();
    const opens = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const threadId = ThreadId.make("thread-interrupted-open");
      const fixture = yield* makeThreadSessionFixture(threadId);
      const providerSessionId = yield* fixture.allocate;
      const openingFiber = yield* fixture
        .open(providerSessionId)
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(opening);
      // The open minted a credential and the adapter registered its scope
      // finalizer, but no entry exists in `sessions` yet — interruption must
      // close the scope, drop the reservation, and revoke the unclaimed
      // credential.
      yield* Fiber.interrupt(openingFiber);
      const exit = yield* Fiber.await(openingFiber);
      assert.equal(exit._tag, "Failure");
      assert.equal((yield* Ref.get(state)).closeCount, 1);
      assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
      // No phantom ownership: a fresh open of the same session id succeeds.
      yield* fixture.open(providerSessionId);
      assert.equal((yield* Ref.get(state)).openCount, 2);
    }).pipe(
      Effect.ensuring(Deferred.succeed(openGate, undefined)),
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 3_600_000,
          afterOpen: Ref.getAndUpdate(opens, (n) => n + 1).pipe(
            Effect.flatMap((n) =>
              n === 0
                ? Deferred.succeed(opening, undefined).pipe(
                    Effect.andThen(Deferred.await(openGate)),
                  )
                : Effect.void,
            ),
          ),
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 serializes a concurrent attach behind an in-flight one", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const writing = yield* Deferred.make<void>();
    const writeGate = yield* Deferred.make<void>();
    const pauseWrite = yield* Ref.make(true);
    const secondDone = yield* Ref.make(false);
    const ownerThreadId = ThreadId.make("thread-attach-serial-owner");
    const attachingThreadId = ThreadId.make("thread-attach-serial-peer");
    const attachedWrites = yield* Ref.make(0);
    const eventSinkLayer = Layer.effect(
      EventSinkV2,
      Effect.gen(function* () {
        const delegate = yield* EventSinkV2;
        return EventSinkV2.of({
          ...delegate,
          write: (input) =>
            Ref.get(pauseWrite).pipe(
              Effect.flatMap((pause) =>
                pause &&
                input.events.some(
                  (event) =>
                    event.type === "provider-session.attached" &&
                    event.threadId === attachingThreadId,
                )
                  ? Deferred.succeed(writing, undefined).pipe(
                      Effect.andThen(Deferred.await(writeGate)),
                    )
                  : Effect.void,
              ),
              Effect.andThen(
                Ref.update(attachedWrites, (n) =>
                  input.events.some(
                    (event) =>
                      event.type === "provider-session.attached" &&
                      event.threadId === attachingThreadId,
                  )
                    ? n + 1
                    : n,
                ),
              ),
              Effect.andThen(delegate.write(input)),
            ),
        });
      }),
    ).pipe(Layer.provide(TestEventSinkLayer));
    yield* Effect.gen(function* () {
      const idAllocator = yield* IdAllocatorV2;
      const owner = yield* makeThreadSessionFixture(ownerThreadId);
      yield* makeThreadSessionFixture(attachingThreadId);
      const providerSessionId = yield* owner.allocate;
      const runtime = yield* owner.open(providerSessionId);
      const providerThread = makeProviderThread({
        idAllocator,
        threadId: attachingThreadId,
        providerSessionId,
        now: yield* DateTime.now,
      });
      // First attach suspends persisting the attachment event while holding
      // the per-(session, thread) attach lock.
      const first = yield* runtime
        .resumeThread({ providerThread, threadId: attachingThreadId })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(writing);
      // A concurrent attach of the same thread must wait for the in-flight
      // one to become durable rather than riding its provisional
      // attachment: an attach that later fails unwinds the bookkeeping and
      // credential claim the second caller was relying on.
      const second = yield* runtime
        .resumeThread({ providerThread, threadId: attachingThreadId })
        .pipe(Effect.ensuring(Ref.set(secondDone, true)), Effect.exit, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.isFalse(yield* Ref.get(secondDone));
      yield* Ref.set(pauseWrite, false);
      yield* Deferred.succeed(writeGate, undefined);
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(first)));
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(second)));
      // The second caller joined the durable attachment: exactly one attach
      // event was persisted, and the adapter resume ran once — the second
      // call sees the loaded provider thread and short-circuits.
      assert.equal(yield* Ref.get(attachedWrites), 1);
      assert.equal((yield* Ref.get(state)).resumeCount, 1);
    }).pipe(
      Effect.ensuring(Deferred.succeed(writeGate, undefined)),
      Effect.provide(makeTestLayer({ state, idleTimeoutMs: 3_600_000, eventSinkLayer })),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 releases a session whose open was interrupted after registration",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const writing = yield* Deferred.make<void>();
      const writeGate = yield* Deferred.make<void>();
      const pauseWrite = yield* Ref.make(true);
      const threadId = ThreadId.make("thread-interrupted-registered-open");
      const eventSinkLayer = Layer.effect(
        EventSinkV2,
        Effect.gen(function* () {
          const delegate = yield* EventSinkV2;
          return EventSinkV2.of({
            ...delegate,
            write: (input) =>
              Ref.get(pauseWrite).pipe(
                Effect.flatMap((pause) =>
                  pause &&
                  input.events.some(
                    (event) =>
                      event.type === "provider-session.attached" && event.threadId === threadId,
                  )
                    ? Deferred.succeed(writing, undefined).pipe(
                        Effect.andThen(Deferred.await(writeGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.write(input)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestEventSinkLayer));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const fixture = yield* makeThreadSessionFixture(threadId);
        const providerSessionId = yield* fixture.allocate;
        const opening = yield* fixture.open(providerSessionId).pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(writing);
        // The entry is registered but the attach-event write is suspended;
        // interrupting here must hand the half-initialized session to the
        // release path rather than leaving it live without an event pump.
        yield* Fiber.interrupt(opening);
        const exit = yield* Fiber.await(opening);
        assert.equal(exit._tag, "Failure");
        yield* Ref.set(pauseWrite, false);
        yield* Deferred.succeed(writeGate, undefined);
        // Do not call close here: the interrupted open's own unwind must hand
        // the session to release, and an explicit close would perform the
        // missing cleanup itself. Poll the credential sweep — the last step of
        // cleanup — as the completion barrier instead.
        for (
          let i = 0;
          i < 24 && McpProviderSession.readMcpProviderSession(threadId) !== undefined;
          i += 1
        ) {
          yield* Effect.yieldNow;
        }
        assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      }).pipe(
        Effect.ensuring(Deferred.succeed(writeGate, undefined)),
        Effect.provide(makeTestLayer({ state, idleTimeoutMs: 3_600_000, eventSinkLayer })),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 rejects a runtime attachment whose event write fails while live",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const writing = yield* Deferred.make<void>();
      const writeGate = yield* Deferred.make<void>();
      const pauseWrite = yield* Ref.make(true);
      const ownerThreadId = ThreadId.make("thread-write-fail-live-owner");
      const attachingThreadId = ThreadId.make("thread-write-fail-live-attach");
      const eventSinkLayer = Layer.effect(
        EventSinkV2,
        Effect.gen(function* () {
          const delegate = yield* EventSinkV2;
          return EventSinkV2.of({
            ...delegate,
            write: (input) =>
              Ref.get(pauseWrite).pipe(
                Effect.flatMap((pause) =>
                  pause &&
                  input.events.some(
                    (event) =>
                      event.type === "provider-session.attached" &&
                      event.threadId === attachingThreadId,
                  )
                    ? Deferred.succeed(writing, undefined).pipe(
                        Effect.andThen(Deferred.await(writeGate)),
                        Effect.andThen(
                          Effect.fail(new EventSinkWriteError({ eventCount: input.events.length })),
                        ),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.write(input)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestEventSinkLayer));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const owner = yield* makeThreadSessionFixture(ownerThreadId);
        yield* makeThreadSessionFixture(attachingThreadId);
        const providerSessionId = yield* owner.allocate;
        const runtime = yield* owner.open(providerSessionId);
        // The attach suspends on the failing event write while the session
        // stays live: the caller must be rejected rather than reaching the
        // adapter for an untracked attachment. The adapter's ensureThread is
        // unimplemented, so a clean protocol error proves it was not called.
        const attaching = yield* runtime
          .ensureThread({ threadId: attachingThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(writing);
        yield* Deferred.succeed(writeGate, undefined);
        const error = yield* Fiber.join(attaching);
        assert.equal(error._tag, "ProviderAdapterProtocolError");
        assert.include(
          error._tag === "ProviderAdapterProtocolError" ? error.detail : "",
          "could not attach",
        );
        // The session stays live and the failed attach's credential is
        // revoked — the provisional claim was unwound with nothing else
        // holding it.
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        assert.isUndefined(McpProviderSession.readMcpProviderSession(attachingThreadId));
      }).pipe(
        Effect.ensuring(Deferred.succeed(writeGate, undefined)),
        Effect.provide(makeTestLayer({ state, idleTimeoutMs: 3_600_000, eventSinkLayer })),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 rejects a queued attachment whose thread was claimed by a pending release",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const writing = yield* Deferred.make<void>();
      const writeGate = yield* Deferred.make<void>();
      const closeReached = yield* Deferred.make<void>();
      const closeGate = yield* Deferred.make<void>();
      const pauseWrite = yield* Ref.make(false);
      const oldThreadId = ThreadId.make("thread-queued-attach-old");
      const ownerThreadId = ThreadId.make("thread-queued-attach-owner");
      const attachingThreadId = oldThreadId;
      const eventSinkLayer = Layer.effect(
        EventSinkV2,
        Effect.gen(function* () {
          const delegate = yield* EventSinkV2;
          return EventSinkV2.of({
            ...delegate,
            write: (input) =>
              Ref.get(pauseWrite).pipe(
                Effect.flatMap((pause) =>
                  pause &&
                  input.events.some(
                    (event) =>
                      event.type === "provider-session.attached" &&
                      event.threadId === attachingThreadId,
                  )
                    ? Deferred.succeed(writing, undefined).pipe(
                        Effect.andThen(Deferred.await(writeGate)),
                        Effect.andThen(
                          Effect.fail(new EventSinkWriteError({ eventCount: input.events.length })),
                        ),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.write(input)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestEventSinkLayer));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const oldSession = yield* makeThreadSessionFixture(oldThreadId);
        const owner = yield* makeThreadSessionFixture(ownerThreadId);
        const oldSessionId = yield* oldSession.allocate;
        yield* oldSession.open(oldSessionId);
        const sharedSessionId = yield* owner.allocate;
        const runtime = yield* owner.open(sharedSessionId);
        // The first attach of the shared thread suspends on the failing event
        // write while holding the per-(session, thread) attach lock.
        yield* Ref.set(pauseWrite, true);
        const first = yield* runtime
          .ensureThread({ threadId: attachingThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(writing);
        // The queued caller passed the pending-release gate before its lock
        // wait; the thread's old session then starts releasing and stays
        // pending behind the close gate.
        const second = yield* runtime
          .ensureThread({ threadId: attachingThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        const closing = yield* manager.close(oldSessionId).pipe(Effect.forkChild);
        yield* Deferred.await(closeReached);
        yield* Deferred.succeed(writeGate, undefined);
        // The first attach fails its write; the queued caller must re-check
        // the pending release inside the atomic attach instead of adding the
        // thread anyway.
        assert.equal((yield* Fiber.join(first))._tag, "Failure");
        const error = yield* Fiber.join(second);
        assert.equal(error._tag, "ProviderAdapterProtocolError");
        assert.include(
          error._tag === "ProviderAdapterProtocolError" ? error.detail : "",
          "not finished cleanup",
        );
        yield* Deferred.succeed(closeGate, undefined);
        yield* Fiber.join(closing);
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(writeGate, undefined).pipe(
            Effect.andThen(Deferred.succeed(closeGate, undefined)),
          ),
        ),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            eventSinkLayer,
            beforeClose: Deferred.succeed(closeReached, undefined).pipe(
              Effect.andThen(Deferred.await(closeGate)),
            ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a live session's claimed credential valid when reattach rotates it",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const browserAccess = yield* Ref.make(true);
      const issuedCredentials = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig>
      >([]);
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            issue: (input) =>
              delegate
                .issue(input)
                .pipe(
                  Effect.tap((issued) =>
                    Ref.update(issuedCredentials, (configs) => [...configs, issued.config]),
                  ),
                ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));
      const settingsLayer = Layer.effect(
        ServerSettings.ServerSettingsService,
        Effect.gen(function* () {
          const delegate = yield* ServerSettings.ServerSettingsService;
          return ServerSettings.ServerSettingsService.of({
            ...delegate,
            getSettings: Ref.get(browserAccess).pipe(
              Effect.flatMap((browser) =>
                Effect.map(delegate.getSettings, (settings) => ({
                  ...settings,
                  enableAgentBrowserAccess: browser,
                })),
              ),
            ),
          });
        }),
      ).pipe(Layer.provide(ServerSettings.layerTest({ enableAgentBrowserAccess: true })));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const sharedThreadId = ThreadId.make("thread-rotate-claimed-shared");
        const ownerThreadId = ThreadId.make("thread-rotate-claimed-owner");
        const shared = yield* makeThreadSessionFixture(sharedThreadId);
        const owner = yield* makeThreadSessionFixture(ownerThreadId);
        const firstSessionId = yield* shared.allocate;
        yield* shared.open(firstSessionId);
        const rotated = McpProviderSession.readMcpProviderSession(sharedThreadId);
        assert.isDefined(rotated);
        const rotatedToken = rotated!.authorizationHeader.replace(/^Bearer\s+/, "");
        const sharedSessionId = yield* owner.allocate;
        const runtime = yield* owner.open(sharedSessionId);
        // Flip browser access off so the shared thread's credential no longer
        // matches the required capabilities: reattaching rotates it, but the
        // first session's process still holds the old token.
        yield* Ref.set(browserAccess, false);
        // The adapter's ensureThread is unimplemented; the credential rotation
        // has already completed by the time it dies.
        yield* runtime
          .ensureThread({ threadId: sharedThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.ignore);
        const replacement = McpProviderSession.readMcpProviderSession(sharedThreadId);
        assert.isDefined(replacement);
        assert.notEqual(replacement!.providerSessionId, rotated!.providerSessionId);
        // The rotated-out credential must stay valid while a live session
        // still records it — its process keeps calling with it.
        assert.isDefined(yield* registry.resolve(rotatedToken));
        yield* manager.close(firstSessionId);
        // The first session was the rotated credential's last recorded
        // holder; the second session recorded the replacement, so the release
        // revokes it rather than leaving a valid unclaimed token.
        assert.isUndefined(yield* registry.resolve(rotatedToken));
      }).pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpRegistryLayer,
            serverSettingsLayer: settingsLayer,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 orders a suspended session update before the release terminal write",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const writing = yield* Deferred.make<void>();
      const writeGate = yield* Deferred.make<void>();
      const pauseWrite = yield* Ref.make(false);
      const threadId = ThreadId.make("thread-update-ordering");
      const eventSinkLayer = Layer.effect(
        EventSinkV2,
        Effect.gen(function* () {
          const delegate = yield* EventSinkV2;
          return EventSinkV2.of({
            ...delegate,
            write: (input) =>
              Ref.get(pauseWrite).pipe(
                Effect.flatMap((pause) =>
                  pause && input.events.some((event) => event.type === "provider-session.updated")
                    ? Deferred.succeed(writing, undefined).pipe(
                        Effect.andThen(Deferred.await(writeGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.write(input)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestEventSinkLayer));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStoreV2;
        const session = yield* makeThreadSessionFixture(threadId);
        const providerSessionId = yield* session.allocate;
        const runtime = yield* session.open(providerSessionId);
        yield* Ref.set(pauseWrite, true);
        // The pump picks up the provider's status update and suspends inside
        // its event write while holding releaseStatus; the close then queues
        // its terminal write behind it instead of being overwritten.
        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(queue);
        yield* Queue.offer(queue!, {
          type: "provider_session.updated",
          driver: CODEX_DRIVER,
          providerSession: runtime.providerSession,
        });
        yield* Deferred.await(writing);
        const closing = yield* manager.close(providerSessionId).pipe(Effect.forkChild);
        yield* Ref.set(pauseWrite, false);
        yield* Deferred.succeed(writeGate, undefined);
        yield* Fiber.join(closing);
        const sessionStatus = (yield* projectionStore.getThreadProjection(
          threadId,
        )).providerSessions.at(-1)?.status;
        assert.equal(sessionStatus, "stopped");
      }).pipe(
        Effect.ensuring(Deferred.succeed(writeGate, undefined)),
        Effect.provide(makeTestLayer({ state, idleTimeoutMs: 3_600_000, eventSinkLayer })),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 never lets a suspended detach strip a same-id replacement's attachment",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const interruptEntered = yield* Deferred.make<void>();
      const interruptGate = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const eventSink = yield* EventSinkV2;
        const projectionStore = yield* ProjectionStoreV2;
        const idAllocator = yield* IdAllocatorV2;
        const now = yield* DateTime.now;
        const firstThreadId = ThreadId.make("thread-detach-replace-first");
        const secondThreadId = ThreadId.make("thread-detach-replace-second");
        const first = yield* makeThreadSessionFixture(firstThreadId);
        const second = yield* makeThreadSessionFixture(secondThreadId);
        const providerSessionId = yield* first.allocate;
        const providerThread = makeProviderThread({
          idAllocator,
          threadId: firstThreadId,
          providerSessionId,
          now,
        });
        const runId = idAllocator.derive.run({ threadId: firstThreadId, ordinal: 1 });
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId: firstThreadId }),
              type: "provider-thread.updated",
              threadId: firstThreadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: providerThread,
            },
            {
              id: yield* idAllocator.allocate.event({ threadId: firstThreadId }),
              type: "provider-turn.updated",
              threadId: firstThreadId,
              runId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: {
                id: idAllocator.derive.providerTurn({
                  driver: CODEX_DRIVER,
                  nativeTurnId: "native-turn-detach-replace",
                }),
                providerThreadId: providerThread.id,
                nodeId: idAllocator.derive.rootNode({ runId }),
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
        yield* first.open(providerSessionId);
        yield* second.open(providerSessionId);
        // The detach captures session A's entry, then parks inside
        // interruptTurn on the seeded running turn. A closes completely and a
        // same-id replacement re-attaches the thread while it is suspended.
        const detaching = yield* manager
          .detach({ providerSessionId, threadId: firstThreadId })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(interruptEntered);
        yield* manager.close(providerSessionId);
        yield* manager.open({
          threadId: firstThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* Deferred.succeed(interruptGate, undefined);
        assert.equal((yield* Fiber.join(detaching))._tag, "Success");
        // The replacement still owns the thread: closing it must write the
        // thread's terminal session event instead of silently skipping it.
        yield* manager.close(providerSessionId);
        const sessionStatus = (yield* projectionStore.getThreadProjection(
          firstThreadId,
        )).providerSessions.at(-1)?.status;
        assert.equal(sessionStatus, "stopped");
      }).pipe(
        Effect.ensuring(Deferred.succeed(interruptGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            beforeInterrupt: Deferred.succeed(interruptEntered, undefined).pipe(
              Effect.andThen(Deferred.await(interruptGate)),
            ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 terminal detach keeps a credential a peer session still claims",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const sharedThreadId = ThreadId.make("thread-terminal-detach-shared");
        const ownerThreadId = ThreadId.make("thread-terminal-detach-owner");
        const shared = yield* makeThreadSessionFixture(sharedThreadId);
        const owner = yield* makeThreadSessionFixture(ownerThreadId);
        const firstSessionId = yield* shared.allocate;
        yield* shared.open(firstSessionId);
        const credential = McpProviderSession.readMcpProviderSession(sharedThreadId);
        assert.isDefined(credential);
        const token = credential!.authorizationHeader.replace(/^Bearer\s+/, "");
        const sharedSessionId = yield* owner.allocate;
        const runtime = yield* owner.open(sharedSessionId);
        // The peer session reuses the same credential for the shared thread.
        yield* runtime
          .ensureThread({ threadId: sharedThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.ignore);
        assert.equal(
          McpProviderSession.readMcpProviderSession(sharedThreadId)?.providerSessionId,
          credential!.providerSessionId,
        );
        // Terminally detaching the thread from the first session must not
        // revoke the credential the peer still records.
        yield* manager.detach({
          providerSessionId: firstSessionId,
          threadId: sharedThreadId,
          revokeMcpCredential: true,
        });
        assert.isDefined(yield* registry.resolve(token));
        assert.isUndefined(McpProviderSession.readMcpProviderSession(sharedThreadId));
        // The peer's own cleanup remains the credential's final holder.
        yield* manager.close(sharedSessionId);
        assert.isUndefined(yield* registry.resolve(token));
      }).pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 3_600_000 })));
    }),
);

it.effect(
  "ProviderSessionManagerV2 rechecks live claims for each credential a release sweeps",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const resolving = yield* Deferred.make<void>();
      const resolveGate = yield* Deferred.make<void>();
      const revoking = yield* Deferred.make<void>();
      const revokeGate = yield* Deferred.make<void>();
      const pauseResolve = yield* Ref.make(false);
      const revokeTarget = yield* Ref.make<Option.Option<string>>(Option.none());
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            resolve: (token) =>
              Ref.get(pauseResolve).pipe(
                Effect.flatMap((pause) =>
                  pause
                    ? Deferred.succeed(resolving, undefined).pipe(
                        Effect.andThen(Deferred.await(resolveGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.resolve(token)),
              ),
            revokeProviderSession: (providerSessionId) =>
              Ref.get(revokeTarget).pipe(
                Effect.flatMap((target) =>
                  Option.isSome(target) && target.value === providerSessionId
                    ? Deferred.succeed(revoking, undefined).pipe(
                        Effect.andThen(Deferred.await(revokeGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.revokeProviderSession(providerSessionId)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const ownerThreadId = ThreadId.make("thread-release-sweep-owner");
        const sharedThreadId = ThreadId.make("thread-release-sweep-shared");
        const peerThreadId = ThreadId.make("thread-release-sweep-peer");
        const owner = yield* makeThreadSessionFixture(ownerThreadId);
        yield* makeThreadSessionFixture(sharedThreadId);
        const peer = yield* makeThreadSessionFixture(peerThreadId);
        const ownerSessionId = yield* owner.allocate;
        const runtimeA = yield* owner.open(ownerSessionId);
        // Session A ends up holding two credentials. The adapter's
        // ensureThread is unimplemented; the credential record lands before
        // the adapter call dies.
        yield* runtimeA
          .ensureThread({ threadId: sharedThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.ignore);
        const ownerCredential = McpProviderSession.readMcpProviderSession(ownerThreadId);
        const sharedCredential = McpProviderSession.readMcpProviderSession(sharedThreadId);
        assert.isDefined(ownerCredential);
        assert.isDefined(sharedCredential);
        const sharedToken = sharedCredential!.authorizationHeader.replace(/^Bearer\s+/, "");
        const peerSessionId = yield* peer.allocate;
        const runtimeB = yield* peer.open(peerSessionId);
        yield* Ref.set(pauseResolve, true);
        // B attaches the shared thread, reserves its credential, then suspends
        // in resolve before its claim is recorded.
        const attaching = yield* runtimeB
          .ensureThread({ threadId: sharedThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(resolving);
        yield* Ref.set(revokeTarget, Option.some(ownerCredential!.providerSessionId));
        const closing = yield* manager.close(ownerSessionId).pipe(Effect.forkChild);
        // The sweep parked inside the first credential's revocation has
        // already taken any up-front snapshot of live sessions.
        yield* Deferred.await(revoking);
        // B's attach resumes and records its claim while the sweep is parked;
        // by the time it finishes the reservation is gone, so only the live
        // session record protects the credential.
        yield* Deferred.succeed(resolveGate, undefined);
        assert.equal((yield* Fiber.join(attaching))._tag, "Failure");
        yield* Deferred.succeed(revokeGate, undefined);
        yield* Fiber.join(closing);
        assert.isDefined(yield* registry.resolve(sharedToken));
        // B's own release remains the credential's final holder.
        yield* manager.close(peerSessionId);
        assert.isUndefined(yield* registry.resolve(sharedToken));
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(resolveGate, undefined).pipe(
            Effect.andThen(Deferred.succeed(revokeGate, undefined)),
          ),
        ),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpRegistryLayer,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 serializes detach behind an in-flight attach of the same thread",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const issuing = yield* Deferred.make<void>();
      const issueGate = yield* Deferred.make<void>();
      const pauseIssue = yield* Ref.make(false);
      const detachDone = yield* Deferred.make<void>();
      const issuedCredentials = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig>
      >([]);
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            issue: (input) =>
              Ref.get(pauseIssue).pipe(
                Effect.flatMap((pause) =>
                  pause
                    ? Deferred.succeed(issuing, undefined).pipe(
                        Effect.andThen(Deferred.await(issueGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.issue(input)),
                Effect.tap((issued) =>
                  Ref.update(issuedCredentials, (configs) => [...configs, issued.config]),
                ),
              ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const ownerThreadId = ThreadId.make("thread-detach-attach-owner");
        const sharedThreadId = ThreadId.make("thread-detach-attach-shared");
        const owner = yield* makeThreadSessionFixture(ownerThreadId);
        yield* makeThreadSessionFixture(sharedThreadId);
        const providerSessionId = yield* owner.allocate;
        const runtime = yield* owner.open(providerSessionId);
        yield* Ref.set(pauseIssue, true);
        // The shared thread's attach suspends inside credential issuance with
        // its provisional attachment already recorded in the entry.
        const attaching = yield* runtime
          .ensureThread({ threadId: sharedThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(issuing);
        yield* manager
          .detach({ providerSessionId, threadId: sharedThreadId, revokeMcpCredential: true })
          .pipe(Effect.ensuring(Deferred.succeed(detachDone, undefined)), Effect.forkChild);
        // The detach must stay parked behind the attach's lock instead of
        // removing the provisional attachment out from under it.
        yield* Effect.forEach(Array.from({ length: 8 }), () => Effect.yieldNow, {
          discard: true,
        });
        assert.isFalse(yield* Deferred.isDone(detachDone));
        yield* Deferred.succeed(issueGate, undefined);
        // The adapter's ensureThread is unimplemented and dies once the attach
        // bookkeeping completes; the detach then runs and wins.
        assert.equal((yield* Fiber.join(attaching))._tag, "Failure");
        yield* Deferred.await(detachDone);
        // The detach ran after the attach fully landed: the freshly minted
        // credential was recorded, then pruned and revoked by the terminal
        // detach instead of surviving as an untracked claim.
        const issued = (yield* Ref.get(issuedCredentials)).find(
          (config) => config.threadId === sharedThreadId,
        );
        assert.isDefined(issued);
        assert.isUndefined(
          yield* registry.resolve(issued!.authorizationHeader.replace(/^Bearer\s+/, "")),
        );
        assert.isUndefined(McpProviderSession.readMcpProviderSession(sharedThreadId));
      }).pipe(
        Effect.ensuring(Deferred.succeed(issueGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpRegistryLayer,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 serializes credential revocation against a new attachment's reservation",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const revoking = yield* Deferred.make<void>();
      const revokeGate = yield* Deferred.make<void>();
      const attachDone = yield* Deferred.make<void>();
      const revokeTarget = yield* Ref.make<Option.Option<string>>(Option.none());
      const issuedCredentials = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig>
      >([]);
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            issue: (input) =>
              delegate
                .issue(input)
                .pipe(
                  Effect.tap((issued) =>
                    Ref.update(issuedCredentials, (configs) => [...configs, issued.config]),
                  ),
                ),
            revokeProviderSession: (providerSessionId) =>
              Ref.get(revokeTarget).pipe(
                Effect.flatMap((target) =>
                  Option.isSome(target) && target.value === providerSessionId
                    ? Deferred.succeed(revoking, undefined).pipe(
                        Effect.andThen(Deferred.await(revokeGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.revokeProviderSession(providerSessionId)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const ownerThreadId = ThreadId.make("thread-revoke-race-owner");
        const sharedThreadId = ThreadId.make("thread-revoke-race-shared");
        const peerThreadId = ThreadId.make("thread-revoke-race-peer");
        const owner = yield* makeThreadSessionFixture(ownerThreadId);
        yield* makeThreadSessionFixture(sharedThreadId);
        const peer = yield* makeThreadSessionFixture(peerThreadId);
        const ownerSessionId = yield* owner.allocate;
        const runtimeA = yield* owner.open(ownerSessionId);
        yield* runtimeA
          .ensureThread({ threadId: sharedThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.ignore);
        const sharedCredential = McpProviderSession.readMcpProviderSession(sharedThreadId);
        assert.isDefined(sharedCredential);
        const sharedToken = sharedCredential!.authorizationHeader.replace(/^Bearer\s+/, "");
        const peerSessionId = yield* peer.allocate;
        const runtimeB = yield* peer.open(peerSessionId);
        yield* Ref.set(revokeTarget, Option.some(sharedCredential!.providerSessionId));
        // Session A stays live for the owner thread; the terminal detach's
        // claim check finds the shared credential unclaimed, then suspends
        // inside the registry delete.
        const detaching = yield* manager
          .detach({
            providerSessionId: ownerSessionId,
            threadId: sharedThreadId,
            revokeMcpCredential: true,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(revoking);
        // B's attach of the same thread must wait for the in-flight
        // revocation instead of reserving and resolving the about-to-be
        // deleted credential.
        const attaching = yield* runtimeB
          .ensureThread({ threadId: sharedThreadId, modelSelection, runtimePolicy })
          .pipe(
            Effect.exit,
            Effect.ensuring(Deferred.succeed(attachDone, undefined)),
            Effect.forkChild,
          );
        yield* Effect.forEach(Array.from({ length: 8 }), () => Effect.yieldNow, {
          discard: true,
        });
        assert.isFalse(yield* Deferred.isDone(attachDone));
        yield* Deferred.succeed(revokeGate, undefined);
        yield* Fiber.join(detaching);
        // The adapter's ensureThread is unimplemented; the credential outcome
        // is decided before the adapter call dies.
        assert.equal((yield* Fiber.join(attaching))._tag, "Failure");
        assert.isUndefined(yield* registry.resolve(sharedToken));
        // B could not ride the doomed credential: it was issued a fresh one,
        // recorded against B, which resolves.
        const reissued = (yield* Ref.get(issuedCredentials)).find(
          (config) =>
            config.threadId === sharedThreadId &&
            config.providerSessionId !== sharedCredential!.providerSessionId,
        );
        assert.isDefined(reissued);
        assert.isDefined(
          yield* registry.resolve(reissued!.authorizationHeader.replace(/^Bearer\s+/, "")),
        );
      }).pipe(
        Effect.ensuring(Deferred.succeed(revokeGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpRegistryLayer,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 revokes a superseded credential when its sweeper attach is interrupted",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const browserAccess = yield* Ref.make(true);
      const revoking = yield* Deferred.make<void>();
      const revokeGate = yield* Deferred.make<void>();
      const revokeTarget = yield* Ref.make<Option.Option<string>>(Option.none());
      const issuedCredentials = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig>
      >([]);
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            issue: (input) =>
              delegate
                .issue(input)
                .pipe(
                  Effect.tap((issued) =>
                    Ref.update(issuedCredentials, (configs) => [...configs, issued.config]),
                  ),
                ),
            revokeProviderSession: (providerSessionId) =>
              Ref.get(revokeTarget).pipe(
                Effect.flatMap((target) =>
                  Option.isSome(target) && target.value === providerSessionId
                    ? Deferred.isDone(revoking).pipe(
                        Effect.flatMap((alreadySignaled) =>
                          alreadySignaled
                            ? Effect.void
                            : Deferred.succeed(revoking, undefined).pipe(
                                Effect.andThen(Deferred.await(revokeGate)),
                              ),
                        ),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.revokeProviderSession(providerSessionId)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));
      const settingsLayer = Layer.effect(
        ServerSettings.ServerSettingsService,
        Effect.gen(function* () {
          const delegate = yield* ServerSettings.ServerSettingsService;
          return ServerSettings.ServerSettingsService.of({
            ...delegate,
            getSettings: Ref.get(browserAccess).pipe(
              Effect.flatMap((browser) =>
                Effect.map(delegate.getSettings, (settings) => ({
                  ...settings,
                  enableAgentBrowserAccess: browser,
                })),
              ),
            ),
          });
        }),
      ).pipe(Layer.provide(ServerSettings.layerTest({ enableAgentBrowserAccess: true })));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const ownerThreadId = ThreadId.make("thread-superseded-owner");
        const sharedThreadId = ThreadId.make("thread-superseded-shared");
        const owner = yield* makeThreadSessionFixture(ownerThreadId);
        yield* makeThreadSessionFixture(sharedThreadId);
        const providerSessionId = yield* owner.allocate;
        const runtime = yield* owner.open(providerSessionId);
        yield* runtime
          .ensureThread({ threadId: sharedThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.ignore);
        const retained = McpProviderSession.readMcpProviderSession(sharedThreadId);
        assert.isDefined(retained);
        const retainedToken = retained!.authorizationHeader.replace(/^Bearer\s+/, "");
        // A plain detach keeps the shared session live for the owner thread
        // and retains the credential record for reuse.
        yield* manager.detach({ providerSessionId, threadId: sharedThreadId });
        // Rotating capabilities makes the reattach mint a replacement
        // credential and supersede the retained one.
        yield* Ref.set(browserAccess, false);
        yield* Ref.set(revokeTarget, Option.some(retained!.providerSessionId));
        // The reattach records the replacement, then suspends inside the
        // superseded credential's registry delete.
        const attaching = yield* runtime
          .ensureThread({ threadId: sharedThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(revoking);
        yield* Fiber.interrupt(attaching);
        assert.equal((yield* Fiber.await(attaching))._tag, "Failure");
        // The superseded credential is out of every record and the config
        // slot; the unwind is its last chance to be revoked.
        assert.isUndefined(yield* registry.resolve(retainedToken));
        const replacement = (yield* Ref.get(issuedCredentials)).find(
          (config) =>
            config.threadId === sharedThreadId &&
            config.providerSessionId !== retained!.providerSessionId,
        );
        assert.isDefined(replacement);
        assert.isUndefined(
          yield* registry.resolve(replacement!.authorizationHeader.replace(/^Bearer\s+/, "")),
        );
      }).pipe(
        Effect.ensuring(Deferred.succeed(revokeGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpRegistryLayer,
            serverSettingsLayer: settingsLayer,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps the bounded release wait when a terminal detach retries during pending cleanup",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const resolving = yield* Deferred.make<void>();
      const resolveGate = yield* Deferred.make<void>();
      const pauseResolve = yield* Ref.make(false);
      const detachDone = yield* Deferred.make<void>();
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            resolve: (token) =>
              Ref.get(pauseResolve).pipe(
                Effect.flatMap((pause) =>
                  pause
                    ? Deferred.succeed(resolving, undefined).pipe(
                        Effect.andThen(Deferred.await(resolveGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.resolve(token)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const sharedThreadId = ThreadId.make("thread-detach-retry-shared");
        const peerThreadId = ThreadId.make("thread-detach-retry-peer");
        const shared = yield* makeThreadSessionFixture(sharedThreadId);
        const peer = yield* makeThreadSessionFixture(peerThreadId);
        const providerSessionId = yield* shared.allocate;
        yield* shared.open(providerSessionId);
        const peerSessionId = yield* peer.allocate;
        const runtimeB = yield* peer.open(peerSessionId);
        yield* Ref.set(pauseResolve, true);
        // A peer attachment of the shared thread holds the prepare lock while
        // its credential resolution is stalled.
        yield* runtimeB
          .ensureThread({ threadId: sharedThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(resolving);
        // Closing the shared session parks its credential sweep on the same
        // lock; the close's own join times out while cleanup continues.
        const closing = yield* manager.close(providerSessionId).pipe(Effect.exit, Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        assert.equal((yield* Fiber.join(closing))._tag, "Failure");
        // A terminal detach retry must join the still-bounded release wait,
        // not block unboundedly on the stalled prepare lock first.
        const detaching = yield* manager
          .detach({ providerSessionId, threadId: sharedThreadId, revokeMcpCredential: true })
          .pipe(
            Effect.exit,
            Effect.ensuring(Deferred.succeed(detachDone, undefined)),
            Effect.forkChild,
          );
        yield* TestClock.adjust("30 seconds");
        yield* Effect.forEach(Array.from({ length: 8 }), () => Effect.yieldNow, {
          discard: true,
        });
        assert.isTrue(yield* Deferred.isDone(detachDone));
        assert.equal((yield* Fiber.join(detaching))._tag, "Failure");
      }).pipe(
        Effect.ensuring(Deferred.succeed(resolveGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpRegistryLayer,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a pruned credential's cleanup alive when its terminal detach is interrupted",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const issuing = yield* Deferred.make<void>();
      const issueGate = yield* Deferred.make<void>();
      const revoked = yield* Deferred.make<void>();
      const pauseIssue = yield* Ref.make(false);
      const failResolve = yield* Ref.make(false);
      const revokeTarget = yield* Ref.make<Option.Option<string>>(Option.none());
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            resolve: (token) =>
              Ref.get(failResolve).pipe(
                Effect.flatMap((fail) =>
                  fail ? Effect.succeed(undefined) : delegate.resolve(token),
                ),
              ),
            issue: (input) =>
              Ref.get(pauseIssue).pipe(
                Effect.flatMap((pause) =>
                  pause
                    ? Deferred.succeed(issuing, undefined).pipe(
                        Effect.andThen(Deferred.await(issueGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.issue(input)),
              ),
            revokeProviderSession: (providerSessionId) =>
              delegate
                .revokeProviderSession(providerSessionId)
                .pipe(
                  Effect.andThen(
                    Ref.get(revokeTarget).pipe(
                      Effect.flatMap((target) =>
                        Option.isSome(target) && target.value === providerSessionId
                          ? Deferred.succeed(revoked, undefined)
                          : Effect.void,
                      ),
                    ),
                  ),
                ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const sharedThreadId = ThreadId.make("thread-detach-interrupt-shared");
        const peerThreadId = ThreadId.make("thread-detach-interrupt-peer");
        const shared = yield* makeThreadSessionFixture(sharedThreadId);
        const peer = yield* makeThreadSessionFixture(peerThreadId);
        const providerSessionId = yield* shared.allocate;
        yield* shared.open(providerSessionId);
        const credential = McpProviderSession.readMcpProviderSession(sharedThreadId);
        assert.isDefined(credential);
        const token = credential!.authorizationHeader.replace(/^Bearer\s+/, "");
        yield* Ref.set(revokeTarget, Option.some(credential!.providerSessionId));
        const peerSessionId = yield* peer.allocate;
        const runtimeB = yield* peer.open(peerSessionId);
        yield* Ref.set(failResolve, true);
        yield* Ref.set(pauseIssue, true);
        // A peer attachment misses the recorded credential on resolve, skips
        // revoking it while the first session still records it, then parks
        // inside `issue` holding the shared thread's prepare lock.
        const attaching = yield* runtimeB
          .ensureThread({ threadId: sharedThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(issuing);
        // The terminal detach prunes the credential record, then its
        // revocation parks behind the peer's prepare lock. Interrupting the
        // detach must not strand the captured credential id: the detached
        // sweep still owns its cleanup.
        const detaching = yield* manager
          .detach({ providerSessionId, threadId: sharedThreadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Effect.forEach(Array.from({ length: 12 }), () => Effect.yieldNow, {
          discard: true,
        });
        yield* Fiber.interrupt(detaching);
        assert.equal((yield* Fiber.await(detaching))._tag, "Failure");
        yield* Deferred.succeed(issueGate, undefined);
        yield* Fiber.await(attaching);
        yield* Deferred.await(revoked);
        yield* Ref.set(failResolve, false);
        assert.isUndefined(yield* registry.resolve(token));
      }).pipe(
        Effect.ensuring(Deferred.succeed(issueGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpRegistryLayer,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps the bounded release wait when a detach discovers pending cleanup mid-flight",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const interruptEntered = yield* Deferred.make<void>();
      const interruptGate = yield* Deferred.make<void>();
      const resolving = yield* Deferred.make<void>();
      const resolveGate = yield* Deferred.make<void>();
      const pauseResolve = yield* Ref.make(false);
      const detachDone = yield* Deferred.make<void>();
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            resolve: (token) =>
              Ref.get(pauseResolve).pipe(
                Effect.flatMap((pause) =>
                  pause
                    ? Deferred.succeed(resolving, undefined).pipe(
                        Effect.andThen(Deferred.await(resolveGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.resolve(token)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const now = yield* DateTime.now;
        const firstThreadId = ThreadId.make("thread-detach-latejoin-first");
        const peerThreadId = ThreadId.make("thread-detach-latejoin-peer");
        const first = yield* makeThreadSessionFixture(firstThreadId);
        const peer = yield* makeThreadSessionFixture(peerThreadId);
        const providerSessionId = yield* first.allocate;
        const providerThread = makeProviderThread({
          idAllocator,
          threadId: firstThreadId,
          providerSessionId,
          now,
        });
        const runId = idAllocator.derive.run({ threadId: firstThreadId, ordinal: 1 });
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId: firstThreadId }),
              type: "provider-thread.updated",
              threadId: firstThreadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: providerThread,
            },
            {
              id: yield* idAllocator.allocate.event({ threadId: firstThreadId }),
              type: "provider-turn.updated",
              threadId: firstThreadId,
              runId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: {
                id: idAllocator.derive.providerTurn({
                  driver: CODEX_DRIVER,
                  nativeTurnId: "native-turn-detach-latejoin",
                }),
                providerThreadId: providerThread.id,
                nodeId: idAllocator.derive.rootNode({ runId }),
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
        yield* first.open(providerSessionId);
        const peerSessionId = yield* peer.allocate;
        const runtimeB = yield* peer.open(peerSessionId);
        yield* Ref.set(pauseResolve, true);
        // A peer attachment parks on the stalled resolution holding the
        // shared thread's prepare lock.
        yield* runtimeB
          .ensureThread({ threadId: firstThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(resolving);
        // The detach passes the pending-release check, then parks inside
        // interruptTurn on the seeded running turn.
        const detaching = yield* manager
          .detach({
            providerSessionId,
            threadId: firstThreadId,
            revokeMcpCredential: true,
          })
          .pipe(
            Effect.exit,
            Effect.ensuring(Deferred.succeed(detachDone, undefined)),
            Effect.forkChild,
          );
        yield* Deferred.await(interruptEntered);
        // The close claims the session while the detach is suspended; its own
        // join times out while the credential sweep stays parked on the lock.
        const closing = yield* manager.close(providerSessionId).pipe(Effect.exit, Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        assert.equal((yield* Fiber.join(closing))._tag, "Failure");
        // The resumed detach discovers the pending release after its atomic
        // decision; it must join the bounded wait instead of parking on the
        // stalled prepare lock first.
        yield* Deferred.succeed(interruptGate, undefined);
        yield* TestClock.adjust("30 seconds");
        yield* Effect.forEach(Array.from({ length: 8 }), () => Effect.yieldNow, {
          discard: true,
        });
        assert.isTrue(yield* Deferred.isDone(detachDone));
        assert.equal((yield* Fiber.join(detaching))._tag, "Failure");
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(interruptGate, undefined).pipe(
            Effect.andThen(Deferred.succeed(resolveGate, undefined)),
          ),
        ),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpRegistryLayer,
            beforeInterrupt: Deferred.succeed(interruptEntered, undefined).pipe(
              Effect.andThen(Deferred.await(interruptGate)),
            ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a failed open's credential claim until its scope finishes closing",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const openReached = yield* Deferred.make<void>();
      const openGate = yield* Deferred.make<void>();
      const finalizerEntered = yield* Deferred.make<void>();
      const finalizerGate = yield* Deferred.make<void>();
      const opens = yield* Ref.make(0);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const threadId = ThreadId.make("thread-open-reservation-scope");
        const fixture = yield* makeThreadSessionFixture(threadId);
        const firstSessionId = yield* fixture.allocate;
        yield* fixture.open(firstSessionId);
        const credential = McpProviderSession.readMcpProviderSession(threadId);
        assert.isDefined(credential);
        const token = credential!.authorizationHeader.replace(/^Bearer\s+/, "");
        // A second open for the same thread reuses the live session's
        // credential, then is interrupted after its provider process started
        // but before the entry registers.
        const secondSessionId = yield* fixture.allocate;
        const opening = yield* manager
          .open({
            threadId,
            providerSessionId: secondSessionId,
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(openReached);
        // The unwind stalls inside the provider scope's close finalizer; the
        // reservation must outlive it or a peer's terminal detach can revoke
        // the credential out from under the still-closing process.
        yield* Fiber.interrupt(opening).pipe(Effect.forkChild);
        yield* Deferred.await(finalizerEntered);
        yield* manager.detach({
          providerSessionId: firstSessionId,
          threadId,
          revokeMcpCredential: true,
        });
        assert.isDefined(yield* registry.resolve(token));
        // Once the scope close settles the reservation drops and the
        // claim-aware sweep revokes the now-unclaimed credential.
        yield* Deferred.succeed(finalizerGate, undefined);
        assert.equal((yield* Fiber.await(opening))._tag, "Failure");
        yield* Effect.forEach(Array.from({ length: 12 }), () => Effect.yieldNow, {
          discard: true,
        });
        assert.isUndefined(yield* registry.resolve(token));
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(openGate, undefined).pipe(
            Effect.andThen(Deferred.succeed(finalizerGate, undefined)),
          ),
        ),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            beforeClose: Deferred.succeed(finalizerEntered, undefined).pipe(
              Effect.andThen(Deferred.await(finalizerGate)),
            ),
            afterOpen: Ref.getAndUpdate(opens, (n) => n + 1).pipe(
              Effect.flatMap((n) =>
                n === 1
                  ? Deferred.succeed(openReached, undefined).pipe(
                      Effect.andThen(Deferred.await(openGate)),
                    )
                  : Effect.void,
              ),
            ),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 marks pending runtime work failed when cleanup times out", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const hangClose = yield* Deferred.make<void>();
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-timeout-requests",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-timeout-requests",
        }),
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

      const closing = yield* manager.close(providerSessionId).pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      assert.equal((yield* Fiber.join(closing))._tag, "Failure");
      yield* Effect.yieldNow;

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const request = projection.runtimeRequests.find(
        (candidate) => candidate.id === pendingRequest.requestId,
      );
      const requestNode = projection.nodes.find((node) => node.id === pendingRequest.nodeId);
      const requestTurnItem = projection.turnItems.find(
        (item) => item.type === "approval_request" && item.requestId === pendingRequest.requestId,
      );
      // Cleanup is still pending at the timeout, so the release is a runtime
      // failure — not a normal close that would mark the work cancelled.
      assert.equal(request?.status, "expired");
      assert.equal(request?.responseCapability.type, "not_resumable");
      assert.equal(requestNode?.status, "failed");
      assert.equal(requestTurnItem?.status, "failed");
    });

    yield* effect.pipe(
      Effect.ensuring(Deferred.succeed(hangClose, undefined)),
      Effect.provide(
        makeTestLayer({ state, idleTimeoutMs: 1000, hangSessionScopeClose: hangClose }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 does not release a same-id replacement from a stale detach",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const revoking = yield* Deferred.make<void>();
      const revokeGate = yield* Deferred.make<void>();
      const pauseRevoke = yield* Ref.make(false);
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            revokeProviderSession: (providerSessionId) =>
              Ref.getAndSet(pauseRevoke, false).pipe(
                Effect.flatMap((pause) =>
                  pause
                    ? Deferred.succeed(revoking, undefined).pipe(
                        Effect.andThen(Deferred.await(revokeGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.revokeProviderSession(providerSessionId)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const threadId = ThreadId.make("thread-stale-detach-replacement");
        const replacementThreadId = ThreadId.make("thread-stale-detach-replacement-peer");
        const fixture = yield* makeThreadSessionFixture(threadId);
        const replacementFixture = yield* makeThreadSessionFixture(replacementThreadId);
        const providerSessionId = yield* fixture.allocate;
        yield* fixture.open(providerSessionId);

        yield* Ref.set(pauseRevoke, true);
        // The terminal detach prunes the thread's credential record and hands
        // it to the forked release's sweep, then its detached revocation parks
        // on the gated registry call while holding mcpPrepareLock — so the
        // release (and anything joining it) settles only once the gate opens.
        const detaching = yield* manager
          .detach({ providerSessionId, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(revoking);

        // Close joins the pending release the detach forked; it stays parked
        // behind the gated revocation until the lock frees.
        const closing = yield* manager.close(providerSessionId).pipe(Effect.exit, Effect.forkChild);
        for (let i = 0; i < 4; i += 1) {
          yield* Effect.yieldNow;
        }
        yield* Deferred.succeed(revokeGate, undefined);
        assert.equal((yield* Fiber.join(closing))._tag, "Success");

        // A same-id replacement for another thread opens once the pending
        // release cleared; the stale detach's join observes the old cleanup.
        yield* replacementFixture.open(providerSessionId);
        assert.equal((yield* Ref.get(state)).openCount, 2);

        assert.equal((yield* Fiber.await(detaching))._tag, "Success");

        // The emptied session's auto-release must not claim the replacement:
        // its runtime identity differs from the entry the detach removed.
        yield* Effect.forEach(Array.from({ length: 12 }), () => Effect.yieldNow, {
          discard: true,
        });
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      }).pipe(
        Effect.ensuring(Deferred.succeed(revokeGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            capabilities: ExclusiveCapabilities,
            mcpRegistryLayer,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 does not join a replacement session's cleanup from a stale detach",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const interruptEntered = yield* Deferred.make<void>();
      const interruptGate = yield* Deferred.make<void>();
      const closeEntered = yield* Deferred.make<void>();
      const closeGate = yield* Deferred.make<void>();
      const gateCloses = yield* Ref.make(false);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const now = yield* DateTime.now;
        const firstThreadId = ThreadId.make("thread-stale-join-first");
        const secondThreadId = ThreadId.make("thread-stale-join-second");
        const replacementThreadId = ThreadId.make("thread-stale-join-replacement");
        const first = yield* makeThreadSessionFixture(firstThreadId);
        const second = yield* makeThreadSessionFixture(secondThreadId);
        const replacement = yield* makeThreadSessionFixture(replacementThreadId);
        const providerSessionId = yield* first.allocate;
        const providerThread = makeProviderThread({
          idAllocator,
          threadId: firstThreadId,
          providerSessionId,
          now,
        });
        const runId = idAllocator.derive.run({ threadId: firstThreadId, ordinal: 1 });
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId: firstThreadId }),
              type: "provider-thread.updated",
              threadId: firstThreadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: providerThread,
            },
            {
              id: yield* idAllocator.allocate.event({ threadId: firstThreadId }),
              type: "provider-turn.updated",
              threadId: firstThreadId,
              runId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: {
                id: idAllocator.derive.providerTurn({
                  driver: CODEX_DRIVER,
                  nativeTurnId: "native-turn-stale-join",
                }),
                providerThreadId: providerThread.id,
                nodeId: idAllocator.derive.rootNode({ runId }),
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
        yield* first.open(providerSessionId);
        yield* second.open(providerSessionId);

        // Detach parks inside interruptTurn on session A. While it is parked:
        // A's own close completes, a same-id replacement B opens for another
        // thread, and B begins a gated cleanup of its own.
        const detachReturned = yield* Deferred.make<void>();
        const detaching = yield* manager
          .detach({ providerSessionId, threadId: firstThreadId })
          .pipe(
            Effect.tap(() => Deferred.succeed(detachReturned, undefined)),
            Effect.exit,
            Effect.forkChild,
          );
        yield* Deferred.await(interruptEntered);
        yield* manager.close(providerSessionId);
        yield* replacement.open(providerSessionId);
        yield* Ref.set(gateCloses, true);
        const closingB = yield* manager
          .close(providerSessionId)
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(closeEntered);

        // The detach's target is already gone; joining B's pending cleanup
        // would park this call on another session's shutdown.
        yield* Deferred.succeed(interruptGate, undefined);
        for (let i = 0; i < 12; i += 1) {
          yield* Effect.yieldNow;
        }
        assert.isTrue(yield* Deferred.isDone(detachReturned));
        assert.equal((yield* Fiber.await(detaching))._tag, "Success");

        yield* Deferred.succeed(closeGate, undefined);
        yield* Fiber.join(closingB);
        assert.equal((yield* Ref.get(state)).closeCount, 2);
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(interruptGate, undefined).pipe(
            Effect.andThen(Deferred.succeed(closeGate, undefined)),
          ),
        ),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            beforeInterrupt: Deferred.succeed(interruptEntered, undefined).pipe(
              Effect.andThen(Deferred.await(interruptGate)),
            ),
            beforeClose: Ref.get(gateCloses).pipe(
              Effect.flatMap((gate) =>
                gate
                  ? Deferred.succeed(closeEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(closeGate)),
                    )
                  : Effect.void,
              ),
            ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 does not let a stale turn failure idle a same-id replacement",
  () =>
    Effect.gen(function* () {
      const discriminated = yield* Ref.make(false);
      // Sweep scheduler suspension points on the stale turn fiber: the
      // discriminating window is anywhere the fiber is suspended before its
      // failure bookkeeping (markIdle) runs — resuming it after the
      // replacement opened makes the stale mark land on the replacement's
      // entry, where the runtime-identity guard must reject it. Points
      // inside the admitted adapter op keep `done` unfired, so the release
      // drain correctly waits on them instead.
      for (let ops = 30; ops < 110; ops += 1) {
        const state = yield* Ref.make(emptyState);
        const aTurnEntered = yield* Deferred.make<void>();
        const bTurnBusy = yield* Deferred.make<void>();
        const bTurnGate = yield* Deferred.make<void>();
        const bClosed = yield* Deferred.make<void>();
        const closes = yield* Ref.make(0);
        const firstThreadId = ThreadId.make(`thread-stale-idle-first-${ops}`);
        const replacementThreadId = ThreadId.make(`thread-stale-idle-replacement-${ops}`);
        yield* Effect.gen(function* () {
          const manager = yield* ProviderSessionManagerV2;
          const stepper = makeSteppingScheduler();
          const idAllocator = yield* IdAllocatorV2;
          const projectionStore = yield* ProjectionStoreV2;
          const now = yield* DateTime.now;
          const first = yield* makeThreadSessionFixture(firstThreadId);
          const replacement = yield* makeThreadSessionFixture(replacementThreadId);
          const providerSessionId = yield* first.allocate;
          const firstRuntime = yield* first.open(providerSessionId);
          yield* firstRuntime.events.pipe(Stream.runDrain, Effect.forkScoped);
          const firstProviderThread = makeProviderThread({
            idAllocator,
            threadId: firstThreadId,
            providerSessionId,
            now,
          });
          const firstAppThread = (yield* projectionStore.getThreadProjection(firstThreadId)).thread;
          const firstRunId = idAllocator.derive.run({ threadId: firstThreadId, ordinal: 1 });

          // A's turn runs on the stepping scheduler; the adapter operation
          // fails as soon as it is invoked so every suspension point after it
          // still has its failure bookkeeping outstanding.
          const aTurn = yield* firstRuntime
            .startTurn({
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
                messageId: yield* idAllocator.allocate.message({
                  threadId: firstThreadId,
                  ordinal: 1,
                }),
                text: "park me",
                attachments: [],
              },
              modelSelection,
              runtimePolicy,
            })
            .pipe(
              Effect.exit,
              Effect.forkDetach,
              Effect.provideService(Scheduler.Scheduler, stepper.scheduler),
            );
          const stepped = yield* stepper.step(aTurn, ops);
          if (!stepped) {
            yield* stepper.drain;
            yield* Fiber.await(aTurn);
            return;
          }

          // A closes while its turn is still in flight. When the turn is
          // parked inside its admitted adapter op the drain waits on it; when
          // it is parked before admission or after the op settled, the close
          // completes and the stale bookkeeping is left outstanding.
          const closing = yield* manager
            .close(providerSessionId)
            .pipe(Effect.exit, Effect.forkChild);
          for (let i = 0; i < 16; i += 1) yield* Effect.yieldNow;
          const closePolled = closing.pollUnsafe();
          const closeSucceeded =
            closePolled !== undefined &&
            Exit.isSuccess(closePolled) &&
            Exit.isSuccess(closePolled.value);
          if (!closeSucceeded) {
            yield* stepper.drain;
            yield* Fiber.await(closing);
            yield* Fiber.await(aTurn);
            return;
          }

          // The release finished while the stale turn's bookkeeping is still
          // suspended: open the same-id replacement and park its own turn
          // busy inside the adapter.
          const replacementRuntime = yield* replacement.open(providerSessionId);
          yield* replacementRuntime.events.pipe(Stream.runDrain, Effect.forkScoped);
          const replacementProviderThread = makeProviderThread({
            idAllocator,
            threadId: replacementThreadId,
            providerSessionId,
            now,
          });
          const replacementAppThread = (yield* projectionStore.getThreadProjection(
            replacementThreadId,
          )).thread;
          const replacementRunId = idAllocator.derive.run({
            threadId: replacementThreadId,
            ordinal: 1,
          });
          yield* replacementRuntime
            .startTurn({
              appThread: replacementAppThread,
              threadId: replacementThreadId,
              runId: replacementRunId,
              runOrdinal: 1,
              providerTurnOrdinal: 1,
              attemptId: idAllocator.derive.runAttempt({
                runId: replacementRunId,
                attemptOrdinal: 1,
              }),
              rootNodeId: idAllocator.derive.rootNode({ runId: replacementRunId }),
              providerThread: replacementProviderThread,
              message: {
                createdBy: "user",
                creationSource: "web",
                messageId: yield* idAllocator.allocate.message({
                  threadId: replacementThreadId,
                  ordinal: 1,
                }),
                text: "keep me busy",
                attachments: [],
              },
              modelSelection,
              runtimePolicy,
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(bTurnBusy);

          // Now let the stale fiber finish: its markIdle lands on the
          // replacement's entry and must be rejected by the runtime-identity
          // guard instead of decrementing the replacement's busy count.
          const aStillParked = aTurn.pollUnsafe() === undefined;
          yield* stepper.drain;
          const aExit = yield* Fiber.await(aTurn);
          assert.isTrue(
            Exit.isSuccess(aExit) && Exit.isFailure(aExit.value),
            `stale turn should end with its own failure (op ${ops})`,
          );
          if (aStillParked) {
            yield* Ref.set(discriminated, true);
          }

          // A stale markIdle that decremented the replacement's busy count
          // leaves it releasable while its own turn is still parked: any
          // activity on the replacement installs an idle probe that then
          // releases it within one idle window.
          yield* replacementRuntime.interruptTurn({
            providerThread: replacementProviderThread,
            providerTurnId: idAllocator.derive.providerTurn({
              driver: CODEX_DRIVER,
              nativeTurnId: `replacement-turn-${ops}`,
            }),
          });
          yield* TestClock.adjust("2 seconds");
          for (let i = 0; i < 12; i += 1) {
            yield* Effect.yieldNow;
          }
          assert.isFalse(yield* Deferred.isDone(bClosed));
          assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
          assert.equal((yield* Ref.get(state)).closeCount, 1);
        }).pipe(
          Effect.ensuring(Deferred.succeed(bTurnGate, undefined)),
          Effect.provide(
            makeTestLayer({
              state,
              idleTimeoutMs: 1_000,
              beforeClose: Ref.getAndUpdate(closes, (n) => n + 1).pipe(
                Effect.flatMap((n) =>
                  n + 1 === 2 ? Deferred.succeed(bClosed, undefined) : Effect.void,
                ),
              ),
              startTurn: (input) =>
                input.threadId === firstThreadId
                  ? Deferred.succeed(aTurnEntered, undefined).pipe(
                      Effect.andThen(
                        Effect.fail(
                          new ProviderAdapterTurnStartError({
                            driver: CODEX_DRIVER,
                            threadId: input.threadId,
                            providerThreadId: input.providerThread.id,
                            runId: input.runId,
                          }),
                        ),
                      ),
                    )
                  : Deferred.succeed(bTurnBusy, undefined).pipe(
                      Effect.andThen(Deferred.await(bTurnGate)),
                    ),
            }),
          ),
        );
      }
      assert.isTrue(
        yield* Ref.get(discriminated),
        "sweep never observed the stale turn parked through the replacement open",
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 does not let a late resume completion mark a replacement's thread loaded",
  () =>
    Effect.gen(function* () {
      const discriminated = yield* Ref.make(false);
      // Sweep scheduler suspension points: the discriminating window is the
      // boundary where the stale runtime's adapter op has settled (so the
      // release drain does not wait on it) but its loaded-thread bookkeeping
      // has not yet run — the mark then lands against the replacement's
      // entry, where the runtime-identity guard rejects it.
      for (let ops = 60; ops < 95; ops += 1) {
        const state = yield* Ref.make(emptyState);
        const resumeCalls = yield* Ref.make(0);
        yield* Effect.gen(function* () {
          const manager = yield* ProviderSessionManagerV2;
          const stepper = makeSteppingScheduler();
          const idAllocator = yield* IdAllocatorV2;
          const now = yield* DateTime.now;
          const threadId = ThreadId.make(`thread-late-resume-replacement-${ops}`);
          const first = yield* makeThreadSessionFixture(threadId);
          const providerSessionId = yield* first.allocate;
          const firstRuntime = yield* first.open(providerSessionId);
          yield* firstRuntime.events.pipe(Stream.runDrain, Effect.forkScoped);
          const resumeProviderThread = makeProviderThread({
            idAllocator,
            threadId,
            providerSessionId,
            now,
          });
          const aResume = yield* firstRuntime
            .resumeThread({ providerThread: resumeProviderThread, threadId })
            .pipe(
              Effect.exit,
              Effect.forkDetach,
              Effect.provideService(Scheduler.Scheduler, stepper.scheduler),
            );
          const stepped = yield* stepper.step(aResume, ops);
          if (!stepped) {
            yield* stepper.drain;
            yield* Fiber.await(aResume);
            return;
          }
          const closing = yield* manager
            .close(providerSessionId)
            .pipe(Effect.exit, Effect.forkChild);
          for (let i = 0; i < 16; i += 1) yield* Effect.yieldNow;
          const closePolled = closing.pollUnsafe();
          const closeSucceeded =
            closePolled !== undefined &&
            Exit.isSuccess(closePolled) &&
            Exit.isSuccess(closePolled.value);
          if (!closeSucceeded) {
            // The suspended resume is still inside its admitted operation —
            // the release drain is correctly waiting on it.
            yield* stepper.drain;
            yield* Fiber.await(closing);
            yield* Fiber.await(aResume);
            return;
          }
          // The op settled and the release finished while the resume's mark
          // is still suspended: open the replacement, then let the stale
          // bookkeeping land against it.
          const replacementRuntime = yield* first.open(providerSessionId);
          yield* replacementRuntime.events.pipe(Stream.runDrain, Effect.forkScoped);
          const resumeStillParked = aResume.pollUnsafe() === undefined;
          yield* stepper.drain;
          assert.isDefined(
            aResume.pollUnsafe(),
            `resume fiber still suspended after drain (op ${ops})`,
          );
          // The stale resume ends honestly either way: admitted before the
          // claim it completes with a mark the replacement's entry rejects,
          // or the admission fence refuses it with a protocol error once the
          // entry is gone. What must not happen is its bookkeeping landing in
          // the replacement's loaded-thread cache.
          const resumeExit = yield* Fiber.await(aResume);
          // The discriminating iteration is the one where the stale resume
          // was still suspended when the drain ran — so its mark lands after
          // the replacement opened — and its adapter op had actually
          // completed. A refused admission (inner Failure) never reaches the
          // mark, and a resume that finished during `step` marked the dead
          // entry; neither exercises the runtime-identity guard.
          if (resumeStillParked && Exit.isSuccess(resumeExit) && Exit.isSuccess(resumeExit.value)) {
            yield* Ref.set(discriminated, true);
          }
          const beforeReplacement = yield* Ref.get(state);
          yield* replacementRuntime.resumeThread({
            providerThread: resumeProviderThread,
            threadId,
          });
          assert.equal(
            (yield* Ref.get(state)).resumeCount,
            beforeReplacement.resumeCount + 1,
            `stale resume marked the replacement's thread loaded (op ${ops})`,
          );
        }).pipe(
          Effect.provide(
            makeTestLayer({
              state,
              idleTimeoutMs: 3_600_000,
              resumeThread: (input) =>
                Ref.getAndUpdate(resumeCalls, (n) => n + 1).pipe(
                  Effect.andThen(
                    Ref.update(state, (current) => ({
                      ...current,
                      resumeCount: current.resumeCount + 1,
                    })),
                  ),
                  Effect.as(input.providerThread),
                ),
            }),
          ),
        );
      }
      assert.isTrue(
        yield* Ref.get(discriminated),
        "sweep found no boundary where the release finished before the mark ran",
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 does not clear a replacement session's MCP config from a stale detach",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const interruptEntered = yield* Deferred.make<void>();
      const interruptGate = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-stale-detach-config");
        const peerThreadId = ThreadId.make("thread-stale-detach-config-peer");
        const first = yield* makeThreadSessionFixture(threadId);
        const peer = yield* makeThreadSessionFixture(peerThreadId);
        const providerSessionId = yield* first.allocate;
        const providerThread = makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now,
        });
        const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: providerThread,
            },
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "provider-turn.updated",
              threadId,
              runId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: {
                id: idAllocator.derive.providerTurn({
                  driver: CODEX_DRIVER,
                  nativeTurnId: "native-turn-stale-config",
                }),
                providerThreadId: providerThread.id,
                nodeId: idAllocator.derive.rootNode({ runId }),
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
        yield* first.open(providerSessionId);
        yield* peer.open(providerSessionId);

        // The terminal detach parks inside interruptTurn holding no locks.
        // While it is parked the session closes and a same-id replacement
        // re-opens the same thread, configuring a fresh credential.
        const detaching = yield* manager
          .detach({ providerSessionId, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(interruptEntered);
        yield* manager.close(providerSessionId);
        yield* first.open(providerSessionId);
        const replacementConfig = McpProviderSession.readMcpProviderSession(threadId);
        assert.isDefined(replacementConfig);

        yield* Deferred.succeed(interruptGate, undefined);
        assert.equal((yield* Fiber.await(detaching))._tag, "Success");

        // The stale detach's credential sweep must not clear the slot the
        // replacement configured for the thread.
        assert.equal(
          McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId,
          replacementConfig!.providerSessionId,
        );
        assert.isDefined(
          yield* registry.resolve(replacementConfig!.authorizationHeader.replace(/^Bearer\s+/, "")),
        );
      }).pipe(
        Effect.ensuring(Deferred.succeed(interruptGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            beforeInterrupt: Deferred.succeed(interruptEntered, undefined).pipe(
              Effect.andThen(Deferred.await(interruptGate)),
            ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 does not re-arm a same-id replacement's idle release from a stale detach",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const revoking = yield* Deferred.make<void>();
      const revokeGate = yield* Deferred.make<void>();
      const pauseRevoke = yield* Ref.make(true);
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            revokeProviderSession: (providerSessionId) =>
              Ref.getAndSet(pauseRevoke, false).pipe(
                Effect.flatMap((pause) =>
                  pause
                    ? Deferred.succeed(revoking, undefined).pipe(
                        Effect.andThen(Deferred.await(revokeGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.revokeProviderSession(providerSessionId)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const firstThreadId = ThreadId.make("thread-stale-sched-first");
        const secondThreadId = ThreadId.make("thread-stale-sched-second");
        const replacementThreadId = ThreadId.make("thread-stale-sched-replacement");
        const first = yield* makeThreadSessionFixture(firstThreadId);
        const second = yield* makeThreadSessionFixture(secondThreadId);
        const replacement = yield* makeThreadSessionFixture(replacementThreadId);
        const providerSessionId = yield* first.allocate;
        yield* first.open(providerSessionId);
        yield* second.open(providerSessionId);

        // Detaching one thread from the shared session leaves the session
        // live for the second thread, so the detach tail reschedules idle
        // release. Park it inside the gated credential revocation.
        const detaching = yield* manager
          .detach({ providerSessionId, threadId: firstThreadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(revoking);

        // The session closes and a same-id replacement opens for another
        // thread while the stale detach is still parked.
        yield* manager.close(providerSessionId);
        yield* replacement.open(providerSessionId);

        // Advance the clock so the replacement's own idle probe is due before
        // the stale detach resumes; a re-armed timer would push it past this.
        yield* TestClock.adjust("500 millis");
        yield* Deferred.succeed(revokeGate, undefined);
        assert.equal((yield* Fiber.await(detaching))._tag, "Success");
        yield* TestClock.adjust("600 millis");
        for (let i = 0; i < 12; i += 1) {
          yield* Effect.yieldNow;
        }

        // The replacement's own idle schedule released it at its original
        // deadline; a stale re-arm would leave it live until 1500ms.
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 2);
      }).pipe(
        Effect.ensuring(Deferred.succeed(revokeGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            mcpRegistryLayer,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 does not let an orphaned idle timer release a same-id replacement",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const firstProbe = yield* Ref.make(true);
      const probeCalls = yield* Ref.make(0);
      const probeEntered = yield* Deferred.make<void>();
      const probeGate = yield* Deferred.make<void>();
      const effect = Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const idAllocator = yield* IdAllocatorV2;
        const threadId = ThreadId.make("thread-orphaned-idle-timer");
        const fixture = yield* makeThreadSessionFixture(threadId);
        const providerSessionId = yield* fixture.allocate;
        const runtimeA = yield* fixture.open(providerSessionId);
        const providerThread = makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now: yield* DateTime.now,
        });
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "orphan-idle-turn",
        });

        // A's idle timer fires and parks inside an uninterruptible probe.
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(probeEntered);

        // Two schedulers both block interrupting that probe fiber. When the
        // gate opens the pending interrupts kill it before it can release A,
        // so both schedulers resume against a live entry: one installs its
        // timer (generation 2, now tracked) and the other's install is
        // displaced. Without loser-cancellation the displaced timer survives
        // as an orphaned callback; the close below only cancels the tracked
        // one.
        const s1 = yield* runtimeA
          .interruptTurn({ providerThread, providerTurnId })
          .pipe(Effect.exit, Effect.forkChild);
        const s2 = yield* runtimeA
          .interruptTurn({ providerThread, providerTurnId })
          .pipe(Effect.exit, Effect.forkChild);
        for (let i = 0; i < 20; i += 1) {
          yield* Effect.yieldNow;
        }
        yield* Deferred.succeed(probeGate, undefined);
        yield* Fiber.join(s1);
        yield* Fiber.join(s2);
        // A is still live: the interrupted probe never reached releaseEntry.
        assert.equal((yield* Ref.get(state)).closeCount, 0);

        yield* manager.close(providerSessionId);
        assert.equal((yield* Ref.get(state)).closeCount, 1);

        // Open the same-id replacement half a window before the orphan's
        // deadline so its own idle timer (due at T0+2.5s) stays behind it,
        // then bump its generation to 2 to match the orphan's. Observe through
        // closeCount, not manager.get: get touches activity and would re-arm
        // the timer being measured.
        yield* TestClock.adjust("500 millis");
        const runtimeB = yield* fixture.open(providerSessionId);
        yield* runtimeB.interruptTurn({ providerThread, providerTurnId }).pipe(Effect.ignore);

        // Orphan deadline. Pinned to A's runtime it must bail before probing
        // the replacement; unguarded it reads B's entry at generation 2 and
        // releases it ahead of B's own timer.
        yield* TestClock.adjust("500 millis");
        for (let i = 0; i < 12; i += 1) {
          yield* Effect.yieldNow;
        }
        assert.equal(yield* Ref.get(probeCalls), 1);
        assert.equal((yield* Ref.get(state)).closeCount, 1);

        // The replacement's own idle release still fires on schedule.
        yield* TestClock.adjust("500 millis");
        for (let i = 0; i < 12; i += 1) {
          yield* Effect.yieldNow;
        }
        assert.equal(yield* Ref.get(probeCalls), 2);
        assert.equal((yield* Ref.get(state)).closeCount, 2);
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            hasPendingBackgroundWork: Effect.uninterruptible(
              Effect.gen(function* () {
                yield* Ref.update(probeCalls, (calls) => calls + 1);
                if (yield* Ref.getAndSet(firstProbe, false)) {
                  yield* Deferred.succeed(probeEntered, undefined);
                  yield* Deferred.await(probeGate);
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
  "ProviderSessionManagerV2 keeps idle cleanup armed when a rescheduler is interrupted",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const firstProbe = yield* Ref.make(true);
      const probeEntered = yield* Deferred.make<void>();
      const probeGate = yield* Deferred.make<void>();
      const effect = Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const threadId = ThreadId.make("thread-interrupted-rescheduler");
        const fixture = yield* makeThreadSessionFixture(threadId);
        const providerSessionId = yield* fixture.allocate;
        yield* fixture.open(providerSessionId);

        // The session's idle timer fires and parks inside the uninterruptible
        // pending-work probe.
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(probeEntered);

        // get() touches activity, so its rescheduler blocks interrupting that
        // probe fiber. Interrupting the lookup must not leave the entry
        // pointing at a dead timer with no replacement installed.
        const getting = yield* manager.get(providerSessionId).pipe(Effect.exit, Effect.forkChild);
        for (let i = 0; i < 20; i += 1) {
          yield* Effect.yieldNow;
        }
        const interrupting = yield* Fiber.interrupt(getting).pipe(Effect.forkChild);
        for (let i = 0; i < 10; i += 1) {
          yield* Effect.yieldNow;
        }
        yield* Deferred.succeed(probeGate, undefined);
        yield* Fiber.join(interrupting);
        yield* Fiber.await(getting);

        // The rescheduler must have installed a replacement timer before it
        // could be interrupted away: the session still idles out.
        yield* TestClock.adjust("1 second");
        for (let i = 0; i < 12; i += 1) {
          yield* Effect.yieldNow;
        }
        assert.equal((yield* Ref.get(state)).closeCount, 1);
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            hasPendingBackgroundWork: Effect.uninterruptible(
              Effect.gen(function* () {
                if (yield* Ref.getAndSet(firstProbe, false)) {
                  yield* Deferred.succeed(probeEntered, undefined);
                  yield* Deferred.await(probeGate);
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
  "ProviderSessionManagerV2 releases an exclusive session when its terminal detach is interrupted",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const revoking = yield* Deferred.make<void>();
      const revokeGate = yield* Deferred.make<void>();
      const pauseRevoke = yield* Ref.make(false);
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            revokeProviderSession: (providerSessionId) =>
              Ref.getAndSet(pauseRevoke, false).pipe(
                Effect.flatMap((pause) =>
                  pause
                    ? Deferred.succeed(revoking, undefined).pipe(
                        Effect.andThen(Deferred.await(revokeGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.revokeProviderSession(providerSessionId)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const threadId = ThreadId.make("thread-interrupted-terminal-detach");
        const fixture = yield* makeThreadSessionFixture(threadId);
        const providerSessionId = yield* fixture.allocate;
        yield* fixture.open(providerSessionId);

        yield* Ref.set(pauseRevoke, true);
        // The terminal detach removes the last attachment and prunes the
        // credential record, then parks joining the detached revocation.
        const detaching = yield* manager
          .detach({ providerSessionId, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(revoking);

        // Interrupting the revocation wait must not strand the emptied
        // exclusive session: the release handoff already happened, so the
        // forked cleanup completes without this caller.
        yield* Fiber.interrupt(detaching);
        yield* Deferred.succeed(revokeGate, undefined);
        for (let i = 0; i < 12; i += 1) {
          yield* Effect.yieldNow;
        }
        assert.equal((yield* Ref.get(state)).closeCount, 1);
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));

        // A retry finds nothing left to release: the handoff already ran.
        yield* manager.detach({ providerSessionId, threadId });
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      }).pipe(
        Effect.ensuring(Deferred.succeed(revokeGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            capabilities: ExclusiveCapabilities,
            mcpRegistryLayer,
          }),
        ),
      );
    }),
);

for (const operation of ["close", "detach"] as const) {
  it.effect(
    `ProviderSessionManagerV2 ${operation} during provider startup joins the in-flight open's cleanup`,
    () =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        const mcpConfigs = yield* Ref.make<
          ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
        >([]);
        const duringOpen = yield* Ref.make<Effect.Effect<void>>(Effect.void);
        const openEntered = yield* Deferred.make<void>();
        const openGate = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          const manager = yield* ProviderSessionManagerV2;
          const registry = yield* McpSessionRegistry.McpSessionRegistry;
          const threadId = ThreadId.make(`thread-open-startup-${operation}`);
          const { allocate, open } = yield* makeThreadSessionFixture(threadId);
          const providerSessionId = yield* allocate;
          yield* Ref.set(
            duringOpen,
            Deferred.succeed(openEntered, undefined).pipe(Effect.andThen(Deferred.await(openGate))),
          );
          const opening = yield* open(providerSessionId).pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(openEntered);

          // The provider process is spawning with a held credential
          // reservation but no live entry: the release must mark the startup
          // and join its unwind, not report success over owned resources.
          const releasing = yield* (
            operation === "close"
              ? manager.close(providerSessionId)
              : manager.detach({ providerSessionId, threadId })
          ).pipe(Effect.exit, Effect.forkChild);
          for (let i = 0; i < 4; i += 1) {
            yield* Effect.yieldNow;
          }
          yield* Deferred.succeed(openGate, undefined);

          const releaseExit = yield* Fiber.join(releasing);
          const openExit = yield* Fiber.join(opening);
          assert.isTrue(Exit.isSuccess(releaseExit));
          assert.isTrue(Exit.isFailure(openExit));

          // The spawned provider's scope was closed by the startup unwind and
          // its reserved credential swept — nothing is left live or unowned.
          assert.equal((yield* Ref.get(state)).closeCount, 1);
          assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
          const issued = (yield* Ref.get(mcpConfigs)).at(-1);
          const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
          assert.isDefined(token);
          assert.isUndefined(yield* registry.resolve(token!));
          assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));

          // With the startup settled, a replacement open proceeds.
          yield* open(providerSessionId);
          assert.equal((yield* Ref.get(state)).openCount, 2);
          yield* manager.close(providerSessionId);
        }).pipe(
          Effect.ensuring(Deferred.succeed(openGate, undefined)),
          Effect.provide(
            makeTestLayer({
              state,
              idleTimeoutMs: 3_600_000,
              capabilities: ExclusiveCapabilities,
              mcpConfigs,
              beforeOpen: () =>
                Ref.get(duringOpen).pipe(
                  Effect.flatten,
                  Effect.tap(() => Ref.set(duringOpen, Effect.void)),
                ),
            }),
          ),
        );
      }),
  );
}

it.effect(
  "ProviderSessionManagerV2 keeps failed startup cleanup visible and blocks replacement",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const poisonOpen = yield* Ref.make(true);
      const poisonClose = yield* Ref.make(true);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const threadId = ThreadId.make("thread-open-startup-failed-cleanup");
        const { allocate, open } = yield* makeThreadSessionFixture(threadId);
        const providerSessionId = yield* allocate;
        const replacementId = yield* allocate;

        // openSession fails after registering its scope finalizers, and the
        // scope close itself defects: the startup cleanup cannot complete, so
        // the provider process and its credential may still be owned.
        const openExit = yield* open(providerSessionId).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(openExit));
        assert.equal((yield* Ref.get(state)).closeCount, 1);

        // The failed startup record blocks replacement by session id and by
        // thread, and a close retry surfaces the recorded cleanup failure.
        assert.equal(
          (yield* open(providerSessionId).pipe(Effect.flip))._tag,
          "ProviderSessionOpenError",
        );
        assert.equal(
          (yield* open(replacementId).pipe(Effect.flip))._tag,
          "ProviderSessionOpenError",
        );
        assert.equal(
          (yield* manager.close(providerSessionId).pipe(Effect.flip))._tag,
          "ProviderSessionCloseError",
        );
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));

        // The unclaimed credential was still swept even though the scope close
        // failed: the record stays only for the provider resources.
        const issued = (yield* Ref.get(mcpConfigs)).at(-1);
        const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(token);
        assert.isUndefined(yield* registry.resolve(token!));
        assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
      }).pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            capabilities: ExclusiveCapabilities,
            mcpConfigs,
            afterOpen: Ref.getAndSet(poisonOpen, false).pipe(
              Effect.flatMap((armed) =>
                armed ? Effect.die("provider spawn blew up") : Effect.void,
              ),
            ),
            beforeClose: Ref.getAndSet(poisonClose, false).pipe(
              Effect.flatMap((armed) =>
                armed ? Effect.die("provider process did not exit") : Effect.void,
              ),
            ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 terminal detach bounds the credential revocation wait when the session stays live",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const pauseSettings = yield* Ref.make(false);
      const preparing = yield* Deferred.make<void>();
      const prepareGate = yield* Deferred.make<void>();
      const settingsLayer = Layer.effect(
        ServerSettings.ServerSettingsService,
        Effect.gen(function* () {
          const delegate = yield* ServerSettings.ServerSettingsService;
          return ServerSettings.ServerSettingsService.of({
            ...delegate,
            getSettings: Ref.get(pauseSettings).pipe(
              Effect.flatMap((pause) =>
                pause
                  ? Deferred.succeed(preparing, undefined).pipe(
                      Effect.andThen(Deferred.await(prepareGate)),
                    )
                  : Effect.void,
              ),
              Effect.andThen(delegate.getSettings),
            ),
          });
        }),
      ).pipe(Layer.provide(ServerSettings.layerTest({ enableAgentBrowserAccess: true })));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const idAllocator = yield* IdAllocatorV2;
        const threadId = ThreadId.make("thread-detach-revoke-bounded");
        const peerThreadId = ThreadId.make("thread-detach-revoke-bounded-peer");
        const first = yield* makeThreadSessionFixture(threadId);
        const peer = yield* makeThreadSessionFixture(peerThreadId);
        const providerSessionId = yield* first.allocate;
        // Multi-thread session with two attachments: detaching one leaves the
        // session live, so no release owns the pruned credential's sweep.
        yield* first.open(providerSessionId);
        yield* peer.open(providerSessionId, peerThreadId);
        const issued = (yield* Ref.get(mcpConfigs)).find((config) => config?.threadId === threadId);
        const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(token);

        // A peer open for the same thread parks inside prepareMcpSession
        // holding mcpPrepareLock[threadId] — the lock the detach's revocation
        // sweep must acquire.
        yield* Ref.set(pauseSettings, true);
        const peerId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const peerOpening = yield* manager
          .open({ threadId, providerSessionId: peerId, modelSelection, runtimePolicy })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(preparing);

        const detaching = yield* manager
          .detach({ providerSessionId, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        for (let i = 0; i < 8; i += 1) {
          yield* Effect.yieldNow;
        }
        // The revocation is parked behind the stalled peer prepare; the detach
        // must report the unfinished cleanup within the 30-second bound
        // instead of waiting on the peer lock indefinitely.
        yield* TestClock.adjust("30 seconds");
        for (let i = 0; i < 8; i += 1) {
          yield* Effect.yieldNow;
        }
        assert.equal((yield* Fiber.join(detaching))._tag, "Failure");

        // The session stays live for the remaining attachment — only the
        // revocation was bounded, not the detach's entry update.
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));

        // Late success: once the peer releases the lock, the detached sweep
        // clears the thread's binding while the credential survives for its
        // remaining holder.
        yield* Deferred.succeed(prepareGate, undefined);
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(peerOpening)));
        for (let i = 0; i < 12; i += 1) {
          yield* Effect.yieldNow;
        }
        assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
        assert.isDefined(yield* registry.resolve(token!));
      }).pipe(
        Effect.ensuring(Deferred.succeed(prepareGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpConfigs,
            serverSettingsLayer: settingsLayer,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 bounds an exclusive terminal detach when the forked release stalls",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const pauseSettings = yield* Ref.make(false);
      const preparing = yield* Deferred.make<void>();
      const prepareGate = yield* Deferred.make<void>();
      const settingsLayer = Layer.effect(
        ServerSettings.ServerSettingsService,
        Effect.gen(function* () {
          const delegate = yield* ServerSettings.ServerSettingsService;
          return ServerSettings.ServerSettingsService.of({
            ...delegate,
            getSettings: Ref.get(pauseSettings).pipe(
              Effect.flatMap((pause) =>
                pause
                  ? Deferred.succeed(preparing, undefined).pipe(
                      Effect.andThen(Deferred.await(prepareGate)),
                    )
                  : Effect.void,
              ),
              Effect.andThen(delegate.getSettings),
            ),
          });
        }),
      ).pipe(Layer.provide(ServerSettings.layerTest({ enableAgentBrowserAccess: true })));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const idAllocator = yield* IdAllocatorV2;
        const threadId = ThreadId.make("thread-detach-exclusive-revoke-bounded");
        const { allocate, open } = yield* makeThreadSessionFixture(threadId);
        const providerSessionId = yield* allocate;
        yield* open(providerSessionId);

        // A peer open for the same thread parks inside prepareMcpSession
        // holding threadLifecycle[threadId] and mcpPrepareLock[threadId] —
        // the release's open drain and its credential sweep both wait behind
        // it, so the release can never reach its scope close.
        yield* Ref.set(pauseSettings, true);
        const peerId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* manager
          .open({ threadId, providerSessionId: peerId, modelSelection, runtimePolicy })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(preparing);

        // The exclusive session's last detach forks the release and joins it;
        // the release is parked behind the stalled peer. The detach must
        // report the unfinished cleanup within the 30-second bound — the
        // release keeps running and keeps ownership.
        const detaching = yield* manager
          .detach({ providerSessionId, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        for (let i = 0; i < 8; i += 1) {
          yield* Effect.yieldNow;
        }
        yield* TestClock.adjust("30 seconds");
        for (let i = 0; i < 8; i += 1) {
          yield* Effect.yieldNow;
        }
        assert.equal((yield* Fiber.join(detaching))._tag, "Failure");
      }).pipe(
        Effect.ensuring(Deferred.succeed(prepareGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            capabilities: ExclusiveCapabilities,
            mcpConfigs,
            serverSettingsLayer: settingsLayer,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps the detached thread's ownership when close races the last detach",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const hangClose = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const stepper = makeSteppingScheduler();
        // The window sits between the detach's attachment mutation and the
        // release claim its forked worker performs. Stepping the outer detach
        // fiber cannot reach it — the mutation and the fork share one op
        // boundary and the worker's claim then runs during the same task
        // drain. The discriminating pause is inside the fibers the detach
        // spawns: hold the first spawned fiber at each of its own op offsets
        // (offset 19 parks the detach's timeout worker after the mutation and
        // before the release claim; later offsets hold the scope-close
        // worker), let a racing close claim first, then check the pending
        // record still covers this thread.
        for (let childOps = 0; childOps < 48; childOps++) {
          const threadId = ThreadId.make(`thread-detach-close-claim-${childOps}`);
          const fixture = yield* makeThreadSessionFixture(threadId);
          const providerSessionId = yield* fixture.allocate;
          const replacementId = yield* fixture.allocate;
          yield* fixture.open(providerSessionId);

          const detaching = yield* manager
            .detach({ providerSessionId, threadId, revokeMcpCredential: true })
            .pipe(
              Effect.exit,
              Effect.forkDetach,
              Effect.provideService(Scheduler.Scheduler, stepper.scheduler),
            );
          stepper.aim(detaching, Number.MAX_SAFE_INTEGER);
          stepper.holdSpawnedAt(childOps);
          yield* stepper.drain;

          // Interleave a close while the spawned release worker is held: it
          // claims the emptied entry or joins the pending release — either
          // way the parked scope close keeps the record alive for the gate
          // check below.
          const closing = yield* manager
            .close(providerSessionId)
            .pipe(Effect.exit, Effect.forkChild);
          // Ambient turns for the close's claim — a synchronous map write a
          // few scheduler turns in — before the held worker resumes.
          for (let i = 0; i < 24; i += 1) {
            yield* Effect.yieldNow;
          }
          stepper.resumeSpawned();
          yield* stepper.drain;
          for (let i = 0; i < 24; i += 1) {
            yield* Effect.yieldNow;
          }

          const replacing = yield* manager
            .open({
              providerSessionId: replacementId,
              threadId,
              modelSelection,
              runtimePolicy,
            })
            .pipe(Effect.exit, Effect.forkChild);
          for (let i = 0; i < 12; i += 1) {
            yield* Effect.yieldNow;
          }
          const openExit = yield* Fiber.join(replacing);
          assert.equal(
            openExit._tag,
            "Failure",
            `close interleaved while the release worker was held at op ${childOps} let a same-thread replacement open during cleanup`,
          );

          yield* TestClock.adjust("30 seconds");
          stepper.resumeSpawned();
          yield* stepper.drain;
          yield* Fiber.join(detaching);
          yield* Fiber.join(closing);
        }
      }).pipe(
        Effect.ensuring(Deferred.succeed(hangClose, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            capabilities: ExclusiveCapabilities,
            hangSessionScopeClose: hangClose,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 fences a startup that finishes opening while shutdown is busy closing another session",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const openEntered = yield* Deferred.make<void>();
      const openGate = yield* Deferred.make<void>();
      const closeEntered = yield* Deferred.make<void>();
      const closeGate = yield* Deferred.make<void>();
      // beforeOpen runs for every session: park only the second open (B's)
      // so A can register normally. beforeClose is likewise shared: park the
      // first close (A's) so B's fenced unwind can still complete.
      const opens = yield* Ref.make(0);
      const closes = yield* Ref.make(0);

      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const a = yield* makeThreadSessionFixture(ThreadId.make("thread-shutdown-startup-race-a"));
        const b = yield* makeThreadSessionFixture(ThreadId.make("thread-shutdown-startup-race-b"));
        const aId = yield* a.allocate;
        yield* a.open(aId);
        const bId = yield* b.allocate;
        const bOpening = yield* b.open(bId).pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(openEntered);
        const stopping = yield* manager.shutdown.pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(closeEntered);
        // Shutdown marked B's startup record before releasing A. Letting B's
        // open resume now must not register a live session behind the
        // shutdown's back.
        yield* Deferred.succeed(openGate, undefined);
        assert.equal((yield* Fiber.join(bOpening))._tag, "Failure");
        yield* Deferred.succeed(closeGate, undefined);
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(stopping)));
        assert.isTrue(Option.isNone(yield* manager.get(bId)));
        // A's scope and B's fenced startup scope were both closed.
        assert.equal((yield* Ref.get(state)).closeCount, 2);
      }).pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            beforeOpen: () =>
              Ref.modify(opens, (n) => [n === 1, n + 1] as const).pipe(
                Effect.andThen((second) =>
                  second
                    ? Deferred.succeed(openEntered, undefined).pipe(
                        Effect.andThen(Deferred.await(openGate)),
                      )
                    : Effect.void,
                ),
              ),
            beforeClose: Ref.modify(closes, (n) => [n === 0, n + 1] as const).pipe(
              Effect.andThen((first) =>
                first
                  ? Deferred.succeed(closeEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(closeGate)),
                    )
                  : Effect.void,
              ),
            ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 fences a startup that finishes opening while closeInstance is busy closing another session",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const openEntered = yield* Deferred.make<void>();
      const openGate = yield* Deferred.make<void>();
      const closeEntered = yield* Deferred.make<void>();
      const closeGate = yield* Deferred.make<void>();
      const opens = yield* Ref.make(0);
      const closes = yield* Ref.make(0);

      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const a = yield* makeThreadSessionFixture(
          ThreadId.make("thread-closeinstance-startup-race-a"),
        );
        const b = yield* makeThreadSessionFixture(
          ThreadId.make("thread-closeinstance-startup-race-b"),
        );
        const aId = yield* a.allocate;
        yield* a.open(aId);
        const bId = yield* b.allocate;
        const bOpening = yield* b.open(bId).pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(openEntered);
        const closing = yield* manager
          .closeInstance(modelSelection.instanceId)
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(closeEntered);
        yield* Deferred.succeed(openGate, undefined);
        assert.equal((yield* Fiber.join(bOpening))._tag, "Failure");
        yield* Deferred.succeed(closeGate, undefined);
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(closing)));
        assert.isTrue(Option.isNone(yield* manager.get(bId)));
        assert.equal((yield* Ref.get(state)).closeCount, 2);
        // The fence is transient: once the instance close settles, a fresh
        // open for it proceeds.
        const c = yield* makeThreadSessionFixture(
          ThreadId.make("thread-closeinstance-startup-race-c"),
        );
        const cId = yield* c.allocate;
        yield* c.open(cId);
        assert.isTrue(Option.isSome(yield* manager.get(cId)));
      }).pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            beforeOpen: () =>
              Ref.modify(opens, (n) => [n === 1, n + 1] as const).pipe(
                Effect.andThen((second) =>
                  second
                    ? Deferred.succeed(openEntered, undefined).pipe(
                        Effect.andThen(Deferred.await(openGate)),
                      )
                    : Effect.void,
                ),
              ),
            beforeClose: Ref.modify(closes, (n) => [n === 0, n + 1] as const).pipe(
              Effect.andThen((first) =>
                first
                  ? Deferred.succeed(closeEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(closeGate)),
                    )
                  : Effect.void,
              ),
            ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 blocks a same-thread attach while a failed startup is still unwinding",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const unwinding = yield* Deferred.make<void>();
      const unwindGate = yield* Deferred.make<void>();
      const opens = yield* Ref.make(0);

      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const threadId = ThreadId.make("thread-failed-startup-unwind");
        const peerThreadId = ThreadId.make("thread-failed-startup-unwind-peer");
        const failing = yield* makeThreadSessionFixture(threadId);
        const peer = yield* makeThreadSessionFixture(peerThreadId);
        const failedId = yield* failing.allocate;
        // The first openSession defects; its scope close parks at
        // beforeClose, so the startup keeps owning provider resources for
        // the thread until the unwind finishes.
        const opening = yield* failing.open(failedId).pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(unwinding);
        const peerId = yield* peer.allocate;
        const peerRuntime = yield* peer.open(peerId);
        // The runtime attach path does not wait on the doomed open's
        // lifecycle lock; it must be rejected by the startup mark alone.
        const attachExit = yield* peerRuntime
          .ensureThread({ threadId, modelSelection, runtimePolicy })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(attachExit));
        if (Exit.isFailure(attachExit)) {
          const failure = Cause.findErrorOption(attachExit.cause);
          assert.isTrue(Option.isSome(failure));
          if (Option.isSome(failure)) {
            assert.include(
              failure.value._tag === "ProviderAdapterProtocolError" ? failure.value.detail : "",
              "cleanup",
            );
          }
        }
        yield* Deferred.succeed(unwindGate, undefined);
        assert.equal((yield* Fiber.join(opening))._tag, "Failure");
        // Once the unwind completed, the thread is free to attach again.
        yield* peerRuntime
          .ensureThread({ threadId, modelSelection, runtimePolicy })
          .pipe(Effect.ignore);
        assert.isTrue(Option.isSome(yield* manager.get(peerId)));
      }).pipe(
        Effect.ensuring(Deferred.succeed(unwindGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            // afterOpen runs after the adapter registered its finalizers, so
            // the defecting session still owns a scope that must be closed.
            afterOpen: Ref.modify(opens, (n) => [n === 0, n + 1] as const).pipe(
              Effect.andThen((first) =>
                first ? Effect.die(new Error("startup defect")) : Effect.void,
              ),
            ),
            beforeClose: Deferred.succeed(unwinding, undefined).pipe(
              Effect.andThen(Deferred.await(unwindGate)),
            ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 rejects an attach that queued behind a doomed startup's mark",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const openEntered = yield* Deferred.make<void>();
      const openGate = yield* Deferred.make<void>();
      const preparing = yield* Deferred.make<void>();
      const prepareGate = yield* Deferred.make<void>();
      const pauseSettings = yield* Ref.make(false);
      const opens = yield* Ref.make(0);
      const settingsLayer = Layer.effect(
        ServerSettings.ServerSettingsService,
        Effect.gen(function* () {
          const delegate = yield* ServerSettings.ServerSettingsService;
          return ServerSettings.ServerSettingsService.of({
            ...delegate,
            getSettings: Ref.get(pauseSettings).pipe(
              Effect.flatMap((pause) =>
                pause
                  ? Deferred.succeed(preparing, undefined).pipe(
                      Effect.andThen(Deferred.await(prepareGate)),
                    )
                  : Effect.void,
              ),
              Effect.andThen(delegate.getSettings),
            ),
          });
        }),
      ).pipe(Layer.provide(ServerSettings.layerTest({ enableAgentBrowserAccess: true })));

      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const startupThreadId = ThreadId.make("thread-queued-attach-startup");
        const peerThreadId = ThreadId.make("thread-queued-attach-peer");
        const startup = yield* makeThreadSessionFixture(startupThreadId);
        const peer = yield* makeThreadSessionFixture(peerThreadId);
        const startupId = yield* startup.allocate;
        // The startup parks inside openSession with its record tracked but
        // unmarked — runtime attaches for its thread still pass the guard.
        const startupOpening = yield* startup.open(startupId).pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(openEntered);
        const peerId = yield* peer.allocate;
        const peerRuntime = yield* peer.open(peerId);
        yield* Ref.set(pauseSettings, true);
        // Attach #1 passes the guard before the close lands, then parks in
        // credential preparation holding the session+thread attach lock.
        const firstAttach = yield* peerRuntime
          .ensureThread({ threadId: startupThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(preparing);
        // Attach #2 queues behind the lock while the guard still passes.
        const secondAttach = yield* peerRuntime
          .ensureThread({ threadId: startupThreadId, modelSelection, runtimePolicy })
          .pipe(Effect.exit, Effect.forkChild);
        for (let i = 0; i < 4; i += 1) {
          yield* Effect.yieldNow;
        }
        // Close marks the startup and joins its unwind; the unwind never
        // finishes because the open stays parked, so the mark outlives the
        // close's own bounded wait.
        const closing = yield* manager.close(startupId).pipe(Effect.exit, Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        assert.equal((yield* Fiber.join(closing))._tag, "Failure");
        // Letting attach #1 finish preparation must not resurrect the thread:
        // the atomic recheck sees the doomed startup's mark.
        yield* Deferred.succeed(prepareGate, undefined);
        const firstExit = yield* Fiber.join(firstAttach);
        const secondExit = yield* Fiber.join(secondAttach);
        // Both attaches must be rejected by the doomed startup's mark, not by
        // the unimplemented adapter call that follows a successful attach.
        for (const attachExit of [firstExit, secondExit]) {
          assert.isTrue(Exit.isFailure(attachExit));
          if (Exit.isFailure(attachExit)) {
            const failure = Cause.findErrorOption(attachExit.cause);
            assert.isTrue(Option.isSome(failure));
            if (Option.isSome(failure)) {
              assert.include(
                failure.value._tag === "ProviderAdapterProtocolError" ? failure.value.detail : "",
                "cleanup",
              );
            }
          }
        }
        yield* Deferred.succeed(openGate, undefined);
        assert.equal((yield* Fiber.join(startupOpening))._tag, "Failure");
        assert.isTrue(Option.isSome(yield* manager.get(peerId)));
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(prepareGate, undefined).pipe(
            Effect.andThen(Deferred.succeed(openGate, undefined)),
          ),
        ),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            serverSettingsLayer: settingsLayer,
            beforeOpen: () =>
              Ref.modify(opens, (n) => [n === 0, n + 1] as const).pipe(
                Effect.andThen((first) =>
                  first
                    ? Deferred.succeed(openEntered, undefined).pipe(
                        Effect.andThen(Deferred.await(openGate)),
                      )
                    : Effect.void,
                ),
              ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 joins a pending credential revocation on terminal-detach retry",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const revoking = yield* Deferred.make<void>();
      const revokeGate = yield* Deferred.make<void>();
      const pauseRevoke = yield* Ref.make(false);
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            revokeProviderSession: (providerSessionId) =>
              Ref.getAndSet(pauseRevoke, false).pipe(
                Effect.flatMap((pause) =>
                  pause
                    ? Deferred.succeed(revoking, undefined).pipe(
                        Effect.andThen(Deferred.await(revokeGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.revokeProviderSession(providerSessionId)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));

      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const threadId = ThreadId.make("thread-detach-revoke-retry");
        const peerThreadId = ThreadId.make("thread-detach-revoke-retry-peer");
        const first = yield* makeThreadSessionFixture(threadId);
        const peer = yield* makeThreadSessionFixture(peerThreadId);
        const providerSessionId = yield* first.allocate;
        // Shared session: detaching one thread leaves the session live for
        // the other, so no release record owns the revocation — the tracked
        // sweep is the only cleanup a retry can join.
        yield* first.open(providerSessionId);
        yield* peer.open(providerSessionId, peerThreadId);
        const issued = (yield* Ref.get(mcpConfigs)).find((config) => config?.threadId === threadId);
        const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(token);

        yield* Ref.set(pauseRevoke, true);
        const detaching = yield* manager
          .detach({ providerSessionId, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(revoking);
        yield* TestClock.adjust("30 seconds");
        assert.equal((yield* Fiber.join(detaching))._tag, "Failure");

        // The retry must not report success over the still-parked sweep, and
        // must not fork a second one.
        const retry = yield* manager
          .detach({ providerSessionId, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        for (let i = 0; i < 8; i += 1) {
          yield* Effect.yieldNow;
        }
        yield* TestClock.adjust("30 seconds");
        assert.equal((yield* Fiber.join(retry))._tag, "Failure");

        // Late success: the tracked sweep completes and a later retry joins
        // its recorded completion — the credential and the thread's binding
        // are both gone.
        yield* Deferred.succeed(revokeGate, undefined);
        yield* manager.detach({ providerSessionId, threadId, revokeMcpCredential: true });
        assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
        assert.isUndefined(yield* registry.resolve(token!));
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      }).pipe(
        Effect.ensuring(Deferred.succeed(revokeGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpConfigs,
            mcpRegistryLayer,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 queues a retry's pruned credential behind the pending revocation",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const revoking = yield* Deferred.make<void>();
      const revokeGate = yield* Deferred.make<void>();
      const pauseRevoke = yield* Ref.make(false);
      const failResolve = yield* Ref.make(false);
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            resolve: (token) =>
              Ref.get(failResolve).pipe(
                Effect.flatMap((fail) =>
                  fail ? Effect.succeed(undefined) : delegate.resolve(token),
                ),
              ),
            revokeProviderSession: (providerSessionId) =>
              Ref.get(pauseRevoke).pipe(
                Effect.flatMap((pause) =>
                  pause
                    ? Deferred.succeed(revoking, undefined).pipe(
                        Effect.andThen(Deferred.await(revokeGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.revokeProviderSession(providerSessionId)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));

      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const threadId = ThreadId.make("thread-detach-revoke-chained");
        const peerThreadId = ThreadId.make("thread-detach-revoke-chained-peer");
        const session = yield* makeThreadSessionFixture(threadId);
        const peer = yield* makeThreadSessionFixture(peerThreadId);
        // Three sessions on one thread; a failing resolve forces a fresh
        // credential per open so each session records a distinct credential
        // and the configured binding ends on the third.
        const sessionA = yield* session.allocate;
        yield* session.open(sessionA);
        yield* Ref.set(failResolve, true);
        const sessionB = yield* session.allocate;
        yield* session.open(sessionB);
        yield* peer.open(sessionB, peerThreadId);
        const sessionC = yield* session.allocate;
        yield* session.open(sessionC);
        yield* Ref.set(failResolve, false);
        const configs = yield* Ref.get(mcpConfigs);
        const tokenOf = (index: number) =>
          configs[index]?.authorizationHeader.replace(/^Bearer\s+/, "");
        const tokenA = tokenOf(0);
        const tokenB = tokenOf(1);
        const tokenC = tokenOf(2);
        assert.isDefined(tokenA);
        assert.isDefined(tokenB);
        assert.isDefined(tokenC);

        // Detach A terminally; its tracked sweep captures {cA, cC} and parks
        // inside the gated revocation.
        yield* Ref.set(pauseRevoke, true);
        const detachA = yield* manager
          .detach({ providerSessionId: sessionA, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(revoking);
        // Detach B's attachment while the sweep is parked: B stays live for
        // its peer thread, so no release record owns cB — only this caller's
        // captured set does. Joining the pending sweep must not discard it.
        const detachB = yield* manager
          .detach({ providerSessionId: sessionB, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        for (let i = 0; i < 8; i += 1) {
          yield* Effect.yieldNow;
        }

        yield* Deferred.succeed(revokeGate, undefined);
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(detachA)));
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(detachB)));
        for (let i = 0; i < 8; i += 1) {
          yield* Effect.yieldNow;
        }
        // The chained sweep released B's pruned credential; C's claim on the
        // configured credential survives.
        assert.isUndefined(yield* registry.resolve(tokenA!));
        assert.isUndefined(yield* registry.resolve(tokenB!));
        assert.isDefined(yield* registry.resolve(tokenC!));
        assert.isTrue(Option.isSome(yield* manager.get(sessionB)));
      }).pipe(
        Effect.ensuring(Deferred.succeed(revokeGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpConfigs,
            mcpRegistryLayer,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a terminal-detach retry waiting on the pending revocation past a session release",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const revoking = yield* Deferred.make<void>();
      const revokeGate = yield* Deferred.make<void>();
      const pauseRevoke = yield* Ref.make(false);
      const closing = yield* Deferred.make<void>();
      const closeGate = yield* Deferred.make<void>();
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            revokeProviderSession: (providerSessionId) =>
              Ref.getAndSet(pauseRevoke, false).pipe(
                Effect.flatMap((pause) =>
                  pause
                    ? Deferred.succeed(revoking, undefined).pipe(
                        Effect.andThen(Deferred.await(revokeGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.revokeProviderSession(providerSessionId)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));

      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const threadId = ThreadId.make("thread-detach-revoke-release-join");
        const peerThreadId = ThreadId.make("thread-detach-revoke-release-join-peer");
        const first = yield* makeThreadSessionFixture(threadId);
        const peer = yield* makeThreadSessionFixture(peerThreadId);
        const providerSessionId = yield* first.allocate;
        yield* first.open(providerSessionId);
        yield* peer.open(providerSessionId, peerThreadId);
        const issued = (yield* Ref.get(mcpConfigs)).find((config) => config?.threadId === threadId);
        const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(token);

        // The first terminal detach prunes the thread's credential and parks
        // inside the tracked revocation sweep.
        yield* Ref.set(pauseRevoke, true);
        const detaching = yield* manager
          .detach({ providerSessionId, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(revoking);
        yield* TestClock.adjust("30 seconds");
        assert.equal((yield* Fiber.join(detaching))._tag, "Failure");

        // A close claims the session; its record never contained the pruned
        // credential, so the parked sweep remains its only owner.
        const closingSession = yield* manager
          .close(providerSessionId)
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(closing);
        const retry = yield* manager
          .detach({ providerSessionId, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        for (let i = 0; i < 8; i += 1) {
          yield* Effect.yieldNow;
        }

        // The release finishes while the revocation is still parked; the
        // retry must not report success over cleanup it does not own.
        yield* Deferred.succeed(closeGate, undefined);
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(closingSession)));
        yield* TestClock.adjust("30 seconds");
        assert.equal((yield* Fiber.join(retry))._tag, "Failure");

        // Once the revocation actually drains, the retry's own bounded wait
        // completes and the binding is gone.
        yield* Deferred.succeed(revokeGate, undefined);
        yield* manager.detach({ providerSessionId, threadId, revokeMcpCredential: true });
        assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
        assert.isUndefined(yield* registry.resolve(token!));
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(revokeGate, undefined).pipe(
            Effect.andThen(Deferred.succeed(closeGate, undefined)),
          ),
        ),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpConfigs,
            mcpRegistryLayer,
            beforeClose: Deferred.succeed(closing, undefined).pipe(
              Effect.andThen(Deferred.await(closeGate)),
            ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 closeInstance does not close another instance's same-id replacement",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const openEntered = yield* Deferred.make<void>();
      const openGate = yield* Deferred.make<void>();
      const closing = yield* Deferred.make<void>();
      const closeGate = yield* Deferred.make<void>();
      const closeCalls = yield* Ref.make(0);
      const openCalls = yield* Ref.make(0);
      const startupThreadId = ThreadId.make("thread-closeinstance-sameid-startup");
      const liveThreadId = ThreadId.make("thread-closeinstance-sameid-live");

      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const idAllocator = yield* IdAllocatorV2;
        const live = yield* makeThreadSessionFixture(liveThreadId);
        const liveId = yield* live.allocate;
        yield* live.open(liveId);
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: startupThreadId,
        });
        // The startup parks inside openSession with its record tracked.
        const startupOpening = yield* manager
          .open({ threadId: startupThreadId, providerSessionId, modelSelection, runtimePolicy })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(openEntered);

        const closingInstance = yield* manager
          .closeInstance(modelSelection.instanceId)
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(closing);

        // The fenced startup unwinds and drops its opening record while the
        // instance close stays parked on the live session's scope.
        yield* Deferred.succeed(openGate, undefined);
        assert.equal((yield* Fiber.join(startupOpening))._tag, "Failure");
        // A different instance may reuse the same session id — the captured
        // record is gone by now, so only the settled deferred still refers to
        // the startup's own cleanup.
        yield* manager.open({
          threadId: startupThreadId,
          providerSessionId,
          modelSelection: {
            ...modelSelection,
            instanceId: ProviderInstanceId.make("codex_other"),
          },
          runtimePolicy,
        });
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));

        yield* Deferred.succeed(closeGate, undefined);
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(closingInstance)));
        // Joining the captured record's settled deferred must not claim the
        // replacement that registered after the record was removed.
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(openGate, undefined).pipe(
            Effect.andThen(Deferred.succeed(closeGate, undefined)),
          ),
        ),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            // The live session opens first; the second open is the startup
            // that must park while closeInstance captures its record.
            beforeOpen: () =>
              Ref.modify(openCalls, (n) => [n === 1, n + 1] as const).pipe(
                Effect.andThen((startup) =>
                  startup
                    ? Deferred.succeed(openEntered, undefined).pipe(
                        Effect.andThen(Deferred.await(openGate)),
                      )
                    : Effect.void,
                ),
              ),
            // Only the live session's close parks: the startup's scope had no
            // finalizers yet and the replacement's scope closes after the
            // gate is already open.
            beforeClose: Ref.modify(closeCalls, (n) => [n === 0, n + 1] as const).pipe(
              Effect.andThen((first) =>
                first
                  ? Deferred.succeed(closing, undefined).pipe(
                      Effect.andThen(Deferred.await(closeGate)),
                    )
                  : Effect.void,
              ),
            ),
            extraAdapters: [
              makeProviderAdapter(state, {
                instanceId: ProviderInstanceId.make("codex_other"),
              }),
            ],
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a mid-flight terminal-detach retry waiting on the pending revocation",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const revoking = yield* Deferred.make<void>();
      const revokeGate = yield* Deferred.make<void>();
      const pauseRevoke = yield* Ref.make(false);
      const interruptEntered = yield* Deferred.make<void>();
      const interruptGate = yield* Deferred.make<void>();
      const interruptCalls = yield* Ref.make(0);
      const closing = yield* Deferred.make<void>();
      const closeGate = yield* Deferred.make<void>();
      const closeCalls = yield* Ref.make(0);
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            revokeProviderSession: (providerSessionId) =>
              Ref.getAndSet(pauseRevoke, false).pipe(
                Effect.flatMap((pause) =>
                  pause
                    ? Deferred.succeed(revoking, undefined).pipe(
                        Effect.andThen(Deferred.await(revokeGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.revokeProviderSession(providerSessionId)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));

      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-detach-revoke-midflight");
        const peerThreadId = ThreadId.make("thread-detach-revoke-midflight-peer");
        const first = yield* makeThreadSessionFixture(threadId);
        const peer = yield* makeThreadSessionFixture(peerThreadId);
        const providerSessionId = yield* first.allocate;
        const providerThread = makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now,
        });
        const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: providerThread,
            },
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "provider-turn.updated",
              threadId,
              runId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: {
                id: idAllocator.derive.providerTurn({
                  driver: CODEX_DRIVER,
                  nativeTurnId: "native-turn-detach-revoke-midflight",
                }),
                providerThreadId: providerThread.id,
                nodeId: idAllocator.derive.rootNode({ runId }),
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
        yield* first.open(providerSessionId);
        yield* peer.open(providerSessionId, peerThreadId);
        const issued = (yield* Ref.get(mcpConfigs)).find((config) => config?.threadId === threadId);
        const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(token);

        // The first terminal detach prunes the credential and parks inside
        // the tracked revocation sweep.
        yield* Ref.set(pauseRevoke, true);
        const detaching = yield* manager
          .detach({ providerSessionId, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(revoking);
        yield* TestClock.adjust("30 seconds");
        assert.equal((yield* Fiber.join(detaching))._tag, "Failure");

        // The retry reads the live entry, then parks inside interruptTurn —
        // a close claims the session while it is suspended, and the release
        // record it joins never contained the pruned credential.
        const retry = yield* manager
          .detach({ providerSessionId, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(interruptEntered);
        const closingSession = yield* manager
          .close(providerSessionId)
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(closing);

        // The release finishes while the revocation is still parked; the
        // retry must not report success over cleanup it does not own.
        yield* Deferred.succeed(interruptGate, undefined);
        yield* Deferred.succeed(closeGate, undefined);
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(closingSession)));
        yield* TestClock.adjust("30 seconds");
        assert.equal((yield* Fiber.join(retry))._tag, "Failure");

        // Once the revocation actually drains, a later retry completes and
        // the binding is gone.
        yield* Deferred.succeed(revokeGate, undefined);
        yield* manager.detach({ providerSessionId, threadId, revokeMcpCredential: true });
        assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
        assert.isUndefined(yield* registry.resolve(token!));
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(interruptGate, undefined).pipe(
            Effect.andThen(Deferred.succeed(closeGate, undefined)),
            Effect.andThen(Deferred.succeed(revokeGate, undefined)),
          ),
        ),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpConfigs,
            mcpRegistryLayer,
            // The first detach interrupts the seeded running turn unpaused;
            // the retry parks inside its own interrupt.
            beforeInterrupt: Ref.modify(interruptCalls, (n) => [n > 0, n + 1] as const).pipe(
              Effect.andThen((seen) =>
                seen
                  ? Deferred.succeed(interruptEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(interruptGate)),
                    )
                  : Effect.void,
              ),
            ),
            beforeClose: Ref.modify(closeCalls, (n) => [n === 0, n + 1] as const).pipe(
              Effect.andThen((firstCall) =>
                firstCall
                  ? Deferred.succeed(closing, undefined).pipe(
                      Effect.andThen(Deferred.await(closeGate)),
                    )
                  : Effect.void,
              ),
            ),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 shutdown joins a session release already in progress", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const closing = yield* Deferred.make<void>();
    const closeGate = yield* Deferred.make<void>();
    const closeCalls = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManagerV2;
      const threadId = ThreadId.make("thread-shutdown-joins-release");
      const { allocate, open } = yield* makeThreadSessionFixture(threadId);
      const providerSessionId = yield* allocate;
      yield* open(providerSessionId);

      const closingSession = yield* manager
        .close(providerSessionId)
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(closing);

      const shuttingDown = yield* manager.shutdown.pipe(Effect.exit, Effect.forkChild);
      // The release is claimed and parked; shutdown must be waiting on it,
      // not reporting teardown over running cleanup.
      yield* TestClock.adjust("15 seconds");
      assert.isUndefined(shuttingDown.pollUnsafe());

      yield* Deferred.succeed(closeGate, undefined);
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(closingSession)));
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(shuttingDown)));
    }).pipe(
      Effect.ensuring(Deferred.succeed(closeGate, undefined)),
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 3_600_000,
          beforeClose: Ref.modify(closeCalls, (n) => [n === 0, n + 1] as const).pipe(
            Effect.andThen((first) =>
              first
                ? Deferred.succeed(closing, undefined).pipe(
                    Effect.andThen(Deferred.await(closeGate)),
                  )
                : Effect.void,
            ),
          ),
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 shutdown releases wedged sessions concurrently", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const hangClose = yield* Deferred.make<void>();
    const closeEntered = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManagerV2;
      const a = yield* makeThreadSessionFixture(ThreadId.make("thread-shutdown-concurrent-a"));
      const b = yield* makeThreadSessionFixture(ThreadId.make("thread-shutdown-concurrent-b"));
      const aId = yield* a.allocate;
      yield* a.open(aId);
      const bId = yield* b.allocate;
      yield* b.open(bId);

      const stopping = yield* manager.shutdown.pipe(Effect.exit, Effect.forkChild);
      // Both releases must START concurrently: beforeClose runs first on
      // each scope close, so under a sequential loop only the first
      // session's close has entered before the first bound elapses.
      yield* Effect.forEach(
        Array.from({ length: 200 }, () => undefined),
        () =>
          Ref.get(closeEntered).pipe(
            Effect.flatMap((n) => (n < 2 ? Effect.yieldNow : Effect.void)),
          ),
        { discard: true },
      );
      assert.equal(yield* Ref.get(closeEntered), 2);
      // Both scope closes now park on the shared gate; each release is
      // bounded at 30s. Sequential release would stack the bounds (60s+
      // here); concurrent release settles at the single bound.
      yield* TestClock.adjust("29 seconds");
      yield* Effect.yieldNow;
      assert.isUndefined(stopping.pollUnsafe());
      yield* TestClock.adjust("2 seconds");
      yield* Effect.yieldNow;
      const exit = stopping.pollUnsafe();
      assert.isTrue(exit !== undefined && Exit.isSuccess(exit) && Exit.isSuccess(exit.value));
    }).pipe(
      Effect.ensuring(Deferred.succeed(hangClose, undefined)),
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 3_600_000,
          hangSessionScopeClose: hangClose,
          beforeClose: Ref.update(closeEntered, (n) => n + 1),
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 bounds the detach wait on a stalled in-flight attach", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const issuing = yield* Deferred.make<void>();
    const issueGate = yield* Deferred.make<void>();
    const attachThreadId = ThreadId.make("thread-detach-attach-lock");
    const mcpRegistryLayer = Layer.effect(
      McpSessionRegistry.McpSessionRegistry,
      Effect.gen(function* () {
        const delegate = yield* McpSessionRegistry.McpSessionRegistry;
        return McpSessionRegistry.McpSessionRegistry.of({
          ...delegate,
          issue: (input) =>
            (input.threadId === attachThreadId
              ? Deferred.succeed(issuing, undefined).pipe(Effect.andThen(Deferred.await(issueGate)))
              : Effect.void
            ).pipe(Effect.andThen(delegate.issue(input))),
        });
      }),
    ).pipe(Layer.provide(TestMcpRegistryLayer));

    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManagerV2;
      const threadId = ThreadId.make("thread-detach-attach-lock-peer");
      const first = yield* makeThreadSessionFixture(threadId);
      const second = yield* makeThreadSessionFixture(attachThreadId);
      const providerSessionId = yield* first.allocate;
      yield* first.open(providerSessionId);

      // The second thread's attach parks inside MCP issuance while holding
      // the [session, thread] attach lock.
      const attaching = yield* second
        .open(providerSessionId, attachThreadId)
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(issuing);

      const detaching = yield* manager
        .detach({ providerSessionId, threadId: attachThreadId, revokeMcpCredential: true })
        .pipe(Effect.exit, Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      const detachExit = yield* Fiber.join(detaching);
      assert.equal(detachExit._tag, "Failure");

      yield* Deferred.succeed(issueGate, undefined);
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(attaching)));
    }).pipe(
      Effect.ensuring(Deferred.succeed(issueGate, undefined)),
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 3_600_000,
          mcpConfigs,
          mcpRegistryLayer,
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 shutdown joins a tracked credential revocation still running",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const revoking = yield* Deferred.make<void>();
      const revokeGate = yield* Deferred.make<void>();
      const pauseRevoke = yield* Ref.make(true);
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            revokeProviderSession: (providerSessionId) =>
              Ref.getAndSet(pauseRevoke, false).pipe(
                Effect.flatMap((pause) =>
                  pause
                    ? Deferred.succeed(revoking, undefined).pipe(
                        Effect.andThen(Deferred.await(revokeGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.revokeProviderSession(providerSessionId)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));

      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const threadId = ThreadId.make("thread-shutdown-pending-revocation");
        const peerThreadId = ThreadId.make("thread-shutdown-pending-revocation-peer");
        const first = yield* makeThreadSessionFixture(threadId);
        const peer = yield* makeThreadSessionFixture(peerThreadId);
        const providerSessionId = yield* first.allocate;
        yield* first.open(providerSessionId);
        yield* peer.open(providerSessionId, peerThreadId);
        const issued = (yield* Ref.get(mcpConfigs)).find((config) => config?.threadId === threadId);
        const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(token);

        // The terminal detach prunes the thread's credential and parks inside
        // the tracked revocation sweep — outliving the detach caller itself.
        const detaching = yield* manager
          .detach({ providerSessionId, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(revoking);
        yield* TestClock.adjust("30 seconds");
        assert.equal((yield* Fiber.join(detaching))._tag, "Failure");

        // Shutdown releases the session (still owned by the peer thread) but
        // must not return while the tracked revocation is still running.
        const shuttingDown = yield* manager.shutdown.pipe(Effect.exit, Effect.forkChild);
        yield* TestClock.adjust("15 seconds");
        assert.isUndefined(shuttingDown.pollUnsafe());

        yield* Deferred.succeed(revokeGate, undefined);
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(shuttingDown)));
        assert.isUndefined(yield* registry.resolve(token!));
      }).pipe(
        Effect.ensuring(Deferred.succeed(revokeGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpConfigs,
            mcpRegistryLayer,
          }),
        ),
      );
    }),
);

for (const operation of ["shutdown", "closeInstance"] as const) {
  it.effect(
    `ProviderSessionManagerV2 ${operation} waits for a revocation tail registered by an in-flight detach`,
    () =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        const mcpConfigs = yield* Ref.make<
          ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
        >([]);
        // Teardown is one-shot, so every offset runs against a fresh manager.
        // The detach's first scheduler checkpoints land while it is still
        // queued on the [session, thread] lock — its in-flight marker is
        // registered, but the masked mutation/registration stretch has not
        // run, so no pendingRevocations record exists yet.
        for (let ops = 4; ops < 24; ops += 1) {
          yield* Effect.gen(function* () {
            const manager = yield* ProviderSessionManagerV2;
            const stepper = makeSteppingScheduler();
            const threadId = ThreadId.make(`thread-${operation}-late-tail-${ops}`);
            const { allocate, open } = yield* makeThreadSessionFixture(threadId);
            const providerSessionId = yield* allocate;
            yield* open(providerSessionId);

            const detaching = yield* manager
              .detach({ providerSessionId, threadId, revokeMcpCredential: true })
              .pipe(
                Effect.exit,
                Effect.forkDetach,
                Effect.provideService(Scheduler.Scheduler, stepper.scheduler),
              );
            yield* stepper.step(detaching, ops);

            const tearingDown = yield* (
              operation === "shutdown"
                ? manager.shutdown
                : manager.closeInstance(modelSelection.instanceId)
            ).pipe(Effect.exit, Effect.forkChild);
            for (let i = 0; i < 16; i += 1) {
              yield* Effect.yieldNow;
            }
            // The detach is in flight but has registered no revocation yet;
            // only draining the in-flight marker keeps teardown pending here.
            // A one-time snapshot returns Success over the owed sweep.
            assert.isUndefined(
              tearingDown.pollUnsafe(),
              `${operation} returned while an in-flight detach could still register a revocation tail (op ${ops})`,
            );

            yield* stepper.drain;
            const teardownExit = yield* Fiber.join(tearingDown);
            assert.isTrue(
              Exit.isSuccess(teardownExit),
              `${operation} returned ${teardownExit._tag} instead of Success (op ${ops})`,
            );
            // Teardown may only finish once the in-flight detach has exited —
            // its tail registration and bounded join are what the drain waits
            // on.
            assert.isDefined(
              detaching.pollUnsafe(),
              `${operation} returned before the in-flight detach settled (op ${ops})`,
            );
            const detachExit = yield* Fiber.join(detaching);
            assert.isTrue(
              Exit.isSuccess(detachExit),
              `${operation}: in-flight detach returned ${detachExit._tag} (op ${ops})`,
            );
          }).pipe(
            Effect.provide(
              makeTestLayer({
                state,
                idleTimeoutMs: 3_600_000,
                mcpConfigs,
              }),
            ),
          );
        }
      }),
  );
}

it.effect(
  "ProviderSessionManagerV2 closeInstance does not drain an in-flight detach owned by another instance",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const idAllocator = yield* IdAllocatorV2;
        const stepper = makeSteppingScheduler();
        const otherSelection = {
          ...modelSelection,
          instanceId: ProviderInstanceId.make("codex_other"),
        };
        const foreignThread = ThreadId.make("thread-foreign-detach");
        const first = yield* makeThreadSessionFixture(ThreadId.make("thread-foreign-detach-owner"));
        yield* makeThreadSessionFixture(foreignThread);
        const sessionA = yield* first.allocate;
        const sessionB = yield* idAllocator.allocate.providerSession({
          providerInstanceId: otherSelection.instanceId,
          threadId: foreignThread,
        });
        yield* first.open(sessionA);
        yield* manager.open({
          threadId: foreignThread,
          providerSessionId: sessionB,
          modelSelection: otherSelection,
          runtimePolicy,
        });

        // The foreign detach is in flight — marker registered, still queued
        // on its session's attach lock — but belongs to codex_other, so this
        // instance's teardown must not be held behind it.
        const detaching = yield* manager
          .detach({
            providerSessionId: sessionB,
            threadId: foreignThread,
            revokeMcpCredential: true,
          })
          .pipe(
            Effect.exit,
            Effect.forkDetach,
            Effect.provideService(Scheduler.Scheduler, stepper.scheduler),
          );
        yield* stepper.step(detaching, 8);

        const closing = yield* manager
          .closeInstance(modelSelection.instanceId)
          .pipe(Effect.exit, Effect.forkChild);
        const closeExit = yield* Fiber.join(closing);
        assert.isTrue(
          Exit.isSuccess(closeExit),
          `closeInstance returned ${closeExit._tag} instead of Success`,
        );
        assert.isUndefined(
          detaching.pollUnsafe(),
          "closeInstance drained a detach owned by another instance",
        );

        yield* stepper.drain;
        yield* Fiber.join(detaching);
      }).pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpConfigs,
            extraAdapters: [
              makeProviderAdapter(state, {
                instanceId: ProviderInstanceId.make("codex_other"),
              }),
            ],
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 closeInstance drains an in-flight detach across a same-id replacement",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const issueStarted = yield* Deferred.make<void>();
      const issueGate = yield* Deferred.make<void>();
      const armIssue = yield* Ref.make(false);
      const detachedThread = ThreadId.make("thread-replaced-detach");
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            issue: (request) =>
              request.threadId === detachedThread
                ? Ref.get(armIssue).pipe(
                    Effect.flatMap((armed) =>
                      armed
                        ? Deferred.succeed(issueStarted, undefined).pipe(
                            Effect.andThen(Deferred.await(issueGate)),
                            Effect.andThen(delegate.issue(request)),
                          )
                        : delegate.issue(request),
                    ),
                  )
                : delegate.issue(request),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const idAllocator = yield* IdAllocatorV2;
        const stepper = makeSteppingScheduler();
        const otherSelection = {
          ...modelSelection,
          instanceId: ProviderInstanceId.make("codex_other"),
        };
        const first = yield* makeThreadSessionFixture(detachedThread);
        const providerSessionId = yield* first.allocate;
        yield* first.open(providerSessionId);

        // Suspend the detach after it recorded which instance's entry it
        // observed (the capture lands around op 10) but before its
        // [session, thread] lock section, so its marker attributes this
        // instance while the session id is about to change hands.
        const detaching = yield* manager
          .detach({
            providerSessionId,
            threadId: detachedThread,
            revokeMcpCredential: true,
          })
          .pipe(
            Effect.exit,
            Effect.forkDetach,
            Effect.provideService(Scheduler.Scheduler, stepper.scheduler),
          );
        yield* stepper.step(detaching, 15);

        // Release the observed session, then reopen the same session id under
        // another instance: map lookups now resolve the marker's session to
        // codex_other, and only the marker's captured owner still attributes
        // the detach to this instance.
        yield* manager.close(providerSessionId);
        const replacementThread = ThreadId.make("thread-replaced-owner");
        yield* makeThreadSessionFixture(replacementThread);
        yield* manager.open({
          threadId: replacementThread,
          providerSessionId,
          modelSelection: otherSelection,
          runtimePolicy,
        });

        // A credential prepare for the detached thread on a third session id
        // parks inside mcpPrepareLock[thread] once armed, so the detach's
        // late-registered revocation tail is observably still running below.
        const holderSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: otherSelection.instanceId,
          threadId: detachedThread,
        });
        yield* manager.open({
          threadId: ThreadId.make("thread-lock-session-owner"),
          providerSessionId: holderSessionId,
          modelSelection: otherSelection,
          runtimePolicy,
        });
        yield* Ref.set(armIssue, true);
        const holding = yield* manager
          .open({
            threadId: detachedThread,
            providerSessionId: holderSessionId,
            modelSelection: otherSelection,
            runtimePolicy,
          })
          .pipe(Effect.exit, Effect.forkChild);
        // Mandatory handshake: the prepare must be parked inside the prepare
        // lock before the detach's tail can be expected to queue behind it.
        yield* Deferred.await(issueStarted);

        const closing = yield* manager
          .closeInstance(modelSelection.instanceId)
          .pipe(Effect.exit, Effect.forkChild);
        for (let i = 0; i < 16; i += 1) {
          yield* Effect.yieldNow;
        }
        // Captured rather than asserted here: a premature teardown exit must
        // still be followed by draining the suspended detach, or the layer's
        // own shutdown waits on it forever and masks the real failure.
        const skippedDetach = closing.pollUnsafe();

        yield* stepper.drain;
        for (let i = 0; i < 16; i += 1) {
          yield* Effect.yieldNow;
        }
        const skippedTail = closing.pollUnsafe();

        // The resumed detach registered its revocation tail and is parked on
        // its join while the tail queues behind the held prepare lock.
        // Interrupting the detach exits it while its tail is still running —
        // teardown may only stay pending here by joining the tail itself. The
        // interrupt is delivered through the stepping dispatcher the fiber is
        // suspended on, so drain is what lands it at the parked join.
        yield* Effect.sync(() => detaching.interruptUnsafe());
        yield* stepper.drain;
        for (let i = 0; i < 16; i += 1) {
          yield* Effect.yieldNow;
        }
        const detachExitEarly = detaching.pollUnsafe();
        const skippedLateTail = closing.pollUnsafe();

        yield* Deferred.succeed(issueGate, undefined);
        const closeExit = yield* Fiber.join(closing);
        const detachExit = yield* Fiber.await(detaching);
        yield* Fiber.join(holding);

        // The marker attributes the in-flight detach to this instance even
        // though its session id now belongs to codex_other — resolving
        // ownership through the current maps returns Success here instead.
        assert.isUndefined(
          skippedDetach,
          `closeInstance skipped an in-flight detach that observed its own instance (${skippedDetach?._tag})`,
        );
        // The resumed detach registered its revocation tail, which was then
        // parked behind the held prepare lock — teardown must still be
        // waiting rather than reporting over a live sweep.
        assert.isUndefined(
          skippedTail,
          `closeInstance returned while the detached thread's revocation tail was still running (${skippedTail?._tag})`,
        );
        // The detach exited while its tail was still parked — teardown must
        // still be waiting on that tail rather than reporting over it.
        assert.isDefined(
          detachExitEarly,
          "the interrupted in-flight detach did not exit while its tail was parked",
        );
        assert.isTrue(
          detachExitEarly !== undefined && Exit.isFailure(detachExit),
          `in-flight detach returned ${detachExit._tag} instead of the interrupt Failure`,
        );
        assert.isUndefined(
          skippedLateTail,
          `closeInstance returned while the detached thread's revocation tail was still running after the detach exited (${skippedLateTail?._tag})`,
        );
        assert.isTrue(
          Exit.isSuccess(closeExit),
          `closeInstance returned ${closeExit._tag} instead of Success`,
        );
      }).pipe(
        Effect.ensuring(Deferred.succeed(issueGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpConfigs,
            mcpRegistryLayer,
            extraAdapters: [
              makeProviderAdapter(state, {
                instanceId: ProviderInstanceId.make("codex_other"),
              }),
            ],
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 closeInstance waits for an in-flight detach that captured no owner",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const stepper = makeSteppingScheduler();
        const otherSelection = {
          ...modelSelection,
          instanceId: ProviderInstanceId.make("codex_other"),
        };
        const detachedThread = ThreadId.make("thread-ownerless-detach");
        const first = yield* makeThreadSessionFixture(detachedThread);
        const providerSessionId = yield* first.allocate;
        yield* first.open(providerSessionId);

        // Suspend before the detach resolves which instance owns the session
        // id (the capture lands around op 10), then close the session while
        // it is suspended: the resumed capture finds no entry, so the marker
        // records resolved-but-unknown ownership — not "not captured yet".
        const detaching = yield* manager
          .detach({
            providerSessionId,
            threadId: detachedThread,
            revokeMcpCredential: true,
          })
          .pipe(
            Effect.exit,
            Effect.forkDetach,
            Effect.provideService(Scheduler.Scheduler, stepper.scheduler),
          );
        yield* stepper.step(detaching, 8);
        yield* manager.close(providerSessionId);
        yield* stepper.step(detaching, 12);

        // The same session id now belongs to another instance. A marker that
        // conflated "captured no owner" with "not captured" would resolve the
        // id through the maps here and skip this detach as foreign-owned.
        const replacementThread = ThreadId.make("thread-ownerless-replacement");
        yield* makeThreadSessionFixture(replacementThread);
        yield* manager.open({
          threadId: replacementThread,
          providerSessionId,
          modelSelection: otherSelection,
          runtimePolicy,
        });

        const closing = yield* manager
          .closeInstance(modelSelection.instanceId)
          .pipe(Effect.exit, Effect.forkChild);
        for (let i = 0; i < 16; i += 1) {
          yield* Effect.yieldNow;
        }
        // Captured rather than asserted here: a premature teardown exit must
        // still be followed by draining the suspended detach, or the layer's
        // own shutdown waits on it forever and masks the real failure.
        const skippedDetach = closing.pollUnsafe();

        yield* stepper.drain;
        for (let i = 0; i < 16; i += 1) {
          yield* Effect.yieldNow;
        }
        const closeExit = yield* Fiber.join(closing);
        const detachExit = yield* Fiber.join(detaching);

        assert.isUndefined(
          skippedDetach,
          `closeInstance skipped an in-flight detach that had resolved no owner for its session id (${skippedDetach?._tag})`,
        );
        assert.isTrue(
          Exit.isSuccess(closeExit),
          `closeInstance returned ${closeExit._tag} instead of Success`,
        );
        assert.isTrue(
          Exit.isSuccess(detachExit),
          `in-flight detach returned ${detachExit._tag} instead of Success`,
        );
      }).pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpConfigs,
            extraAdapters: [
              makeProviderAdapter(state, {
                instanceId: ProviderInstanceId.make("codex_other"),
              }),
            ],
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 closeInstance reports an in-flight detach that outlives the cleanup bound",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const stepper = makeSteppingScheduler();
        const threadId = ThreadId.make("thread-stuck-detach");
        const { allocate, open } = yield* makeThreadSessionFixture(threadId);
        const providerSessionId = yield* allocate;
        yield* open(providerSessionId);

        // The detach never resumes: its in-flight marker outlives the cleanup
        // bound, and teardown must report that instead of discarding the
        // timeout and returning success over a still-running detach.
        const detaching = yield* manager
          .detach({ providerSessionId, threadId, revokeMcpCredential: true })
          .pipe(
            Effect.exit,
            Effect.forkDetach,
            Effect.provideService(Scheduler.Scheduler, stepper.scheduler),
          );
        yield* stepper.step(detaching, 8);

        const closing = yield* manager
          .closeInstance(modelSelection.instanceId)
          .pipe(Effect.exit, Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        const closeExit = yield* Fiber.join(closing);
        // Drain and join before asserting: a teardown that wrongly reported
        // success still leaves the suspended detach for the layer's own
        // shutdown, which would hang and mask this failure.
        yield* stepper.drain;
        yield* Fiber.join(detaching);
        assert.isTrue(
          Exit.isFailure(closeExit),
          `closeInstance returned ${closeExit._tag} instead of Failure`,
        );
      }).pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpConfigs,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 closeInstance joins a chained revocation started by its own instance",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const revoking = yield* Deferred.make<void>();
      const revokeGate = yield* Deferred.make<void>();
      const pauseRevoke = yield* Ref.make(true);
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            revokeProviderSession: (providerSessionId) =>
              Ref.getAndSet(pauseRevoke, false).pipe(
                Effect.flatMap((pause) =>
                  pause
                    ? Deferred.succeed(revoking, undefined).pipe(
                        Effect.andThen(Deferred.await(revokeGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.revokeProviderSession(providerSessionId)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));

      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const idAllocator = yield* IdAllocatorV2;
        const threadId = ThreadId.make("thread-closeinstance-chained-revoke");
        const peerA = ThreadId.make("thread-closeinstance-chained-revoke-a");
        const peerB = ThreadId.make("thread-closeinstance-chained-revoke-b");
        const otherSelection = {
          ...modelSelection,
          instanceId: ProviderInstanceId.make("codex_other"),
        };
        const firstA = yield* makeThreadSessionFixture(threadId);
        const holderA = yield* makeThreadSessionFixture(peerA);
        yield* makeThreadSessionFixture(peerB);
        const sessionA = yield* firstA.allocate;
        const sessionB = yield* idAllocator.allocate.providerSession({
          providerInstanceId: otherSelection.instanceId,
          threadId: peerB,
        });
        yield* firstA.open(sessionA);
        yield* holderA.open(sessionA, peerA);
        yield* manager.open({
          threadId: peerB,
          providerSessionId: sessionB,
          modelSelection: otherSelection,
          runtimePolicy,
        });
        // The thread is attached to both instances' sessions.
        yield* manager.open({
          threadId,
          providerSessionId: sessionB,
          modelSelection: otherSelection,
          runtimePolicy,
        });

        // A's terminal detach parks inside the tracked sweep; B's detach of
        // the same thread chains behind it — the tail must still carry A's
        // attribution because A's sweep is still running.
        const detachA = yield* manager
          .detach({ providerSessionId: sessionA, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(revoking);
        const detachB = yield* manager
          .detach({ providerSessionId: sessionB, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        assert.equal((yield* Fiber.join(detachA))._tag, "Failure");
        assert.equal((yield* Fiber.join(detachB))._tag, "Failure");

        const closingInstance = yield* manager
          .closeInstance(modelSelection.instanceId)
          .pipe(Effect.exit, Effect.forkChild);
        yield* TestClock.adjust("15 seconds");
        // A's predecessor sweep is still parked — teardown must be waiting.
        assert.isUndefined(closingInstance.pollUnsafe());

        yield* Deferred.succeed(revokeGate, undefined);
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(closingInstance)));
      }).pipe(
        Effect.ensuring(Deferred.succeed(revokeGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpConfigs,
            mcpRegistryLayer,
            extraAdapters: [
              makeProviderAdapter(state, {
                instanceId: ProviderInstanceId.make("codex_other"),
              }),
            ],
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 closeInstance does not join an unrelated instance's revocation tail",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const revoking = yield* Deferred.make<void>();
      const revokeGate = yield* Deferred.make<void>();
      const pauseRevoke = yield* Ref.make(true);
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            revokeProviderSession: (providerSessionId) =>
              Ref.getAndSet(pauseRevoke, false).pipe(
                Effect.flatMap((pause) =>
                  pause
                    ? Deferred.succeed(revoking, undefined).pipe(
                        Effect.andThen(Deferred.await(revokeGate)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(delegate.revokeProviderSession(providerSessionId)),
              ),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));

      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const idAllocator = yield* IdAllocatorV2;
        const threadId = ThreadId.make("thread-closeinstance-foreign-revoke");
        const peerA = ThreadId.make("thread-closeinstance-foreign-revoke-a");
        const threadB = ThreadId.make("thread-closeinstance-foreign-revoke-b");
        const otherSelection = {
          ...modelSelection,
          instanceId: ProviderInstanceId.make("codex_other"),
        };
        const firstA = yield* makeThreadSessionFixture(threadId);
        const holderA = yield* makeThreadSessionFixture(peerA);
        yield* makeThreadSessionFixture(threadB);
        const sessionA = yield* firstA.allocate;
        const sessionB = yield* idAllocator.allocate.providerSession({
          providerInstanceId: otherSelection.instanceId,
          threadId: threadB,
        });
        yield* firstA.open(sessionA);
        yield* holderA.open(sessionA, peerA);
        yield* manager.open({
          threadId: threadB,
          providerSessionId: sessionB,
          modelSelection: otherSelection,
          runtimePolicy,
        });

        // A's terminal detach parks inside the tracked sweep; the retry finds
        // the thread already detached on the still-live session and chains a
        // new tail — which must keep A's attribution from the observed entry.
        const detaching = yield* manager
          .detach({ providerSessionId: sessionA, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(revoking);
        yield* TestClock.adjust("30 seconds");
        assert.equal((yield* Fiber.join(detaching))._tag, "Failure");
        const retry = yield* manager
          .detach({ providerSessionId: sessionA, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        assert.equal((yield* Fiber.join(retry))._tag, "Failure");

        // B's teardown must not wait on — and must not fail on — a revocation
        // owned by A.
        const closingB = yield* manager
          .closeInstance(otherSelection.instanceId)
          .pipe(Effect.exit, Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(closingB)));
        // A's own teardown still joins its sweep.
        const closingA = yield* manager
          .closeInstance(modelSelection.instanceId)
          .pipe(Effect.exit, Effect.forkChild);
        yield* TestClock.adjust("15 seconds");
        assert.isUndefined(closingA.pollUnsafe());
        yield* Deferred.succeed(revokeGate, undefined);
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(closingA)));
      }).pipe(
        Effect.ensuring(Deferred.succeed(revokeGate, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpConfigs,
            mcpRegistryLayer,
            extraAdapters: [
              makeProviderAdapter(state, {
                instanceId: ProviderInstanceId.make("codex_other"),
              }),
            ],
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 closeInstance does not inherit a finished predecessor's pending successor",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const gateA = yield* Ref.make<string | undefined>(undefined);
      const gateB = yield* Ref.make<string | undefined>(undefined);
      const revokingA = yield* Deferred.make<void>();
      const revokingB = yield* Deferred.make<void>();
      const gateFirst = yield* Deferred.make<void>();
      const gateSecond = yield* Deferred.make<void>();
      const mcpRegistryLayer = Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const delegate = yield* McpSessionRegistry.McpSessionRegistry;
          return McpSessionRegistry.McpSessionRegistry.of({
            ...delegate,
            revokeProviderSession: (providerSessionId) =>
              Effect.gen(function* () {
                const a = yield* Ref.get(gateA);
                const b = yield* Ref.get(gateB);
                if (providerSessionId === a) {
                  yield* Deferred.succeed(revokingA, undefined);
                  yield* Deferred.await(gateFirst);
                } else if (providerSessionId === b) {
                  yield* Deferred.succeed(revokingB, undefined);
                  yield* Deferred.await(gateSecond);
                }
              }).pipe(Effect.andThen(delegate.revokeProviderSession(providerSessionId))),
          });
        }),
      ).pipe(Layer.provide(TestMcpRegistryLayer));

      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const idAllocator = yield* IdAllocatorV2;
        const threadId = ThreadId.make("thread-closeinstance-settled-predecessor");
        const peerA = ThreadId.make("thread-closeinstance-settled-predecessor-a");
        const peerB = ThreadId.make("thread-closeinstance-settled-predecessor-b");
        const peerC = ThreadId.make("thread-closeinstance-settled-predecessor-c");
        const otherSelection = {
          ...modelSelection,
          instanceId: ProviderInstanceId.make("codex_other"),
        };
        const firstA = yield* makeThreadSessionFixture(threadId);
        const holderA = yield* makeThreadSessionFixture(peerA);
        yield* makeThreadSessionFixture(peerB);
        yield* makeThreadSessionFixture(peerC);
        const sessionA = yield* firstA.allocate;
        const sessionB = yield* idAllocator.allocate.providerSession({
          providerInstanceId: otherSelection.instanceId,
          threadId: peerB,
        });
        const sessionC = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: peerC,
        });
        yield* firstA.open(sessionA);
        yield* holderA.open(sessionA, peerA);
        const credentialA = McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId;
        yield* Ref.set(gateA, credentialA);
        yield* manager.open({
          threadId: peerB,
          providerSessionId: sessionB,
          modelSelection: otherSelection,
          runtimePolicy,
        });
        // The instance mismatch rotates the thread's credential so B's
        // session claims its own.
        yield* manager.open({
          threadId,
          providerSessionId: sessionB,
          modelSelection: otherSelection,
          runtimePolicy,
        });
        const credentialB = McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId;
        yield* Ref.set(gateB, credentialB);
        // A third session re-rotates the binding, then closes so the binding
        // is cleared: the first sweep then only carries A's credential and
        // can finish while B's own sweep stays parked.
        yield* manager.open({
          threadId: peerC,
          providerSessionId: sessionC,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.open({
          threadId,
          providerSessionId: sessionC,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.close(sessionC);

        const detachA = yield* manager
          .detach({ providerSessionId: sessionA, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(revokingA);
        const detachB = yield* manager
          .detach({ providerSessionId: sessionB, threadId, revokeMcpCredential: true })
          .pipe(Effect.exit, Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        assert.equal((yield* Fiber.join(detachA))._tag, "Failure");
        assert.equal((yield* Fiber.join(detachB))._tag, "Failure");

        // A's sweep finishes; B's chained sweep parks on its own credential.
        yield* Deferred.succeed(gateFirst, undefined);
        yield* Deferred.await(revokingB);

        // A's teardown must not wait on — or fail on — B's still-running sweep.
        const closingA = yield* manager
          .closeInstance(modelSelection.instanceId)
          .pipe(Effect.exit, Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(closingA)));

        yield* Deferred.succeed(gateSecond, undefined);
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(gateFirst, undefined).pipe(
            Effect.andThen(Deferred.succeed(gateSecond, undefined)),
          ),
        ),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpConfigs,
            mcpRegistryLayer,
            extraAdapters: [
              makeProviderAdapter(state, {
                instanceId: ProviderInstanceId.make("codex_other"),
              }),
            ],
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 an interrupted pending-release detach cannot strand the revocation tail",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      // Per-iteration gate: each close must stay parked inside its scope
      // finalizer so the detach observes a pending release and takes the
      // tracked-revocation path.
      const closeGate = yield* Ref.make<
        | {
            readonly entered: Deferred.Deferred<void>;
            readonly release: Deferred.Deferred<void>;
          }
        | undefined
      >(undefined);

      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const stepper = makeSteppingScheduler();

        // Interrupting between the tail registration and the worker fork
        // used to leave a `done` that never settles. There is no suspension
        // between the two, so only a per-op boundary reaches the window:
        // sweep the interrupt across every op offset instead of racing it.
        for (let ops = 0; ops < 128; ops++) {
          const threadId = ThreadId.make(`thread-detach-stranded-tail-${ops}`);
          const peerId = ThreadId.make(`thread-detach-stranded-tail-peer-${ops}`);
          const first = yield* makeThreadSessionFixture(threadId);
          const peer = yield* makeThreadSessionFixture(peerId);
          const providerSessionId = yield* first.allocate;
          yield* first.open(providerSessionId);
          yield* peer.open(providerSessionId, peerId);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          yield* Ref.set(closeGate, { entered, release });
          const closingSession = yield* manager
            .close(providerSessionId)
            .pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(entered);
          const detaching = yield* manager
            .detach({ providerSessionId, threadId, revokeMcpCredential: true })
            .pipe(
              Effect.exit,
              Effect.forkDetach,
              Effect.provideService(Scheduler.Scheduler, stepper.scheduler),
            );
          // A detach legitimately parks once it joins the parked release;
          // interrupt wherever the fiber stopped, then end the sweep when the
          // target boundary was not reached — later offsets are unreachable.
          const reached = yield* stepper.step(detaching, ops);
          // Interrupt while the fiber is still suspended: the resumption is
          // queued into the stepping dispatcher, so drain delivers the
          // interrupt deterministically at this op boundary.
          yield* Effect.sync(() => detaching.interruptUnsafe());
          yield* stepper.drain;
          yield* Fiber.await(detaching);

          yield* Deferred.succeed(release, undefined);
          assert.isTrue(Exit.isSuccess(yield* Fiber.join(closingSession)));

          // A stranded tail never settles; the next join parks until the 30s
          // bound. A healthy tail settles during the drain above, so the join
          // completes without any clock advance.
          const closingInstance = yield* manager
            .closeInstance(modelSelection.instanceId)
            .pipe(Effect.exit, Effect.forkChild);
          yield* stepper.drain;
          if (closingInstance.pollUnsafe() === undefined) {
            yield* TestClock.adjust("30 seconds");
          }
          assert.isTrue(
            Exit.isSuccess(yield* Fiber.join(closingInstance)),
            `interrupt at op ${ops} stranded the revocation tail`,
          );
          if (!reached) break;
        }
      }).pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 3_600_000,
            mcpConfigs,
            beforeClose: Ref.get(closeGate).pipe(
              Effect.flatMap((gate) =>
                gate === undefined
                  ? Effect.void
                  : Deferred.succeed(gate.entered, undefined).pipe(
                      Effect.andThen(Deferred.await(gate.release)),
                    ),
              ),
            ),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 an interrupted startup cannot strand the opening record", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);

    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManagerV2;
      const idAllocator = yield* IdAllocatorV2;
      const stepper = makeSteppingScheduler();
      const threadId = ThreadId.make("thread-open-stranded-record");
      yield* makeThreadSessionFixture(threadId);

      // Interrupting after `opening.set` but before the unwind handler is
      // installed used to strand the record: a later close marked it and
      // joined a `settled` that never completed, failing at the 30s bound
      // while replacements stayed blocked. The gap has no suspension, so
      // sweep the interrupt across every op offset. `cwd: null` skips the
      // async `fileSystem.stat`, which would park the fiber mid-sweep and
      // leave offsets past the park unreachable.
      const startupPolicy = { ...runtimePolicy, cwd: null };
      for (let ops = 0; ops < 160; ops++) {
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const opening = yield* manager
          .open({
            providerSessionId,
            threadId,
            modelSelection,
            runtimePolicy: startupPolicy,
          })
          .pipe(
            Effect.exit,
            Effect.forkDetach,
            Effect.provideService(Scheduler.Scheduler, stepper.scheduler),
          );
        // Interrupt wherever the fiber stopped, then end the sweep when the
        // target boundary was not reached — later offsets are unreachable.
        const reached = yield* stepper.step(opening, ops);
        // Interrupt while the fiber is still suspended: the resumption is
        // queued into the stepping dispatcher, so drain delivers the
        // interrupt deterministically at this op boundary.
        yield* Effect.sync(() => opening.interruptUnsafe());
        yield* stepper.drain;
        yield* Fiber.await(opening);

        // A stranded record keeps its `settled` pending forever; the close
        // marks it and joins, so it only resolves at the 30s bound — and
        // fails. A settled or absent record lets the close finish during
        // the drain, before any clock advance.
        const closing = yield* manager.close(providerSessionId).pipe(Effect.exit, Effect.forkChild);
        yield* stepper.drain;
        if (closing.pollUnsafe() === undefined) {
          yield* TestClock.adjust("30 seconds");
        }
        assert.isTrue(
          Exit.isSuccess(yield* Fiber.join(closing)),
          `interrupt at op ${ops} stranded the opening record`,
        );
        if (!reached) break;
      }
    }).pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 3_600_000,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 close joins an open still resolving its workspace", () =>
  Effect.gen(function* () {
    const realFileSystem = yield* FileSystem.FileSystem;
    const root = yield* realFileSystem.makeTempDirectoryScoped();
    const cwd = `${root}/workspace`;
    yield* realFileSystem.makeDirectory(cwd);
    const statEntered = yield* Deferred.make<void>();
    const statRelease = yield* Deferred.make<void>();
    const gatedFileSystem = new Proxy(realFileSystem, {
      get: (target, property, receiver) =>
        property === "stat"
          ? (path: string) =>
              path === cwd
                ? Deferred.succeed(statEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(statRelease)),
                    Effect.andThen(target.stat(path)),
                  )
                : target.stat(path)
          : Reflect.get(target, property, receiver),
    });
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManagerV2;
      const threadId = ThreadId.make("thread-close-during-workspace-stat");
      const { allocate } = yield* makeThreadSessionFixture(threadId);
      const providerSessionId = yield* allocate;
      const opening = yield* manager
        .open({
          providerSessionId,
          threadId,
          modelSelection,
          runtimePolicy: { ...runtimePolicy, cwd },
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(statEntered);
      const closing = yield* manager.close(providerSessionId).pipe(Effect.exit, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      // The startup record is registered before the workspace stat, so the
      // close marks it and joins its unwind — it cannot complete while the
      // open is still parked. When the stat resolves, the marked record
      // fences the spawn and the unwind settles the close.
      assert.isTrue(closing.pollUnsafe() === undefined);
      yield* Deferred.succeed(statRelease, undefined);
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(closing)));
      assert.equal((yield* Fiber.join(opening))._tag, "Failure");
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
    }).pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 3_600_000,
          fileSystemLayer: Layer.succeed(FileSystem.FileSystem, gatedFileSystem),
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderSessionManagerV2 closeInstance joins only its own unfinished sweeps", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const gateA = yield* Ref.make<string | undefined>(undefined);
    const gateB = yield* Ref.make<string | undefined>(undefined);
    const revokingA = yield* Deferred.make<void>();
    const revokingB = yield* Deferred.make<void>();
    const gateFirst = yield* Deferred.make<void>();
    const gateSecond = yield* Deferred.make<void>();
    const releaseArmed = yield* Ref.make(false);
    const releaseStarted = yield* Deferred.make<void>();
    const mcpRegistryLayer = Layer.effect(
      McpSessionRegistry.McpSessionRegistry,
      Effect.gen(function* () {
        const delegate = yield* McpSessionRegistry.McpSessionRegistry;
        return McpSessionRegistry.McpSessionRegistry.of({
          ...delegate,
          revokeProviderSession: (providerSessionId) =>
            Effect.gen(function* () {
              const a = yield* Ref.get(gateA);
              const b = yield* Ref.get(gateB);
              if (providerSessionId === a) {
                yield* Deferred.succeed(revokingA, undefined);
                yield* Deferred.await(gateFirst);
              } else if (providerSessionId === b) {
                yield* Deferred.succeed(revokingB, undefined);
                yield* Deferred.await(gateSecond);
              }
            }).pipe(Effect.andThen(delegate.revokeProviderSession(providerSessionId))),
        });
      }),
    ).pipe(Layer.provide(TestMcpRegistryLayer));

    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManagerV2;
      const idAllocator = yield* IdAllocatorV2;
      const threadId = ThreadId.make("thread-closeinstance-own-sweep");
      const peerA = ThreadId.make("thread-closeinstance-own-sweep-a");
      const peerB = ThreadId.make("thread-closeinstance-own-sweep-b");
      const peerC = ThreadId.make("thread-closeinstance-own-sweep-c");
      const otherSelection = {
        ...modelSelection,
        instanceId: ProviderInstanceId.make("codex_other"),
      };
      const firstA = yield* makeThreadSessionFixture(threadId);
      const holderA = yield* makeThreadSessionFixture(peerA);
      yield* makeThreadSessionFixture(peerB);
      yield* makeThreadSessionFixture(peerC);
      const sessionA = yield* firstA.allocate;
      const sessionB = yield* idAllocator.allocate.providerSession({
        providerInstanceId: otherSelection.instanceId,
        threadId: peerB,
      });
      const sessionC = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: peerC,
      });
      yield* firstA.open(sessionA);
      yield* holderA.open(sessionA, peerA);
      const credentialA = McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId;
      yield* Ref.set(gateA, credentialA);
      yield* manager.open({
        threadId: peerB,
        providerSessionId: sessionB,
        modelSelection: otherSelection,
        runtimePolicy,
      });
      yield* manager.open({
        threadId,
        providerSessionId: sessionB,
        modelSelection: otherSelection,
        runtimePolicy,
      });
      const credentialB = McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId;
      yield* Ref.set(gateB, credentialB);
      yield* manager.open({
        threadId: peerC,
        providerSessionId: sessionC,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.open({
        threadId,
        providerSessionId: sessionC,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.close(sessionC);

      // Sweep A parks on its credential; B's detach chains a successor tail
      // behind it.
      const detachA = yield* manager
        .detach({ providerSessionId: sessionA, threadId, revokeMcpCredential: true })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(revokingA);
      const detachB = yield* manager
        .detach({ providerSessionId: sessionB, threadId, revokeMcpCredential: true })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      // closeInstance starts while A's sweep is still pending. The release
      // handshake means it is parked on the revocation join by the time the
      // test resumes.
      yield* Ref.set(releaseArmed, true);
      const closingA = yield* manager
        .closeInstance(modelSelection.instanceId)
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(releaseStarted);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      // A's sweep finishes while B's chained sweep stays parked on its own
      // credential. Joining the matching record — not the tail — lets A's
      // teardown complete now.
      yield* Deferred.succeed(gateFirst, undefined);
      yield* Deferred.await(revokingB);
      yield* Effect.yieldNow;
      const early = closingA.pollUnsafe();
      assert.isTrue(early !== undefined && Exit.isSuccess(early));

      // detachA joined its own tail, which settled when A's sweep finished;
      // detachB is still parked behind B's sweep and fails at the bound.
      yield* TestClock.adjust("30 seconds");
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(detachA)));
      assert.equal((yield* Fiber.join(detachB))._tag, "Failure");
      yield* Deferred.succeed(gateSecond, undefined);
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(closingA)));
    }).pipe(
      Effect.ensuring(
        Deferred.succeed(gateFirst, undefined).pipe(
          Effect.andThen(Deferred.succeed(gateSecond, undefined)),
        ),
      ),
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 3_600_000,
          mcpConfigs,
          mcpRegistryLayer,
          beforeClose: Ref.get(releaseArmed).pipe(
            Effect.flatMap((armed) =>
              armed ? Deferred.succeed(releaseStarted, undefined).pipe(Effect.asVoid) : Effect.void,
            ),
          ),
          extraAdapters: [
            makeProviderAdapter(state, {
              instanceId: ProviderInstanceId.make("codex_other"),
            }),
          ],
        }),
      ),
    );
  }),
);
