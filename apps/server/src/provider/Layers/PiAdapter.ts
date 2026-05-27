import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ChatAttachment,
  type PiSettings,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";
import { randomUUID } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFile } from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdir, stat } from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { readPiAssistantTextDelta, runPiRpcPrompt, splitPiModelSlug } from "./PiRpc.ts";

const PROVIDER = ProviderDriverKind.make("pi");

type PiAdapterShape = ProviderAdapterShape<
  | ProviderAdapterProcessError
  | ProviderAdapterRequestError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterValidationError
>;

interface PiSessionContext {
  session: ProviderSession;
  readonly sessionPath: string;
  activeAbort: AbortController | null;
  turns: Array<ProviderThreadSnapshot["turns"][number]>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const sanitizePathPart = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, "_");

function makePiArgs(input: {
  readonly sessionPath: string;
  readonly model: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly sessionExists: boolean;
}): ReadonlyArray<string> {
  const args = ["--session", input.sessionPath];
  if (input.sessionExists) args.push("--continue");
  if (input.model) args.push("--model", input.model);
  if (input.thinkingLevel) args.push("--thinking", input.thinkingLevel);
  return args;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  piSettings: PiSettings,
  options: {
    readonly instanceId?: ProviderInstanceId | undefined;
    readonly environment?: NodeJS.ProcessEnv | undefined;
  } = {},
) {
  const serverConfig = yield* ServerConfig;
  const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("pi");
  const environment = options.environment ?? process.env;
  const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, PiSessionContext>();

  const emit = (event: ProviderRuntimeEvent) =>
    Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

  const eventBase = (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId | undefined;
    readonly itemId?: string | undefined;
  }) =>
    Effect.gen(function* () {
      const uuid = yield* Random.nextUUIDv4;
      const createdAt = yield* nowIso;
      return {
        eventId: EventId.make(uuid),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: input.threadId,
        createdAt,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
      };
    });

  const eventBaseSync = (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
    readonly turnId?: TurnId | undefined;
    readonly itemId?: string | undefined;
  }) => ({
    eventId: EventId.make(randomUUID()),
    provider: PROVIDER,
    providerInstanceId: boundInstanceId,
    threadId: input.threadId,
    createdAt: input.createdAt,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
  });

  const requireSession = (threadId: ThreadId) =>
    Effect.sync(() => sessions.get(threadId)).pipe(
      Effect.flatMap((session) =>
        session
          ? Effect.succeed(session)
          : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId })),
      ),
    );

  const updateSession = (context: PiSessionContext, patch: Partial<ProviderSession>) =>
    Effect.gen(function* () {
      const updatedAt = yield* nowIso;
      context.session = {
        ...context.session,
        ...patch,
        updatedAt,
      };
    });

  const resolveAttachment = (attachment: ChatAttachment) =>
    Effect.tryPromise({
      try: async () => {
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          throw new Error(`Invalid attachment id '${attachment.id}'.`);
        }
        const data = await readFile(attachmentPath);
        return {
          type: "image" as const,
          data: data.toString("base64"),
          mimeType: attachment.mimeType,
        };
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "prompt",
          detail: errorDetail(cause),
          cause,
        }),
    });

  const startSession: PiAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }
      const existing = sessions.get(input.threadId);
      if (existing) {
        existing.activeAbort?.abort();
        sessions.delete(input.threadId);
      }

      const createdAt = yield* nowIso;
      const sessionDir = join(serverConfig.stateDir, "providers", "pi", "sessions");
      yield* Effect.tryPromise(() => mkdir(sessionDir, { recursive: true })).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: `Failed to create Pi session directory: ${errorDetail(cause)}`,
              cause,
            }),
        ),
      );
      const sessionPath = join(sessionDir, `${sanitizePathPart(input.threadId)}.json`);
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd: input.cwd ?? serverConfig.cwd,
        ...(input.modelSelection?.instanceId === boundInstanceId
          ? { model: input.modelSelection.model }
          : {}),
        threadId: input.threadId,
        createdAt,
        updatedAt: createdAt,
      };
      sessions.set(input.threadId, {
        session,
        sessionPath,
        activeAbort: null,
        turns: [],
      });

      yield* emit({
        ...(yield* eventBase({ threadId: input.threadId })),
        type: "session.started",
        payload: { message: "Pi session started" },
      });
      yield* emit({
        ...(yield* eventBase({ threadId: input.threadId })),
        type: "thread.started",
        payload: { providerThreadId: sessionPath },
      });

      return session;
    });

  const sendTurn: PiAdapterShape["sendTurn"] = (input: ProviderSendTurnInput) =>
    Effect.gen(function* () {
      const context = yield* requireSession(input.threadId);
      const text = input.input?.trim();
      if (!text && (input.attachments ?? []).length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Pi turns require text input or at least one attachment.",
        });
      }
      if (
        input.modelSelection !== undefined &&
        input.modelSelection.instanceId !== boundInstanceId
      ) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Pi model selection is bound to instance '${input.modelSelection.instanceId}', expected '${boundInstanceId}'.`,
        });
      }

      const turnId = TurnId.make(`pi-turn-${yield* Random.nextUUIDv4}`);
      const itemId = `pi-assistant-${yield* Random.nextUUIDv4}`;
      const abort = new AbortController();
      context.activeAbort = abort;
      const model = input.modelSelection?.model ?? context.session.model;
      const thinkingLevel = getModelSelectionStringOptionValue(
        input.modelSelection,
        "thinkingLevel",
      );
      const parsedModel = splitPiModelSlug(model);
      const modelArg = parsedModel ? `${parsedModel.provider}/${parsedModel.modelId}` : model;
      const sessionExists = yield* Effect.promise(() =>
        stat(context.sessionPath).then(
          () => true,
          () => false,
        ),
      );
      const images = yield* Effect.forEach(input.attachments ?? [], resolveAttachment, {
        concurrency: 1,
      });

      yield* updateSession(context, {
        status: "running",
        activeTurnId: turnId,
        ...(model ? { model } : {}),
      });
      yield* emit({
        ...(yield* eventBase({ threadId: input.threadId, turnId })),
        type: "turn.started",
        payload: {
          ...(model ? { model } : {}),
          ...(thinkingLevel ? { effort: thinkingLevel } : {}),
        },
      });

      let assistantItemStarted = false;
      let streamedAssistantText = "";
      let streamingEmitQueue: Promise<void> = Promise.resolve();
      const streamingCreatedAtFallback = yield* nowIso;
      const runtimeContext = yield* Effect.context<never>();
      const runPromise = Effect.runPromiseWith(runtimeContext);
      const enqueueStreamingEmit = (effect: Effect.Effect<void>) => {
        streamingEmitQueue = streamingEmitQueue
          .then(() => runPromise(effect))
          .catch(() => undefined);
      };

      const result = yield* Effect.tryPromise({
        try: () =>
          runPiRpcPrompt({
            binaryPath: piSettings.binaryPath,
            args: makePiArgs({
              sessionPath: context.sessionPath,
              model: modelArg,
              thinkingLevel,
              sessionExists,
            }),
            cwd: context.session.cwd ?? serverConfig.cwd,
            environment,
            message: text ?? "",
            images,
            timeoutMs: 180_000,
            signal: abort.signal,
            onEvent: (event) => {
              const delta = readPiAssistantTextDelta(event);
              if (delta.length === 0 || abort.signal.aborted) {
                return;
              }
              const eventTimestamp =
                typeof event.timestamp === "string" ? event.timestamp : streamingCreatedAtFallback;
              streamedAssistantText += delta;
              enqueueStreamingEmit(
                Effect.gen(function* () {
                  if (!assistantItemStarted) {
                    assistantItemStarted = true;
                    yield* emit({
                      ...eventBaseSync({
                        threadId: input.threadId,
                        createdAt: eventTimestamp,
                        turnId,
                        itemId,
                      }),
                      type: "item.started",
                      payload: {
                        itemType: "assistant_message",
                        status: "inProgress",
                        title: "Pi response",
                      },
                    });
                  }
                  yield* emit({
                    ...eventBaseSync({
                      threadId: input.threadId,
                      createdAt: eventTimestamp,
                      turnId,
                      itemId,
                    }),
                    type: "content.delta",
                    payload: {
                      streamKind: "assistant_text",
                      delta,
                    },
                  });
                }),
              );
            },
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: errorDetail(cause),
            cause,
          }),
      }).pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            context.activeAbort = null;
            yield* updateSession(context, {
              status: "ready",
              activeTurnId: undefined,
              lastError: error.message,
            });
            yield* emit({
              ...(yield* eventBase({ threadId: input.threadId, turnId })),
              type: "turn.completed",
              payload: {
                state: abort.signal.aborted ? "interrupted" : "failed",
                errorMessage: error.message,
              },
            });
          }),
        ),
      );

      yield* Effect.promise(() => streamingEmitQueue);

      const assistantText = result.text.trim();
      if (assistantText.length > 0) {
        if (!assistantItemStarted) {
          assistantItemStarted = true;
          yield* emit({
            ...(yield* eventBase({ threadId: input.threadId, turnId, itemId })),
            type: "item.started",
            payload: {
              itemType: "assistant_message",
              status: "inProgress",
              title: "Pi response",
            },
          });
          yield* emit({
            ...(yield* eventBase({ threadId: input.threadId, turnId, itemId })),
            type: "content.delta",
            payload: {
              streamKind: "assistant_text",
              delta: assistantText,
            },
          });
        } else if (assistantText.startsWith(streamedAssistantText)) {
          const finalRemainder = assistantText.slice(streamedAssistantText.length);
          if (finalRemainder.length > 0) {
            yield* emit({
              ...(yield* eventBase({ threadId: input.threadId, turnId, itemId })),
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta: finalRemainder,
              },
            });
          }
        }
      }
      if (assistantItemStarted) {
        yield* emit({
          ...(yield* eventBase({ threadId: input.threadId, turnId, itemId })),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Pi response",
          },
        });
      }
      yield* emit({
        ...(yield* eventBase({ threadId: input.threadId, turnId })),
        type: "turn.completed",
        payload: {
          state: "completed",
          stopReason: null,
        },
      });

      context.activeAbort = null;
      context.turns.push({ id: turnId, items: result.events as unknown[] });
      yield* updateSession(context, {
        status: "ready",
        activeTurnId: undefined,
        lastError: undefined,
      });

      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: { sessionPath: context.sessionPath },
      };
    });

  const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      context.activeAbort?.abort();
      context.activeAbort = null;
      yield* updateSession(context, { status: "ready", activeTurnId: undefined });
    });

  const respondToRequest: PiAdapterShape["respondToRequest"] = (threadId, requestId) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToRequest",
        detail: `Pi adapter has no pending approval request '${requestId}' for thread '${threadId}'.`,
      }),
    );

  const respondToUserInput: PiAdapterShape["respondToUserInput"] = (threadId, requestId) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToUserInput",
        detail: `Pi adapter has no pending user-input request '${requestId}' for thread '${threadId}'.`,
      }),
    );

  const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      context.activeAbort?.abort();
      sessions.delete(threadId);
      yield* emit({
        ...(yield* eventBase({ threadId })),
        type: "session.exited",
        payload: {
          reason: "Pi session stopped",
          recoverable: true,
          exitKind: "graceful",
        },
      });
    });

  const listSessions: PiAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => sessions.has(threadId));

  const readThread: PiAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      return {
        threadId,
        turns: [...context.turns],
      };
    });

  const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      if (numTurns > 0) {
        context.turns = context.turns.slice(0, Math.max(0, context.turns.length - numTurns));
      }
      return {
        threadId,
        turns: [...context.turns],
      };
    });

  const stopAll: PiAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.keys()), (threadId) => stopSession(threadId), {
      discard: true,
    });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const context of sessions.values()) {
        context.activeAbort?.abort();
      }
      sessions.clear();
    }).pipe(Effect.andThen(Queue.shutdown(runtimeEvents)), Effect.ignore),
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
      return Stream.fromQueue(runtimeEvents);
    },
  } satisfies PiAdapterShape;
});
