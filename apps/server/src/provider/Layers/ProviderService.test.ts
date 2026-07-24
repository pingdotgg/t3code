// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionStartInput,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { it, assert, vi } from "@effect/vitest";

import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpServer } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderSessionDirectoryPersistenceError,
  ProviderUnsupportedError,
  ProviderValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";

const defaultServerSettingsLayer = ServerSettings.ServerSettingsService.layerTest();

const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeAgentInstanceId = ProviderInstanceId.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

const makeStartInput = (
  threadId: ThreadId,
  overrides: Partial<Omit<ProviderSessionStartInput, "threadId">> = {},
): ProviderSessionStartInput => ({
  provider: CODEX_DRIVER,
  providerInstanceId: codexInstanceId,
  runtimeMode: "full-access",
  ...overrides,
  threadId,
});

const makeServiceLayer = (
  registry: ProviderAdapterRegistry.ProviderAdapterRegistryShape,
  directory: ProviderSessionDirectory.ProviderSessionDirectoryShape,
) =>
  makeProviderServiceLive().pipe(
    Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
    Layer.provide(Layer.succeed(ProviderSessionDirectory.ProviderSessionDirectory, directory)),
    Layer.provide(defaultServerSettingsLayer),
    Layer.provide(AnalyticsService.layerTest),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  );

const mcpTestEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-provider-service-test")),
  getDescriptor: Effect.die("unused test environment method"),
});
const mcpTestHttpServer = HttpServer.HttpServer.of({
  address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});
const mcpTestRegistryLayer = McpSessionRegistry.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(HttpServer.HttpServer, mcpTestHttpServer),
      Layer.succeed(ServerEnvironment.ServerEnvironment, mcpTestEnvironment),
      NodeServices.layer,
    ),
  ),
);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function makeFakeCodexAdapter(provider: ProviderDriverKind = CODEX_DRIVER) {
  const sessions = new Map<ThreadId, ProviderSession>();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    Effect.sync(() => {
      const now = "2026-01-01T00:00:00.000Z";
      const session: ProviderSession = {
        provider,
        ...(input.providerInstanceId !== undefined
          ? { providerInstanceId: input.providerInstanceId }
          : {}),
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? {
          opaque: `resume-${String(input.threadId)}`,
        },
        cwd: input.cwd ?? process.cwd(),
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(session.threadId, session);
      return session;
    }),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }

      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.make(`turn-${String(input.threadId)}`),
      });
    },
  );

  const interruptTurn = vi.fn(
    (_threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.void,
  );

  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const stopSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
  );

  const listSessions = vi.fn(
    (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => Array.from(sessions.values())),
  );

  const hasSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<boolean> => Effect.succeed(sessions.has(threadId)),
  );

  const readThread = vi.fn(
    (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{ id: TurnId; items: readonly [] }>;
      },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId,
        turns: [{ id: asTurnId("turn-1"), items: [] }],
      }),
  );

  const rollbackThread = vi.fn(
    (
      threadId: ThreadId,
      _numTurns: number,
    ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId, turns: [] }),
  );

  const stopAll = vi.fn(
    (): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.clear();
      }),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  const updateSession = (
    threadId: ThreadId,
    update: (session: ProviderSession) => ProviderSession,
  ): void => {
    const existing = sessions.get(threadId);
    if (!existing) {
      return;
    }
    sessions.set(threadId, update(existing));
  };
  const setSession = (session: ProviderSession): void => {
    sessions.set(session.threadId, session);
  };

  return {
    adapter,
    emit,
    updateSession,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    setSession,
  };
}

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

function makeProviderServiceLayer() {
  const codex = makeFakeCodexAdapter();
  const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
  const cursor = makeFakeCodexAdapter(CURSOR_DRIVER);
  const registry = makeAdapterRegistryMock({
    [ProviderDriverKind.make("codex")]: codex.adapter,
    [ProviderDriverKind.make("claudeAgent")]: claude.adapter,
    [ProviderDriverKind.make("cursor")]: cursor.adapter,
  });

  const providerAdapterLayer = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistry,
    registry,
  );
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  const layer = it.layer(
    Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,

      runtimeRepositoryLayer,
      NodeServices.layer,
    ),
  );

  return {
    codex,
    claude,
    cursor,
    layer,
  };
}

function makeBindingFailureHarness(
  initialBindings: ReadonlyArray<ProviderSessionDirectory.ProviderRuntimeBinding> = [],
  listBindingsFailure?: ProviderSessionDirectoryPersistenceError,
) {
  const codex = makeFakeCodexAdapter();
  const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
  const bindings = new Map(initialBindings.map((binding) => [binding.threadId, binding]));
  const persistenceFailure = new ProviderSessionDirectoryPersistenceError({
    operation: "upsert",
    detail: "injected binding failure",
  });
  const upsert = vi.fn<ProviderSessionDirectory.ProviderSessionDirectoryShape["upsert"]>(() =>
    Effect.fail(persistenceFailure),
  );
  const directory = ProviderSessionDirectory.ProviderSessionDirectory.of({
    upsert,
    getProvider: (threadId) =>
      Option.match(bindings.get(threadId) ? Option.some(bindings.get(threadId)!) : Option.none(), {
        onNone: () => Effect.die("missing test binding"),
        onSome: (binding) => Effect.succeed(binding.provider),
      }),
    getBinding: (threadId) => {
      const binding = bindings.get(threadId);
      return Effect.succeed(binding === undefined ? Option.none() : Option.some(binding));
    },
    listThreadIds: () => Effect.succeed(Array.from(bindings.keys())),
    listBindings: () =>
      listBindingsFailure
        ? Effect.fail(listBindingsFailure)
        : Effect.succeed(
            Array.from(bindings.values(), (binding) => ({
              ...binding,
              lastSeenAt: "2026-01-01T00:00:00.000Z",
            })),
          ),
  });
  const registry = makeAdapterRegistryMock({
    [CODEX_DRIVER]: codex.adapter,
    [CLAUDE_AGENT_DRIVER]: claude.adapter,
  });
  const layer = makeServiceLayer(registry, directory);
  return { claude, codex, layer, persistenceFailure, upsert };
}

function makeStopGenerationHarness(
  threadId: ThreadId,
  upsert: ProviderSessionDirectory.ProviderSessionDirectoryShape["upsert"],
) {
  const codex = makeFakeCodexAdapter();
  const binding: ProviderSessionDirectory.ProviderRuntimeBinding = {
    provider: CODEX_DRIVER,
    providerInstanceId: codexInstanceId,
    threadId,
    runtimeMode: "full-access",
    resumeCursor: { opaque: "persisted-resume" },
  };
  const directory = ProviderSessionDirectory.ProviderSessionDirectory.of({
    upsert,
    getProvider: () => Effect.succeed(binding.provider),
    getBinding: () => Effect.succeed(Option.some(binding)),
    listThreadIds: () => Effect.succeed([threadId]),
    listBindings: () => Effect.succeed([{ ...binding, lastSeenAt: "2026-01-01T00:00:00.000Z" }]),
  });
  const registry = makeAdapterRegistryMock({ [CODEX_DRIVER]: codex.adapter });
  const layer = makeServiceLayer(registry, directory);
  return { codex, layer };
}

