import { randomUUID } from "node:crypto";

import type {
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import { Effect, Queue, Stream } from "effect";

import {
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../src/provider/Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../src/provider/Services/ProviderAdapter.ts";

export interface TestTurnResponse {
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  readonly mutateWorkspace?: (input: {
    readonly cwd: string;
    readonly turnCount: number;
  }) => Effect.Effect<void, never>;
}

interface SessionState {
  readonly session: ProviderSession;
  snapshot: ProviderThreadSnapshot;
  turnCount: number;
  readonly queuedResponses: Array<TestTurnResponse>;
  readonly rollbackCalls: Array<number>;
}

export interface TestProviderAdapterHarness {
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly queueTurnResponse: (
    sessionId: string,
    response: TestTurnResponse,
  ) => Effect.Effect<void, ProviderAdapterSessionNotFoundError>;
  readonly getRollbackCalls: (sessionId: string) => ReadonlyArray<number>;
}

const PROVIDER = "codex" as const;

function nowIso(): string {
  return new Date().toISOString();
}

function sessionNotFound(sessionId: string): ProviderAdapterSessionNotFoundError {
  return new ProviderAdapterSessionNotFoundError({
    provider: PROVIDER,
    sessionId,
  });
}

function missingSessionEffect(sessionId: string): Effect.Effect<never, ProviderAdapterError> {
  return Effect.fail(sessionNotFound(sessionId));
}

export const makeTestProviderAdapterHarness = Effect.gen(function* () {
  const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  let sessionCount = 0;
  const sessions = new Map<string, SessionState>();

  const emit = (event: ProviderRuntimeEvent) => Queue.offer(runtimeEvents, event);

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }

      sessionCount += 1;
      const sessionId = `test-session-${sessionCount}`;
      const threadId = `test-thread-${sessionCount}`;
      const createdAt = nowIso();

      const session: ProviderSession = {
        sessionId,
        provider: PROVIDER,
        status: "ready",
        threadId,
        cwd: input.cwd,
        createdAt,
        updatedAt: createdAt,
      };

      sessions.set(sessionId, {
        session,
        snapshot: {
          threadId,
          turns: [],
        },
        turnCount: 0,
        queuedResponses: [],
        rollbackCalls: [],
      });

      return session;
    });

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const state = sessions.get(input.sessionId);
      if (!state) {
        return yield* missingSessionEffect(input.sessionId);
      }

      state.turnCount += 1;
      const turnCount = state.turnCount;
      const turnId = `turn-${turnCount}`;

      const response = state.queuedResponses.shift();
      if (!response) {
        return yield* Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `No queued turn response for session ${input.sessionId}.`,
          }),
        );
      }

      const assistantDeltas: string[] = [];
      let hasCompletedEvent = false;
      for (const fixtureEvent of response.events) {
        const rawEvent: Record<string, unknown> = {
          ...(fixtureEvent as Record<string, unknown>),
          eventId: randomUUID(),
          provider: PROVIDER,
          sessionId: input.sessionId,
          createdAt: nowIso(),
        };
        if (Object.hasOwn(rawEvent, "threadId")) {
          rawEvent.threadId = state.snapshot.threadId;
        }
        if (Object.hasOwn(rawEvent, "turnId")) {
          rawEvent.turnId = turnId;
        }

        const runtimeEvent = rawEvent as ProviderRuntimeEvent;
        if (runtimeEvent.type === "message.delta") {
          assistantDeltas.push(runtimeEvent.delta);
        }
        if (runtimeEvent.type === "turn.completed") {
          hasCompletedEvent = true;
        }

        yield* emit(runtimeEvent);
      }

      if (response.mutateWorkspace && state.session.cwd) {
        yield* response.mutateWorkspace({ cwd: state.session.cwd!, turnCount });
      }

      const userItem = {
        type: "userMessage",
        content: [{ type: "text", text: input.input }],
      } as const;
      const assistantText = assistantDeltas.join("");
      const nextItems: Array<unknown> =
        assistantText.length > 0
          ? [userItem, { type: "agentMessage", text: assistantText }]
          : [userItem];

      const nextTurn: ProviderThreadTurnSnapshot = {
        id: turnId,
        items: nextItems,
      };

      state.snapshot = {
        threadId: state.snapshot.threadId,
        turns: [...state.snapshot.turns, nextTurn],
      };

      if (!hasCompletedEvent) {
        yield* emit({
          type: "turn.completed",
          eventId: randomUUID(),
          provider: PROVIDER,
          sessionId: input.sessionId,
          createdAt: nowIso(),
          threadId: state.snapshot.threadId,
          turnId,
          status: "completed",
        });
      }

      return {
        threadId: state.snapshot.threadId,
        turnId,
      } satisfies ProviderTurnStartResult;
    });

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
    sessionId,
    _turnId,
  ) => (sessions.has(sessionId) ? Effect.void : missingSessionEffect(sessionId));

  const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
    sessionId,
    _requestId,
    _decision,
  ) => (sessions.has(sessionId) ? Effect.void : missingSessionEffect(sessionId));

  const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (sessionId) =>
    Effect.sync(() => {
      sessions.delete(sessionId);
    });

  const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (state) => state.session));

  const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (sessionId) =>
    Effect.succeed(sessions.has(sessionId));

  const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (sessionId) => {
    const state = sessions.get(sessionId);
    if (!state) {
      return missingSessionEffect(sessionId);
    }
    return Effect.succeed(state.snapshot);
  };

  const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
    sessionId,
    numTurns,
  ) => {
    const state = sessions.get(sessionId);
    if (!state) {
      return missingSessionEffect(sessionId);
    }
    if (!Number.isInteger(numTurns) || numTurns < 0 || numTurns > state.snapshot.turns.length) {
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer between 0 and current turn count.",
        }),
      );
    }

    return Effect.sync(() => {
      state.rollbackCalls.push(numTurns);
      state.snapshot = {
        threadId: state.snapshot.threadId,
        turns: state.snapshot.turns.slice(0, state.snapshot.turns.length - numTurns),
      };
      state.turnCount = state.snapshot.turns.length;
      return state.snapshot;
    });
  };

  const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
    Effect.sync(() => {
      sessions.clear();
    });

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: PROVIDER,
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
    streamEvents: Stream.fromQueue(runtimeEvents),
  };

  const queueTurnResponse = (
    sessionId: string,
    response: TestTurnResponse,
  ): Effect.Effect<void, ProviderAdapterSessionNotFoundError> =>
    Effect.sync(() => sessions.get(sessionId)).pipe(
      Effect.flatMap((state) =>
        state
          ? Effect.sync(() => {
              state.queuedResponses.push(response);
            })
          : Effect.fail(sessionNotFound(sessionId)),
      ),
    );

  const getRollbackCalls = (sessionId: string): ReadonlyArray<number> => {
    const state = sessions.get(sessionId);
    if (!state) {
      return [];
    }
    return [...state.rollbackCalls];
  };

  return {
    adapter,
    queueTurnResponse,
    getRollbackCalls,
  } satisfies TestProviderAdapterHarness;
});
