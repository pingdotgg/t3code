import {
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";
import { Effect, Exit, Fiber, FileSystem, Layer, Queue, Scope, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { OllamaAdapter, type OllamaAdapterShape } from "../Services/OllamaAdapter.ts";
import type {
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import {
  attachmentImagesForOllama,
  postOllamaChat,
  resolveOllamaConnectionForSelection,
  type OllamaChatMessage,
  type OllamaChatResponseChunk,
} from "../ollama/client.ts";

const PROVIDER = "ollama" as const;

interface OllamaResumeCursor {
  readonly connectionId?: string;
  readonly messages?: ReadonlyArray<OllamaChatMessage>;
}

interface OllamaTurnRecord {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

interface OllamaSessionContext {
  session: ProviderSession;
  messages: Array<OllamaChatMessage>;
  turns: Array<OllamaTurnRecord>;
  connectionId: string | undefined;
  threadStarted: boolean;
  activeTurn:
    | {
        readonly turnId: TurnId;
        readonly itemId: RuntimeItemId;
        readonly fiber: Fiber.Fiber<void, unknown>;
        readonly startedAt: string;
      }
    | undefined;
  stopped: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function requireSession(
  sessions: Map<ThreadId, OllamaSessionContext>,
  threadId: ThreadId,
): OllamaSessionContext {
  const session = sessions.get(threadId);
  if (!session) {
    throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
  }
  if (session.stopped) {
    throw new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
  }
  return session;
}

function parseResumeCursor(value: unknown): OllamaResumeCursor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const cursor = value as { connectionId?: unknown; messages?: unknown };
  return {
    ...(typeof cursor.connectionId === "string" ? { connectionId: cursor.connectionId } : {}),
    ...(Array.isArray(cursor.messages)
      ? {
          messages: cursor.messages.filter(
            (entry): entry is OllamaChatMessage =>
              typeof entry === "object" &&
              entry !== null &&
              "role" in entry &&
              "content" in entry &&
              typeof (entry as { role?: unknown }).role === "string" &&
              typeof (entry as { content?: unknown }).content === "string",
          ),
        }
      : {}),
  };
}

function toResumeCursor(context: OllamaSessionContext): OllamaResumeCursor {
  return {
    ...(context.connectionId ? { connectionId: context.connectionId } : {}),
    messages: context.messages,
  };
}

async function readNdjsonStream(
  response: Response,
  onChunk: (chunk: OllamaChatResponseChunk) => Promise<void>,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      await onChunk(JSON.parse(line) as OllamaChatResponseChunk);
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    await onChunk(JSON.parse(trailing) as OllamaChatResponseChunk);
  }
}

const makeOllamaAdapter = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const adapterScope = yield* Effect.acquireRelease(Scope.make("sequential"), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, OllamaSessionContext>();

  const loadSettings = (operation: string) =>
    serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation,
            issue: "Failed to load server settings.",
            cause,
          }),
      ),
    );

  const offerEvent = (event: ProviderRuntimeEvent) => Queue.offer(runtimeEventQueue, event);

  const emitBase = (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId;
    readonly itemId?: RuntimeItemId;
    readonly payload: ProviderRuntimeEvent["payload"];
    readonly type: ProviderRuntimeEvent["type"];
  }) =>
    offerEvent({
      eventId: EventId.make(crypto.randomUUID()),
      provider: PROVIDER,
      threadId: input.threadId,
      createdAt: nowIso(),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
      type: input.type,
      payload: input.payload as never,
    } as ProviderRuntimeEvent);

  const startSession: OllamaAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const settings = yield* loadSettings("startSession");
      const resume = parseResumeCursor(input.resumeCursor);
      const selectedConnection = resolveOllamaConnectionForSelection({
        settings,
        ...(input.modelSelection?.provider === PROVIDER && input.modelSelection.options
          ? { modelOptions: input.modelSelection.options }
          : {}),
        ...(resume?.connectionId ? { resumeConnectionId: resume.connectionId } : {}),
      });
      if (!selectedConnection) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "No Ollama connection is configured.",
        });
      }

      const existing = sessions.get(input.threadId);
      if (existing?.activeTurn) {
        yield* Fiber.interrupt(existing.activeTurn.fiber);
      }

      const createdAt = nowIso();
      const session: ProviderSession = {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        model:
          input.modelSelection?.provider === PROVIDER
            ? input.modelSelection.model
            : DEFAULT_MODEL_BY_PROVIDER.ollama,
        threadId: input.threadId,
        resumeCursor: {
          ...(selectedConnection.connection.id
            ? { connectionId: selectedConnection.connection.id }
            : {}),
          ...(resume?.messages ? { messages: resume.messages } : {}),
        },
        createdAt,
        updatedAt: createdAt,
      };

      const context: OllamaSessionContext = {
        session,
        messages: [...(resume?.messages ?? [])],
        turns: [],
        connectionId: selectedConnection.connection.id,
        threadStarted: false,
        activeTurn: undefined,
        stopped: false,
      };
      sessions.set(input.threadId, context);

      yield* emitBase({
        threadId: input.threadId,
        type: "session.started",
        payload: {
          message: `Connected to ${selectedConnection.connection.name}`,
          resume: session.resumeCursor,
        },
      });
      yield* emitBase({
        threadId: input.threadId,
        type: "session.state.changed",
        payload: { state: "ready" },
      });
      return session;
    },
  );

  const runTurn = Effect.fn("runTurn")(function* (input: {
    readonly context: OllamaSessionContext;
    readonly turnId: TurnId;
    readonly itemId: RuntimeItemId;
    readonly model: string;
    readonly requestMessages: ReadonlyArray<OllamaChatMessage>;
    readonly connectionId: string;
  }) {
    let assistantText = "";
    const executeTurn = Effect.gen(function* () {
      const settings = yield* loadSettings("sendTurn");
      const connection = resolveOllamaConnectionForSelection({
        settings,
        modelOptions: { connectionId: input.connectionId },
      })?.connection;
      if (!connection) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "chat",
          detail: "The selected Ollama connection is no longer configured.",
        });
      }

      const response = yield* Effect.tryPromise(() =>
        postOllamaChat({
          connection,
          model: input.model,
          messages: input.requestMessages,
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "chat",
              detail: cause instanceof Error ? cause.message : "Ollama request failed.",
              cause,
            }),
        ),
      );

      yield* Effect.tryPromise(() =>
        readNdjsonStream(response, async (chunk) => {
          const delta = chunk.message?.content ?? "";
          if (!delta) return;
          assistantText += delta;
          await Effect.runPromise(
            emitBase({
              threadId: input.context.session.threadId,
              turnId: input.turnId,
              itemId: input.itemId,
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta,
              },
            }),
          );
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "chat.stream",
              detail: cause instanceof Error ? cause.message : "Failed to stream Ollama response.",
              cause,
            }),
        ),
      );

      input.context.messages = [
        ...input.requestMessages,
        {
          role: "assistant",
          content: assistantText,
        },
      ];
      input.context.turns.push({
        id: input.turnId,
        items: input.context.messages,
      });
      const { activeTurnId: _activeTurnId, ...sessionWithoutActiveTurnId } = input.context.session;
      input.context.session = {
        ...sessionWithoutActiveTurnId,
        status: "ready",
        updatedAt: nowIso(),
        resumeCursor: toResumeCursor(input.context),
        model: input.model,
      };
      input.context.activeTurn = undefined;
      yield* emitBase({
        threadId: input.context.session.threadId,
        turnId: input.turnId,
        itemId: input.itemId,
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: assistantText,
        },
      });
      yield* emitBase({
        threadId: input.context.session.threadId,
        turnId: input.turnId,
        type: "turn.completed",
        payload: {
          state: "completed",
          stopReason: "end_of_turn",
        },
      });
      yield* emitBase({
        threadId: input.context.session.threadId,
        type: "session.state.changed",
        payload: { state: "ready" },
      });
    });

    yield* executeTurn.pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const message =
            error instanceof Error ? error.message : "Ollama turn failed unexpectedly.";
          const wasInterrupted = message.toLowerCase().includes("abort");
          const { activeTurnId: _activeTurnId, ...sessionWithoutActiveTurnId } =
            input.context.session;
          input.context.session = {
            ...sessionWithoutActiveTurnId,
            status: "ready",
            updatedAt: nowIso(),
            ...(wasInterrupted ? {} : { lastError: message }),
          };
          input.context.activeTurn = undefined;
          yield* emitBase({
            threadId: input.context.session.threadId,
            turnId: input.turnId,
            itemId: input.itemId,
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: wasInterrupted ? "declined" : "failed",
              ...(assistantText ? { detail: assistantText } : {}),
            },
          });
          yield* emitBase({
            threadId: input.context.session.threadId,
            turnId: input.turnId,
            type: "turn.completed",
            payload: {
              state: wasInterrupted ? "interrupted" : "failed",
              ...(wasInterrupted ? { stopReason: "interrupted" } : {}),
              ...(wasInterrupted ? {} : { errorMessage: message }),
            },
          });
          if (!wasInterrupted) {
            yield* emitBase({
              threadId: input.context.session.threadId,
              turnId: input.turnId,
              type: "runtime.error",
              payload: {
                message,
                class: "provider_error",
              },
            });
          }
          return yield* emitBase({
            threadId: input.context.session.threadId,
            type: "session.state.changed",
            payload: { state: "ready" },
          });
        }),
      ),
    );
  });

  const sendTurn: OllamaAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: `Expected provider '${PROVIDER}' but received '${input.modelSelection.provider}'.`,
      });
    }

    const context = requireSession(sessions, input.threadId);
    if (context.activeTurn) {
      yield* Fiber.interrupt(context.activeTurn.fiber);
    }

    const settings = yield* loadSettings("sendTurn");
    const selectedConnection = resolveOllamaConnectionForSelection({
      settings,
      ...(input.modelSelection?.provider === PROVIDER && input.modelSelection.options
        ? { modelOptions: input.modelSelection.options }
        : {}),
      ...(context.connectionId ? { resumeConnectionId: context.connectionId } : {}),
    });
    if (!selectedConnection) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "No Ollama connection is configured.",
      });
    }

    const model =
      input.modelSelection?.model ?? context.session.model ?? DEFAULT_MODEL_BY_PROVIDER.ollama;
    const turnId = TurnId.make(crypto.randomUUID());
    const itemId = RuntimeItemId.make(crypto.randomUUID());
    const userImages = yield* attachmentImagesForOllama({
      attachmentsDir: serverConfig.attachmentsDir,
      attachments: input.attachments ?? [],
    }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
    const userMessage: OllamaChatMessage = {
      role: "user",
      content: input.input ?? "",
      ...(userImages.length > 0 ? { images: userImages } : {}),
    };
    const requestMessages = [...context.messages, userMessage];

    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt: nowIso(),
      model,
      resumeCursor: {
        connectionId: selectedConnection.connection.id,
        messages: requestMessages,
      },
    };
    context.connectionId = selectedConnection.connection.id;

    if (!context.threadStarted) {
      yield* emitBase({
        threadId: input.threadId,
        type: "thread.started",
        payload: {
          providerThreadId: input.threadId,
        },
      });
      context.threadStarted = true;
    }
    yield* emitBase({
      threadId: input.threadId,
      type: "session.state.changed",
      payload: { state: "running" },
    });
    yield* emitBase({
      threadId: input.threadId,
      turnId,
      type: "turn.started",
      payload: {
        model,
      },
    });

    const fiber = yield* runTurn({
      context,
      turnId,
      itemId,
      model,
      requestMessages,
      connectionId: selectedConnection.connection.id,
    }).pipe(Effect.forkIn(adapterScope));
    context.activeTurn = {
      turnId,
      itemId,
      fiber,
      startedAt: nowIso(),
    };

    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: {
        connectionId: selectedConnection.connection.id,
        messages: requestMessages,
      },
    } satisfies ProviderTurnStartResult;
  });

  const interruptTurn: OllamaAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId) {
      const context = requireSession(sessions, threadId);
      if (context.activeTurn) {
        yield* Fiber.interrupt(context.activeTurn.fiber);
      }
    },
  );

  const respondToRequest: OllamaAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId) {
      requireSession(sessions, threadId);
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToRequest",
        detail: "Ollama sessions do not issue approval requests.",
      });
    },
  );

  const respondToUserInput: OllamaAdapterShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (threadId) {
    requireSession(sessions, threadId);
    return yield* new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "respondToUserInput",
      detail: "Ollama sessions do not issue structured user-input requests.",
    });
  });

  const stopSession: OllamaAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      const context = requireSession(sessions, threadId);
      context.stopped = true;
      if (context.activeTurn) {
        yield* Fiber.interrupt(context.activeTurn.fiber);
      }
      context.session = {
        ...context.session,
        status: "closed",
        updatedAt: nowIso(),
      };
      yield* emitBase({
        threadId,
        type: "session.exited",
        payload: {
          reason: "session stopped",
          exitKind: "graceful",
        },
      });
      sessions.delete(threadId);
    },
  );

  const listSessions: OllamaAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (entry) => entry.session));

  const hasSession: OllamaAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const readThread: OllamaAdapterShape["readThread"] = (threadId) =>
    Effect.sync(() => {
      const context = requireSession(sessions, threadId);
      return {
        threadId,
        turns: context.turns,
      } satisfies ProviderThreadSnapshot;
    });

  const rollbackThread: OllamaAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.sync(() => {
      const context = requireSession(sessions, threadId);
      if (numTurns > 0) {
        context.turns.splice(Math.max(0, context.turns.length - numTurns), numTurns);
      }
      const lastTurn = context.turns.at(-1);
      context.messages = Array.isArray(lastTurn?.items)
        ? (lastTurn.items as Array<OllamaChatMessage>)
        : [];
      context.session = {
        ...context.session,
        resumeCursor: toResumeCursor(context),
        updatedAt: nowIso(),
      };
      return {
        threadId,
        turns: context.turns as ReadonlyArray<ProviderThreadTurnSnapshot>,
      } satisfies ProviderThreadSnapshot;
    });

  const stopAll: OllamaAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.keys()), (threadId) => stopSession(threadId), {
      discard: true,
    });

  yield* Effect.addFinalizer(() =>
    stopAll().pipe(Effect.orDie, Effect.andThen(Queue.shutdown(runtimeEventQueue))),
  );

  return {
    provider: PROVIDER,
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
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies OllamaAdapterShape;
});

export const OllamaAdapterLive = Layer.effect(OllamaAdapter, makeOllamaAdapter);

export function makeOllamaAdapterLive() {
  return Layer.effect(OllamaAdapter, makeOllamaAdapter);
}