it.effect("ProviderServiceLive compensates a newly started session when binding fails", () =>
  Effect.gen(function* () {
    const harness = makeBindingFailureHarness();
    const threadId = asThreadId("thread-binding-failure-new");
    const exit = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      return yield* Effect.exit(provider.startSession(threadId, makeStartInput(threadId)));
    }).pipe(Effect.provide(harness.layer));

    assert.equal(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) {
      assert.equal(
        Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
        harness.persistenceFailure,
      );
    }
    assert.deepEqual(harness.codex.stopSession.mock.calls, [[threadId]]);
  }),
);

it.effect("ProviderServiceLive does not compensate a preexisting adapter session", () =>
  Effect.gen(function* () {
    const threadId = asThreadId("thread-binding-failure-existing");
    const harness = makeBindingFailureHarness([
      {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { opaque: "existing-resume" },
      },
    ]);
    const previousMcpSession = {
      environmentId: EnvironmentId.make("environment-test"),
      threadId,
      providerSessionId: "provider-session-existing",
      providerInstanceId: codexInstanceId,
      endpoint: "http://127.0.0.1/mcp",
      authorizationHeader: "Bearer existing",
    };
    McpProviderSession.setMcpProviderSession(previousMcpSession);
    yield* harness.codex.adapter.startSession(makeStartInput(threadId));

    const exit = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      return yield* Effect.exit(
        provider.startSession(threadId, makeStartInput(threadId), { activeSession: "reuse" }),
      );
    }).pipe(Effect.provide(harness.layer));

    assert.equal(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) {
      assert.equal(
        Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
        harness.persistenceFailure,
      );
    }
    assert.equal(harness.codex.stopSession.mock.calls.length, 0);
    assert.equal(yield* harness.codex.adapter.hasSession(threadId), true);
    assert.equal(McpProviderSession.readMcpProviderSession(threadId), previousMcpSession);
    McpProviderSession.clearMcpProviderSession(threadId);
  }),
);

it.effect("ProviderServiceLive owns and compensates an explicit replacement", () =>
  Effect.gen(function* () {
    const harness = makeBindingFailureHarness();
    const threadId = asThreadId("thread-binding-failure-replacement");
    yield* harness.codex.adapter.startSession(makeStartInput(threadId));

    const exit = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      return yield* Effect.exit(
        provider.startSession(threadId, makeStartInput(threadId), { activeSession: "replace" }),
      );
    }).pipe(Effect.provide(harness.layer));

    assert.equal(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) {
      assert.equal(
        Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
        harness.persistenceFailure,
      );
    }
    assert.equal(harness.codex.startSession.mock.calls.length, 2);
    assert.deepEqual(harness.codex.stopSession.mock.calls, [[threadId], [threadId]]);
    assert.equal(yield* harness.codex.adapter.hasSession(threadId), false);
  }),
);

it.effect("ProviderServiceLive preserves binding failures when compensation cleanup fails", () =>
  Effect.gen(function* () {
    const harness = makeBindingFailureHarness();
    const threadId = asThreadId("thread-binding-failure-cleanup-failure");
    harness.codex.stopSession.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: String(CODEX_DRIVER),
          method: "stopSession",
          detail: "injected cleanup failure",
        }),
      ),
    );

    const exit = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      return yield* Effect.exit(provider.startSession(threadId, makeStartInput(threadId)));
    }).pipe(Effect.provide(harness.layer));

    assert.equal(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) {
      assert.equal(
        Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
        harness.persistenceFailure,
      );
    }
    assert.deepEqual(harness.codex.stopSession.mock.calls, [[threadId]]);
  }),
);

it.effect("ProviderServiceLive serializes competing starts through persistence and cleanup", () =>
  Effect.gen(function* () {
    const firstUpsertStarted = yield* Deferred.make<void>();
    const releaseFirstUpsert = yield* Deferred.make<void>();
    const codex = makeFakeCodexAdapter();
    const persistenceFailure = new ProviderSessionDirectoryPersistenceError({
      operation: "upsert",
      detail: "injected first binding failure",
    });
    let upsertCount = 0;
    const directory = ProviderSessionDirectory.ProviderSessionDirectory.of({
      upsert: () => {
        upsertCount += 1;
        return upsertCount === 1
          ? Deferred.succeed(firstUpsertStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirstUpsert)),
              Effect.andThen(Effect.fail(persistenceFailure)),
            )
          : Effect.void;
      },
      getProvider: () => Effect.die("unused test directory method"),
      getBinding: () => Effect.succeed(Option.none()),
      listThreadIds: () => Effect.succeed([]),
      listBindings: () => Effect.succeed([]),
    });
    const registry = makeAdapterRegistryMock({ [CODEX_DRIVER]: codex.adapter });
    const layer = makeServiceLayer(registry, directory);
    const threadId = asThreadId("thread-binding-failure-concurrent");

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const start = () => provider.startSession(threadId, makeStartInput(threadId));
      const first = yield* Effect.forkChild(start());
      yield* Deferred.await(firstUpsertStarted);
      const second = yield* Effect.forkChild(start());
      yield* Effect.yieldNow;
      assert.equal(codex.startSession.mock.calls.length, 1);

      yield* Deferred.succeed(releaseFirstUpsert, undefined);
      const firstExit = yield* Fiber.await(first);
      assert.equal(Exit.isFailure(firstExit), true);
      if (Exit.isFailure(firstExit)) {
        assert.equal(
          Option.getOrUndefined(Cause.findErrorOption(firstExit.cause)),
          persistenceFailure,
        );
      }
      yield* Fiber.join(second);
      assert.equal(yield* codex.adapter.hasSession(threadId), true);
    }).pipe(Effect.provide(layer));

    assert.equal(codex.startSession.mock.calls.length, 2);
    assert.deepEqual(codex.stopSession.mock.calls, [[threadId]]);
  }),
);

it.effect("ProviderServiceLive rejects stale updates after same-instance replacement", () =>
  Effect.gen(function* () {
    const replacementUpsertStarted = yield* Deferred.make<void>();
    const releaseReplacementUpsert = yield* Deferred.make<void>();
    const staleTurnStarted = yield* Deferred.make<void>();
    const releaseStaleTurn = yield* Deferred.make<void>();
    const threadId = asThreadId("thread-binding-recovery-race");
    const codex = makeFakeCodexAdapter();
    codex.sendTurn.mockImplementation((input) =>
      Deferred.succeed(staleTurnStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseStaleTurn)),
        Effect.as({
          threadId: input.threadId,
          turnId: TurnId.make("turn-stale-provider"),
        }),
      ),
    );
    let binding: ProviderSessionDirectory.ProviderRuntimeBinding = {
      provider: CODEX_DRIVER,
      providerInstanceId: codexInstanceId,
      threadId,
      runtimeMode: "full-access",
      resumeCursor: { opaque: "codex-resume" },
    };
    let upsertCount = 0;
    let staleTurnWrite: ProviderSessionDirectory.ProviderRuntimeBinding | undefined;
    const directory = ProviderSessionDirectory.ProviderSessionDirectory.of({
      upsert: (nextBinding) => {
        upsertCount += 1;
        const commit = Effect.sync(() => {
          binding = { ...binding, ...nextBinding };
          if (
            nextBinding.runtimePayload &&
            typeof nextBinding.runtimePayload === "object" &&
            "activeTurnId" in nextBinding.runtimePayload &&
            nextBinding.runtimePayload.activeTurnId === "turn-stale-provider"
          ) {
            staleTurnWrite = nextBinding;
          }
        });
        return upsertCount === 1
          ? Deferred.succeed(replacementUpsertStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseReplacementUpsert)),
              Effect.andThen(commit),
            )
          : commit;
      },
      getProvider: () => Effect.succeed(binding.provider),
      getBinding: () => Effect.succeed(Option.some(binding)),
      listThreadIds: () => Effect.succeed([threadId]),
      listBindings: () => Effect.succeed([{ ...binding, lastSeenAt: "2026-01-01T00:00:00.000Z" }]),
    });
    const registry = makeAdapterRegistryMock({ [CODEX_DRIVER]: codex.adapter });
    const layer = makeServiceLayer(registry, directory);
    yield* codex.adapter.startSession(makeStartInput(threadId));

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const turn = yield* Effect.forkChild(
        provider.sendTurn({
          threadId,
          input: "route before replacement",
          attachments: [],
        }),
      );
      yield* Deferred.await(staleTurnStarted);
      const replacement = yield* Effect.forkChild(
        provider.startSession(threadId, makeStartInput(threadId), { activeSession: "replace" }),
      );
      yield* Deferred.await(replacementUpsertStarted);
      yield* Deferred.succeed(releaseStaleTurn, undefined);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseReplacementUpsert, undefined);
      yield* Fiber.join(replacement);
      yield* Fiber.join(turn);
    }).pipe(Effect.provide(layer));

    assert.equal(binding.providerInstanceId, codexInstanceId);
    assert.equal(codex.startSession.mock.calls.length, 2);
    assert.equal(codex.stopSession.mock.calls.length, 1);
    assert.equal(codex.sendTurn.mock.calls.length, 1);
    assert.equal(staleTurnWrite, undefined);
  }),
);

