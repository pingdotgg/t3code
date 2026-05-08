import {
  ApprovalRequestId,
  EventId,
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  RuntimeSessionId,
  ProviderSession,
  ProviderTurnStartResult,
  ThreadId,
  TurnId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";

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
  readonly events: ReadonlyArray<FixtureProviderRuntimeEvent>;
  readonly mutateWorkspace?: (input: {
    readonly cwd: string;
    readonly turnCount: number;
  }) => Effect.Effect<void, never>;
}

export type FixtureProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: string;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

// Temporary alias while fixtures migrate to the new name.
export type LegacyProviderRuntimeEvent = FixtureProviderRuntimeEvent;

interface SessionState {
  readonly session: ProviderSession;
  snapshot: ProviderThreadSnapshot;
  turnCount: number;
  readonly queuedResponses: Array<TestTurnResponse>;
  readonly rollbackCalls: Array<number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeTurnState(value: unknown): "completed" | "failed" | "interrupted" | "cancelled" {
  if (
    value === "completed" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "completed";
}

function mapRequestType(
  requestKind: unknown,
): "command_execution_approval" | "file_change_approval" | "unknown" {
  if (requestKind === "command") {
    return "command_execution_approval";
  }
  if (requestKind === "file-change") {
    return "file_change_approval";
  }
  return "unknown";
}

function mapItemType(toolKind: unknown): "command_execution" | "file_change" | "unknown" {
  if (toolKind === "command") {
    return "command_execution";
  }
  if (toolKind === "file-change") {
    return "file_change";
  }
  return "unknown";
}

function normalizeFixtureEvent(rawEvent: Record<string, unknown>): ProviderRuntimeEvent {
  const type = typeof rawEvent.type === "string" ? rawEvent.type : "";
  switch (type) {
    case "turn.started":
      return {
        ...rawEvent,
        type: "turn.started",
        payload: isRecord(rawEvent.payload) ? rawEvent.payload : {},
      } as ProviderRuntimeEvent;
    case "turn.completed":
      return {
        ...rawEvent,
        type: "turn.completed",
        payload: isRecord(rawEvent.payload)
          ? rawEvent.payload
          : {
              state: normalizeTurnState(rawEvent.status),
            },
      } as ProviderRuntimeEvent;
    case "message.delta":
      return {
        ...rawEvent,
        type: "content.delta",
        payload: {
          streamKind: "assistant_text",
          delta: typeof rawEvent.delta === "string" ? rawEvent.delta : "",
        },
      } as ProviderRuntimeEvent;
    case "message.completed":
      return {
        ...rawEvent,
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          ...(typeof rawEvent.detail === "string" ? { detail: rawEvent.detail } : {}),
        },
      } as ProviderRuntimeEvent;
    case "tool.started":
      return {
        ...rawEvent,
        type: "item.started",
        payload: {
          itemType: mapItemType(rawEvent.toolKind),
          ...(typeof rawEvent.title === "string" ? { title: rawEvent.title } : {}),
          ...(typeof rawEvent.detail === "string" ? { detail: rawEvent.detail } : {}),
        },
      } as ProviderRuntimeEvent;
    case "tool.completed":
      return {
        ...rawEvent,
        type: "item.completed",
        payload: {
          itemType: mapItemType(rawEvent.toolKind),
          status: "completed",
          ...(typeof rawEvent.title === "string" ? { title: rawEvent.title } : {}),
          ...(typeof rawEvent.detail === "string" ? { detail: rawEvent.detail } : {}),
        },
      } as ProviderRuntimeEvent;
    case "approval.requested":
      return {
        ...rawEvent,
        type: "request.opened",
        payload: {
          requestType: mapRequestType(rawEvent.requestKind),
          ...(typeof rawEvent.detail === "string" ? { detail: rawEvent.detail } : {}),
        },
      } as ProviderRuntimeEvent;
    case "approval.resolved":
      return {
        ...rawEvent,
        type: "request.resolved",
        payload: {
          requestType: mapRequestType(rawEvent.requestKind),
          ...(typeof rawEvent.decision === "string" ? { decision: rawEvent.decision } : {}),
        },
      } as ProviderRuntimeEvent;
    default:
      return rawEvent as ProviderRuntimeEvent;
  }
}

export interface TestProviderAdapterHarness {
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly provider: ProviderDriverKind;
  readonly queueTurnResponse: (
    threadId: ThreadId,
    response: TestTurnResponse,
  ) => Effect.Effect<void, ProviderAdapterSessionNotFoundError>;
  readonly queueTurnResponseForNextSession: (
    response: TestTurnResponse,
  ) => Effect.Effect<void, never>;
  readonly getStartCount: () => number;
  readonly getRollbackCalls: (threadId: ThreadId) => ReadonlyArray<number>;
  readonly getInterruptCalls: (threadId: ThreadId) => ReadonlyArray<TurnId | undefined>;
  readonly listActiveSessionIds: () => ReadonlyArray<ThreadId>;
  readonly getApprovalResponses: (threadId: ThreadId) => ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly requestId: ApprovalRequestId;
    readonly decision: ProviderApprovalDecision;
  }>;
}

