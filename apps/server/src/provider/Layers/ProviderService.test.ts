import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ProviderApprovalDecision,
  ProviderGetCheckpointDiffInput,
  ProviderGetCheckpointDiffResult,
  ProviderListCheckpointsInput,
  ProviderListCheckpointsResult,
  ProviderRevertToCheckpointInput,
  ProviderRuntimeEvent,
  ProviderRevertToCheckpointResult,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import { providerSessionStartInputSchema } from "@t3tools/contracts";
import { it, assert, vi } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";

import { Effect, Fiber, Layer, PubSub, Ref, Stream } from "effect";

import { CheckpointService } from "../../checkpointing/Services/CheckpointService.ts";
import {
  ProviderAdapterSessionNotFoundError,
  ProviderSessionNotFoundError,
  ProviderValidationError,
  ProviderUnsupportedError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderServiceLive } from "./ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { NodeServices } from "@effect/platform-node";
import { ProviderSessionRepositoryLive } from "../../persistence/Layers/ProviderSessions.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";

function makeFakeCodexAdapter() {
  const sessions = new Map<string, ProviderSession>();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  let nextSession = 1;

  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    Effect.sync(() => {
      const now = new Date().toISOString();
      const session: ProviderSession = {
        sessionId: `sess-${nextSession}`,
        provider: "codex",
        status: "ready",
        threadId: input.resumeThreadId ?? `thread-${nextSession}`,
        cwd: input.cwd ?? process.cwd(),
        createdAt: now,
        updatedAt: now,
      };
      nextSession += 1;
      sessions.set(session.sessionId, session);
      return session;
    }),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.sessionId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: "codex",
            sessionId: input.sessionId,
          }),
        );
      }

      return Effect.succeed({
        threadId: "thread-1",
        turnId: "turn-1",
      });
    },
  );

  const interruptTurn = vi.fn(
    (_sessionId: string, _turnId?: string): Effect.Effect<void, ProviderAdapterError> =>
      Effect.void,
  );

  const respondToRequest = vi.fn(
    (
      _sessionId: string,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const stopSession = vi.fn(
    (sessionId: string): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.delete(sessionId);
      }),
  );

  const listSessions = vi.fn(
    (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => Array.from(sessions.values())),
  );

  const hasSession = vi.fn(
    (sessionId: string): Effect.Effect<boolean> => Effect.succeed(sessions.has(sessionId)),
  );

  const readThread = vi.fn(
    (
      _sessionId: string,
    ): Effect.Effect<{ threadId: string; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId: "thread-1", turns: [] }),
  );

  const rollbackThread = vi.fn(
    (
      _sessionId: string,
      _numTurns: number,
    ): Effect.Effect<{ threadId: string; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId: "thread-1", turns: [] }),
  );

  const stopAll = vi.fn(
    (): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.clear();
      }),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: "codex",
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };

  const emit = (event: ProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event));
  };

  return {
    adapter,
    emit,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
  };
}

function makeCheckpointServiceDouble() {
  const initializeForSession = vi.fn(
    (_: { providerSessionId: string; cwd: string }) => Effect.void,
  );
  const captureCurrentTurn = vi.fn(
    (_: { providerSessionId: string; turnId?: string; status?: string }) => Effect.void,
  );
  const listCheckpoints = vi.fn(
    (_input: ProviderListCheckpointsInput): Effect.Effect<ProviderListCheckpointsResult> =>
      Effect.succeed({
        threadId: "thread-1",
        checkpoints: [
          {
            id: "root",
            turnCount: 0,
            messageCount: 0,
            label: "Start of conversation",
            isCurrent: true,
          },
        ],
      }),
  );
  const getCheckpointDiff = vi.fn(
    (input: ProviderGetCheckpointDiffInput): Effect.Effect<ProviderGetCheckpointDiffResult> =>
      Effect.succeed({
        threadId: "thread-1",
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
        diff: "diff --git a/a.ts b/a.ts",
      }),
  );
  const revertToCheckpoint = vi.fn(
    (input: ProviderRevertToCheckpointInput): Effect.Effect<ProviderRevertToCheckpointResult> =>
      Effect.succeed({
        threadId: "thread-1",
        turnCount: input.turnCount,
        messageCount: 0,
        rolledBackTurns: 0,
        checkpoints: [
          {
            id: "root",
            turnCount: 0,
            messageCount: 0,
            label: "Start of conversation",
            isCurrent: input.turnCount === 0,
          },
        ],
      }),
  );
  const releaseSession = vi.fn((_input: { providerSessionId: string }) => Effect.void);

  const service: typeof CheckpointService.Service = {
    initializeForSession,
    captureCurrentTurn,
    listCheckpoints,
    getCheckpointDiff,
    revertToCheckpoint,
    releaseSession,
  };

  return {
    service,
    initializeForSession,
    captureCurrentTurn,
    listCheckpoints,
    getCheckpointDiff,
    revertToCheckpoint,
    releaseSession,
  };
}

