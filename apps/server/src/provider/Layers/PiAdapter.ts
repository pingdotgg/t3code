import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import {
  type CanonicalItemType,
  EventId,
  type PiSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { makePiEnvironment } from "../Drivers/PiHome.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";

const PROVIDER = ProviderDriverKind.make("piAgent");

interface PiToolItem {
  readonly id: RuntimeItemId;
  readonly type: CanonicalItemType;
  readonly toolName: string;
  readonly args: unknown;
}

interface PiTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly items: Array<PiToolItem>;
}

interface PiSessionContext {
  session: ProviderSession;
  piSession: AgentSession;
  unsubscribe: (() => void) | undefined;
  streamFiber: Fiber.Fiber<void, never> | undefined;
  readonly startedAt: string;
  turnState: PiTurnState | undefined;
  readonly turns: Array<{ id: TurnId; items: Array<PiToolItem> }>;
  stopped: boolean;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function readPiResumeState(resumeCursor: unknown): { sessionFile: string } | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") return undefined;
  const cursor = resumeCursor as Record<string, unknown>;
  return typeof cursor.sessionFile === "string" && cursor.sessionFile.trim().length > 0
    ? { sessionFile: cursor.sessionFile }
    : undefined;
}

function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("agent") || normalized.includes("subagent")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("shell") ||
    normalized.includes("command") ||
    normalized.includes("exec")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("apply")
  ) {
    return "file_change";
  }
  if (normalized.includes("search") || normalized.includes("web")) {
    return "web_search";
  }
  return "dynamic_tool_call";
}

function summarizePiToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const input = args as Record<string, unknown>;

  const commandValue = input.command ?? input.cmd;
  if (typeof commandValue === "string" && commandValue.trim().length > 0) {
    return commandValue.trim().slice(0, 400);
  }

  const pathValue = input.file_path ?? input.path ?? input.filePath;
  if (typeof pathValue === "string" && pathValue.trim().length > 0) {
    return pathValue.trim().slice(0, 400);
  }

  try {
    const serialized = JSON.stringify(input);
    if (serialized.length <= 400) return serialized;
    return `${serialized.slice(0, 397)}...`;
  } catch {
    return undefined;
  }
}

