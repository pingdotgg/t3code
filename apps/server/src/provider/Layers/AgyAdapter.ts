/**
 * AgyAdapter — provider adapter for the Google Antigravity CLI (agy).
 *
 * Drives the `agy` CLI in headless streaming JSON mode (`--input-format stream-json --output-format stream-json`)
 * and translates output events into T3 Code provider runtime events.
 *
 * @module AgyAdapter
 */
import {
  type AgySettings,
  type ModelSelection,
  EventId,
  type ProviderInteractionMode,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ProviderTurnStartResult,
  type ThreadId,
  TurnId,
  ProviderDriverKind,
  RuntimeItemId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as ChildProcessSpawnerTypes from "effect/unstable/process/ChildProcessSpawner";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { resolveAgyModelForEffort } from "../AgyModelSelection.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type AgyAdapterShape } from "../Services/AgyAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("agy");
const AGY_RESUME_VERSION = 1 as const;
const AGY_INIT_TIMEOUT_MS = 10_000;

const AgyToolInfo = Schema.Struct({
  name: Schema.optional(Schema.String),
  parameters: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});

const AgyNativeEvent = Schema.Union([
  Schema.Struct({
    event: Schema.Literal("init"),
    conversation_id: Schema.optional(Schema.String),
    init: Schema.optional(Schema.Struct({ conversation_id: Schema.optional(Schema.String) })),
  }),
  Schema.Struct({
    event: Schema.Literal("step_update"),
    step_update: Schema.Struct({
      step_index: Schema.optional(Schema.Number),
      state: Schema.optional(Schema.String),
      step_type: Schema.optional(Schema.String),
      text_delta: Schema.optional(Schema.String),
      tool_name: Schema.optional(Schema.String),
      tool_info: Schema.optional(AgyToolInfo),
      output: Schema.optional(Schema.Unknown),
      error: Schema.optional(Schema.Unknown),
    }),
  }),
  Schema.Struct({
    event: Schema.Literal("result"),
    result: Schema.optional(
      Schema.Struct({
        status: Schema.optional(Schema.String),
        error: Schema.optional(Schema.String),
        usage: Schema.optional(
          Schema.Struct({
            input_tokens: Schema.optional(Schema.Number),
            output_tokens: Schema.optional(Schema.Number),
            total_tokens: Schema.optional(Schema.Number),
          }),
        ),
      }),
    ),
  }),
]);

const AgyUserMessage = Schema.Struct({
  event: Schema.Literal("user"),
  message: Schema.Struct({ content: Schema.String }),
});

const decodeAgyNativeEventExit = Schema.decodeUnknownExit(Schema.fromJsonString(AgyNativeEvent));
const encodeAgyUserMessage = Schema.encodeEffect(Schema.fromJsonString(AgyUserMessage));
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

function encodeJsonForDisplay(value: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(value);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface AgyAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

interface EventBaseInput {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: RuntimeItemId | undefined;
  readonly createdAt?: string | undefined;
}

interface AgyTurnState {
  readonly turnId: TurnId;
  readonly items: Array<unknown>;
  assistantItemId: RuntimeItemId | undefined;
  toolItemIds: Map<number, RuntimeItemId>;
}

interface AgySessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  cwd: string;
  conversationId: string | undefined;
  readonly conversationReady: Deferred.Deferred<string>;
  activeTurnId: TurnId | undefined;
  currentTurnState: AgyTurnState | undefined;
  childProcess: ChildProcessSpawnerTypes.ChildProcessHandle | undefined;
  stdinQueue: Queue.Queue<Uint8Array> | undefined;
  stdinFiber: Fiber.Fiber<void, never> | undefined;
  readFiber: Fiber.Fiber<void, never> | undefined;
  readonly scope: Scope.Closeable;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  threadStarted: boolean;
  stopped: boolean;
  modelSelection: ModelSelection | undefined;
  interactionMode: ProviderInteractionMode;
}

function parseAgyResume(raw: unknown): { conversationId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== AGY_RESUME_VERSION) return undefined;
  if (typeof record.conversationId !== "string" || !record.conversationId.trim()) return undefined;
  return { conversationId: record.conversationId.trim() };
}

