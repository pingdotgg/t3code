import type {
  ProviderApprovalDecision,
  ProviderEvent,
  ProviderGetCheckpointDiffInput,
  ProviderGetCheckpointDiffResult,
  ProviderListCheckpointsInput,
  ProviderListCheckpointsResult,
  ProviderRevertToCheckpointInput,
  ProviderRevertToCheckpointResult,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import { providerSessionStartInputSchema } from "@t3tools/contracts";
import { it, assert, vi } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";

import { Effect, Layer } from "effect";

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
import { ProviderServiceLive } from "./ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";

function makeFakeCodexAdapter() {
  const sessions = new Map<string, ProviderSession>();
  const eventListeners = new Set<(event: ProviderEvent) => void>();
  let nextSession = 1;

  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    Effect.sync(() => {
      const now = new Date().toISOString();
      const session: ProviderSession = {
        sessionId: `sess-${nextSession}`,
        provider: "codex",
        status: "ready",
        threadId: `thread-${nextSession}`,
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

  const subscribeToEvents = vi.fn(
    (callback: (event: ProviderEvent) => void): Effect.Effect<() => void, ProviderAdapterError> =>
      Effect.sync(() => {
        eventListeners.add(callback);
        return () => {
          eventListeners.delete(callback);
        };
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
    subscribeToEvents,
  };

  const emit = (event: ProviderEvent): void => {
    for (const listener of eventListeners) {
      listener(event);
    }
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
    subscribeToEvents,
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

  const service: typeof CheckpointService.Service = {
    initializeForSession,
    captureCurrentTurn,
    listCheckpoints,
    getCheckpointDiff,
    revertToCheckpoint,
  };

  return {
    service,
    initializeForSession,
    captureCurrentTurn,
    listCheckpoints,
    getCheckpointDiff,
    revertToCheckpoint,
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

  const layer = it.layer(
    ProviderServiceLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderAdapterRegistry, registry),
          ProviderSessionDirectoryLive,
          Layer.succeed(CheckpointService, checkpoint.service),
        ),
      ),
    ),
  );

  return {
    codex,
    checkpoint,
    layer,
  };
}

const routing = makeProviderServiceLayer();
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
});

const fanout = makeProviderServiceLayer();
fanout.layer("ProviderServiceLive fanout", (it) => {
  it.effect("fans out adapter events and captures turn completion checkpoints", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession({
        provider: "codex",
      });

      const onEvent = vi.fn((_event: ProviderEvent) => undefined);
      const unsubscribe = yield* provider.subscribeToEvents(onEvent);

      const completedEvent: ProviderEvent = {
        id: "evt-1",
        kind: "notification",
        provider: "codex",
        sessionId: session.sessionId,
        createdAt: new Date().toISOString(),
        method: "turn/completed",
        threadId: "thread-1",
        turnId: "turn-1",
        payload: {
          turn: {
            status: "completed",
          },
        },
      };

      fanout.codex.emit(completedEvent);
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

      assert.equal(onEvent.mock.calls.length, 1);
      assert.equal(onEvent.mock.calls[0]?.[0]?.method, "turn/completed");
      assert.deepEqual(fanout.checkpoint.captureCurrentTurn.mock.calls, [
        [{ providerSessionId: session.sessionId, turnId: "turn-1", status: "completed" }],
      ]);

      unsubscribe();
      fanout.codex.emit({
        ...completedEvent,
        id: "evt-2",
      });
      assert.equal(onEvent.mock.calls.length, 1);
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
});
