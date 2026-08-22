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
  type OrchestrationV2ProviderTurn,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpServer } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
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

const makeFailingAttachEventSinkLayer = (input: {
  readonly threadId: ThreadId;
  readonly capturedConfig: Ref.Ref<McpProviderSession.McpProviderSessionConfig | undefined>;
  /** When set, attach failures arm only while this ref is true. */
  readonly enabled?: Ref.Ref<boolean>;
}) =>
  Layer.effect(
    EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSinkV2;
      return EventSinkV2.of({
        ...delegate,
        write: (writeInput) =>
          Effect.gen(function* () {
            const shouldFail =
              writeInput.events.some(
                (event) =>
                  event.type === "provider-session.attached" && event.threadId === input.threadId,
              ) &&
              (input.enabled === undefined || (yield* Ref.get(input.enabled)));
            if (!shouldFail) {
              return yield* delegate.write(writeInput);
            }
            yield* Ref.set(
              input.capturedConfig,
              McpProviderSession.readMcpProviderSession(input.threadId),
            );
            return yield* new EventSinkWriteError({ eventCount: writeInput.events.length });
          }),
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
  readonly deleteCount: number;
  readonly detachedDeleteCount: number;
  readonly interruptCount: number;
  readonly interruptedNativeThreadIds: ReadonlyArray<string | null>;
  readonly resumeCount: number;
  readonly startCount: number;
  readonly eventQueues: ReadonlyMap<string, Queue.Queue<ProviderAdapterV2Event>>;
}

const emptyState: TestProviderRuntimeState = {
  openCount: 0,
  closeCount: 0,
  deleteCount: 0,
  detachedDeleteCount: 0,
  interruptCount: 0,
  interruptedNativeThreadIds: [],
  resumeCount: 0,
  startCount: 0,
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
    readonly failEventStream?: boolean;
    readonly capabilities?: OrchestrationV2ProviderCapabilities;
    readonly mcpConfigs?: Ref.Ref<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >;
    readonly beforeOpen?: (input: {
      readonly providerSessionId: ProviderSessionId;
    }) => Effect.Effect<void>;
    /**
     * Runs after the session scope finalizers are registered, before
     * openSession returns: the natural place to park an open that is fully set
     * up so tests can interrupt it mid-openSession.
     */
    readonly afterOpenSetup?: (input: {
      readonly providerSessionId: ProviderSessionId;
    }) => Effect.Effect<void>;
    /** Parks or observes native thread deletion during detach. */
    readonly beforeDeleteThread?: Effect.Effect<void>;
    /** Parks native thread creation during a manager-owned operation. */
    readonly beforeEnsureThread?: Effect.Effect<void>;
    readonly ensuredProviderThread?: Effect.Effect<OrchestrationV2ProviderThread>;
    /** Parks or observes native turn start during a manager-owned operation. */
    readonly beforeStartTurn?: Effect.Effect<void>;
    /** Runs after the raw running event is queued but before start returns. */
    readonly afterStartTurnEvent?: Effect.Effect<void>;
    readonly failAfterStartTurnEvent?: boolean;
    readonly emitSessionUpdateBeforeTurn?: boolean;
    readonly emitPendingTurnOnly?: boolean;
    readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
    readonly hangSessionScopeClose?: boolean;
    readonly onHangingSessionScopeClose?: Effect.Effect<void>;
    readonly failDeleteThread?: boolean;
    readonly failNextDeleteThread?: Ref.Ref<boolean>;
    readonly failDetachedDeleteThread?: boolean;
    readonly omitDeleteThread?: boolean;
  } = {},
): ProviderAdapterV2Shape {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: CODEX_DRIVER,
    deleteDetachedThread: () =>
      Ref.update(state, (current) => ({
        ...current,
        detachedDeleteCount: current.detachedDeleteCount + 1,
      })).pipe(
        Effect.andThen(
          options.failDetachedDeleteThread === true
            ? unimplemented("detached native deletion failed")
            : Effect.void,
        ),
      ),
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
          yield* Effect.addFinalizer(() =>
            (options.onHangingSessionScopeClose ?? Effect.void).pipe(Effect.andThen(Effect.never)),
          );
        }
        if (options.afterOpenSetup !== undefined) {
          yield* options.afterOpenSetup({ providerSessionId: input.providerSessionId });
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
          ensureThread: () =>
            options.ensuredProviderThread === undefined
              ? unimplemented("ensureThread unused in test")
              : (options.beforeEnsureThread ?? Effect.void).pipe(
                  Effect.andThen(options.ensuredProviderThread),
                ),
          resumeThread: (threadInput) =>
            Ref.update(state, (current) => ({
              ...current,
              resumeCount: current.resumeCount + 1,
            })).pipe(Effect.as(threadInput.providerThread)),
          ...(options.omitDeleteThread === true
            ? {}
            : {
                deleteThread: () =>
                  Effect.gen(function* () {
                    if (options.beforeDeleteThread !== undefined) {
                      yield* options.beforeDeleteThread;
                    }
                    yield* Ref.update(state, (current) => ({
                      ...current,
                      deleteCount: current.deleteCount + 1,
                    }));
                    const failDeleteThread =
                      options.failDeleteThread === true ||
                      (options.failNextDeleteThread !== undefined &&
                        (yield* Ref.getAndSet(options.failNextDeleteThread, false)));
                    if (failDeleteThread) {
                      return yield* unimplemented("native deletion failed");
                    }
                  }),
              }),
          startTurn: (input) =>
            Effect.gen(function* () {
              if (options.beforeStartTurn !== undefined) {
                yield* options.beforeStartTurn;
              }
              if (options.emitSessionUpdateBeforeTurn === true) {
                yield* Queue.offer(events, {
                  type: "provider_session.updated",
                  driver: CODEX_DRIVER,
                  providerSession: session,
                });
              }
              const startedAt = yield* DateTime.now;
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver: CODEX_DRIVER,
                threadId: input.threadId,
                providerTurn: {
                  id: ProviderTurnId.make(`provider-turn:${input.attemptId}`),
                  providerThreadId: input.providerThread.id,
                  nodeId: input.rootNodeId,
                  runAttemptId: input.attemptId,
                  nativeTurnRef: null,
                  ordinal: input.providerTurnOrdinal,
                  status: options.emitPendingTurnOnly === true ? "pending" : "running",
                  startedAt: options.emitPendingTurnOnly === true ? null : startedAt,
                  completedAt: null,
                },
              });
              if (options.afterStartTurnEvent !== undefined) {
                yield* options.afterStartTurnEvent;
              }
              if (options.failAfterStartTurnEvent === true) {
                return yield* unimplemented("native turn start failed after running event");
              }
              yield* Ref.update(state, (current) => ({
                ...current,
                startCount: current.startCount + 1,
              }));
            }),
          steerTurn: () => Effect.void,
          interruptTurn: (input) =>
            Ref.update(state, (current) => ({
              ...current,
              interruptCount: current.interruptCount + 1,
              interruptedNativeThreadIds: [
                ...current.interruptedNativeThreadIds,
                input.providerThread.nativeThreadRef?.nativeId ?? null,
              ],
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
  readonly afterOpenSetup?: (input: {
    readonly providerSessionId: ProviderSessionId;
  }) => Effect.Effect<void>;
  readonly beforeDeleteThread?: Effect.Effect<void>;
  readonly beforeEnsureThread?: Effect.Effect<void>;
  readonly beforeStartTurn?: Effect.Effect<void>;
  readonly afterStartTurnEvent?: Effect.Effect<void>;
  readonly failAfterStartTurnEvent?: boolean;
  readonly emitSessionUpdateBeforeTurn?: boolean;
  readonly emitPendingTurnOnly?: boolean;
  readonly ensuredProviderThread?: Effect.Effect<OrchestrationV2ProviderThread>;
  readonly afterProviderTurnObservation?: (
    providerTurn: OrchestrationV2ProviderTurn,
  ) => Effect.Effect<void>;
  readonly afterRuntimeOperationAdmission?: (
    runtime: ProviderAdapterV2SessionRuntime,
  ) => Effect.Effect<void>;
  readonly beforeRuntimeOperationIdleRearm?: Effect.Effect<void>;
  readonly afterIdleScheduleReservation?: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly generation: number;
  }) => Effect.Effect<void>;
  readonly beforeStaleArchiveRestore?: Effect.Effect<void>;
  readonly afterEntryCommit?: Effect.Effect<void>;
  readonly beforeReuseActivity?: Effect.Effect<void>;
  readonly beforeEventSinkWrite?: (
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
  ) => Effect.Effect<void>;
  readonly releaseScopeCloseTimeoutMs?: number;
  readonly runtimeOperationDrainTimeoutMs?: number;
  readonly failReleaseEventWrites?: boolean;
  readonly failAttachedThread?: {
    readonly threadId: ThreadId;
    readonly capturedConfig: Ref.Ref<McpProviderSession.McpProviderSessionConfig | undefined>;
    readonly enabled?: Ref.Ref<boolean>;
  };
  readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
  readonly hangSessionScopeClose?: boolean;
  readonly onHangingSessionScopeClose?: Effect.Effect<void>;
  readonly failDeleteThread?: boolean;
  readonly failNextDeleteThread?: Ref.Ref<boolean>;
  readonly failDetachedDeleteThread?: boolean;
  readonly omitDeleteThread?: boolean;
  readonly serverSettingsLayer?: Layer.Layer<ServerSettings.ServerSettingsService>;
}) {
  let configuredEventSinkLayer = TestEventSinkLayer;
  if (input.failAttachedThread !== undefined) {
    configuredEventSinkLayer = makeFailingAttachEventSinkLayer(input.failAttachedThread);
  } else if (input.failReleaseEventWrites) {
    configuredEventSinkLayer = FailingReleaseEventSinkLayer;
  }
  if (input.beforeEventSinkWrite !== undefined) {
    const beforeEventSinkWrite = input.beforeEventSinkWrite;
    const delegateLayer = configuredEventSinkLayer;
    configuredEventSinkLayer = Layer.effect(
      EventSinkV2,
      Effect.gen(function* () {
        const delegate = yield* EventSinkV2;
        return EventSinkV2.of({
          ...delegate,
          write: (writeInput) =>
            beforeEventSinkWrite(writeInput.events).pipe(
              Effect.andThen(delegate.write(writeInput)),
            ),
        });
      }),
    ).pipe(Layer.provide(delegateLayer));
  }
  const registryLayer = makeProviderAdapterRegistryLayer(
    makeProviderAdapter(input.state, {
      failEventStream: input.failEventStream ?? false,
      ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
      ...(input.mcpConfigs === undefined ? {} : { mcpConfigs: input.mcpConfigs }),
      ...(input.beforeOpen === undefined ? {} : { beforeOpen: input.beforeOpen }),
      ...(input.afterOpenSetup === undefined ? {} : { afterOpenSetup: input.afterOpenSetup }),
      ...(input.beforeDeleteThread === undefined
        ? {}
        : { beforeDeleteThread: input.beforeDeleteThread }),
      ...(input.beforeEnsureThread === undefined
        ? {}
        : { beforeEnsureThread: input.beforeEnsureThread }),
      ...(input.beforeStartTurn === undefined ? {} : { beforeStartTurn: input.beforeStartTurn }),
      ...(input.afterStartTurnEvent === undefined
        ? {}
        : { afterStartTurnEvent: input.afterStartTurnEvent }),
      ...(input.failAfterStartTurnEvent === undefined
        ? {}
        : { failAfterStartTurnEvent: input.failAfterStartTurnEvent }),
      ...(input.emitSessionUpdateBeforeTurn === undefined
        ? {}
        : { emitSessionUpdateBeforeTurn: input.emitSessionUpdateBeforeTurn }),
      ...(input.emitPendingTurnOnly === undefined
        ? {}
        : { emitPendingTurnOnly: input.emitPendingTurnOnly }),
      ...(input.ensuredProviderThread === undefined
        ? {}
        : { ensuredProviderThread: input.ensuredProviderThread }),
      ...(input.hasPendingBackgroundWork === undefined
        ? {}
        : { hasPendingBackgroundWork: input.hasPendingBackgroundWork }),
      ...(input.hangSessionScopeClose === undefined
        ? {}
        : { hangSessionScopeClose: input.hangSessionScopeClose }),
      ...(input.onHangingSessionScopeClose === undefined
        ? {}
        : { onHangingSessionScopeClose: input.onHangingSessionScopeClose }),
      ...(input.failDeleteThread === undefined ? {} : { failDeleteThread: input.failDeleteThread }),
      ...(input.failNextDeleteThread === undefined
        ? {}
        : { failNextDeleteThread: input.failNextDeleteThread }),
      ...(input.failDetachedDeleteThread === undefined
        ? {}
        : { failDetachedDeleteThread: input.failDetachedDeleteThread }),
      ...(input.omitDeleteThread === undefined ? {} : { omitDeleteThread: input.omitDeleteThread }),
    }),
  );
  return Layer.mergeAll(
    TestDatabaseLayer,
    TestStoresLayer,
    configuredEventSinkLayer,
    idAllocatorLayer,
    TestMcpRegistryLayer,
    providerSessionManagerLayerWithOptions({
      idleTimeoutMs: input.idleTimeoutMs,
      ...(input.maxIdlePinMs === undefined ? {} : { maxIdlePinMs: input.maxIdlePinMs }),
      ...(input.afterEntryCommit === undefined ? {} : { afterEntryCommit: input.afterEntryCommit }),
      ...(input.beforeReuseActivity === undefined
        ? {}
        : { beforeReuseActivity: input.beforeReuseActivity }),
      ...(input.releaseScopeCloseTimeoutMs === undefined
        ? {}
        : { releaseScopeCloseTimeoutMs: input.releaseScopeCloseTimeoutMs }),
      ...(input.runtimeOperationDrainTimeoutMs === undefined
        ? {}
        : { runtimeOperationDrainTimeoutMs: input.runtimeOperationDrainTimeoutMs }),
      ...(input.afterProviderTurnObservation === undefined
        ? {}
        : { afterProviderTurnObservation: input.afterProviderTurnObservation }),
      ...(input.afterRuntimeOperationAdmission === undefined
        ? {}
        : { afterRuntimeOperationAdmission: input.afterRuntimeOperationAdmission }),
      ...(input.beforeRuntimeOperationIdleRearm === undefined
        ? {}
        : { beforeRuntimeOperationIdleRearm: input.beforeRuntimeOperationIdleRearm }),
      ...(input.afterIdleScheduleReservation === undefined
        ? {}
        : { afterIdleScheduleReservation: input.afterIdleScheduleReservation }),
      ...(input.beforeStaleArchiveRestore === undefined
        ? {}
        : { beforeStaleArchiveRestore: input.beforeStaleArchiveRestore }),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          registryLayer,
          configuredEventSinkLayer,
          idAllocatorLayer,
          TestMcpRegistryLayer,
          TestStoresLayer,
          ...(input.serverSettingsLayer === undefined ? [] : [input.serverSettingsLayer]),
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
        assert.deepEqual(resolved?.capabilities, new Set(["preview", "orchestration", "worktree"]));

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
        assert.deepEqual(resolved?.capabilities, new Set(["orchestration", "worktree"]));

        yield* manager.close(providerSessionId);
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
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

it.effect("ProviderSessionManagerV2 revokes MCP credentials when a shared attach fails", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const failedAttachConfig = yield* Ref.make<
      McpProviderSession.McpProviderSessionConfig | undefined
    >(undefined);
    const firstThreadId = ThreadId.make("thread-provider-session-manager-attach-owner");
    const secondThreadId = ThreadId.make("thread-provider-session-manager-attach-failure");
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const now = yield* DateTime.now;
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

      const firstConfig = (yield* Ref.get(mcpConfigs))[0];
      const firstToken = firstConfig?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(firstToken);
      assert.isDefined(yield* registry.resolve(firstToken!));

      const attachExit = yield* manager
        .open({
          threadId: secondThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(attachExit));

      const captured = yield* Ref.get(failedAttachConfig);
      const failedToken = captured?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(failedToken);
      assert.isUndefined(McpProviderSession.readMcpProviderSession(secondThreadId));
      assert.isUndefined(yield* registry.resolve(failedToken!));
      assert.isDefined(yield* registry.resolve(firstToken!));
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1_000,
          mcpConfigs,
          failAttachedThread: {
            threadId: secondThreadId,
            capturedConfig: failedAttachConfig,
          },
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 preserves a reused MCP credential when reattach fails", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const failedAttachConfig = yield* Ref.make<
      McpProviderSession.McpProviderSessionConfig | undefined
    >(undefined);
    const failNextAttach = yield* Ref.make(false);
    const threadId = ThreadId.make("thread-provider-session-manager-reattach-reuse-fail");
    const peerThreadId = ThreadId.make("thread-provider-session-manager-reattach-reuse-peer");
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const now = yield* DateTime.now;
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
          yield* makeThreadCreatedEvent({ idAllocator, threadId: peerThreadId, now }),
        ],
      });
      // Shared multi-thread session: both threads open against one provider process.
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.open({
        threadId: peerThreadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      const original = (yield* Ref.get(mcpConfigs))[0];
      const originalToken = original?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(originalToken);
      assert.equal((yield* registry.resolve(originalToken!))?.threadId, threadId);

      // Workspace handoff: detach the first thread while the provider process
      // (and the peer thread) keep the original credential.
      yield* manager.detach({ providerSessionId, threadId });
      assert.equal(
        McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId,
        original?.providerSessionId,
      );
      assert.isDefined(yield* registry.resolve(originalToken!));

      // Arm the attach failure only for the reattach path.
      yield* Ref.set(failNextAttach, true);

      // Reattach fails after prepare reused the live credential. Cleanup must
      // not revoke that token: the shared process still holds it.
      const attachExit = yield* manager
        .open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(attachExit));

      const captured = yield* Ref.get(failedAttachConfig);
      const capturedToken = captured?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.equal(capturedToken, originalToken);
      assert.equal(
        McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId,
        original?.providerSessionId,
      );
      assert.equal((yield* registry.resolve(originalToken!))?.threadId, threadId);
      assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          mcpConfigs,
          failAttachedThread: {
            threadId,
            capturedConfig: failedAttachConfig,
            enabled: failNextAttach,
          },
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 does not call the provider when thread attachment fails", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const failedAttachConfig = yield* Ref.make<
      McpProviderSession.McpProviderSessionConfig | undefined
    >(undefined);
    const nativeEnsureCalled = yield* Ref.make(false);
    const ensuredProviderThread = yield* Deferred.make<OrchestrationV2ProviderThread>();
    const firstThreadId = ThreadId.make("thread-provider-session-manager-required-attach-owner");
    const secondThreadId = ThreadId.make("thread-provider-session-manager-required-attach-fail");
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: firstThreadId,
      });
      const providerThread = makeProviderThread({
        idAllocator,
        threadId: secondThreadId,
        providerSessionId,
        now,
      });
      yield* Deferred.succeed(ensuredProviderThread, providerThread);

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

      const error = yield* runtime
        .ensureThread({ threadId: secondThreadId, modelSelection, runtimePolicy })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterProtocolError");
      assert.isFalse(yield* Ref.get(nativeEnsureCalled));
      assert.isUndefined(McpProviderSession.readMcpProviderSession(secondThreadId));
      assert.deepEqual(yield* manager.listAttached(secondThreadId), []);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          ensuredProviderThread: Deferred.await(ensuredProviderThread),
          beforeEnsureThread: Ref.set(nativeEnsureCalled, true),
          failAttachedThread: {
            threadId: secondThreadId,
            capturedConfig: failedAttachConfig,
          },
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 serializes native deletion before replacement open", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const deleteEntered = yield* Deferred.make<void>();
    const releaseDelete = yield* Deferred.make<void>();
    const replacementStarted = yield* Deferred.make<void>();
    const firstDelete = yield* Ref.make(true);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-detach-replace-race");
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
      const firstRuntime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      // Permanent detach parks inside native deleteThread. Release the old
      // entry while it is parked, then attempt a replacement open that reuses
      // the same providerSessionId.
      const detachFiber = yield* manager
        .detach({
          providerSessionId,
          threadId,
          deleteProviderThread: true,
          providerSession: firstRuntime.providerSession,
          requireExpectedRuntime: true,
          providerThreads: [providerThread],
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(deleteEntered);

      const interruptExit = yield* Effect.exit(
        firstRuntime.interruptTurn({
          providerThread,
          providerTurnId: idAllocator.derive.providerTurn({
            driver: CODEX_DRIVER,
            nativeTurnId: "native-turn-after-operation-drain-closed",
          }),
        }),
      );
      assert.isTrue(Exit.isFailure(interruptExit));
      assert.equal((yield* Ref.get(state)).interruptCount, 0);

      yield* manager.close(providerSessionId);
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));

      const replacementFiber = yield* Effect.gen(function* () {
        yield* Deferred.succeed(replacementStarted, undefined);
        return yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(replacementStarted);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      // The replacement cannot commit while native deletion is still using
      // the old runtime, so the old operation cannot delete through R2.
      assert.equal((yield* Ref.get(state)).openCount, 1);

      yield* Deferred.succeed(releaseDelete, undefined);
      yield* Fiber.join(detachFiber);
      const replacementRuntime = yield* Fiber.join(replacementFiber);
      assert.notStrictEqual(replacementRuntime, firstRuntime);
      assert.equal((yield* Ref.get(state)).openCount, 2);
      const replacementCredential = (yield* Ref.get(mcpConfigs)).at(-1);
      const replacementToken = replacementCredential?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(replacementToken);

      const live = yield* manager.get(providerSessionId);
      assert.isTrue(Option.isSome(live));
      assert.strictEqual(Option.getOrThrow(live), replacementRuntime);

      yield* manager.detach({
        providerSessionId,
        threadId,
        providerSession: firstRuntime.providerSession,
        requireExpectedRuntime: true,
      });
      assert.equal((yield* Ref.get(state)).deleteCount, 1);
      assert.strictEqual(
        Option.getOrThrow(yield* manager.get(providerSessionId)),
        replacementRuntime,
      );
      assert.equal((yield* registry.resolve(replacementToken!))?.threadId, threadId);
      assert.equal(
        McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId,
        replacementCredential?.providerSessionId,
      );

      yield* manager.detach({
        providerSessionId,
        threadId,
        providerSession: firstRuntime.providerSession,
        requireExpectedRuntime: true,
        revokeMcpCredential: true,
      });
      assert.strictEqual(
        Option.getOrThrow(yield* manager.get(providerSessionId)),
        replacementRuntime,
      );
      assert.equal((yield* registry.resolve(replacementToken!))?.threadId, threadId);

      yield* manager.detach({
        providerSessionId,
        threadId,
        requireExpectedRuntime: true,
      });
      assert.strictEqual(
        Option.getOrThrow(yield* manager.get(providerSessionId)),
        replacementRuntime,
      );

      yield* manager.detach({
        providerSessionId,
        threadId,
        deleteProviderThread: true,
        revokeMcpCredential: true,
        providerInstanceId: modelSelection.instanceId,
        providerSession: firstRuntime.providerSession,
        requireExpectedRuntime: true,
        providerThreads: [providerThread],
      });
      assert.equal((yield* Ref.get(state)).deleteCount, 2);
      assert.equal((yield* Ref.get(state)).detachedDeleteCount, 0);
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.isUndefined(yield* registry.resolve(replacementToken!));
      assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          capabilities: ExclusiveCapabilities,
          hangSessionScopeClose: true,
          mcpConfigs,
          releaseScopeCloseTimeoutMs: 0,
          beforeDeleteThread: Effect.gen(function* () {
            if (yield* Ref.getAndSet(firstDelete, false)) {
              yield* Deferred.succeed(deleteEntered, undefined);
              yield* Deferred.await(releaseDelete);
            }
          }),
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 retries deletion of a native thread created during detach drain",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const failNextDeleteThread = yield* Ref.make(true);
      const ensureEntered = yield* Deferred.make<void>();
      const releaseEnsure = yield* Deferred.make<void>();
      const ensuredProviderThread = yield* Deferred.make<OrchestrationV2ProviderThread>();

      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const manager = yield* ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-delete-admitted-ensure");
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
        const pendingProviderThread: OrchestrationV2ProviderThread = {
          ...providerThread,
          nativeThreadRef: null,
          status: "not_loaded",
        };
        yield* Deferred.succeed(ensuredProviderThread, providerThread);

        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: pendingProviderThread,
            },
          ],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const ensureFiber = yield* runtime
          .ensureThread({ threadId, modelSelection, runtimePolicy })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(ensureEntered);

        const detachFiber = yield* manager
          .detach({
            providerSessionId,
            threadId,
            deleteProviderThread: true,
            providerInstanceId: modelSelection.instanceId,
            requireExpectedRuntime: true,
            providerThreads: [],
          })
          .pipe(Effect.forkScoped);
        assert.isTrue(
          Option.isNone(yield* Fiber.await(detachFiber).pipe(Effect.timeoutOption("0 millis"))),
        );
        assert.equal((yield* Ref.get(state)).deleteCount, 0);

        yield* Deferred.succeed(releaseEnsure, undefined);
        assert.strictEqual(yield* Fiber.join(ensureFiber), providerThread);
        const firstDetachExit = yield* Fiber.await(detachFiber);

        assert.isTrue(Exit.isFailure(firstDetachExit));
        assert.equal((yield* Ref.get(state)).deleteCount, 1);
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        assert.deepEqual(
          (yield* projectionStore.getThreadProjection(threadId)).providerThreads.map(
            (candidate) => candidate.nativeThreadRef?.nativeId,
          ),
          [providerThread.nativeThreadRef?.nativeId],
        );

        yield* manager.detach({
          providerSessionId,
          threadId,
          deleteProviderThread: true,
          providerInstanceId: modelSelection.instanceId,
          requireExpectedRuntime: true,
          providerThreads: [],
        });
        assert.equal((yield* Ref.get(state)).detachedDeleteCount, 1);
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 60_000,
            capabilities: ExclusiveCapabilities,
            failNextDeleteThread,
            ensuredProviderThread: Deferred.await(ensuredProviderThread),
            beforeEnsureThread: Effect.gen(function* () {
              yield* Deferred.succeed(ensureEntered, undefined);
              yield* Deferred.await(releaseEnsure);
            }),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 deletes distinct native threads that share one logical id",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const replacementProviderThread = yield* Deferred.make<OrchestrationV2ProviderThread>();
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const manager = yield* ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-delete-native-fallbacks");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const original = makeProviderThread({ idAllocator, threadId, providerSessionId, now });
        const replacement: OrchestrationV2ProviderThread = {
          ...original,
          id: original.id,
          nativeThreadRef: {
            driver: CODEX_DRIVER,
            nativeId: "native-thread-replacement",
            strength: "strong",
          },
        };
        yield* Deferred.succeed(replacementProviderThread, replacement);
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: original,
            },
          ],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        assert.strictEqual(
          yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy }),
          replacement,
        );

        yield* manager.detach({
          providerSessionId,
          threadId,
          deleteProviderThread: true,
          providerSession: runtime.providerSession,
          providerThreads: [original],
        });
        assert.equal((yield* Ref.get(state)).deleteCount, 2);
        assert.deepEqual(
          (yield* projectionStore.getThreadProjection(threadId)).providerThreads
            .map((providerThread) => providerThread.nativeThreadRef?.nativeId)
            .sort(),
          ["native-thread", "native-thread-replacement"],
        );
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 60_000,
            capabilities: ExclusiveCapabilities,
            ensuredProviderThread: Deferred.await(replacementProviderThread),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 restores a blind archive detach after unarchive", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-blind-archive-restore");
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
      const initialProjection = yield* projectionStore.getThreadProjection(threadId);
      const archivedAt = DateTime.add(now, { seconds: 1 });
      yield* eventSink.write({
        events: [
          {
            id: yield* idAllocator.allocate.event({ threadId }),
            type: "thread.archived",
            threadId,
            occurredAt: archivedAt,
            payload: {
              ...initialProjection.thread,
              archivedAt,
              updatedAt: archivedAt,
            },
          },
          {
            id: yield* idAllocator.allocate.event({ threadId, providerSessionId }),
            type: "provider-session.detached",
            threadId,
            driver: runtime.driver,
            providerInstanceId: runtime.instanceId,
            occurredAt: archivedAt,
            payload: { providerSessionId, detachedAt: archivedAt },
          },
        ],
      });
      const archivedProjection = yield* projectionStore.getThreadProjection(threadId);
      const unarchivedAt = DateTime.add(now, { seconds: 2 });
      yield* eventSink.write({
        events: [
          {
            id: yield* idAllocator.allocate.event({ threadId }),
            type: "thread.unarchived",
            threadId,
            occurredAt: unarchivedAt,
            payload: {
              ...archivedProjection.thread,
              archivedAt: null,
              updatedAt: unarchivedAt,
            },
          },
        ],
      });

      yield* manager.detach({
        providerSessionId,
        threadId,
        expectedArchivedAt: DateTime.formatIso(archivedAt),
        requireExpectedRuntime: true,
        revokeMcpCredential: true,
      });

      assert.deepEqual(yield* manager.listAttached(threadId), [runtime.providerSession]);
      assert.deepEqual((yield* projectionStore.getThreadProjection(threadId)).providerSessions, [
        runtime.providerSession,
      ]);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          capabilities: ExclusiveCapabilities,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 revalidates stale archive restoration against rearchive", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const restoreEntered = yield* Deferred.make<void>();
    const releaseRestore = yield* Deferred.make<void>();
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-stale-archive");
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
      const initialProjection = yield* projectionStore.getThreadProjection(threadId);
      assert.lengthOf(initialProjection.providerSessions, 1);

      const firstArchivedAt = DateTime.add(now, { seconds: 1 });
      yield* eventSink.write({
        events: [
          {
            id: yield* idAllocator.allocate.event({ threadId }),
            type: "thread.archived",
            threadId,
            occurredAt: firstArchivedAt,
            payload: {
              ...initialProjection.thread,
              archivedAt: firstArchivedAt,
              updatedAt: firstArchivedAt,
            },
          },
          {
            id: yield* idAllocator.allocate.event({ threadId, providerSessionId }),
            type: "provider-session.detached",
            threadId,
            driver: runtime.driver,
            providerInstanceId: runtime.instanceId,
            occurredAt: firstArchivedAt,
            payload: { providerSessionId, detachedAt: firstArchivedAt },
          },
        ],
      });
      const archivedProjection = yield* projectionStore.getThreadProjection(threadId);
      assert.lengthOf(archivedProjection.providerSessions, 0);
      assert.deepEqual(yield* manager.listAttached(threadId), [runtime.providerSession]);

      const unarchivedAt = DateTime.add(now, { seconds: 2 });
      yield* eventSink.write({
        events: [
          {
            id: yield* idAllocator.allocate.event({ threadId }),
            type: "thread.unarchived",
            threadId,
            occurredAt: unarchivedAt,
            payload: {
              ...archivedProjection.thread,
              archivedAt: null,
              updatedAt: unarchivedAt,
            },
          },
        ],
      });
      const staleDetachFiber = yield* manager
        .detach({
          providerSessionId,
          threadId,
          expectedArchivedAt: DateTime.formatIso(firstArchivedAt),
          requireExpectedRuntime: true,
          revokeMcpCredential: true,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(restoreEntered);

      const rearchivedAt = DateTime.add(now, { seconds: 3 });
      const unarchivedProjection = yield* projectionStore.getThreadProjection(threadId);
      yield* eventSink.write({
        events: [
          {
            id: yield* idAllocator.allocate.event({ threadId }),
            type: "thread.archived",
            threadId,
            occurredAt: rearchivedAt,
            payload: {
              ...unarchivedProjection.thread,
              archivedAt: rearchivedAt,
              updatedAt: rearchivedAt,
            },
          },
          {
            id: yield* idAllocator.allocate.event({ threadId, providerSessionId }),
            type: "provider-session.detached",
            threadId,
            driver: runtime.driver,
            providerInstanceId: runtime.instanceId,
            occurredAt: rearchivedAt,
            payload: { providerSessionId, detachedAt: rearchivedAt },
          },
        ],
      });
      yield* Deferred.succeed(releaseRestore, undefined);
      yield* Fiber.join(staleDetachFiber);
      assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      assert.lengthOf((yield* projectionStore.getThreadProjection(threadId)).providerSessions, 0);

      yield* manager.detach({
        providerSessionId,
        threadId,
        expectedArchivedAt: DateTime.formatIso(rearchivedAt),
        requireExpectedRuntime: true,
        revokeMcpCredential: true,
      });
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          capabilities: ExclusiveCapabilities,
          beforeStaleArchiveRestore: Effect.gen(function* () {
            yield* Deferred.succeed(restoreEntered, undefined);
            yield* Deferred.await(releaseRestore);
          }),
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 observes a started turn behind queued persistence during detach drain",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const startEntered = yield* Deferred.make<void>();
      const releaseStart = yield* Deferred.make<void>();
      const pendingObserved = yield* Deferred.make<void>();
      const ensuredProviderThread = yield* Deferred.make<OrchestrationV2ProviderThread>();

      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const manager = yield* ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStoreV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-detach-late-turn",
        });
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-detach-late-turn",
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
        const duplicateProviderThread: OrchestrationV2ProviderThread = {
          ...providerThread,
          id: ProviderThreadId.make(`${providerThread.id}:duplicate-logical-row`),
        };
        const loadedProviderThread: OrchestrationV2ProviderThread = {
          ...providerThread,
          nativeThreadRef: {
            driver: CODEX_DRIVER,
            nativeId: "native-thread-loaded-by-manager",
            strength: "strong",
          },
        };
        yield* Deferred.succeed(ensuredProviderThread, loadedProviderThread);
        const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
        const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
        const rootNodeId = idAllocator.derive.rootNode({ runId });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "provider-thread.updated" as const,
              threadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: providerThread,
            },
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "provider-thread.updated" as const,
              threadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: duplicateProviderThread,
            },
          ],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        assert.strictEqual(
          yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy }),
          loadedProviderThread,
        );
        const appThread = (yield* projectionStore.getThreadProjection(threadId)).thread;

        // Admit startTurn into the runtime operation gate, then park before it
        // emits a running turn. Detach must drain this admitted work first.
        const startFiber = yield* runtime
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
          .pipe(Effect.forkScoped);
        yield* Deferred.await(startEntered);

        const detachFiber = yield* manager
          .detach({
            providerSessionId,
            threadId,
            deleteProviderThread: true,
            providerInstanceId: modelSelection.instanceId,
            providerSession: runtime.providerSession,
            providerThreads: [providerThread],
          })
          .pipe(Effect.forkScoped);

        // Detach has begun draining; the late turn is neither emitted nor projected yet.
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(state)).interruptCount, 0);
        assert.equal(
          (yield* projectionStore.getThreadProjection(threadId)).providerTurns.filter(
            (turn) => turn.status === "running",
          ).length,
          0,
        );

        yield* Deferred.succeed(releaseStart, undefined);
        yield* Deferred.await(pendingObserved);
        assert.isTrue(
          Option.isNone(yield* Fiber.await(startFiber).pipe(Effect.timeoutOption("0 millis"))),
        );
        assert.isTrue(
          Option.isNone(yield* Fiber.await(detachFiber).pipe(Effect.timeoutOption("0 millis"))),
        );
        const runtimeEvents = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(runtimeEvents);
        const startedAt = yield* DateTime.now;
        yield* Queue.offer(runtimeEvents!, {
          type: "provider_turn.updated",
          driver: CODEX_DRIVER,
          threadId,
          providerTurn: {
            id: ProviderTurnId.make(`provider-turn:${attemptId}`),
            providerThreadId: providerThread.id,
            nodeId: rootNodeId,
            runAttemptId: attemptId,
            nativeTurnRef: null,
            ordinal: 1,
            status: "running",
            startedAt,
            completedAt: null,
          },
        });
        yield* Fiber.join(startFiber);
        yield* Fiber.join(detachFiber);

        assert.equal((yield* Ref.get(state)).startCount, 1);
        assert.equal(
          (yield* Ref.get(state)).interruptCount,
          1,
          "detach must interrupt the turn observed from the drained startTurn",
        );
        assert.deepEqual((yield* Ref.get(state)).interruptedNativeThreadIds, [
          "native-thread-loaded-by-manager",
        ]);
        assert.equal((yield* Ref.get(state)).deleteCount, 2);
        assert.equal(
          (yield* projectionStore.getThreadProjection(threadId)).providerTurns.length,
          0,
          "the test must leave persistence delayed beyond the manager event-pump observation",
        );
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 60_000,
            capabilities: ExclusiveCapabilities,
            ensuredProviderThread: Deferred.await(ensuredProviderThread),
            emitSessionUpdateBeforeTurn: true,
            emitPendingTurnOnly: true,
            beforeStartTurn: Effect.gen(function* () {
              yield* Deferred.succeed(startEntered, undefined);
              yield* Deferred.await(releaseStart);
            }),
            afterProviderTurnObservation: (providerTurn) =>
              providerTurn.status === "pending"
                ? Deferred.succeed(pendingObserved, undefined)
                : Effect.void,
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 falls back to detached deletion when release wins", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const startEntered = yield* Deferred.make<void>();
    const releaseStart = yield* Deferred.make<void>();
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-operation-detach",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-operation-detach",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({ idAllocator, threadId, providerSessionId, now });
      const runId = idAllocator.derive.run({ threadId, ordinal: 1 });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const appThread = (yield* projectionStore.getThreadProjection(threadId)).thread;
      const startFiber = yield* runtime
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
            text: "hello",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(startEntered);

      const detachFiber = yield* manager
        .detach({
          providerSessionId,
          threadId,
          deleteProviderThread: true,
          providerInstanceId: modelSelection.instanceId,
          providerSession: runtime.providerSession,
          providerThreads: [providerThread],
        })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.equal((yield* Ref.get(state)).deleteCount, 0);

      yield* manager.close(providerSessionId);
      yield* Deferred.succeed(releaseStart, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.await(startFiber)));
      yield* Fiber.join(detachFiber);
      assert.equal((yield* Ref.get(state)).startCount, 1);
      assert.equal((yield* Ref.get(state)).deleteCount, 0);
      assert.equal((yield* Ref.get(state)).detachedDeleteCount, 1);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          capabilities: ExclusiveCapabilities,
          beforeStartTurn: Effect.gen(function* () {
            yield* Deferred.succeed(startEntered, undefined);
            yield* Deferred.await(releaseStart);
          }),
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 lets a replacement run while an old operation unwinds", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const firstStart = yield* Ref.make(true);
    const startEntered = yield* Deferred.make<void>();
    const releaseStart = yield* Deferred.make<void>();
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-replacement-operation",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-replacement-operation",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({ idAllocator, threadId, providerSessionId, now });
      const appThreadEvent = yield* makeThreadCreatedEvent({ idAllocator, threadId, now });
      yield* eventSink.write({ events: [appThreadEvent] });
      const appThread = (yield* projectionStore.getThreadProjection(threadId)).thread;

      const oldRuntime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const oldRunId = idAllocator.derive.run({ threadId, ordinal: 1 });
      const oldStart = yield* oldRuntime
        .startTurn({
          appThread,
          threadId,
          runId: oldRunId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: idAllocator.derive.runAttempt({ runId: oldRunId, attemptOrdinal: 1 }),
          rootNodeId: idAllocator.derive.rootNode({ runId: oldRunId }),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
            text: "old runtime",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(startEntered);

      yield* manager.close(providerSessionId);
      const replacement = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const replacementRunId = idAllocator.derive.run({ threadId, ordinal: 2 });
      yield* replacement.startTurn({
        appThread,
        threadId,
        runId: replacementRunId,
        runOrdinal: 2,
        providerTurnOrdinal: 2,
        attemptId: idAllocator.derive.runAttempt({
          runId: replacementRunId,
          attemptOrdinal: 1,
        }),
        rootNodeId: idAllocator.derive.rootNode({ runId: replacementRunId }),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 2 }),
          text: "replacement runtime",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      assert.equal((yield* Ref.get(state)).startCount, 1);

      yield* Deferred.succeed(releaseStart, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.await(oldStart)));
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          beforeStartTurn: Effect.gen(function* () {
            if (yield* Ref.getAndSet(firstStart, false)) {
              yield* Deferred.succeed(startEntered, undefined);
              yield* Deferred.await(releaseStart);
            }
          }),
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 serializes attachment persistence with release", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const writeEntered = yield* Deferred.make<void>();
    const releaseWrite = yield* Deferred.make<void>();
    const secondThreadId = ThreadId.make("thread-provider-session-manager-attach-persist-race");
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const firstThreadId = ThreadId.make("thread-provider-session-manager-attach-persist-owner");
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

      const attachFiber = yield* manager
        .open({
          threadId: secondThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(writeEntered);
      const closeFiber = yield* manager.close(providerSessionId).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.isUndefined(closeFiber.pollUnsafe());

      yield* Deferred.succeed(releaseWrite, undefined);
      yield* Fiber.join(attachFiber);
      yield* Fiber.join(closeFiber);
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          beforeEventSinkWrite: (events) =>
            events.some(
              (event) =>
                event.type === "provider-session.attached" && event.threadId === secondThreadId,
            )
              ? Deferred.succeed(writeEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseWrite)),
                )
              : Effect.void,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 serializes status persistence with replacement", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const writeEntered = yield* Deferred.make<void>();
    const releaseWrite = yield* Deferred.make<void>();
    const blockStatusWrite = yield* Ref.make(true);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-status-persist-race");
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
      const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(queue);
      yield* Queue.offer(queue!, {
        type: "provider_session.updated",
        driver: CODEX_DRIVER,
        providerSession: runtime.providerSession,
      });
      yield* Deferred.await(writeEntered);

      const closeFiber = yield* manager.close(providerSessionId).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.isUndefined(closeFiber.pollUnsafe());
      yield* Deferred.succeed(releaseWrite, undefined);
      yield* Fiber.join(closeFiber);

      const replacement = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(
        projection.providerSessions.at(-1)?.incarnationId,
        replacement.providerSession.incarnationId,
      );
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          beforeEventSinkWrite: (events) =>
            Effect.gen(function* () {
              if (
                !events.some((event) => event.type === "provider-session.updated") ||
                !(yield* Ref.getAndSet(blockStatusWrite, false))
              ) {
                return;
              }
              yield* Deferred.succeed(writeEntered, undefined);
              yield* Deferred.await(releaseWrite);
            }),
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 finalizes a runtime when drain release persistence fails", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const startEntered = yield* Deferred.make<void>();
    const releaseStart = yield* Deferred.make<void>();
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-operation-drain-timeout",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-operation-drain-timeout",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({ idAllocator, threadId, providerSessionId, now });
      const runId = idAllocator.derive.run({ threadId, ordinal: 1 });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const appThread = (yield* projectionStore.getThreadProjection(threadId)).thread;
      const startFiber = yield* runtime
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
            text: "wedged runtime",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(startEntered);

      const detachExit = yield* Effect.exit(
        manager.detach({
          providerSessionId,
          threadId,
          deleteProviderThread: true,
          providerSession: runtime.providerSession,
          requireExpectedRuntime: true,
          providerThreads: [providerThread],
        }),
      );
      assert.isTrue(Exit.isFailure(detachExit));
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);

      const replacement = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      assert.notStrictEqual(replacement, runtime);
      yield* Deferred.succeed(releaseStart, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.await(startFiber)));
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          failReleaseEventWrites: true,
          idleTimeoutMs: 60_000,
          runtimeOperationDrainTimeoutMs: 0,
          beforeStartTurn: Effect.gen(function* () {
            yield* Deferred.succeed(startEntered, undefined);
            yield* Deferred.await(releaseStart);
          }),
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
        // S1 records credential C1 and stays attached to the thread.
        yield* manager.open({ threadId, providerSessionId: s1, modelSelection, runtimePolicy });

        // The credential dies externally, so S2's attach must rotate to C2.
        yield* registry.revokeThread(threadId);
        yield* manager.open({ threadId, providerSessionId: s2, modelSelection, runtimePolicy });
        const rotated = McpProviderSession.readMcpProviderSession(threadId);
        assert.isDefined(rotated);
        const rotatedToken = rotated?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(yield* registry.resolve(rotatedToken!));

        // Releasing S2 must revoke C2 even though attached S1 still carries a
        // stale record of dead C1 for the same thread.
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
        yield* Ref.set(duringOpen, manager.close(s1).pipe(Effect.orDie));
        yield* manager.open({ threadId, providerSessionId: s2, modelSelection, runtimePolicy });

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