export const makeAgyAdapter = Effect.fn("makeAgyAdapter")(function* (
  agySettings: AgySettings,
  options?: AgyAdapterLiveOptions,
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("agy");
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, AgySessionContext>();
  const environment = options?.environment ?? process.env;
  const nativeLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
      : undefined);
  const managedNativeLogger = options?.nativeEventLogger === undefined ? nativeLogger : undefined;

  const randomUUIDv4 = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

  const buildEventBase = (input: EventBaseInput) =>
    Effect.gen(function* () {
      const eventId = EventId.make(yield* randomUUIDv4);
      const createdAt = input.createdAt ?? (yield* nowIso);
      return {
        eventId,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        createdAt,
        threadId: input.threadId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.itemId ? { itemId: input.itemId } : {}),
      };
    });

  const ensureSessionContext = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const context = sessions.get(threadId);
      if (!context || context.stopped) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      return context;
    });

  const stopChildProcess = (context: AgySessionContext) =>
    Effect.gen(function* () {
      if (context.stdinQueue) {
        yield* Queue.shutdown(context.stdinQueue);
        context.stdinQueue = undefined;
      }
      if (context.stdinFiber) {
        yield* Fiber.interrupt(context.stdinFiber);
        context.stdinFiber = undefined;
      }
      if (context.readFiber) {
        yield* Fiber.interrupt(context.readFiber);
        context.readFiber = undefined;
      }
      if (context.childProcess) {
        const childProcess = context.childProcess;
        context.childProcess = undefined;
        yield* childProcess.kill().pipe(Effect.ignore);
      }
    });

  const handleNdjsonLine = (context: AgySessionContext, line: string) =>
    Effect.gen(function* () {
      const trimmed = line.trim();
      if (!trimmed) return;

      const decoded = decodeAgyNativeEventExit(trimmed);
      if (!Exit.isSuccess(decoded)) {
        yield* Effect.logWarning("Ignoring malformed Antigravity event.", {
          threadId: context.threadId,
        });
        return;
      }
      const parsed = decoded.value;
      if (nativeLogger) {
        yield* nativeLogger.write(parsed, context.threadId);
      }
      const eventType = parsed.event;

      if (eventType === "init") {
        const conversationId = parsed.conversation_id ?? parsed.init?.conversation_id;
        if (typeof conversationId === "string" && conversationId.trim()) {
          context.conversationId = conversationId.trim();
          context.session = {
            ...context.session,
            resumeCursor: {
              schemaVersion: AGY_RESUME_VERSION,
              conversationId: context.conversationId,
            },
            updatedAt: yield* nowIso,
          };
          yield* Deferred.succeed(context.conversationReady, context.conversationId);
          if (!context.threadStarted) {
            context.threadStarted = true;
            yield* emit({
              ...(yield* buildEventBase({ threadId: context.threadId })),
              type: "thread.started",
              payload: { providerThreadId: context.conversationId },
            });
          }
        }
        return;
      }

      if (eventType === "step_update") {
        const stepUpdate = parsed.step_update;
        if (!stepUpdate) return;

        const turnId = context.activeTurnId;
        if (!turnId) return;
        context.currentTurnState?.items.push(parsed);

        const stepType = stepUpdate.step_type;
        const stepState = stepUpdate.state; // "ACTIVE" | "DONE"
        const stepIndex = typeof stepUpdate.step_index === "number" ? stepUpdate.step_index : 0;

        if (stepType === "agent_response") {
          const textDelta = stepUpdate.text_delta;
          if (typeof textDelta === "string" && textDelta.length > 0) {
            if (!context.currentTurnState?.assistantItemId) {
              const assistantItemId = RuntimeItemId.make(yield* randomUUIDv4);
              if (context.currentTurnState) {
                context.currentTurnState.assistantItemId = assistantItemId;
              }
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.threadId,
                  turnId,
                  itemId: assistantItemId,
                })),
                type: "item.started",
                payload: {
                  itemType: "assistant_message",
                  status: "inProgress",
                },
              });
            }

            const itemId = context.currentTurnState?.assistantItemId;
            if (itemId) {
              yield* emit({
                ...(yield* buildEventBase({ threadId: context.threadId, turnId, itemId })),
                type: "content.delta",
                payload: {
                  streamKind: "assistant_text",
                  delta: textDelta,
                },
              });
            }
          }

          if (stepState === "DONE" && context.currentTurnState?.assistantItemId) {
            const itemId = context.currentTurnState.assistantItemId;
            yield* emit({
              ...(yield* buildEventBase({ threadId: context.threadId, turnId, itemId })),
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
              },
            });
            context.currentTurnState.assistantItemId = undefined;
          }
          return;
        }

        if (stepType === "tool") {
          const toolName = stepUpdate.tool_name ?? stepUpdate.tool_info?.name ?? "tool";
          const canonicalItemType =
            toolName === "run_command"
              ? "command_execution"
              : toolName === "write_to_file" ||
                  toolName === "replace_file_content" ||
                  toolName === "multi_replace_file_content"
                ? "file_change"
                : "dynamic_tool_call";
          let toolItemId = context.currentTurnState?.toolItemIds.get(stepIndex);

          if (stepState === "ACTIVE" && !toolItemId) {
            toolItemId = RuntimeItemId.make(yield* randomUUIDv4);
            context.currentTurnState?.toolItemIds.set(stepIndex, toolItemId);

            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.threadId,
                turnId,
                itemId: toolItemId,
              })),
              type: "item.started",
              payload: {
                itemType: canonicalItemType,
                status: "inProgress",
                title: toolName,
                data: stepUpdate.tool_info?.parameters,
              },
            });
          }

          if (stepState === "DONE") {
            if (!toolItemId) {
              toolItemId = RuntimeItemId.make(yield* randomUUIDv4);
              context.currentTurnState?.toolItemIds.set(stepIndex, toolItemId);
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.threadId,
                  turnId,
                  itemId: toolItemId,
                })),
                type: "item.started",
                payload: {
                  itemType: canonicalItemType,
                  status: "inProgress",
                  title: toolName,
                },
              });
            }

            const output = stepUpdate.output ?? stepUpdate.tool_info?.output;
            const error = stepUpdate.error ?? stepUpdate.tool_info?.error;

            if (output !== undefined) {
              const delta = typeof output === "string" ? output : encodeJsonForDisplay(output);
              if (delta !== undefined) {
                yield* emit({
                  ...(yield* buildEventBase({
                    threadId: context.threadId,
                    turnId,
                    itemId: toolItemId,
                  })),
                  type: "content.delta",
                  payload: {
                    streamKind:
                      canonicalItemType === "command_execution"
                        ? "command_output"
                        : canonicalItemType === "file_change"
                          ? "file_change_output"
                          : "unknown",
                    delta,
                  },
                });
              }
            }

            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.threadId,
                turnId,
                itemId: toolItemId,
              })),
              type: "item.completed",
              payload: {
                itemType: canonicalItemType,
                status: error ? "failed" : "completed",
                ...(error
                  ? {
                      detail:
                        typeof error === "string"
                          ? error
                          : (encodeJsonForDisplay(error) ?? "Antigravity tool failed."),
                    }
                  : {}),
              },
            });
            context.currentTurnState?.toolItemIds.delete(stepIndex);
          }
          return;
        }

        return;
      }

      if (eventType === "result") {
        const result = parsed.result;
        const turnId = context.activeTurnId;
        if (!turnId) return;
        context.currentTurnState?.items.push(parsed);

        const status = result?.status;
        const state =
          status === "SUCCESS"
            ? "completed"
            : status === "CANCELED"
              ? "cancelled"
              : status === "INTERRUPTED"
                ? "interrupted"
                : "failed";

        yield* emit({
          ...(yield* buildEventBase({ threadId: context.threadId, turnId })),
          type: "turn.completed",
          payload: {
            state,
            ...(state === "failed"
              ? {
                  errorMessage:
                    result?.error ?? `Antigravity turn ended with status ${status ?? "UNKNOWN"}.`,
                }
              : {}),
            usage: {
              inputTokens: result?.usage?.input_tokens ?? 0,
              outputTokens: result?.usage?.output_tokens ?? 0,
              totalTokens: result?.usage?.total_tokens ?? 0,
            },
          },
        });

        context.activeTurnId = undefined;
        context.currentTurnState = undefined;
        context.session = {
          ...context.session,
          status: state === "failed" ? "error" : "ready",
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
          ...(state === "failed"
            ? {
                lastError:
                  result?.error ?? `Antigravity turn ended with status ${status ?? "UNKNOWN"}.`,
              }
            : {}),
        };

        yield* emit({
          ...(yield* buildEventBase({ threadId: context.threadId })),
          type: "session.state.changed",
          payload: {
            state: state === "failed" ? "error" : "ready",
            ...(state === "failed"
              ? {
                  reason:
                    result?.error ?? `Antigravity turn ended with status ${status ?? "UNKNOWN"}.`,
                }
              : {}),
          },
        });
      }
    });

  const spawnAgyProcess = (
    context: AgySessionContext,
    modelSelection: ModelSelection | undefined,
    interactionMode: ProviderInteractionMode | undefined,
  ) =>
    Effect.gen(function* () {
      yield* stopChildProcess(context);

      const commandName = agySettings.binaryPath || "agy";
      const effort = modelSelection
        ? getModelSelectionStringOptionValue(modelSelection, "reasoningEffort")
        : undefined;
      const model = resolveAgyModelForEffort(modelSelection?.model, effort);
      const mode = interactionMode === "plan" ? "plan" : "accept-edits";

      const args = [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        ...(context.session.runtimeMode === "full-access"
          ? ["--dangerously-skip-permissions"]
          : ["--sandbox"]),
        ...(context.conversationId ? ["--conversation", context.conversationId] : []),
        ...(model ? ["--model", model] : []),
        ...(effort ? ["--effort", effort] : []),
        "--mode",
        mode,
        ...tokenizeCliArgs(agySettings.launchArgs),
      ];

      const spawnCommand = yield* resolveSpawnCommand(commandName, args, {
        env: environment,
      });

      const childCommand = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        cwd: context.cwd,
        shell: spawnCommand.shell,
      });

      const spawned = yield* childProcessSpawner.spawn(childCommand).pipe(
        Effect.provideService(Scope.Scope, context.scope),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: context.threadId,
              detail: `Failed to spawn Antigravity CLI (${commandName})`,
              cause,
            }),
        ),
      );

      context.childProcess = spawned;
      const stdinQueue = yield* Queue.unbounded<Uint8Array>();
      const stdinFiber = yield* Stream.fromQueue(stdinQueue).pipe(
        Stream.run(spawned.stdin),
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write to Antigravity stdin stream.", {
            threadId: context.threadId,
            cause,
          }),
        ),
        Effect.forkIn(context.scope),
      );
      context.stdinQueue = stdinQueue;
      context.stdinFiber = stdinFiber;

      const readFiber = yield* spawned.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => handleNdjsonLine(context, line)),
        Effect.catchCause((cause) =>
          Effect.logWarning("Error in Antigravity stdout stream", {
            threadId: context.threadId,
            cause,
          }),
        ),
        Effect.forkIn(context.scope),
      );

      context.readFiber = readFiber;

      yield* spawned.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((message) =>
          message.trim().length > 0
            ? Effect.logWarning("Antigravity CLI stderr", {
                threadId: context.threadId,
                message: message.trim(),
              })
            : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to read Antigravity stderr stream.", {
            threadId: context.threadId,
            cause,
          }),
        ),
        Effect.forkIn(context.scope),
      );

      yield* spawned.exitCode.pipe(
        Effect.andThen(Fiber.join(readFiber)),
        Effect.flatMap(() =>
          Effect.gen(function* () {
            if (context.childProcess !== spawned || context.stopped) {
              return;
            }

            context.childProcess = undefined;
            context.readFiber = undefined;
            const activeTurnId = context.activeTurnId;
            if (!activeTurnId) {
              return;
            }
            context.activeTurnId = undefined;
            context.currentTurnState = undefined;
            context.session = {
              ...context.session,
              status: "error",
              activeTurnId: undefined,
              updatedAt: yield* nowIso,
              lastError: "Antigravity CLI exited before the turn completed.",
            };

            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.threadId,
                turnId: activeTurnId,
              })),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: "Antigravity CLI exited before the turn completed.",
              },
            });
            yield* emit({
              ...(yield* buildEventBase({ threadId: context.threadId })),
              type: "session.state.changed",
              payload: {
                state: "error",
                reason: "Antigravity CLI exited before the turn completed.",
              },
            });
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to monitor Antigravity process exit.", {
            threadId: context.threadId,
            cause,
          }),
        ),
        Effect.forkIn(context.scope),
      );
    });

  const startSession: AgyAdapterShape["startSession"] = Effect.fn("startSession")(function* (
    input: ProviderSessionStartInput,
  ) {
    if (input.provider !== undefined && input.provider !== PROVIDER) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
      });
    }

    const existing = sessions.get(input.threadId);
    if (existing) {
      existing.stopped = true;
      yield* stopChildProcess(existing);
      yield* Scope.close(existing.scope, Exit.void);
      sessions.delete(input.threadId);
    }

    const startedAt = yield* nowIso;
    const scope = yield* Scope.make();
    const conversationReady = yield* Deferred.make<string>();
    const resumeInfo = parseAgyResume(input.resumeCursor);
    const conversationId = resumeInfo?.conversationId;
    const modelSelection =
      input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
    if (conversationId !== undefined) {
      yield* Deferred.succeed(conversationReady, conversationId);
    }

    const session: ProviderSession = {
      threadId: input.threadId,
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      status: "ready",
      runtimeMode: input.runtimeMode,
      createdAt: startedAt,
      updatedAt: startedAt,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(modelSelection?.model ? { model: modelSelection.model } : {}),
      ...(conversationId
        ? { resumeCursor: { schemaVersion: AGY_RESUME_VERSION, conversationId } }
        : {}),
    };

    const context: AgySessionContext = {
      threadId: input.threadId,
      session,
      cwd: input.cwd ?? process.cwd(),
      conversationId,
      conversationReady,
      activeTurnId: undefined,
      currentTurnState: undefined,
      childProcess: undefined,
      stdinQueue: undefined,
      stdinFiber: undefined,
      readFiber: undefined,
      scope,
      turns: [],
      threadStarted: conversationId !== undefined,
      stopped: false,
      modelSelection,
      interactionMode: "default",
    };

    sessions.set(input.threadId, context);

    yield* emit({
      ...(yield* buildEventBase({ threadId: input.threadId })),
      type: "session.started",
      payload: session.resumeCursor !== undefined ? { resume: session.resumeCursor } : {},
    });
    yield* emit({
      ...(yield* buildEventBase({ threadId: input.threadId })),
      type: "session.state.changed",
      payload: {
        state: "ready",
      },
    });
    if (conversationId !== undefined) {
      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId })),
        type: "thread.started",
        payload: { providerThreadId: conversationId },
      });
    }

    return session;
  });

  const sendTurn: AgyAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (
    input: ProviderSendTurnInput,
  ) {
    const context = yield* ensureSessionContext(input.threadId);
    if (context.session.status === "error") {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "sendTurn",
        detail: "Antigravity session is in an error state and must be restarted.",
      });
    }
    if (context.activeTurnId !== undefined) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "sendTurn",
        detail: "Antigravity does not accept a new prompt while a turn is running.",
      });
    }
    const turnId = TurnId.make(yield* randomUUIDv4);
    const interactionMode = input.interactionMode ?? context.interactionMode;
    const modelSelection =
      input.modelSelection?.instanceId === boundInstanceId
        ? input.modelSelection
        : context.modelSelection;

    const currentEffort = context.modelSelection
      ? getModelSelectionStringOptionValue(context.modelSelection, "reasoningEffort")
      : undefined;
    const nextEffort = modelSelection
      ? getModelSelectionStringOptionValue(modelSelection, "reasoningEffort")
      : undefined;
    const modelSelectionChanged =
      resolveAgyModelForEffort(context.modelSelection?.model, currentEffort) !==
        resolveAgyModelForEffort(modelSelection?.model, nextEffort) || currentEffort !== nextEffort;

    if (
      context.childProcess &&
      (interactionMode !== context.interactionMode || modelSelectionChanged)
    ) {
      yield* stopChildProcess(context);
    }

    if (!context.childProcess) {
      yield* spawnAgyProcess(context, modelSelection, interactionMode);
    }
    context.interactionMode = interactionMode;
    context.modelSelection = modelSelection;

    context.activeTurnId = turnId;
    const turnItems: Array<unknown> = [];
    context.currentTurnState = {
      turnId,
      items: turnItems,
      assistantItemId: undefined,
      toolItemIds: new Map(),
    };
    context.turns.push({ id: turnId, items: turnItems });
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt: yield* nowIso,
      ...(modelSelection?.model ? { model: modelSelection.model } : {}),
    };

    yield* emit({
      ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
      type: "turn.started",
      payload: modelSelection?.model ? { model: modelSelection.model } : {},
    });

    yield* emit({
      ...(yield* buildEventBase({ threadId: input.threadId })),
      type: "session.state.changed",
      payload: {
        state: "running",
      },
    });

    const userMessagePayload = yield* encodeAgyUserMessage({
      event: "user",
      message: {
        content: input.input ?? "",
      },
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: "Failed to encode Antigravity prompt.",
            cause,
          }),
      ),
    );

    if (context.stdinQueue) {
      const bytes = new TextEncoder().encode(`${userMessagePayload}\n`);
      yield* Queue.offer(context.stdinQueue, bytes).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: "Failed to write prompt to Antigravity CLI stdin",
              cause,
            }),
        ),
      );
    }

    const initialized = yield* Deferred.await(context.conversationReady).pipe(
      Effect.timeoutOption(AGY_INIT_TIMEOUT_MS),
    );
    if (Option.isNone(initialized)) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "sendTurn",
        detail: "Antigravity CLI did not initialize a conversation.",
      });
    }

    return {
      threadId: input.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    } satisfies ProviderTurnStartResult;
  });

  const interruptTurn: AgyAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(function* (
    threadId: ThreadId,
    turnId?: TurnId,
  ) {
    const context = yield* ensureSessionContext(threadId);
    const activeTurnId = turnId ?? context.activeTurnId;

    yield* stopChildProcess(context);

    if (activeTurnId) {
      yield* emit({
        ...(yield* buildEventBase({ threadId, turnId: activeTurnId })),
        type: "turn.completed",
        payload: {
          state: "interrupted",
        },
      });
    }

    context.activeTurnId = undefined;
    context.currentTurnState = undefined;
    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt: yield* nowIso,
    };

    yield* emit({
      ...(yield* buildEventBase({ threadId })),
      type: "session.state.changed",
      payload: {
        state: "ready",
      },
    });
  });

  const stopSession: AgyAdapterShape["stopSession"] = Effect.fn("stopSession")(function* (
    threadId: ThreadId,
  ) {
    const context = sessions.get(threadId);
    if (!context) {
      return yield* new ProviderAdapterSessionNotFoundError({
        provider: PROVIDER,
        threadId,
      });
    }

    context.stopped = true;
    yield* stopChildProcess(context);
    yield* Scope.close(context.scope, Exit.void);
    sessions.delete(threadId);

    yield* emit({
      ...(yield* buildEventBase({ threadId })),
      type: "session.exited",
      payload: {
        reason: "Session stopped.",
        recoverable: false,
        exitKind: "graceful",
      },
    });
  });

  const respondToRequest: AgyAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId) {
      yield* ensureSessionContext(threadId);
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToRequest",
        detail: "Antigravity streaming sessions do not expose interactive approval requests.",
      });
    },
  );

  const respondToUserInput: AgyAdapterShape["respondToUserInput"] = Effect.fn("respondToUserInput")(
    function* (threadId) {
      yield* ensureSessionContext(threadId);
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToUserInput",
        detail: "Antigravity streaming sessions do not expose structured user-input requests.",
      });
    },
  );

  const listSessions: AgyAdapterShape["listSessions"] = () =>
    Effect.sync(() => [...sessions.values()].map((c) => c.session));

  const hasSession: AgyAdapterShape["hasSession"] = (threadId: ThreadId) =>
    Effect.sync(() => sessions.has(threadId));

  const readThread: AgyAdapterShape["readThread"] = Effect.fn("readThread")(function* (
    threadId: ThreadId,
  ) {
    const context = yield* ensureSessionContext(threadId);
    return {
      threadId,
      turns: context.turns,
    };
  });

  const rollbackThread: AgyAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(function* (
    threadId: ThreadId,
    numTurns: number,
  ) {
    yield* ensureSessionContext(threadId);
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "rollbackThread",
        issue: "numTurns must be an integer >= 1.",
      });
    }
    return yield* new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "thread/rollback",
      detail: "Antigravity streaming sessions do not support provider-side rollback.",
    });
  });

  const stopAll: AgyAdapterShape["stopAll"] = Effect.fn("stopAll")(function* () {
    for (const context of sessions.values()) {
      context.stopped = true;
      yield* stopChildProcess(context);
      yield* Scope.close(context.scope, Exit.void);
    }
    sessions.clear();
  });

  const streamEvents: AgyAdapterShape["streamEvents"] = Stream.fromPubSub(events);

  yield* Effect.addFinalizer(() =>
    Effect.ignore(stopAll()).pipe(
      Effect.tap(() => PubSub.shutdown(events)),
      Effect.tap(() => managedNativeLogger?.close() ?? Effect.void),
    ),
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
    streamEvents,
  } satisfies AgyAdapterShape;
});