export interface PiAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  piSettings: PiSettings,
  options?: PiAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("piAgent");
  const serverConfig = yield* ServerConfig;
  const piEnvironment = yield* makePiEnvironment(piSettings, options?.environment);

  const sessions = new Map<ThreadId, PiSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const completeTurn = Effect.fn("completeTurn")(function* (
    context: PiSessionContext,
    state: ProviderRuntimeTurnStatus,
    message?: string,
  ) {
    const turnState = context.turnState;
    if (!turnState) return;

    context.turnState = undefined;
    context.turns.push({
      id: turnState.turnId,
      items: [...turnState.items],
    });

    const updatedAt = yield* nowIso;
    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt,
    };

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        state,
        ...(message ? { message } : {}),
      },
      providerRefs: {},
    });
  });

  const handlePiEvent = Effect.fn("handlePiEvent")(function* (
    context: PiSessionContext,
    event: AgentSessionEvent,
  ) {
    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
      providerRefs: {},
      raw: {
        source: "pi.sdk.event" as const,
        method: event.type,
        payload: event,
      },
    };

    switch (event.type) {
      case "agent_start":
        yield* offerRuntimeEvent({
          ...base,
          type: "session.state.changed",
          payload: { state: "running" },
        });
        return;

      case "turn_start": {
        if (!context.turnState) {
          const turnId = TurnId.make(yield* Random.nextUUIDv4);
          const startedAt = yield* nowIso;
          context.turnState = { turnId, startedAt, items: [] };
          const updatedAt = yield* nowIso;
          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt,
          };
          yield* offerRuntimeEvent({
            ...base,
            turnId,
            type: "turn.started",
            payload: {},
          });
        }
        return;
      }

      case "message_update": {
        if (!context.turnState) return;
        const assistantEvent = event.assistantMessageEvent;
        if (!assistantEvent) return;
        if (assistantEvent.type === "text_delta") {
          yield* offerRuntimeEvent({
            ...base,
            turnId: context.turnState.turnId,
            type: "content.delta",
            payload: {
              streamKind: "assistant_text",
              delta: assistantEvent.delta,
            },
          });
        } else if (assistantEvent.type === "thinking_delta") {
          yield* offerRuntimeEvent({
            ...base,
            turnId: context.turnState.turnId,
            type: "content.delta",
            payload: {
              streamKind: "reasoning_text",
              delta: assistantEvent.delta,
            },
          });
        }
        return;
      }

      case "tool_execution_start": {
        if (!context.turnState) return;
        const itemId = RuntimeItemId.make(event.toolCallId);
        const itemType = classifyToolItemType(event.toolName);
        const detail = summarizePiToolArgs(event.args);
        const argsObj =
          event.args && typeof event.args === "object"
            ? (event.args as Record<string, unknown>)
            : undefined;
        context.turnState.items.push({
          id: itemId,
          type: itemType,
          toolName: event.toolName,
          args: event.args,
        });
        yield* offerRuntimeEvent({
          ...base,
          turnId: context.turnState.turnId,
          itemId,
          type: "item.started",
          payload: {
            itemType,
            title: event.toolName,
            ...(detail ? { detail } : {}),
            ...(argsObj ? { data: { toolName: event.toolName, input: argsObj } } : {}),
          },
        });
        return;
      }

      case "tool_execution_update": {
        if (!context.turnState) return;
        const itemId = RuntimeItemId.make(event.toolCallId);
        const itemType = classifyToolItemType(event.toolName);
        if (event.partialResult !== undefined) {
          const partial =
            typeof event.partialResult === "string"
              ? event.partialResult
              : String(event.partialResult);
          yield* offerRuntimeEvent({
            ...base,
            turnId: context.turnState.turnId,
            itemId,
            type: "content.delta",
            payload: {
              streamKind:
                itemType === "command_execution" ? "command_output" : "file_change_output",
              delta: partial,
            },
          });
        }
        return;
      }

      case "tool_execution_end": {
        if (!context.turnState) return;
        const itemId = RuntimeItemId.make(event.toolCallId);
        const itemType = classifyToolItemType(event.toolName);
        const storedItem = context.turnState.items.find((item) => item.id === itemId);
        const args = storedItem?.args;
        const detail = summarizePiToolArgs(args);
        const argsObj =
          args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;
        yield* offerRuntimeEvent({
          ...base,
          turnId: context.turnState.turnId,
          itemId,
          type: "item.completed",
          payload: {
            itemType,
            title: event.toolName,
            status: event.isError ? "failed" : "completed",
            ...(detail ? { detail } : {}),
            ...(argsObj ? { data: { toolName: event.toolName, input: argsObj } } : {}),
          },
        });
        return;
      }

      case "turn_end": {
        // Pi fires turn_end after each internal LLM call, but agent_end fires
        // after the full agent run. Completing here would fragment the Pi run
        // into multiple t3code turns, causing tool activities to disappear and
        // the timer to reset on every sub-turn. Let agent_end drive completion.
        return;
      }

      case "agent_end": {
        if (context.turnState) {
          yield* completeTurn(context, event.willRetry ? "interrupted" : "completed");
        }
        return;
      }

      case "compaction_start": {
        yield* offerRuntimeEvent({
          ...base,
          type: "session.state.changed",
          payload: { state: "waiting", reason: `compaction:${event.reason}` },
        });
        return;
      }

      case "compaction_end": {
        yield* offerRuntimeEvent({
          ...base,
          type: "thread.state.changed",
          payload: { state: "compacted" },
        });
        return;
      }

      default:
        return;
    }
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    context: PiSessionContext,
    options?: { readonly emitExitEvent?: boolean },
  ) {
    if (context.stopped) return;
    context.stopped = true;

    if (context.turnState) {
      yield* completeTurn(context, "interrupted", "Session stopped.");
    }

    if (context.unsubscribe) {
      context.unsubscribe();
      context.unsubscribe = undefined;
    }

    yield* Effect.sync(() => {
      try {
        context.piSession.dispose();
      } catch {
        /* best-effort cleanup */
      }
    });

    const updatedAt = yield* nowIso;
    context.session = {
      ...context.session,
      status: "closed",
      activeTurnId: undefined,
      updatedAt,
    };

    if (options?.emitExitEvent !== false) {
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.exited",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          reason: "Session stopped",
          exitKind: "graceful",
        },
        providerRefs: {},
      });
    }

    sessions.delete(context.session.threadId);
  });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<PiSessionContext, ProviderAdapterError> => {
    const context = sessions.get(threadId);
    if (!context) {
      return Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    if (context.stopped || context.session.status === "closed") {
      return Effect.fail(
        new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    return Effect.succeed(context);
  };

  const startSession: PiAdapterShape["startSession"] = Effect.fn("startSession")(function* (input) {
    if (input.provider !== undefined && input.provider !== PROVIDER) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
      });
    }

    const existingContext = sessions.get(input.threadId);
    if (existingContext) {
      yield* stopSessionInternal(existingContext, { emitExitEvent: false }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pi.session.replace.stop-failed", {
            threadId: input.threadId,
            cause,
          }),
        ),
      );
    }

    const startedAt = yield* nowIso;
    const threadId = input.threadId;
    const modelSelection =
      input.modelSelection !== undefined && input.modelSelection.instanceId === boundInstanceId
        ? input.modelSelection
        : undefined;

    const runtimeContext = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(runtimeContext);

    const piResumeState = readPiResumeState(input.resumeCursor);
    const baseCwd = input.cwd ?? serverConfig.cwd;

    const piSession = yield* Effect.tryPromise({
      try: async () => {
        if (piResumeState) {
          try {
            const sessionManager = SessionManager.open(piResumeState.sessionFile);
            const result = await createAgentSession({ cwd: baseCwd, sessionManager });
            return result.session;
          } catch {
            // Session file inaccessible; fall through to a fresh session.
          }
        }
        const result = await createAgentSession({ cwd: baseCwd });
        return result.session;
      },
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId,
          detail: toMessage(cause, "Failed to start Pi Agent session."),
          cause,
        }),
    });

    const piSessionFile = piSession.sessionFile;

    const session: ProviderSession = {
      threadId,
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      status: "ready",
      runtimeMode: input.runtimeMode,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(modelSelection?.model ? { model: modelSelection.model } : {}),
      ...(piSessionFile !== undefined ? { resumeCursor: { sessionFile: piSessionFile } } : {}),
      createdAt: startedAt,
      updatedAt: startedAt,
    };

    const context: PiSessionContext = {
      session,
      piSession,
      unsubscribe: undefined,
      streamFiber: undefined,
      startedAt,
      turnState: undefined,
      turns: [],
      stopped: false,
    };
    sessions.set(threadId, context);

    const unsubscribe = piSession.subscribe((event: AgentSessionEvent) => {
      if (context.stopped) return;
      runFork(handlePiEvent(context, event));
    });
    context.unsubscribe = unsubscribe;

    const sessionStartedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "session.started",
      eventId: sessionStartedStamp.eventId,
      provider: PROVIDER,
      createdAt: sessionStartedStamp.createdAt,
      threadId,
      payload: {},
      providerRefs: {},
    });

    const configuredStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "session.configured",
      eventId: configuredStamp.eventId,
      provider: PROVIDER,
      createdAt: configuredStamp.createdAt,
      threadId,
      payload: {
        config: {
          ...(modelSelection?.model ? { model: modelSelection.model } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
        },
      },
      providerRefs: {},
    });

    const readyStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "session.state.changed",
      eventId: readyStamp.eventId,
      provider: PROVIDER,
      createdAt: readyStamp.createdAt,
      threadId,
      payload: { state: "ready" },
      providerRefs: {},
    });

    return { ...session };
  });

  const sendTurn: PiAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);

    if (context.turnState) {
      yield* completeTurn(context, "completed");
    }

    const turnId = TurnId.make(yield* Random.nextUUIDv4);
    const turnStartedAt = yield* nowIso;
    context.turnState = { turnId, startedAt: turnStartedAt, items: [] };
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt: turnStartedAt,
    };

    const turnStartedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.started",
      eventId: turnStartedStamp.eventId,
      provider: PROVIDER,
      createdAt: turnStartedStamp.createdAt,
      threadId: context.session.threadId,
      turnId,
      payload: {},
      providerRefs: {},
    });

    const promptText = typeof input.input === "string" ? input.input : "";

    const runtimeContext = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(runtimeContext);
    runFork(
      Effect.tryPromise({
        try: () => context.piSession.prompt(promptText),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/prompt",
            detail: toMessage(cause, "Failed to send prompt to Pi Agent."),
          }),
      }).pipe(Effect.catch(() => completeTurn(context, "failed", "Prompt failed."))),
    );

    return {
      threadId: context.session.threadId,
      turnId,
    };
  });

  const interruptTurn: PiAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId, _turnId) {
      const context = yield* requireSession(threadId);
      yield* Effect.tryPromise({
        try: () => context.piSession.abort(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/interrupt",
            detail: toMessage(cause, "Failed to interrupt Pi Agent turn."),
          }),
      });
    },
  );

  const readThread: PiAdapterShape["readThread"] = Effect.fn("readThread")(function* (threadId) {
    const context = yield* requireSession(threadId);
    return {
      threadId,
      turns: context.turns.map((turn) => ({
        id: turn.id,
        items: [...turn.items],
      })),
    };
  });

  const rollbackThread: PiAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns) {
      const context = yield* requireSession(threadId);
      const nextLength = Math.max(0, context.turns.length - numTurns);
      context.turns.splice(nextLength);
      return {
        threadId,
        turns: context.turns.map((turn) => ({
          id: turn.id,
          items: [...turn.items],
        })),
      };
    },
  );

  const respondToRequest: PiAdapterShape["respondToRequest"] = (_threadId, _requestId, _decision) =>
    Effect.void;

  const respondToUserInput: PiAdapterShape["respondToUserInput"] = (
    _threadId,
    _requestId,
    _answers,
  ) => Effect.void;

  const stopSession: PiAdapterShape["stopSession"] = Effect.fn("stopSession")(function* (threadId) {
    const context = yield* requireSession(threadId);
    yield* stopSessionInternal(context, { emitExitEvent: true });
  });

  const listSessions: PiAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopAll: PiAdapterShape["stopAll"] = () =>
    Effect.forEach(
      sessions,
      ([, context]) => stopSessionInternal(context, { emitExitEvent: true }),
      { discard: true },
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      sessions,
      ([, context]) => stopSessionInternal(context, { emitExitEvent: false }),
      { discard: true },
    ).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "unsupported" as const,
    },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies PiAdapterShape;
});