it.effect("ProviderServiceLive does not persist a stale turn after failed replacement", () =>
  Effect.gen(function* () {
    const staleTurnStarted = yield* Deferred.make<void>();
    const releaseStaleTurn = yield* Deferred.make<void>();
    const threadId = asThreadId("thread-binding-failed-replacement-race");
    const harness = makeBindingFailureHarness([
      {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { opaque: "old-session" },
      },
    ]);
    let replacementWriteSeen = false;
    let delayedWrite: ProviderSessionDirectory.ProviderRuntimeBinding | undefined;
    harness.upsert.mockImplementation((binding) => {
      if (!replacementWriteSeen) {
        replacementWriteSeen = true;
        return Effect.fail(harness.persistenceFailure);
      }
      return Effect.sync(() => {
        delayedWrite = binding;
      });
    });
    yield* harness.codex.adapter.startSession(makeStartInput(threadId));
    harness.codex.sendTurn.mockImplementation((input) =>
      Deferred.succeed(staleTurnStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseStaleTurn)),
        Effect.as({
          threadId: input.threadId,
          turnId: TurnId.make("turn-stale-failed-replacement"),
        }),
      ),
    );

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const turn = yield* Effect.forkChild(
        provider.sendTurn({
          threadId,
          input: "started before failed replacement",
          attachments: [],
        }),
      );
      yield* Deferred.await(staleTurnStarted);
      const replacementExit = yield* Effect.exit(
        provider.startSession(threadId, makeStartInput(threadId), { activeSession: "replace" }),
      );
      assert.equal(Exit.isFailure(replacementExit), true);
      yield* Deferred.succeed(releaseStaleTurn, undefined);
      yield* Fiber.join(turn);
      assert.equal(delayedWrite, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("ProviderServiceLive rejects delayed turn updates when stop persistence fails", () =>
  Effect.gen(function* () {
    const threadId = asThreadId("thread-stop-persistence-failure-race");
    const turnStarted = yield* Deferred.make<void>();
    const releaseTurn = yield* Deferred.make<void>();
    const persistenceFailure = new ProviderSessionDirectoryPersistenceError({
      operation: "upsert",
      detail: "injected stop binding failure",
    });
    const upsert = vi.fn<ProviderSessionDirectory.ProviderSessionDirectoryShape["upsert"]>(() =>
      Effect.fail(persistenceFailure),
    );
    const harness = makeStopGenerationHarness(threadId, upsert);
    yield* harness.codex.adapter.startSession(makeStartInput(threadId));
    harness.codex.sendTurn.mockImplementation((input) =>
      Deferred.succeed(turnStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseTurn)),
        Effect.as({ threadId: input.threadId, turnId: TurnId.make("turn-before-failed-stop") }),
      ),
    );
    let upsertCountBeforeStop = 0;
    let operationWrites: ReadonlyArray<ProviderSessionDirectory.ProviderRuntimeBinding> = [];

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      upsertCountBeforeStop = upsert.mock.calls.length;
      const turn = yield* Effect.forkChild(
        provider.sendTurn({ threadId, input: "before failed stop", attachments: [] }),
      );
      yield* Deferred.await(turnStarted);
      const stopExit = yield* Effect.exit(provider.stopSession({ threadId }));
      assert.equal(Exit.isFailure(stopExit), true);
      if (Exit.isFailure(stopExit)) {
        assert.equal(
          Option.getOrUndefined(Cause.findErrorOption(stopExit.cause)),
          persistenceFailure,
        );
      }
      yield* Deferred.succeed(releaseTurn, undefined);
      yield* Fiber.join(turn);
      operationWrites = upsert.mock.calls.slice(upsertCountBeforeStop).map(([binding]) => binding);
    }).pipe(Effect.provide(harness.layer));

    assert.deepEqual(
      operationWrites.map((binding) => binding.status),
      ["stopped"],
    );
  }),
);

it.effect("ProviderServiceLive rejects delayed turn updates when stop is interrupted", () =>
  Effect.gen(function* () {
    const threadId = asThreadId("thread-stop-interruption-race");
    const turnStarted = yield* Deferred.make<void>();
    const releaseTurn = yield* Deferred.make<void>();
    const stopStarted = yield* Deferred.make<void>();
    const upsert = vi.fn<ProviderSessionDirectory.ProviderSessionDirectoryShape["upsert"]>(
      () => Effect.void,
    );
    const harness = makeStopGenerationHarness(threadId, upsert);
    yield* harness.codex.adapter.startSession(makeStartInput(threadId));
    harness.codex.sendTurn.mockImplementation((input) =>
      Deferred.succeed(turnStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseTurn)),
        Effect.as({
          threadId: input.threadId,
          turnId: TurnId.make("turn-before-interrupted-stop"),
        }),
      ),
    );
    harness.codex.stopSession.mockImplementation(() =>
      Deferred.succeed(stopStarted, undefined).pipe(Effect.andThen(Effect.never)),
    );
    let upsertCountBeforeStop = 0;
    let operationWrites: ReadonlyArray<ProviderSessionDirectory.ProviderRuntimeBinding> = [];

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      upsertCountBeforeStop = upsert.mock.calls.length;
      const turn = yield* Effect.forkChild(
        provider.sendTurn({ threadId, input: "before interrupted stop", attachments: [] }),
      );
      yield* Deferred.await(turnStarted);
      const stop = yield* Effect.forkChild(provider.stopSession({ threadId }));
      yield* Deferred.await(stopStarted);
      yield* Fiber.interrupt(stop);
      yield* Deferred.succeed(releaseTurn, undefined);
      yield* Fiber.join(turn);
      operationWrites = upsert.mock.calls.slice(upsertCountBeforeStop).map(([binding]) => binding);
    }).pipe(Effect.provide(harness.layer));

    assert.deepEqual(operationWrites, []);
  }),
);