function makeProviderServiceLayer() {
  const codex = makeFakeCodexAdapter();
  const checkpoint = makeCheckpointServiceDouble();
  const registry: typeof ProviderAdapterRegistry.Service = {
    getByProvider: (provider) =>
      provider === "codex"
        ? Effect.succeed(codex.adapter)
        : Effect.fail(new ProviderUnsupportedError({ provider })),
    listProviders: () => Effect.succeed(["codex"]),
  };

  const checkpointLayer = Layer.succeed(CheckpointService, checkpoint.service);
  const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
  const directoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRepositoryLive),
    Layer.provide(SqlitePersistenceMemory),
  );

  const layer = it.layer(
    Layer.mergeAll(
      ProviderServiceLive.pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(checkpointLayer),
      ),
      directoryLayer,
      NodeServices.layer,
    ),
  );

  return {
    codex,
    checkpoint,
    layer,
  };
}

const routing = makeProviderServiceLayer();
it.effect("ProviderServiceLive keeps persisted resumable sessions on startup", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-service-"));
    const dbPath = path.join(tempDir, "orchestration.sqlite");

    const codex = makeFakeCodexAdapter();
    const checkpoint = makeCheckpointServiceDouble();
    const registry: typeof ProviderAdapterRegistry.Service = {
      getByProvider: (provider) =>
        provider === "codex"
          ? Effect.succeed(codex.adapter)
          : Effect.fail(new ProviderUnsupportedError({ provider })),
      listProviders: () => Effect.succeed(["codex"]),
    };

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const directoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRepositoryLive),
      Layer.provide(persistenceLayer),
    );

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      yield* directory.upsert({
        sessionId: "sess-stale",
        provider: "codex",
        threadId: "thread-stale",
      });
    }).pipe(Effect.provide(directoryLayer));

    const providerLayer = ProviderServiceLive.pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(Layer.succeed(CheckpointService, checkpoint.service)),
    );

    checkpoint.releaseSession.mockClear();
    yield* Effect.gen(function* () {
      yield* ProviderService;
    }).pipe(Effect.provide(providerLayer));

    assert.deepEqual(checkpoint.releaseSession.mock.calls, []);
    const persistedProvider = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      return yield* directory.getProvider("sess-stale");
    }).pipe(Effect.provide(directoryLayer));
    assert.equal(persistedProvider, "codex");

    fs.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive restores checkpoint RPC routing after restart using persisted thread mapping", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-service-restart-"));
    const dbPath = path.join(tempDir, "orchestration.sqlite");
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);

    const checkpoint = makeCheckpointServiceDouble();
    const firstCodex = makeFakeCodexAdapter();
    const firstRegistry: typeof ProviderAdapterRegistry.Service = {
      getByProvider: (provider) =>
        provider === "codex"
          ? Effect.succeed(firstCodex.adapter)
          : Effect.fail(new ProviderUnsupportedError({ provider })),
      listProviders: () => Effect.succeed(["codex"]),
    };

    const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRepositoryLive),
      Layer.provide(persistenceLayer),
    );
    const firstProviderLayer = ProviderServiceLive.pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
      Layer.provide(firstDirectoryLayer),
      Layer.provide(Layer.succeed(CheckpointService, checkpoint.service)),
    );

    const startedSession = yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      return yield* provider.startSession({
        provider: "codex",
        cwd: "/tmp/project",
      });
    }).pipe(Effect.provide(firstProviderLayer));

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      yield* provider.stopAll();
    }).pipe(Effect.provide(firstProviderLayer));

    const secondCodex = makeFakeCodexAdapter();
    const secondRegistry: typeof ProviderAdapterRegistry.Service = {
      getByProvider: (provider) =>
        provider === "codex"
          ? Effect.succeed(secondCodex.adapter)
          : Effect.fail(new ProviderUnsupportedError({ provider })),
      listProviders: () => Effect.succeed(["codex"]),
    };
    const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRepositoryLive),
      Layer.provide(persistenceLayer),
    );
    const secondProviderLayer = ProviderServiceLive.pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, secondRegistry)),
      Layer.provide(secondDirectoryLayer),
      Layer.provide(Layer.succeed(CheckpointService, checkpoint.service)),
    );

    checkpoint.getCheckpointDiff.mockClear();
    secondCodex.startSession.mockClear();

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      yield* provider.getCheckpointDiff({
        sessionId: startedSession.sessionId,
        fromTurnCount: 0,
        toTurnCount: 0,
      });
    }).pipe(Effect.provide(secondProviderLayer));

    assert.deepEqual(secondCodex.startSession.mock.calls, [
      [
        {
          provider: "codex",
          resumeThreadId: startedSession.threadId,
        },
      ],
    ]);
    assert.equal(checkpoint.getCheckpointDiff.mock.calls.length, 1);
    const recoveredDiffInput = checkpoint.getCheckpointDiff.mock.calls[0]?.[0];
    assert.equal(typeof recoveredDiffInput?.sessionId, "string");
    assert.equal((recoveredDiffInput?.sessionId?.length ?? 0) > 0, true);
    assert.equal(recoveredDiffInput?.fromTurnCount, 0);
    assert.equal(recoveredDiffInput?.toTurnCount, 0);

    fs.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("routes provider operations and delegates checkpoint workflows", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const session = yield* provider.startSession({
        provider: "codex",
        cwd: "/tmp/project",
      });
      assert.equal(session.provider, "codex");
      assert.deepEqual(routing.checkpoint.initializeForSession.mock.calls, [
        [{ providerSessionId: session.sessionId, cwd: "/tmp/project" }],
      ]);

      const sessions = yield* provider.listSessions();
      assert.equal(sessions.length, 1);

      yield* provider.sendTurn({
        sessionId: session.sessionId,
        input: "hello",
        attachments: [],
      });
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);

      yield* provider.interruptTurn({ sessionId: session.sessionId });
      assert.deepEqual(routing.codex.interruptTurn.mock.calls, [[session.sessionId, undefined]]);

      yield* provider.respondToRequest({
        sessionId: session.sessionId,
        requestId: "req-1",
        decision: "accept",
      });
      assert.deepEqual(routing.codex.respondToRequest.mock.calls, [
        [session.sessionId, "req-1", "accept"],
      ]);

      yield* provider.listCheckpoints({ sessionId: session.sessionId });
      yield* provider.getCheckpointDiff({
        sessionId: session.sessionId,
        fromTurnCount: 0,
        toTurnCount: 0,
      });
      yield* provider.revertToCheckpoint({
        sessionId: session.sessionId,
        turnCount: 0,
      });

      assert.deepEqual(routing.checkpoint.listCheckpoints.mock.calls, [
        [{ sessionId: session.sessionId }],
      ]);
      assert.deepEqual(routing.checkpoint.getCheckpointDiff.mock.calls, [
        [{ sessionId: session.sessionId, fromTurnCount: 0, toTurnCount: 0 }],
      ]);
      assert.deepEqual(routing.checkpoint.revertToCheckpoint.mock.calls, [
        [{ sessionId: session.sessionId, turnCount: 0 }],
      ]);

      yield* provider.stopSession({ sessionId: session.sessionId });
      assert.deepEqual(routing.checkpoint.releaseSession.mock.calls, [
        [{ providerSessionId: session.sessionId }],
      ]);
      const sendAfterStop = yield* Effect.result(
        provider.sendTurn({
          sessionId: session.sessionId,
          input: "after-stop",
          attachments: [],
        }),
      );
      assertFailure(
        sendAfterStop,
        new ProviderSessionNotFoundError({ sessionId: session.sessionId }),
      );
    }),
  );

  it.effect("recovers stale persisted sessions for checkpoint RPCs by resuming thread identity", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const initial = yield* provider.startSession({
        provider: "codex",
        cwd: "/tmp/project",
      });
      yield* routing.codex.stopSession(initial.sessionId);

      routing.checkpoint.getCheckpointDiff.mockClear();
      routing.checkpoint.revertToCheckpoint.mockClear();
      routing.codex.startSession.mockClear();

      yield* provider.getCheckpointDiff({
        sessionId: initial.sessionId,
        fromTurnCount: 0,
        toTurnCount: 0,
      });
      yield* provider.revertToCheckpoint({
        sessionId: initial.sessionId,
        turnCount: 0,
      });

      assert.deepEqual(routing.codex.startSession.mock.calls, [
        [
          {
            provider: "codex",
            resumeThreadId: initial.threadId,
          },
        ],
      ]);
      assert.equal(routing.checkpoint.getCheckpointDiff.mock.calls.length, 1);
      assert.equal(routing.checkpoint.revertToCheckpoint.mock.calls.length, 1);

      const diffInput = routing.checkpoint.getCheckpointDiff.mock.calls[0]?.[0];
      const revertInput = routing.checkpoint.revertToCheckpoint.mock.calls[0]?.[0];
      assert.equal(diffInput?.fromTurnCount, 0);
      assert.equal(diffInput?.toTurnCount, 0);
      assert.equal(diffInput?.sessionId === initial.sessionId, false);
      assert.equal(revertInput?.sessionId, diffInput?.sessionId);
      assert.equal(revertInput?.turnCount, 0);
    }),
  );

  it.effect("releases checkpoint session state when stopping all sessions", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const first = yield* provider.startSession({
        provider: "codex",
      });
      const second = yield* provider.startSession({
        provider: "codex",
      });

      yield* provider.stopAll();

      assert.deepEqual(routing.checkpoint.releaseSession.mock.calls.slice(-2), [
        [{ providerSessionId: first.sessionId }],
        [{ providerSessionId: second.sessionId }],
      ]);

      const remaining = yield* provider.listSessions();
      assert.equal(remaining.length, 0);
    }),
  );
});