it.effect("ProviderSessionManagerV2 deletes native threads only on permanent detach", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-native-delete",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-native-delete",
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
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
          {
            id: yield* idAllocator.allocate.event({ threadId }),
            type: "provider-thread.updated",
            threadId,
            driver: CODEX_DRIVER,
            occurredAt: now,
            payload: providerThread,
          },
        ],
      });
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });

      yield* manager.detach({
        providerSessionId,
        threadId,
        detail: "Thread deleted.",
        deleteProviderThread: true,
      });

      assert.equal((yield* Ref.get(state)).deleteCount, 1);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1_000,
          capabilities: ExclusiveCapabilities,
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 cleans up the session and MCP credential when native deletion fails",
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
        const threadId = ThreadId.make("thread-provider-session-manager-delete-failure");
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
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: providerThread,
            },
          ],
        });
        yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
        const token = (yield* Ref.get(mcpConfigs))
          .at(-1)
          ?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(yield* registry.resolve(token!));

        yield* manager
          .detach({
            providerSessionId,
            threadId,
            detail: "Thread deleted.",
            deleteProviderThread: true,
            revokeMcpCredential: true,
          })
          .pipe(Effect.flip);

        const runtimeState = yield* Ref.get(state);
        assert.equal(runtimeState.deleteCount, 1);
        assert.equal(runtimeState.closeCount, 1);
        assert.isUndefined(yield* registry.resolve(token!));
        assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            capabilities: ExclusiveCapabilities,
            mcpConfigs,
            failDeleteThread: true,
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 deletes detached historical native threads", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-historical-native-delete",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-historical-native-delete",
        }),
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerSession = makeProviderSession({ providerSessionId, now });
      const providerThread = makeProviderThread({
        idAllocator,
        threadId,
        providerSessionId,
        now,
      });

      yield* manager.detach({
        providerSessionId,
        threadId,
        detail: "Thread deleted.",
        deleteProviderThread: true,
        providerInstanceId: modelSelection.instanceId,
        providerSession,
        providerThreads: [providerThread],
      });

      assert.equal((yield* Ref.get(state)).detachedDeleteCount, 1);
      assert.equal((yield* Ref.get(state)).openCount, 0);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1_000,
          capabilities: ExclusiveCapabilities,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 reports detached native deletion after cleanup", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-historical-native-delete-failure",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-historical-native-delete-failure",
        }),
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* manager
        .detach({
          providerSessionId,
          threadId,
          detail: "Thread deleted.",
          deleteProviderThread: true,
          revokeMcpCredential: true,
          providerInstanceId: modelSelection.instanceId,
          providerSession: makeProviderSession({ providerSessionId, now }),
          providerThreads: [makeProviderThread({ idAllocator, threadId, providerSessionId, now })],
        })
        .pipe(Effect.flip);

      assert.equal((yield* Ref.get(state)).detachedDeleteCount, 1);
      assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1_000,
          capabilities: ExclusiveCapabilities,
          failDetachedDeleteThread: true,
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 aborts deletion atomically after a projection read failure",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const manager = yield* ProviderSessionManagerV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-projection-read-failure");
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
        yield* sql`DROP TABLE orchestration_v2_projection_threads`;

        const error = yield* manager
          .detach({
            providerSessionId,
            threadId,
            deleteProviderThread: true,
            providerInstanceId: modelSelection.instanceId,
            providerSession: runtime.providerSession,
            providerThreads: [
              makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
            ],
          })
          .pipe(Effect.flip);

        assert.equal(error._tag, "ProviderSessionReleaseError");
        assert.equal((yield* Ref.get(state)).detachedDeleteCount, 0);
        assert.equal((yield* Ref.get(state)).deleteCount, 0);
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({ state, idleTimeoutMs: 1_000, capabilities: ExclusiveCapabilities }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 retries deletion when the adapter is unavailable", () =>
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
      const threadId = ThreadId.make("thread-provider-session-manager-adapter-unavailable");
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
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
          {
            id: yield* idAllocator.allocate.event({ threadId }),
            type: "provider-thread.updated",
            threadId,
            driver: CODEX_DRIVER,
            occurredAt: now,
            payload: providerThread,
          },
        ],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const token = (yield* Ref.get(mcpConfigs))
        .at(-1)
        ?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(yield* registry.resolve(token!));

      const error = yield* manager
        .detach({
          providerSessionId,
          threadId,
          deleteProviderThread: true,
          revokeMcpCredential: true,
          providerInstanceId: ProviderInstanceId.make("missing-adapter"),
          providerSession: runtime.providerSession,
          providerThreads: [providerThread],
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderSessionReleaseError");
      assert.equal((yield* Ref.get(state)).detachedDeleteCount, 0);
      assert.equal((yield* Ref.get(state)).closeCount, 1);
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.isUndefined(yield* registry.resolve(token!));
      assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1_000,
          capabilities: ExclusiveCapabilities,
          mcpConfigs,
          omitDeleteThread: true,
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
  "ProviderSessionManagerV2 does not idle-release an admitted operation before it starts",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const admitted = yield* Deferred.make<void>();
      const continueOperation = yield* Deferred.make<void>();
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const manager = yield* ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-admitted-idle-race",
          projectId: yield* idAllocator.allocate.project({
            fixtureName: "provider-session-manager-admitted-idle-race",
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
        const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
        const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });

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
        const turnFiber = yield* runtime
          .startTurn({
            appThread,
            threadId,
            runId,
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId,
            rootNodeId: idAllocator.derive.rootNode({ runId }),
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

        yield* Deferred.await(admitted);
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        assert.lengthOf(yield* manager.listAttached(threadId), 1);
        assert.equal((yield* Ref.get(state)).closeCount, 0);

        yield* Deferred.succeed(continueOperation, undefined);
        yield* Fiber.join(turnFiber);
        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(queue);
        yield* Queue.offer(queue!, {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId: providerThread.id,
          providerTurnId: ProviderTurnId.make(`provider-turn:${attemptId}`),
          runOrdinal: 1,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1000,
            afterRuntimeOperationAdmission: () =>
              Deferred.succeed(admitted, undefined).pipe(
                Effect.andThen(Deferred.await(continueOperation)),
              ),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 releases a runtime whose started turn is never observed", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-start-observation-timeout",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-start-observation-timeout",
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
      const runId = idAllocator.derive.run({ threadId, ordinal: 1 });

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
      const startFiber = yield* runtime
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
            text: "hello",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.exit, Effect.forkScoped);

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.isTrue(Exit.isFailure(yield* Fiber.join(startFiber)));
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);
      assert.equal(
        (yield* projectionStore.getThreadProjection(threadId)).providerSessions.at(-1)?.status,
        "error",
      );
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          emitPendingTurnOnly: true,
          runtimeOperationDrainTimeoutMs: 1000,
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 rearms idle generation atomically with operation completion",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const rearmEntered = yield* Deferred.make<void>();
      const continueRearm = yield* Deferred.make<void>();
      const ensuredProviderThread = yield* Deferred.make<OrchestrationV2ProviderThread>();
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const manager = yield* ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-operation-idle-rearm",
          projectId: yield* idAllocator.allocate.project({
            fixtureName: "provider-session-manager-operation-idle-rearm",
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
        yield* Deferred.succeed(ensuredProviderThread, providerThread);

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const ensureFiber = yield* runtime
          .ensureThread({ threadId, modelSelection, runtimePolicy })
          .pipe(Effect.forkScoped);

        yield* Deferred.await(rearmEntered);
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        assert.lengthOf(yield* manager.listAttached(threadId), 1);
        assert.equal((yield* Ref.get(state)).closeCount, 0);

        yield* Deferred.succeed(continueRearm, undefined);
        assert.strictEqual(yield* Fiber.join(ensureFiber), providerThread);
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        assert.lengthOf(yield* manager.listAttached(threadId), 0);
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1000,
            ensuredProviderThread: Deferred.await(ensuredProviderThread),
            beforeRuntimeOperationIdleRearm: Deferred.succeed(rearmEntered, undefined).pipe(
              Effect.andThen(Deferred.await(continueRearm)),
            ),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 cannot install an older overlapping idle schedule", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const raceArmed = yield* Ref.make(false);
    const parkFirstReservation = yield* Ref.make(true);
    const firstReservation = yield* Deferred.make<void>();
    const continueFirstReservation = yield* Deferred.make<void>();
    const generations = yield* Ref.make<ReadonlyArray<number>>([]);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-overlapping-idle-schedule",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-overlapping-idle-schedule",
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
      const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
      const steerInput = {
        threadId,
        runId,
        providerThread,
        providerTurnId: ProviderTurnId.make("provider-turn:overlapping-idle-schedule"),
        message: {
          createdBy: "user" as const,
          creationSource: "web" as const,
          messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
          text: "continue",
          attachments: [],
        },
      };

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* Ref.set(raceArmed, true);

      const firstSteer = yield* runtime.steerTurn(steerInput).pipe(Effect.forkScoped);
      yield* Deferred.await(firstReservation);
      yield* TestClock.adjust("900 millis");
      yield* runtime.steerTurn(steerInput);
      yield* Deferred.succeed(continueFirstReservation, undefined);
      yield* Fiber.join(firstSteer);

      const reserved = yield* Ref.get(generations);
      assert.isAtLeast(reserved.length, 3);
      assert.deepEqual(
        reserved,
        reserved.toSorted((left, right) => left - right),
      );
      assert.equal(new Set(reserved).size, reserved.length);

      yield* TestClock.adjust("100 millis");
      yield* Effect.yieldNow;
      assert.lengthOf(yield* manager.listAttached(threadId), 1);
      assert.equal((yield* Ref.get(state)).closeCount, 0);

      yield* TestClock.adjust("900 millis");
      yield* Effect.yieldNow;
      assert.lengthOf(yield* manager.listAttached(threadId), 0);
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1000,
          afterIdleScheduleReservation: ({ generation }) =>
            Effect.gen(function* () {
              if (!(yield* Ref.get(raceArmed))) {
                return;
              }
              yield* Ref.update(generations, (current) => [...current, generation]);
              if (yield* Ref.getAndSet(parkFirstReservation, false)) {
                yield* Deferred.succeed(firstReservation, undefined);
                yield* Deferred.await(continueFirstReservation);
              }
            }),
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 releases the runtime on unobserved start interruption", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const startEntered = yield* Deferred.make<void>();
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-start-interruption",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-start-interruption",
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
      const runId = idAllocator.derive.run({ threadId, ordinal: 1 });

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
      const startFiber = yield* runtime
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
            text: "hello",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkScoped);

      yield* Deferred.await(startEntered);
      yield* Fiber.interrupt(startFiber);
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
          beforeStartTurn: Deferred.succeed(startEntered, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 retains bound busy ownership when start later fails", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const runningObserved = yield* Deferred.make<void>();
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-bound-start-failure",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-bound-start-failure",
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
      const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
      const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
      const providerTurnId = ProviderTurnId.make(`provider-turn:${attemptId}`);

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
      const startExit = yield* runtime
        .startTurn({
          appThread,
          threadId,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId,
          rootNodeId: idAllocator.derive.rootNode({ runId }),
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
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(startExit));
      yield* TestClock.adjust("2 seconds");
      yield* Effect.yieldNow;
      assert.lengthOf(yield* manager.listAttached(threadId), 1);
      assert.equal((yield* Ref.get(state)).closeCount, 0);

      const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(queue);
      yield* Queue.offer(queue!, {
        type: "turn.terminal",
        driver: CODEX_DRIVER,
        providerThreadId: providerThread.id,
        providerTurnId,
        runOrdinal: 1,
        status: "failed",
        failure: {
          class: "provider_error",
          message: "Native start failed after emitting the running turn.",
          code: null,
          retryable: null,
        },
        failureItemOrdinal: 1,
        threadDisposition: "reusable",
      });
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.lengthOf(yield* manager.listAttached(threadId), 0);
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1000,
          afterProviderTurnObservation: (providerTurn) =>
            providerTurn.status === "running"
              ? Deferred.succeed(runningObserved, undefined)
              : Effect.void,
          afterStartTurnEvent: Deferred.await(runningObserved),
          failAfterStartTurnEvent: true,
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
        const providerTurnId = ProviderTurnId.make(`provider-turn:${attemptId}`);

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

      // close removes the map entry first, then waits to interrupt the idle
      // fiber (still uninterruptible). That window lets a replacement open
      // under the same providerSessionId before the stale probe finishes.
      const closeFiber = yield* manager.close(providerSessionId).pipe(Effect.forkDetach);
      for (let i = 0; i < 20; i += 1) {
        yield* Effect.yieldNow;
      }
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      assert.equal((yield* Ref.get(state)).openCount, 2);

      // Stale probe reports pending work against the old runtime; the pin
      // stamp must no-op on the replacement (runtime / generation mismatch).
      yield* Deferred.succeed(checkGate, undefined);
      yield* Fiber.join(closeFiber);
      for (let i = 0; i < 10; i += 1) {
        yield* Effect.yieldNow;
      }

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

it.effect("ProviderSessionManagerV2 cancels idle release while reusing a live session", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const reuseEntered = yield* Deferred.make<void>();
    const releaseReuse = yield* Deferred.make<void>();
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-reuse-idle-race");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const firstRuntime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const reuseFiber = yield* manager
        .open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(reuseEntered);

      yield* TestClock.adjust("1 millis");
      for (let i = 0; i < 20; i += 1) yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseReuse, undefined);
      const reusedRuntime = yield* Fiber.join(reuseFiber);

      assert.strictEqual(reusedRuntime, firstRuntime);
      assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).openCount, 1);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1,
          beforeReuseActivity: Deferred.succeed(reuseEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseReuse)),
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
        const providerTurnId = ProviderTurnId.make(`provider-turn:${attemptId}`);

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
      const eventFiber = yield* runtime.events.pipe(
        Stream.runDrain,
        Effect.ignore,
        Effect.forkScoped,
      );
      yield* Fiber.join(eventFiber);

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
        const firstAttemptId = idAllocator.derive.runAttempt({
          runId: firstRunId,
          attemptOrdinal: 1,
        });
        const secondAttemptId = idAllocator.derive.runAttempt({
          runId: secondRunId,
          attemptOrdinal: 1,
        });
        const firstProviderTurnId = ProviderTurnId.make(`provider-turn:${firstAttemptId}`);
        const secondProviderTurnId = ProviderTurnId.make(`provider-turn:${secondAttemptId}`);

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
          attemptId: firstAttemptId,
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
          attemptId: secondAttemptId,
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
          providerThread: { ...secondProviderThread, status: "error" },
          threadId: secondThreadId,
          modelSelection,
          runtimePolicy,
        });
        assert.equal((yield* Ref.get(state)).resumeCount, 2);
        yield* secondRuntime.resumeThread({
          providerThread: secondProviderThread,
          threadId: secondThreadId,
          modelSelection: { ...modelSelection, model: "gpt-5.4-mini" },
          runtimePolicy,
        });
        assert.equal((yield* Ref.get(state)).resumeCount, 3);
        yield* resumeSecondThread;
        assert.equal((yield* Ref.get(state)).resumeCount, 4);
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
        assert.equal((yield* Ref.get(state)).resumeCount, 5);

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

it.effect(
  "ProviderSessionManagerV2 interruption during open closes the session scope and revokes the fresh credential",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const firstOpen = yield* Ref.make(true);
      const openEntered = yield* Deferred.make<void>();
      const releaseOpen = yield* Deferred.make<void>();
      const afterOpenSetup = () =>
        Effect.gen(function* () {
          if (yield* Ref.getAndSet(firstOpen, false)) {
            yield* Deferred.succeed(openEntered, undefined);
            yield* Deferred.await(releaseOpen);
          }
        });
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-open-interrupt");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        // Park the open inside openSession, after the adapter registered its
        // session-scope finalizers but before the entry is committed.
        const openFiber = yield* manager
          .open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(openEntered);
        assert.equal((yield* Ref.get(state)).openCount, 1);

        const issued = (yield* Ref.get(mcpConfigs)).at(-1);
        assert.isDefined(issued);
        const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(token);
        assert.isDefined(yield* registry.resolve(token!));

        yield* Fiber.interrupt(openFiber);
        const exit = yield* Fiber.await(openFiber);
        assert.isTrue(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isInterruptReason));

        // The independently-created session scope was closed (the adapter's
        // finalizer ran), the reservation dropped, and only the freshly
        // issued credential revoked -- and no entry was committed.
        assert.equal((yield* Ref.get(state)).closeCount, 1);
        assert.isUndefined(yield* registry.resolve(token!));
        assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));

        // The manager stays usable: a fresh open mints a new credential and
        // releases cleanly, so the interrupted open leaked nothing.
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const replacement = (yield* Ref.get(mcpConfigs)).at(-1);
        assert.isDefined(replacement);
        const replacementToken = replacement?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(replacementToken);
        assert.notEqual(replacementToken, token);
        assert.equal((yield* registry.resolve(replacementToken!))?.threadId, threadId);
        yield* manager.close(providerSessionId);
        assert.isUndefined(yield* registry.resolve(replacementToken!));
        assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 60_000,
            mcpConfigs,
            afterOpenSetup,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 cleans up the session credential when openSession defects",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const capturedConfig = yield* Ref.make<
        McpProviderSession.McpProviderSessionConfig | undefined
      >(undefined);
      const threadId = ThreadId.make("thread-provider-session-manager-open-defect");
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const now = yield* DateTime.now;
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        const exit = yield* manager
          .open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(exit));
        const config = yield* Ref.get(capturedConfig);
        assert.isDefined(config);
        const token = config?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(token);
        assert.isUndefined(yield* registry.resolve(token!));
        assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 60_000,
            beforeOpen: () =>
              Ref.set(capturedConfig, McpProviderSession.readMcpProviderSession(threadId)).pipe(
                Effect.andThen(Effect.die("openSession defect")),
              ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 interruption during open outlives a wedged scope finalizer",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const openEntered = yield* Deferred.make<void>();
      const closeEntered = yield* Deferred.make<void>();
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-open-close-timeout");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        const openFiber = yield* manager
          .open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(openEntered);
        const issued = (yield* Ref.get(mcpConfigs)).at(-1);
        const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(token);

        const interruptFiber = yield* Fiber.interrupt(openFiber).pipe(Effect.forkScoped);
        yield* Deferred.await(closeEntered);
        yield* Fiber.join(interruptFiber);
        const exit = yield* Fiber.await(openFiber);

        assert.isTrue(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isInterruptReason));
        assert.isUndefined(yield* registry.resolve(token!));
        assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 60_000,
            mcpConfigs,
            hangSessionScopeClose: true,
            onHangingSessionScopeClose: Deferred.succeed(closeEntered, undefined),
            releaseScopeCloseTimeoutMs: 0,
            afterOpenSetup: () =>
              Deferred.succeed(openEntered, undefined).pipe(Effect.andThen(Effect.never)),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 revokes a reused credential when a replacement open is interrupted",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const parkReplacement = yield* Ref.make(false);
      const openEntered = yield* Deferred.make<void>();
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const manager = yield* ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-reused-interrupt");
        const firstSessionId = yield* idAllocator.allocate.providerSession({
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
          providerSessionId: firstSessionId,
          modelSelection,
          runtimePolicy,
        });
        const original = (yield* Ref.get(mcpConfigs)).at(-1);
        const originalToken = original?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(originalToken);
        yield* Ref.set(parkReplacement, true);

        const openFiber = yield* manager
          .open({
            threadId,
            providerSessionId: replacementSessionId,
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(openEntered);

        // The old entry releases while the replacement open holds the reused
        // credential reservation. The old release must leave the credential
        // alone until the replacement either commits or cleans it up.
        yield* manager.detach({ providerSessionId: firstSessionId, threadId });
        yield* manager.close(firstSessionId);
        yield* Fiber.interrupt(openFiber);
        const exit = yield* Fiber.await(openFiber);
        assert.isTrue(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isInterruptReason));

        assert.isUndefined(yield* registry.resolve(originalToken!));
        assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
        assert.isTrue(Option.isNone(yield* manager.get(replacementSessionId)));
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 60_000,
            mcpConfigs,
            afterOpenSetup: () =>
              Effect.gen(function* () {
                if (yield* Ref.getAndSet(parkReplacement, false)) {
                  yield* Deferred.succeed(openEntered, undefined);
                  return yield* Effect.never;
                }
              }),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 releases the committed session during post-commit interruption",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const entryCommitted = yield* Deferred.make<void>();
      const releaseTail = yield* Deferred.make<void>();
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSinkV2;
        const idAllocator = yield* IdAllocatorV2;
        const manager = yield* ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-commit-interrupt");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        const openFiber = yield* manager
          .open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entryCommitted);

        const interruptFiber = yield* Fiber.interrupt(openFiber).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseTail, undefined);
        yield* Fiber.join(interruptFiber);

        const exit = yield* Fiber.await(openFiber);
        assert.isTrue(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isInterruptReason));
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 60_000,
            afterEntryCommit: Deferred.succeed(entryCommitted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseTail)),
            ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 writes released events before a replacement session commits",
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
          fixtureName: "provider-session-manager-delayed-release-replacement",
        });
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-delayed-release-replacement",
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

        // Start releasing session A: the entry is removed immediately, then
        // the release parks inside the time-boxed scope close because A's
        // adapter wedged it with a finalizer that never completes.
        const releaseFiber = yield* manager.close(providerSessionId).pipe(Effect.forkDetach);
        let removed = false;
        for (let i = 0; i < 100 && !removed; i += 1) {
          yield* Effect.yieldNow;
          removed = Option.isNone(yield* manager.get(providerSessionId));
        }
        assert.isTrue(removed, "release must remove the entry before parking");

        // The replacement session B reuses the same providerSessionId while
        // A's release is still parked in scope close.
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        // A's released events were serialized before B committed. The old
        // runtime's delayed scope close therefore cannot overwrite B later,
        // while requests owned by A still receive their terminal state.
        yield* Fiber.join(releaseFiber);

        const afterDelayedRelease = yield* projectionStore.getThreadProjection(threadId);
        assert.equal(
          afterDelayedRelease.providerSessions.at(-1)?.status,
          "ready",
          "the delayed release must not stop the replacement session's projection record",
        );
        const request = afterDelayedRelease.runtimeRequests.at(-1);
        assert.equal(
          request?.status,
          "cancelled",
          "release must terminalize requests owned by the old runtime",
        );
        assert.equal(request?.responseCapability.type, "not_resumable");

        // B is still live. Release it (wedged scope close again) and confirm
        // the released events are written once no replacement exists.
        const finalReleaseFiber = yield* manager.close(providerSessionId).pipe(Effect.forkDetach);
        yield* Fiber.join(finalReleaseFiber);

        const afterFinalRelease = yield* projectionStore.getThreadProjection(threadId);
        assert.equal(afterFinalRelease.providerSessions.at(-1)?.status, "stopped");
        assert.equal(afterFinalRelease.runtimeRequests.at(-1)?.status, "cancelled");
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 60_000,
            hangSessionScopeClose: true,
            releaseScopeCloseTimeoutMs: 0,
          }),
        ),
      );
    }),
);