interface MakeTestProviderAdapterHarnessOptions {
  readonly provider?: ProviderDriverKind;
}

function nowIso(): string {
  return "2026-01-01T00:00:00.000Z";
}

function sessionNotFound(
  provider: ProviderDriverKind,
  threadId: ThreadId,
): ProviderAdapterSessionNotFoundError {
  return new ProviderAdapterSessionNotFoundError({
    provider,
    threadId: String(threadId),
  });
}

function missingSessionEffect(
  provider: ProviderDriverKind,
  threadId: ThreadId,
): Effect.Effect<never, ProviderAdapterError> {
  return Effect.fail(sessionNotFound(provider, threadId));
}

export const makeTestProviderAdapterHarness = (options?: MakeTestProviderAdapterHarnessOptions) =>
  Effect.gen(function* () {
    const provider = options?.provider ?? ProviderDriverKind.make("codex");
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    let sessionCount = 0;
    const sessions = new Map<ThreadId, SessionState>();
    const queuedResponsesForNextSession: TestTurnResponse[] = [];
    const interruptCallsBySession = new Map<ThreadId, Array<TurnId | undefined>>();
    const approvalResponsesBySession = new Map<
      ThreadId,
      Array<{
        readonly threadId: ThreadId;
        readonly requestId: ApprovalRequestId;
        readonly decision: ProviderApprovalDecision;
      }>
    >();

    const emit = (event: ProviderRuntimeEvent) => Queue.offer(runtimeEvents, event);

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== provider) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "startSession",
            issue: `Expected provider '${provider}' but received '${input.provider}'.`,
          });
        }

        sessionCount += 1;
        const threadId = input.threadId;
        const createdAt = nowIso();

        const session: ProviderSession = {
          provider,
          ...(input.providerInstanceId !== undefined
            ? { providerInstanceId: input.providerInstanceId }
            : {}),
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId,
          cwd: input.cwd,
          resumeCursor: input.resumeCursor ?? { threadId: String(threadId), seed: sessionCount },
          createdAt,
          updatedAt: createdAt,
        };

        sessions.set(threadId, {
          session,
          snapshot: {
            threadId,
            turns: [],
          },
          turnCount: 0,
          queuedResponses: queuedResponsesForNextSession.splice(0),
          rollbackCalls: [],
        });

        return session;
      });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const state = sessions.get(input.threadId);
        if (!state) {
          return yield* missingSessionEffect(provider, input.threadId);
        }

        state.turnCount += 1;
        const turnCount = state.turnCount;
        const turnId = TurnId.make(`turn-${turnCount}`);

        const response = state.queuedResponses.shift();
        if (!response) {
          return yield* new ProviderAdapterValidationError({
            provider,
            operation: "sendTurn",
            issue: `No queued turn response for thread ${input.threadId}.`,
          });
        }

        const assistantDeltas: string[] = [];
        const deferredTurnCompletedEvents: ProviderRuntimeEvent[] = [];
        for (const fixtureEvent of response.events) {
          const rawEvent: Record<string, unknown> = {
            ...(fixtureEvent as Record<string, unknown>),
            eventId: yield* Random.nextUUIDv4,
            provider,
            sessionId: RuntimeSessionId.make(String(input.threadId)),
          };
          rawEvent.threadId = state.snapshot.threadId;
          if (Object.hasOwn(rawEvent, "turnId")) {
            rawEvent.turnId = turnId;
          }

          const runtimeEvent = normalizeFixtureEvent(rawEvent);
          const runtimeType = (runtimeEvent as { type: string }).type;
          if (runtimeType === "content.delta") {
            const payload = runtimeEvent.payload as { delta?: unknown } | undefined;
            if (typeof payload?.delta === "string") {
              assistantDeltas.push(payload.delta);
            }
          } else if (runtimeType === "message.delta") {
            const legacyDelta = (runtimeEvent as { delta?: unknown }).delta;
            if (typeof legacyDelta === "string") {
              assistantDeltas.push(legacyDelta);
            }
          }
          if (runtimeEvent.type === "turn.completed") {
            deferredTurnCompletedEvents.push(runtimeEvent);
            continue;
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

        if (deferredTurnCompletedEvents.length === 0) {
          yield* emit({
            type: "turn.completed",
            eventId: EventId.make(yield* Random.nextUUIDv4),
            provider,
            createdAt: nowIso(),
            threadId: state.snapshot.threadId,
            turnId,
            payload: {
              state: "completed",
            },
          });
        } else {
          for (const completedEvent of deferredTurnCompletedEvents) {
            yield* emit(completedEvent);
          }
        }

        return {
          threadId: state.snapshot.threadId,
          turnId,
        } satisfies ProviderTurnStartResult;
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
      threadId,
      turnId,
    ) =>
      sessions.has(threadId)
        ? Effect.sync(() => {
            const existing = interruptCallsBySession.get(threadId) ?? [];
            existing.push(turnId);
            interruptCallsBySession.set(threadId, existing);
          })
        : missingSessionEffect(provider, threadId);

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      sessions.has(threadId)
        ? Effect.sync(() => {
            const existing = approvalResponsesBySession.get(threadId) ?? [];
            existing.push({
              threadId,
              requestId,
              decision,
            });
            approvalResponsesBySession.set(threadId, existing);
          })
        : missingSessionEffect(provider, threadId);

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
      threadId,
      _requestId,
      _answers,
    ) => (sessions.has(threadId) ? Effect.void : missingSessionEffect(provider, threadId));

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      Effect.sync(() => {
        sessions.delete(threadId);
      });

    const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (state) => state.session));

    const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
      Effect.succeed(sessions.has(threadId));

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) => {
      const state = sessions.get(threadId);
      if (!state) {
        return missingSessionEffect(provider, threadId);
      }
      return Effect.succeed(state.snapshot);
    };

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
      numTurns,
    ) => {
      const state = sessions.get(threadId);
      if (!state) {
        return missingSessionEffect(provider, threadId);
      }
      if (!Number.isInteger(numTurns) || numTurns < 0 || numTurns > state.snapshot.turns.length) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider,
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
      streamEvents: Stream.fromQueue(runtimeEvents),
    };

    const queueTurnResponse = (
      threadId: ThreadId,
      response: TestTurnResponse,
    ): Effect.Effect<void, ProviderAdapterSessionNotFoundError> =>
      Effect.sync(() => sessions.get(threadId)).pipe(
        Effect.flatMap((state) =>
          state
            ? Effect.sync(() => {
                state.queuedResponses.push(response);
              })
            : Effect.fail(sessionNotFound(provider, threadId)),
        ),
      );

    const queueTurnResponseForNextSession = (
      response: TestTurnResponse,
    ): Effect.Effect<void, never> =>
      Effect.sync(() => {
        queuedResponsesForNextSession.push(response);
      });

    const getRollbackCalls = (threadId: ThreadId): ReadonlyArray<number> => {
      const state = sessions.get(threadId);
      if (!state) {
        return [];
      }
      return [...state.rollbackCalls];
    };

    const getStartCount = (): number => sessionCount;

    const getInterruptCalls = (threadId: ThreadId): ReadonlyArray<TurnId | undefined> => {
      const calls = interruptCallsBySession.get(threadId);
      if (!calls) {
        return [];
      }
      return [...calls];
    };

    const listActiveSessionIds = (): ReadonlyArray<ThreadId> =>
      Array.from(sessions.values(), (state) => state.session.threadId);

    const getApprovalResponses = (
      threadId: ThreadId,
    ): ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly requestId: ApprovalRequestId;
      readonly decision: ProviderApprovalDecision;
    }> => {
      const responses = approvalResponsesBySession.get(threadId);
      if (!responses) {
        return [];
      }
      return [...responses];
    };

    return {
      adapter,
      provider,
      queueTurnResponse,
      queueTurnResponseForNextSession,
      getStartCount,
      getRollbackCalls,
      getInterruptCalls,
      listActiveSessionIds,
      getApprovalResponses,
    } satisfies TestProviderAdapterHarness;
  });