const fanout = makeProviderServiceLayer();
fanout.layer("ProviderServiceLive fanout", (it) => {
  it.effect("fans out adapter events and captures turn completion checkpoints", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession({
        provider: "codex",
      });

      const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(eventsRef, (current) => [...current, event]),
      ).pipe(
        Effect.forkChild,
      );
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

      const completedEvent: ProviderRuntimeEvent = {
        type: "turn.completed",
        eventId: "evt-1",
        provider: "codex",
        sessionId: session.sessionId,
        createdAt: new Date().toISOString(),
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
      };

      fanout.codex.emit(completedEvent);
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

      const events = yield* Ref.get(eventsRef);
      yield* Fiber.interrupt(consumer);

      assert.equal(events.length >= 2, true);
      assert.equal(events[0]?.type, "turn.completed");
      assert.equal(events[1]?.type, "checkpoint.captured");
      assert.deepEqual(fanout.checkpoint.captureCurrentTurn.mock.calls, [
        [{ providerSessionId: session.sessionId, turnId: "turn-1", status: "completed" }],
      ]);
    }),
  );

  it.effect("keeps subscriber delivery ordered and isolates failing subscribers", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession({
        provider: "codex",
      });
      fanout.checkpoint.captureCurrentTurn.mockClear();

      const receivedByHealthy: string[] = [];
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
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

      const events: ReadonlyArray<ProviderRuntimeEvent> = [
        {
          type: "tool.completed",
          eventId: "evt-ordered-1",
          provider: "codex",
          sessionId: session.sessionId,
          createdAt: new Date().toISOString(),
          threadId: "thread-1",
          turnId: "turn-1",
          toolKind: "command",
          title: "Command run",
          detail: "echo one",
        },
        {
          type: "message.delta",
          eventId: "evt-ordered-2",
          provider: "codex",
          sessionId: session.sessionId,
          createdAt: new Date().toISOString(),
          threadId: "thread-1",
          turnId: "turn-1",
          delta: "hello",
        },
        {
          type: "turn.completed",
          eventId: "evt-ordered-3",
          provider: "codex",
          sessionId: session.sessionId,
          createdAt: new Date().toISOString(),
          threadId: "thread-1",
          turnId: "turn-1",
          status: "completed",
        },
      ];

      for (const event of events) {
        fanout.codex.emit(event);
      }
      const failingResult = yield* Effect.result(Fiber.join(failingFiber));
      assert.equal(failingResult._tag, "Failure");
      yield* Fiber.join(healthyFiber);

      assert.deepEqual(receivedByHealthy.slice(0, 3), [
        "evt-ordered-1",
        "evt-ordered-2",
        "evt-ordered-3",
      ]);
      assert.equal(receivedByHealthy.length, 3);
    }),
  );
});