it.effect(
  "ProviderServiceLive rejects delayed turn updates when replacement stop is interrupted",
  () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-replacement-stop-interruption-race");
      const turnStarted = yield* Deferred.make<void>();
      const releaseTurn = yield* Deferred.make<void>();
      const stopStarted = yield* Deferred.make<void>();
      const upsert = vi.fn<ProviderSessionDirectory.ProviderSessionDirectoryShape["upsert"]>(
        () => Effect.void,
      );
      const harness = makeStopGenerationHarness(threadId, upsert);
      yield* harness.codex.adapter.startSession(makeStartInput(threadId));
      harness.codex.sendTurn.mockImplementation((input) =>
        Deferred.succeed(turnStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseTurn)),
          Effect.as({
            threadId: input.threadId,
            turnId: TurnId.make("turn-before-interrupted-replacement"),
          }),
        ),
      );
      harness.codex.stopSession.mockImplementation(() =>
        Deferred.succeed(stopStarted, undefined).pipe(Effect.andThen(Effect.never)),
      );
      let operationWrites: ReadonlyArray<ProviderSessionDirectory.ProviderRuntimeBinding> = [];

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const upsertCountBeforeReplacement = upsert.mock.calls.length;
        const turn = yield* Effect.forkChild(
          provider.sendTurn({ threadId, input: "before interrupted replacement", attachments: [] }),
        );
        yield* Deferred.await(turnStarted);
        const replacement = yield* Effect.forkChild(
          provider.startSession(threadId, makeStartInput(threadId), { activeSession: "replace" }),
        );
        yield* Deferred.await(stopStarted);
        yield* Fiber.interrupt(replacement);
        yield* Deferred.succeed(releaseTurn, undefined);
        yield* Fiber.join(turn);
        operationWrites = upsert.mock.calls
          .slice(upsertCountBeforeReplacement)
          .map(([binding]) => binding);
      }).pipe(Effect.provide(harness.layer));

      assert.deepEqual(operationWrites, []);
    }),
);

it.effect("ProviderServiceLive compensates an interrupted start after adapter startup", () =>
  Effect.gen(function* () {
    const upsertStarted = yield* Deferred.make<void>();
    const codex = makeFakeCodexAdapter();
    const directory = ProviderSessionDirectory.ProviderSessionDirectory.of({
      upsert: () => Deferred.succeed(upsertStarted, undefined).pipe(Effect.andThen(Effect.never)),
      getProvider: () => Effect.die("unused test directory method"),
      getBinding: () => Effect.succeed(Option.none()),
      listThreadIds: () => Effect.succeed([]),
      listBindings: () => Effect.succeed([]),
    });
    const registry = makeAdapterRegistryMock({ [CODEX_DRIVER]: codex.adapter });
    const layer = makeServiceLayer(registry, directory);
    const threadId = asThreadId("thread-binding-failure-interrupted");

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const start = yield* Effect.forkChild(
        provider.startSession(threadId, makeStartInput(threadId)),
      );
      yield* Deferred.await(upsertStarted);
      yield* Fiber.interrupt(start);
    }).pipe(Effect.provide(layer));

    assert.deepEqual(codex.stopSession.mock.calls, [[threadId]]);
    assert.equal(yield* codex.adapter.hasSession(threadId), false);
  }),
);

it.effect("ProviderServiceLive compensates a resumed session when binding fails", () =>
  Effect.gen(function* () {
    const threadId = asThreadId("thread-binding-failure-recovery");
    const harness = makeBindingFailureHarness([
      {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { opaque: "persisted-resume" },
      },
    ]);
    const exit = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      return yield* Effect.exit(provider.rollbackConversation({ threadId, numTurns: 1 }));
    }).pipe(Effect.provide(harness.layer));

    assert.equal(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) {
      assert.equal(
        Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
        harness.persistenceFailure,
      );
    }
    assert.equal(harness.codex.startSession.mock.calls.length, 1);
    assert.deepEqual(harness.codex.stopSession.mock.calls, [[threadId]]);
  }),
);

it.effect(
  "ProviderServiceLive clears stale MCP state when credential issuance is unavailable",
  () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-mcp-registry-unavailable");
      const codex = makeFakeCodexAdapter();
      let observedMcpSession: McpProviderSession.McpProviderSessionConfig | undefined;
      const startSession = codex.startSession.getMockImplementation()!;
      codex.startSession.mockImplementation((input) =>
        Effect.sync(() => {
          observedMcpSession = McpProviderSession.readMcpProviderSession(threadId);
        }).pipe(Effect.andThen(startSession(input))),
      );
      const directory = ProviderSessionDirectory.ProviderSessionDirectory.of({
        upsert: () => Effect.void,
        getProvider: () => Effect.die("unused test directory method"),
        getBinding: () => Effect.succeed(Option.none()),
        listThreadIds: () => Effect.succeed([]),
        listBindings: () => Effect.succeed([]),
      });
      const registry = makeAdapterRegistryMock({ [CODEX_DRIVER]: codex.adapter });
      const layer = makeServiceLayer(registry, directory);
      const previousMcpSession = {
        environmentId: EnvironmentId.make("environment-test"),
        threadId,
        providerSessionId: "provider-session-stale",
        providerInstanceId: codexInstanceId,
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer stale",
      };

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        McpProviderSession.setMcpProviderSession(previousMcpSession);
        yield* provider.startSession(threadId, makeStartInput(threadId));

        assert.equal(observedMcpSession, undefined);
        assert.equal(McpProviderSession.readMcpProviderSession(threadId), undefined);
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
      );
    }),
);

it.effect("ProviderServiceLive compensates a started session with a mismatched provider", () =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const harness = makeBindingFailureHarness();
    const threadId = asThreadId("thread-provider-mismatch-start");
    let attemptCredential: McpProviderSession.McpProviderSessionConfig | undefined;
    harness.codex.startSession.mockImplementation((input) =>
      Effect.sync(() => {
        attemptCredential = McpProviderSession.readMcpProviderSession(threadId);
        const session: ProviderSession = {
          provider: CLAUDE_AGENT_DRIVER,
          providerInstanceId: codexInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          cwd: input.cwd ?? process.cwd(),
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        harness.codex.setSession(session);
        return session;
      }),
    );

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const exit = yield* Effect.exit(provider.startSession(threadId, makeStartInput(threadId)));
      assert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        assert.equal(error?._tag, "ProviderValidationError");
        if (error?._tag === "ProviderValidationError") {
          assert.equal(
            error.issue,
            "Adapter/provider mismatch: requested 'codex', received 'claudeAgent'.",
          );
        }
      }
      assert.deepEqual(harness.codex.stopSession.mock.calls, [[threadId]]);
      assert.equal(yield* harness.codex.adapter.hasSession(threadId), false);
      assert.equal(McpProviderSession.readMcpProviderSession(threadId), undefined);
      assert.equal(attemptCredential !== undefined, true);
      const attemptToken = attemptCredential?.authorizationHeader.replace(/^Bearer\s+/, "") ?? "";
      assert.equal(yield* registry.resolve(attemptToken), undefined);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(mcpTestRegistryLayer)),
);