const validation = makeProviderServiceLayer();
validation.layer("ProviderServiceLive validation", (it) => {
  it.effect("returns ProviderValidationError for invalid input payloads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const parse = providerSessionStartInputSchema.safeParse({
        provider: "invalid-provider",
      });
      assert.equal(parse.success, false);
      if (parse.success) {
        return;
      }

      const failure = yield* Effect.result(
        provider.startSession({
          provider: "invalid-provider",
        } as never),
      );

      const cause = (parse.error as { cause?: unknown }).cause;
      assertFailure(
        failure,
        new ProviderValidationError({
          operation: "ProviderService.startSession",
          issue: parse.error.message,
          ...(cause !== undefined ? { cause } : {}),
        }),
      );
    }),
  );

  it.effect("fails startSession when adapter returns no threadId", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = new Date().toISOString();
          return {
            sessionId: "sess-missing-thread",
            provider: "codex",
            status: "ready",
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const failure = yield* Effect.result(
        provider.startSession({
          provider: "codex",
          cwd: "/tmp/project",
        }),
      );

      assertFailure(
        failure,
        new ProviderValidationError({
          operation: "ProviderService.startSession",
          issue:
            "Provider 'codex' returned a session without threadId. threadId is required for checkpoint initialization.",
        }),
      );
    }),
  );
});