it.effect("ProviderServiceLive restores MCP state when recovery mismatch cleanup fails", () =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const threadId = asThreadId("thread-provider-mismatch-recovery");
    const harness = makeBindingFailureHarness([
      {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { opaque: "persisted-resume" },
      },
    ]);
    let attemptCredential: McpProviderSession.McpProviderSessionConfig | undefined;
    harness.codex.startSession.mockImplementation((input) =>
      Effect.sync(() => {
        attemptCredential = McpProviderSession.readMcpProviderSession(threadId);
        const session: ProviderSession = {
          provider: CLAUDE_AGENT_DRIVER,
          providerInstanceId: codexInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          cwd: input.cwd ?? process.cwd(),
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        harness.codex.setSession(session);
        return session;
      }),
    );
    const cleanupFailure = new ProviderAdapterRequestError({
      provider: String(CODEX_DRIVER),
      method: "stopSession",
      detail: "injected mismatch cleanup failure",
    });
    harness.codex.stopSession.mockImplementation(() => Effect.fail(cleanupFailure));
    const oldCredential = yield* registry.issue({
      threadId,
      providerInstanceId: codexInstanceId,
    });

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      McpProviderSession.setMcpProviderSession(oldCredential.config);
      const exit = yield* Effect.exit(provider.rollbackConversation({ threadId, numTurns: 1 }));

      assert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        assert.equal(error?._tag, "ProviderValidationError");
        if (error?._tag === "ProviderValidationError") {
          assert.equal(
            error.issue,
            `Adapter/provider mismatch while recovering thread '${threadId}'. Expected 'codex', received 'claudeAgent'.`,
          );
        }
      }
      assert.deepEqual(harness.codex.stopSession.mock.calls, [[threadId]]);
      assert.equal(McpProviderSession.readMcpProviderSession(threadId), oldCredential.config);
      assert.equal(attemptCredential !== undefined, true);
      const oldToken = oldCredential.config.authorizationHeader.replace(/^Bearer\s+/, "");
      const attemptToken = attemptCredential?.authorizationHeader.replace(/^Bearer\s+/, "") ?? "";
      assert.equal(
        (yield* registry.resolve(oldToken))?.providerSessionId,
        oldCredential.config.providerSessionId,
      );
      assert.equal(yield* registry.resolve(attemptToken), undefined);
      McpProviderSession.clearMcpProviderSession(threadId);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(mcpTestRegistryLayer)),
);

it.effect(
  "ProviderServiceLive replaces stale target sessions without revoking the old provider",
  () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-binding-failure-provider-switch");
      const harness = makeBindingFailureHarness([
        {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { opaque: "codex-resume" },
        },
      ]);
      const previousMcpSession = {
        environmentId: EnvironmentId.make("environment-test"),
        threadId,
        providerSessionId: "provider-session-old-provider",
        providerInstanceId: codexInstanceId,
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer old-provider",
      };
      McpProviderSession.setMcpProviderSession(previousMcpSession);
      yield* harness.codex.adapter.startSession(makeStartInput(threadId));
      yield* harness.claude.adapter.startSession(
        makeStartInput(threadId, {
          provider: CLAUDE_AGENT_DRIVER,
          providerInstanceId: claudeAgentInstanceId,
        }),
      );

      const exit = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* Effect.exit(
          provider.startSession(
            threadId,
            makeStartInput(threadId, {
              provider: CLAUDE_AGENT_DRIVER,
              providerInstanceId: claudeAgentInstanceId,
            }),
            { activeSession: "reuse" },
          ),
        );
      }).pipe(Effect.provide(harness.layer));

      assert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        assert.equal(
          Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
          harness.persistenceFailure,
        );
      }
      assert.equal(yield* harness.codex.adapter.hasSession(threadId), true);
      assert.equal(harness.codex.stopSession.mock.calls.length, 0);
      assert.deepEqual(harness.claude.stopSession.mock.calls, [[threadId], [threadId]]);
      assert.equal(yield* harness.claude.adapter.hasSession(threadId), false);
      assert.equal(McpProviderSession.readMcpProviderSession(threadId), previousMcpSession);
      McpProviderSession.clearMcpProviderSession(threadId);
    }),
);

it.effect(
  "ProviderServiceLive retains the old MCP credential when replacement persistence fails",
  () =>
    Effect.gen(function* () {
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const threadId = asThreadId("thread-mcp-failed-replacement");
      const harness = makeBindingFailureHarness([
        {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { opaque: "codex-resume" },
        },
      ]);
      yield* harness.codex.adapter.startSession(makeStartInput(threadId));
      const oldCredential = yield* registry.issue({
        threadId,
        providerInstanceId: codexInstanceId,
      });
      let attemptCredential: McpProviderSession.McpProviderSessionConfig | undefined;
      harness.upsert.mockImplementation(() =>
        Effect.sync(() => {
          const current = McpProviderSession.readMcpProviderSession(threadId);
          if (current?.providerInstanceId === claudeAgentInstanceId) {
            attemptCredential = current;
          }
          return current;
        }).pipe(
          Effect.flatMap((current) =>
            current?.providerInstanceId === claudeAgentInstanceId
              ? Effect.fail(harness.persistenceFailure)
              : Effect.void,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        McpProviderSession.setMcpProviderSession(oldCredential.config);
        const exit = yield* Effect.exit(
          provider.startSession(
            threadId,
            makeStartInput(threadId, {
              provider: CLAUDE_AGENT_DRIVER,
              providerInstanceId: claudeAgentInstanceId,
            }),
          ),
        );
        assert.equal(Exit.isFailure(exit), true);
        assert.equal(McpProviderSession.readMcpProviderSession(threadId), oldCredential.config);
        assert.equal(attemptCredential !== undefined, true);
        const oldToken = oldCredential.config.authorizationHeader.replace(/^Bearer\s+/, "");
        const attemptToken = attemptCredential?.authorizationHeader.replace(/^Bearer\s+/, "") ?? "";
        assert.equal(
          (yield* registry.resolve(oldToken))?.providerSessionId,
          oldCredential.config.providerSessionId,
        );
        assert.equal(yield* registry.resolve(attemptToken), undefined);
      }).pipe(Effect.provide(harness.layer));

      McpProviderSession.clearMcpProviderSession(threadId);
    }).pipe(Effect.provide(mcpTestRegistryLayer)),
);

it.effect("ProviderServiceLive commits the new MCP credential after successful replacement", () =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const codex = makeFakeCodexAdapter();
    const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
    const bindings = new Map<ThreadId, ProviderSessionDirectory.ProviderRuntimeBinding>();
    const directory = ProviderSessionDirectory.ProviderSessionDirectory.of({
      upsert: (binding) =>
        Effect.sync(() => {
          bindings.set(binding.threadId, binding);
        }),
      getProvider: (threadId) => Effect.succeed(bindings.get(threadId)?.provider ?? CODEX_DRIVER),
      getBinding: (threadId) => {
        const binding = bindings.get(threadId);
        return Effect.succeed(binding ? Option.some(binding) : Option.none());
      },
      listThreadIds: () => Effect.succeed(Array.from(bindings.keys())),
      listBindings: () =>
        Effect.succeed(
          Array.from(bindings.values(), (binding) => ({
            ...binding,
            lastSeenAt: "2026-01-01T00:00:00.000Z",
          })),
        ),
    });
    const adapterRegistry = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
      [CLAUDE_AGENT_DRIVER]: claude.adapter,
    });
    const providerLayer = makeServiceLayer(adapterRegistry, directory);
    const threadId = asThreadId("thread-mcp-successful-replacement");

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* provider.startSession(threadId, makeStartInput(threadId));
      const oldCredential = McpProviderSession.readMcpProviderSession(threadId);
      assert.equal(oldCredential !== undefined, true);

      yield* provider.startSession(
        threadId,
        makeStartInput(threadId, {
          provider: CLAUDE_AGENT_DRIVER,
          providerInstanceId: claudeAgentInstanceId,
        }),
      );
      const currentCredential = McpProviderSession.readMcpProviderSession(threadId);
      assert.equal(currentCredential !== undefined, true);
      const oldToken = oldCredential?.authorizationHeader.replace(/^Bearer\s+/, "") ?? "";
      const currentToken = currentCredential?.authorizationHeader.replace(/^Bearer\s+/, "") ?? "";
      assert.equal(yield* registry.resolve(oldToken), undefined);
      assert.equal(
        (yield* registry.resolve(currentToken))?.providerSessionId,
        currentCredential?.providerSessionId,
      );
      McpProviderSession.clearMcpProviderSession(threadId);
    }).pipe(Effect.provide(providerLayer));
  }).pipe(Effect.provide(mcpTestRegistryLayer)),
);

it.effect("ProviderServiceLive catches stopAll failures during shutdown", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    codex.stopAll.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: String(CODEX_DRIVER),
          method: "stopAll",
          detail: "simulated stopAll failure",
        }),
      ),
    );
    const registry = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
    });
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,
      runtimeRepositoryLayer,
      NodeServices.layer,
    );
    const scope = yield* Scope.make();
    const runtimeServices = yield* Layer.build(providerLayer).pipe(Scope.provide(scope));

    yield* ProviderService.ProviderService.pipe(Effect.provide(runtimeServices));
    const closeExit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit);

    assert.equal(Exit.isSuccess(closeExit), true);
    assert.equal(codex.stopAll.mock.calls.length, 1);
  }),
);

it.effect("ProviderServiceLive rejects new sessions for disabled providers", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
    const registryBase = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
      [CLAUDE_AGENT_DRIVER]: claude.adapter,
    });
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      ...registryBase,
      getInstanceInfo: (instanceId) =>
        instanceId === claudeAgentInstanceId
          ? Effect.succeed({
              instanceId,
              driverKind: CLAUDE_AGENT_DRIVER,
              displayName: undefined,
              enabled: false,
              continuationIdentity: {
                driverKind: CLAUDE_AGENT_DRIVER,
                continuationKey: "claudeAgent:instance:claudeAgent",
              },
            })
          : registryBase.getInstanceInfo(instanceId),
    };
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-disabled"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'claudeAgent' is disabled");
    assert.equal(claude.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive allows enabled custom instances when legacy driver is disabled",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const driverKind = CODEX_DRIVER;
      const codex = makeFakeCodexAdapter();
      const unsupported = () =>
        new ProviderUnsupportedError({
          provider: driverKind,
        });
      const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
        getByInstance: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed(codex.adapter)
            : Effect.fail(unsupported()),
        getInstanceInfo: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed({
                instanceId,
                driverKind,
                displayName: "Codex Personal",
                enabled: true,
                continuationIdentity: {
                  driverKind,
                  continuationKey: "codex:/Users/example/.codex",
                },
              })
            : Effect.fail(unsupported()),
        listInstances: () => Effect.succeed([instanceId]),
        listProviders: () => Effect.succeed([driverKind] as const),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
          PubSub.subscribe(pubsub),
        ),
      };
      const providerAdapterLayer = Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistry,
        registry,
      );
      const serverSettingsLayer = ServerSettings.ServerSettingsService.layerTest({
        providers: {
          codex: {
            enabled: false,
          },
        },
      });
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(serverSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const session = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-enabled-custom"), {
          provider: driverKind,
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-enabled-custom"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer));

      assert.equal(session.providerInstanceId, instanceId);
      assert.equal(codex.startSession.mock.calls.length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive rejects new sessions for disabled custom instances", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const driverKind = ProviderDriverKind.make("codex");
    const codex = makeFakeCodexAdapter();
    const unsupported = () =>
      new ProviderUnsupportedError({
        provider: ProviderDriverKind.make("codex"),
      });
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      getByInstance: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed(codex.adapter)
          : Effect.fail(unsupported()),
      getInstanceInfo: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed({
              instanceId,
              driverKind,
              displayName: "Codex Personal",
              enabled: false,
              continuationIdentity: {
                driverKind,
                continuationKey: "codex:/Users/example/.codex",
              },
            })
          : Effect.fail(unsupported()),
      listInstances: () => Effect.succeed([instanceId]),
      listProviders: () => Effect.succeed([CODEX_DRIVER] as const),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
        PubSub.subscribe(pubsub),
      ),
    };
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled-instance"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-disabled-instance"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'codex_personal' is disabled");
    assert.equal(codex.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const routing = makeProviderServiceLayer();

it.effect("ProviderServiceLive writes canonical events to the emitting thread segment", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const canonicalEvents: ProviderRuntimeEvent[] = [];
    const canonicalThreadIds: Array<string | null> = [];
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive({
      canonicalEventLogger: {
        filePath: "memory://provider-canonical-events",
        write: (event, threadId) => {
          canonicalEvents.push(event as ProviderRuntimeEvent);
          canonicalThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    }).pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      yield* ProviderService.ProviderService;
      yield* advanceTestClock(10);
      codex.emit({
        eventId: asEventId("evt-canonical-thread-segment"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-canonical-thread-segment"),
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "turn.completed",
        payload: {
          state: "completed",
        },
      });
      yield* advanceTestClock(20);
    }).pipe(Effect.provide(providerLayer));

    assert.equal(canonicalEvents.length, 1);
    assert.equal(canonicalEvents[0]?.threadId, "thread-canonical-thread-segment");
    assert.deepEqual(canonicalThreadIds, ["thread-canonical-thread-segment"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive keeps persisted resumable sessions on startup", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-service-"));
    const dbPath = NodePath.join(tempDir, "orchestration.sqlite");

    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: ThreadId.make("thread-stale"),
      });
    }).pipe(Effect.provide(directoryLayer));

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* ProviderService.ProviderService.pipe(Effect.provide(providerLayer));

    const persistedProvider = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      return yield* directory.getProvider(asThreadId("thread-stale"));
    }).pipe(Effect.provide(directoryLayer));
    assert.equal(persistedProvider, "codex");

    const runtime = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({
        threadId: asThreadId("thread-stale"),
      });
    }).pipe(Effect.provide(runtimeRepositoryLayer));
    assert.equal(Option.isSome(runtime), true);

    const legacyTableRows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_sessions'
      `;
    }).pipe(Effect.provide(persistenceLayer));
    assert.equal(legacyTableRows.length, 0);

    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive restores rollback routing after restart using persisted thread mapping",
  () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-provider-service-restart-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstCodex = makeFakeCodexAdapter();
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: firstCodex.adapter,
      });

      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );
      const updatedResumeCursor = {
        threadId: asThreadId("thread-1"),
        resume: "resume-session-1",
        resumeSessionAt: "assistant-message-1",
        turnCount: 1,
      };

      const startedSession = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const threadId = asThreadId("thread-1");
        const session = yield* provider.startSession(threadId, {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          threadId,
        });
        firstCodex.updateSession(threadId, (existing) => ({
          ...existing,
          status: "ready",
          resumeCursor: updatedResumeCursor,
          updatedAt: "2026-01-01T00:00:01.000Z",
        }));
        return session;
      }).pipe(Effect.provide(firstProviderLayer));

      const persistedAfterStopAll = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({
          threadId: startedSession.threadId,
        });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persistedAfterStopAll), true);
      if (Option.isSome(persistedAfterStopAll)) {
        assert.equal(persistedAfterStopAll.value.status, "stopped");
        assert.deepEqual(persistedAfterStopAll.value.resumeCursor, updatedResumeCursor);
      }

      const secondCodex = makeFakeCodexAdapter();
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: secondCodex.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      secondCodex.startSession.mockClear();
      secondCodex.rollbackThread.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.rollbackConversation({
          threadId: startedSession.threadId,
          numTurns: 1,
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondCodex.startSession.mock.calls.length, 1);
      const resumedStartInput = secondCodex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, updatedResumeCursor);
        assert.equal(startPayload.threadId, startedSession.threadId);
      }
      assert.equal(secondCodex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = secondCodex.rollbackThread.mock.calls[0];
      assert.equal(typeof rollbackCall?.[0], "string");
      assert.equal(rollbackCall?.[1], 1);

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("routes provider operations and rollback conversation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.equal(session.provider, "codex");

      const sessions = yield* provider.listSessions();
      assert.equal(sessions.length, 1);

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);

      yield* provider.interruptTurn({ threadId: session.threadId });
      assert.deepEqual(routing.codex.interruptTurn.mock.calls, [[session.threadId, undefined]]);

      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-1"),
        decision: "accept",
      });
      assert.deepEqual(routing.codex.respondToRequest.mock.calls, [
        [session.threadId, asRequestId("req-1"), "accept"],
      ]);

      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-user-input-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      assert.deepEqual(routing.codex.respondToUserInput.mock.calls, [
        [
          session.threadId,
          asRequestId("req-user-input-1"),
          {
            sandbox_mode: "workspace-write",
          },
        ],
      ]);

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 0,
      });

      yield* provider.stopSession({ threadId: session.threadId });
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "after-stop",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, session.resumeCursor);
        assert.equal(startPayload.threadId, session.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers stale persisted sessions for rollback by resuming thread identity", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopSession(initial.threadId);
      routing.codex.startSession.mockClear();
      routing.codex.rollbackThread.mockClear();

      yield* provider.rollbackConversation({
        threadId: initial.threadId,
        numTurns: 1,
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = routing.codex.rollbackThread.mock.calls[0];
      assert.equal(rollbackCall?.[1], 1);
    }),
  );

  it.effect("preserves the persisted binding when stopping a session", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const initial = yield* provider.startSession(asThreadId("thread-reap-preserve"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-reap-preserve"),
        cwd: "/tmp/project-reap-preserve",
        runtimeMode: "full-access",
      });

      yield* provider.stopSession({ threadId: initial.threadId });

      const persistedAfterStop = yield* runtimeRepository.getByThreadId({
        threadId: initial.threadId,
      });
      assert.equal(Option.isSome(persistedAfterStop), true);
      if (Option.isSome(persistedAfterStop)) {
        assert.equal(persistedAfterStop.value.status, "stopped");
        assert.deepEqual(persistedAfterStop.value.resumeCursor, initial.resumeCursor);
      }

      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume after reap",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-reap-preserve");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("routes explicit claudeAgent provider session starts to the claude adapter", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-claude"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-claude"),
        cwd: "/tmp/project-claude",
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "claudeAgent");
      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const startInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof startInput === "object" && startInput !== null, true);
      if (startInput && typeof startInput === "object") {
        const startPayload = startInput as {
          provider?: string;
          providerInstanceId?: ProviderInstanceId;
          cwd?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.providerInstanceId, claudeAgentInstanceId);
        assert.equal(startPayload.cwd, "/tmp/project-claude");
      }
    }),
  );

  it.effect("dies when an active session conflicts with its persisted binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-binding-mismatch");

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-binding-mismatch",
        runtimeMode: "full-access",
      });

      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        runtimeMode: "full-access",
      });

      const exit = yield* Effect.exit(provider.listSessions());
      assert.equal(Exit.hasDies(exit), true);
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        runtimeMode: "full-access",
      });
    }),
  );

  it.effect("stops stale sessions in other providers after a successful replacement start", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-provider-replacement");

      const codexSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      routing.codex.stopSession.mockClear();
      routing.claude.stopSession.mockClear();

      const claudeSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      assert.equal(codexSession.provider, "codex");
      assert.equal(claudeSession.provider, "claudeAgent");
      assert.deepEqual(routing.codex.stopSession.mock.calls, [[threadId]]);
      assert.equal(routing.claude.stopSession.mock.calls.length, 0);

      const sessions = yield* provider.listSessions();
      assert.deepEqual(
        sessions
          .filter((session) => session.threadId === threadId)
          .map((session) => session.provider),
        ["claudeAgent"],
      );
    }),
  );

  it.effect("finishes stale-session cleanup when interrupted after replacement persistence", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-provider-replacement-interrupted");
      const staleStopStarted = yield* Deferred.make<void>();
      const releaseStaleStop = yield* Deferred.make<void>();

      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const originalStopSession = routing.codex.stopSession.getMockImplementation();
      assert.equal(originalStopSession !== undefined, true);
      routing.codex.stopSession.mockImplementation((stoppedThreadId) =>
        Deferred.succeed(staleStopStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseStaleStop)),
          Effect.andThen(originalStopSession!(stoppedThreadId)),
        ),
      );

      const replacement = yield* Effect.forkChild(
        provider.startSession(threadId, {
          provider: CLAUDE_AGENT_DRIVER,
          providerInstanceId: claudeAgentInstanceId,
          threadId,
          runtimeMode: "full-access",
        }),
      );
      yield* Deferred.await(staleStopStarted);
      const interruption = yield* Effect.forkChild(Fiber.interrupt(replacement));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseStaleStop, undefined);
      yield* Fiber.join(interruption);
      routing.codex.stopSession.mockImplementation(originalStopSession!);

      assert.equal(yield* routing.codex.adapter.hasSession(threadId), false);
      assert.equal(yield* routing.claude.adapter.hasSession(threadId), true);
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.equal(binding?.providerInstanceId, claudeAgentInstanceId);
    }),
  );

  it.effect("recovers stale sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project-send-turn",
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-send-turn");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers stale claudeAgent sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-claude-send-turn"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-claude-send-turn"),
        cwd: "/tmp/project-claude-send-turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });

      yield* routing.claude.stopAll();
      routing.claude.startSession.mockClear();
      routing.claude.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume with claude",
        attachments: [],
      });

      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          modelSelection?: unknown;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-send-turn");
        assert.deepEqual(
          startPayload.modelSelection,
          createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-6", [
            { id: "effort", value: "max" },
          ]),
        );
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.claude.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("lists no sessions after adapter runtime clears", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      yield* provider.startSession(asThreadId("thread-2"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-2"),
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      yield* routing.claude.stopAll();

      const remaining = yield* provider.listSessions();
      assert.equal(remaining.length, 0);
    }),
  );

  it.effect("persists runtime status transitions in provider_session_runtime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const threadId = asThreadId("thread-runtime-status");
      const session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const runningRuntime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runningRuntime), true);
      if (Option.isSome(runningRuntime)) {
        assert.equal(runningRuntime.value.status, "running");
        assert.deepEqual(runningRuntime.value.resumeCursor, session.resumeCursor);
        const payload = runningRuntime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            cwd: string;
            model: string | null;
            activeTurnId: string | null;
            lastError: string | null;
            lastRuntimeEvent: string | null;
          };
          assert.equal(runtimePayload.cwd, session.cwd);
          assert.equal(runtimePayload.model, null);
          assert.equal(runtimePayload.activeTurnId, `turn-${String(session.threadId)}`);
          assert.equal(runtimePayload.lastError, null);
          assert.equal(runtimePayload.lastRuntimeEvent, "provider.sendTurn");
        }
      }
    }),
  );

  it.effect("reuses persisted resume cursor when startSession is called after a restart", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-provider-service-start-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("claudeAgent")]: firstClaude.adapter,
      });
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-claude-start"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-claude-start"),
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(firstProviderLayer));

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.listSessions();
      }).pipe(Effect.provide(firstProviderLayer));

      const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("claudeAgent")]: secondClaude.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      secondClaude.startSession.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.startSession(initial.threadId, {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: initial.threadId,
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondClaude.startSession.mock.calls.length, 1);
      const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-start");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reuses persisted cwd when startSession resumes a claude session without cwd input",
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-provider-service-cwd-"),
        );
        const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
        const persistenceLayer = makeSqlitePersistenceLive(dbPath);
        const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
          Layer.provide(persistenceLayer),
        );

        const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
        const firstRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("claudeAgent")]: firstClaude.adapter,
        });
        const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const firstProviderLayer = makeProviderServiceLive().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
          ),
          Layer.provide(firstDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        );

        const initial = yield* Effect.gen(function* () {
          const provider = yield* ProviderService.ProviderService;
          return yield* provider.startSession(asThreadId("thread-claude-cwd"), {
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeAgentInstanceId,
            threadId: asThreadId("thread-claude-cwd"),
            cwd: "/tmp/project-claude-cwd",
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(firstProviderLayer));

        const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
        const secondRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("claudeAgent")]: secondClaude.adapter,
        });
        const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const secondProviderLayer = makeProviderServiceLive().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
          ),
          Layer.provide(secondDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        );

        secondClaude.startSession.mockClear();

        yield* Effect.gen(function* () {
          const provider = yield* ProviderService.ProviderService;
          yield* provider.startSession(initial.threadId, {
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeAgentInstanceId,
            threadId: initial.threadId,
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(secondProviderLayer));

        assert.equal(secondClaude.startSession.mock.calls.length, 1);
        const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
        assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
        if (resumedStartInput && typeof resumedStartInput === "object") {
          const startPayload = resumedStartInput as {
            provider?: string;
            cwd?: string;
            resumeCursor?: unknown;
            threadId?: string;
          };
          assert.equal(startPayload.provider, "claudeAgent");
          assert.equal(startPayload.cwd, "/tmp/project-claude-cwd");
          assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
          assert.equal(startPayload.threadId, initial.threadId);
        }

        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const fanout = makeProviderServiceLayer();
fanout.layer("ProviderServiceLive fanout", (it) => {
  it.effect("fans out adapter turn completion events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(eventsRef, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* advanceTestClock(50);

      const completedEvent: LegacyProviderRuntimeEvent = {
        type: "turn.completed",
        eventId: asEventId("evt-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      };

      fanout.codex.emit(completedEvent);
      yield* advanceTestClock(50);

      const events = yield* Ref.get(eventsRef);
      yield* Fiber.interrupt(consumer);

      assert.equal(
        events.some((entry) => entry.type === "turn.completed"),
        true,
      );
      assert.equal(
        events.some(
          (entry) =>
            entry.type === "turn.completed" && entry.providerInstanceId === codexInstanceId,
        ),
        true,
      );
    }),
  );

  it.effect("fans out canonical runtime events in emission order", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-seq"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-seq"),
        runtimeMode: "full-access",
      });

      const receivedRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      fanout.codex.emit({
        type: "tool.started",
        eventId: asEventId("evt-seq-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "tool.completed",
        eventId: asEventId("evt-seq-2"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-seq-3"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      });

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepEqual(
        received.map((event) => event.eventId),
        [asEventId("evt-seq-1"), asEventId("evt-seq-2"), asEventId("evt-seq-3")],
      );
    }),
  );

  it.effect("keeps subscriber delivery ordered and isolates failing subscribers", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const receivedByHealthy: string[] = [];
      const expectedEventIds = new Set<string>(["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"]);
      const healthyFiber = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            receivedByHealthy.push(event.eventId);
          }),
        ),
        Effect.forkChild,
      );
      const failingFiber = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach(() => Effect.fail("listener crash")),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      const events: ReadonlyArray<LegacyProviderRuntimeEvent> = [
        {
          type: "tool.completed",
          eventId: asEventId("evt-ordered-1"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          toolKind: "command",
          title: "Ran command",
          detail: "echo one",
        },
        {
          type: "message.delta",
          eventId: asEventId("evt-ordered-2"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          delta: "hello",
        },
        {
          type: "turn.completed",
          eventId: asEventId("evt-ordered-3"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          status: "completed",
        },
      ];

      for (const event of events) {
        fanout.codex.emit(event);
      }
      const failingResult = yield* Effect.result(Fiber.join(failingFiber));
      assert.equal(failingResult._tag, "Failure");
      yield* Fiber.join(healthyFiber);

      assert.deepEqual(
        receivedByHealthy.filter((eventId) => expectedEventIds.has(eventId)).slice(0, 3),
        ["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"],
      );
    }),
  );

  it.effect("records provider metrics with the routed provider label", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-metrics"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-metrics"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      yield* provider.interruptTurn({ threadId: session.threadId });
      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-1"),
        decision: "accept",
      });
      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-2"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 1,
      });
      yield* provider.stopSession({ threadId: session.threadId });

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "interrupt",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "approval-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "user-input-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "rollback",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_sessions_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "stop",
          outcome: "success",
        }),
        true,
      );
    }),
  );

  it.effect(
    "records sendTurn metrics with the resolved provider when modelSelection is omitted",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;

        const session = yield* provider.startSession(asThreadId("thread-send-metrics"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-send-metrics"),
          cwd: "/tmp/project-send-metrics",
          runtimeMode: "full-access",
        });

        yield* provider.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        const snapshots = yield* Metric.snapshot;

        assert.equal(
          hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
            outcome: "success",
          }),
          true,
        );
        assert.equal(
          hasMetricSnapshot(snapshots, "t3_provider_turn_duration", {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
          }),
          true,
        );
      }),
  );
});

const validation = makeProviderServiceLayer();
validation.layer("ProviderServiceLive validation", (it) => {
  it.effect("rejects session starts without an explicit provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-missing-instance-id"), {
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-missing-instance-id"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(failure.issue, "Provider instance id is required for provider 'codex'.");
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("rejects mismatched provider kind and provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();
      validation.claude.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-instance-mismatch"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-instance-mismatch"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(
        failure.issue,
        "Provider instance 'claudeAgent' belongs to driver 'claudeAgent', not 'codex'.",
      );
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
      assert.equal(validation.claude.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("returns ProviderValidationError for invalid input payloads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const failure = yield* Effect.result(
        provider.startSession(asThreadId("thread-validation"), {
          threadId: asThreadId("thread-validation"),
          provider: "invalid-provider",
          runtimeMode: "full-access",
        } as never),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }
      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }
      assert.equal(failure.failure.operation, "ProviderService.startSession");
      assert.equal(failure.failure.issue.includes("invalid-provider"), true);
    }),
  );

  it.effect("accepts startSession when adapter has not emitted provider thread id yet", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = "2026-01-01T00:00:00.000Z";
          return {
            provider: ProviderDriverKind.make("codex"),
            status: "ready",
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-missing"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-missing"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, asThreadId("thread-missing"));

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, session.threadId);
      }
    }),
  );
});
