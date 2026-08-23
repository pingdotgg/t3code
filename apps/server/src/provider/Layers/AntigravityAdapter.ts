import {
  type ApprovalRequestId,
  type AntigravitySettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ThreadTokenUsageSnapshot,
  type ProviderSendTurnInput,
  type ProviderTurnStartResult,
  type ProviderSessionStartInput,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type AntigravityAdapterShape } from "../Services/AntigravityAdapter.ts";
import { type ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { normalizeAntigravityModel } from "./AntigravityProvider.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("antigravity");
const ANTIGRAVITY_RESUME_VERSION = 1 as const;

export interface AntigravityAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

interface AntigravityResumeCursor {
  readonly schemaVersion: typeof ANTIGRAVITY_RESUME_VERSION;
  readonly conversationId: string;
}

function parseAntigravityResume(raw: unknown): AntigravityResumeCursor | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== ANTIGRAVITY_RESUME_VERSION) {
    return undefined;
  }
  if (typeof record.conversationId !== "string" || record.conversationId.trim().length === 0) {
    return undefined;
  }
  return {
    schemaVersion: ANTIGRAVITY_RESUME_VERSION,
    conversationId: record.conversationId.trim(),
  };
}

interface AntigravityTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

interface AntigravitySessionContext {
  session: ProviderSession;
  readonly directory: string;
  conversationId: string | undefined;
  activeTurnId: TurnId | undefined;
  activeFiber: Fiber.Fiber<void, unknown> | undefined;
  activeTurnInterrupt: Deferred.Deferred<void> | undefined;
  readonly turns: Array<AntigravityTurnSnapshot>;
  readonly stopped: Ref.Ref<boolean>;
  readonly scope: Scope.Closeable;
}

type AgyEvent =
  | {
      readonly event: "init";
      readonly conversation_id: string;
      readonly init?: {
        readonly cwd?: string;
        readonly tools?: ReadonlyArray<string>;
        readonly permission_mode?: string;
      };
    }
  | {
      readonly event: "step_update";
      readonly step_update: {
        readonly conversation_id?: string;
        readonly step_index: number;
        readonly state?: "ACTIVE" | "DONE" | "ERROR" | string;
        readonly step_type?:
          | "user_input"
          | "checkpoint"
          | "agent_response"
          | "tool"
          | "system_message"
          | string;
        readonly text_delta?: string;
        readonly duration_seconds?: number;
        readonly tool_name?: string;
        readonly tool_info?: {
          readonly name?: string;
          readonly parameters?: Record<string, unknown>;
          readonly output?: string;
        };
        readonly usage?: {
          readonly input_tokens?: number;
          readonly output_tokens?: number;
          readonly thinking_tokens?: number;
          readonly cache_read_tokens?: number;
          readonly total_tokens?: number;
        };
      };
    }
  | {
      readonly event: "result";
      readonly result: {
        readonly conversation_id?: string;
        readonly status?: "SUCCESS" | "ERROR" | string;
        readonly response?: string;
        readonly duration_seconds?: number;
        readonly num_turns?: number;
        readonly usage?: {
          readonly input_tokens?: number;
          readonly output_tokens?: number;
          readonly thinking_tokens?: number;
          readonly cache_read_tokens?: number;
          readonly total_tokens?: number;
        };
      };
    };

function parseAgyJsonLine(line: string): AgyEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed.event === "init" || parsed.event === "step_update" || parsed.event === "result") {
      return parsed as unknown as AgyEvent;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function makeAntigravityAdapter(
  antigravitySettings: AntigravitySettings,
  options?: AntigravityAdapterLiveOptions,
): Effect.Effect<
  AntigravityAdapterShape,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | Scope.Scope
> {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("antigravity");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);

    const sessions = new Map<ThreadId, AntigravitySessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Antigravity runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = Option.fromNullishOr(current.get(threadId));
        if (Option.isSome(existing)) {
          return Effect.succeed([existing.value, current] as const);
        }
        return Semaphore.make(1).pipe(
          Effect.map((created) => {
            const next = new Map(current);
            next.set(threadId, created);
            return [created, next] as const;
          }),
        );
      });

    const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const semaphore = yield* getThreadSemaphore(threadId);
        return yield* semaphore.withPermit(effect);
      });

    const startSession = (
      input: ProviderSessionStartInput,
    ): Effect.Effect<ProviderSession, ProviderAdapterError> =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const rawCwd = input.cwd ?? process.cwd();
          const cwd = path.resolve(rawCwd);
          const exists = yield* fileSystem.exists(cwd).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "fileSystem/exists",
                  detail: `Failed to check workspace directory '${cwd}'.`,
                  cause,
                }),
            ),
          );
          if (!exists) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Workspace directory '${cwd}' does not exist.`,
            });
          }

          const existingContext = sessions.get(input.threadId);
          if (existingContext) {
            return existingContext.session;
          }

          const resume = parseAntigravityResume(input.resumeCursor);
          const conversationId = resume?.conversationId;
          const createdAt = yield* nowIso;
          const sessionScope = yield* Scope.make();
          const stoppedRef = yield* Ref.make(false);

          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: input.modelSelection?.model ?? "gemini-3.7-flash-high",
            threadId: input.threadId,
            createdAt,
            updatedAt: createdAt,
            ...(resume ? { resumeCursor: resume } : {}),
          };

          const context: AntigravitySessionContext = {
            session,
            directory: cwd,
            conversationId,
            activeTurnId: undefined,
            activeFiber: undefined,
            activeTurnInterrupt: undefined,
            turns: [],
            stopped: stoppedRef,
            scope: sessionScope,
          };

          sessions.set(input.threadId, context);

          yield* Scope.addFinalizer(
            sessionScope,
            Effect.sync(() => {
              sessions.delete(input.threadId);
            }),
          );

          return session;
        }),
      );

    const sendTurn = (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const context = sessions.get(input.threadId);
          if (!context) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }

          if (yield* Ref.get(context.stopped)) {
            return yield* new ProviderAdapterSessionClosedError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }

          const turnId = TurnId.make(yield* randomUUIDv4);
          context.activeTurnId = turnId;
          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };

          const interruptDeferred = yield* Deferred.make<void>();
          context.activeTurnInterrupt = interruptDeferred;

          // Prepare prompt and attachments
          const rawInput = input.input ?? "";
          let fullPrompt = rawInput;
          if (input.attachments && input.attachments.length > 0) {
            const attachmentNotes: string[] = [];
            for (const att of input.attachments) {
              const attPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment: att,
              });
              if (attPath) {
                attachmentNotes.push(`Attachment '${att.name}': ${attPath}`);
              }
            }
            if (attachmentNotes.length > 0) {
              fullPrompt = `${fullPrompt}\n\n[Context Attachments]\n${attachmentNotes.join("\n")}`;
            }
          }

          const requestedModel =
            input.modelSelection?.model ?? context.session.model ?? "gemini-3.7-flash";
          const effort = getProviderOptionStringSelectionValue(
            input.modelSelection?.options,
            "effort",
          );

          const normalizedModel = normalizeAntigravityModel(requestedModel, effort ?? undefined);

          const binary = antigravitySettings.binaryPath || "agy";
          const cliArgs: string[] = ["-p", fullPrompt, "--output-format", "stream-json"];

          if (context.conversationId) {
            cliArgs.push("--conversation", context.conversationId);
          }
          if (normalizedModel) {
            cliArgs.push("--model", normalizedModel);
          }
          if (antigravitySettings.dangerouslySkipPermissions !== false) {
            cliArgs.push("--dangerously-skip-permissions");
          }

          const resolvedEnvironment = options?.environment ?? process.env;

          const spawnCommand = yield* resolveSpawnCommand(binary, cliArgs, {
            env: resolvedEnvironment,
          });

          // Emit turn.started
          const startStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "turn.started",
            ...startStamp,
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: {
              ...(normalizedModel ? { model: normalizedModel } : {}),
              ...(effort ? { effort } : {}),
            },
          });

          // Assistant message item id
          const assistantItemId = yield* randomUUIDv4;
          const assistantItemStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.started",
            ...assistantItemStamp,
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            itemId: RuntimeItemId.make(assistantItemId),
            payload: {
              itemType: "assistant_message",
              status: "inProgress",
            },
          });

          const stdoutRemainderRef = yield* Ref.make("");
          const currentAssistantTextRef = yield* Ref.make("");
          const resultErrorRef = yield* Ref.make<string | undefined>(undefined);
          const activeToolItems = new Map<number, string>();

          const handleAgyEvent = (agyEvent: AgyEvent): Effect.Effect<void, ProviderAdapterError> =>
            Effect.gen(function* () {
              if (nativeEventLogger) {
                yield* nativeEventLogger.write(agyEvent, input.threadId);
              }

              if (agyEvent.event === "init") {
                if (agyEvent.conversation_id) {
                  context.conversationId = agyEvent.conversation_id;
                  const resumeCursor: AntigravityResumeCursor = {
                    schemaVersion: ANTIGRAVITY_RESUME_VERSION,
                    conversationId: agyEvent.conversation_id,
                  };
                  context.session = {
                    ...context.session,
                    resumeCursor,
                  };
                }
                return;
              }

              if (agyEvent.event === "step_update") {
                const step = agyEvent.step_update;

                if (step.usage) {
                  const usageStamp = yield* makeEventStamp();
                  const usedTokens =
                    (step.usage.input_tokens ?? 0) + (step.usage.output_tokens ?? 0);
                  const tokenUsage: ThreadTokenUsageSnapshot = {
                    usedTokens,
                    ...(step.usage.input_tokens !== undefined
                      ? { inputTokens: step.usage.input_tokens }
                      : {}),
                    ...(step.usage.output_tokens !== undefined
                      ? { outputTokens: step.usage.output_tokens }
                      : {}),
                    ...(step.usage.thinking_tokens !== undefined
                      ? { reasoningOutputTokens: step.usage.thinking_tokens }
                      : {}),
                    ...(step.usage.cache_read_tokens !== undefined
                      ? { cachedInputTokens: step.usage.cache_read_tokens }
                      : {}),
                    ...(step.usage.total_tokens !== undefined
                      ? { totalProcessedTokens: step.usage.total_tokens }
                      : {}),
                  };
                  yield* offerRuntimeEvent({
                    type: "thread.token-usage.updated",
                    ...usageStamp,
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: {
                      usage: tokenUsage,
                    },
                  });
                }

                if (step.step_type === "agent_response" && step.text_delta) {
                  yield* Ref.update(currentAssistantTextRef, (curr) => curr + step.text_delta);
                  const deltaStamp = yield* makeEventStamp();
                  yield* offerRuntimeEvent({
                    type: "content.delta",
                    ...deltaStamp,
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    itemId: RuntimeItemId.make(assistantItemId),
                    payload: {
                      streamKind: "assistant_text",
                      delta: step.text_delta,
                    },
                    raw: {
                      source: "antigravity.cli.output",
                      method: "step_update",
                      payload: step,
                    },
                  });
                }

                if (step.step_type === "tool") {
                  let toolItemId = activeToolItems.get(step.step_index);
                  if (!toolItemId) {
                    toolItemId = yield* randomUUIDv4;
                    activeToolItems.set(step.step_index, toolItemId);
                  }

                  const toolName = step.tool_name ?? step.tool_info?.name ?? "tool";
                  const isDone = step.state === "DONE";
                  const toolStamp = yield* makeEventStamp();

                  yield* offerRuntimeEvent({
                    type: isDone ? "item.completed" : "item.started",
                    ...toolStamp,
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    itemId: RuntimeItemId.make(toolItemId),
                    payload: {
                      itemType: "dynamic_tool_call",
                      status: isDone ? "completed" : "inProgress",
                      title: toolName,
                      ...(step.tool_info?.parameters ? { data: step.tool_info.parameters } : {}),
                      ...(step.tool_info?.output ? { detail: step.tool_info.output } : {}),
                    },
                    raw: {
                      source: "antigravity.cli.output",
                      method: "step_update/tool",
                      payload: step,
                    },
                  });
                }
                return;
              }

              if (agyEvent.event === "result") {
                const result = agyEvent.result;
                if (result.status === "ERROR" || (result as { error?: string }).error) {
                  yield* Ref.set(
                    resultErrorRef,
                    (result as { error?: string }).error ?? result.response ?? "Turn failed",
                  );
                }
                if (result.usage) {
                  const usageStamp = yield* makeEventStamp();
                  const usedTokens =
                    (result.usage.input_tokens ?? 0) + (result.usage.output_tokens ?? 0);
                  const tokenUsage: ThreadTokenUsageSnapshot = {
                    usedTokens,
                    ...(result.usage.input_tokens !== undefined
                      ? { inputTokens: result.usage.input_tokens }
                      : {}),
                    ...(result.usage.output_tokens !== undefined
                      ? { outputTokens: result.usage.output_tokens }
                      : {}),
                    ...(result.usage.thinking_tokens !== undefined
                      ? { reasoningOutputTokens: result.usage.thinking_tokens }
                      : {}),
                    ...(result.usage.cache_read_tokens !== undefined
                      ? { cachedInputTokens: result.usage.cache_read_tokens }
                      : {}),
                    ...(result.usage.total_tokens !== undefined
                      ? { totalProcessedTokens: result.usage.total_tokens }
                      : {}),
                  };
                  yield* offerRuntimeEvent({
                    type: "thread.token-usage.updated",
                    ...usageStamp,
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: {
                      usage: tokenUsage,
                    },
                  });
                }
              }
            });

          const runTurnFiber = Effect.gen(function* () {
            const child = yield* childProcessSpawner.spawn(
              ChildProcess.make(spawnCommand.command, spawnCommand.args, {
                env: resolvedEnvironment,
                cwd: context.directory,
                shell: spawnCommand.shell,
              }),
            );

            const stderrBufferRef = yield* Ref.make("");
            const stderrFiber = yield* child.stderr.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk) => Ref.update(stderrBufferRef, (curr) => curr + chunk)),
              Effect.forkScoped,
            );

            const stdoutFiber = yield* child.stdout.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk) =>
                Ref.modify(stdoutRemainderRef, (current) => {
                  const combined = current + chunk;
                  const lines = combined.split("\n");
                  const remainder = lines.pop() ?? "";
                  return [lines.map((l) => l.replace(/\r$/, "")), remainder] as const;
                }).pipe(
                  Effect.flatMap((lines) =>
                    Effect.forEach(
                      lines,
                      (line) => {
                        const event = parseAgyJsonLine(line);
                        return event ? handleAgyEvent(event) : Effect.void;
                      },
                      { discard: true },
                    ),
                  ),
                ),
              ),
              Effect.forkScoped,
            );

            const exitCode = yield* child.exitCode;
            yield* Fiber.join(stdoutFiber);
            yield* Fiber.join(stderrFiber);

            // Flush remaining line in stdout
            const finalRemainder = yield* Ref.get(stdoutRemainderRef);
            if (finalRemainder.trim()) {
              const event = parseAgyJsonLine(finalRemainder);
              if (event) {
                yield* handleAgyEvent(event);
              }
            }

            const stderrOutput = yield* Ref.get(stderrBufferRef);
            const recordedError = yield* Ref.get(resultErrorRef);
            const errorMessage =
              recordedError ?? (exitCode !== 0 ? stderrOutput.trim() || "Turn failed" : undefined);
            const isSuccess = exitCode === 0 && !recordedError;

            // Complete assistant message item
            const compItemStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "item.completed",
              ...compItemStamp,
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              itemId: RuntimeItemId.make(assistantItemId),
              payload: {
                itemType: "assistant_message",
                status: isSuccess ? "completed" : "failed",
              },
            });

            // Complete turn
            const compTurnStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...compTurnStamp,
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: {
                state: isSuccess ? "completed" : "failed",
                ...(errorMessage ? { errorMessage } : {}),
              },
            });

            context.session = {
              ...context.session,
              status: isSuccess ? "ready" : "error",
              activeTurnId: undefined,
              updatedAt: yield* nowIso,
            };
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                // Interrupted
                const intItemStamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  type: "item.completed",
                  ...intItemStamp,
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  itemId: RuntimeItemId.make(assistantItemId),
                  payload: {
                    itemType: "assistant_message",
                    status: "declined",
                  },
                });

                const intTurnStamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  type: "turn.completed",
                  ...intTurnStamp,
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    state: "interrupted",
                  },
                });

                context.session = {
                  ...context.session,
                  status: "ready",
                  activeTurnId: undefined,
                  updatedAt: yield* nowIso,
                };
              }),
            ),
            Effect.scoped,
          );

          const fiber = yield* runTurnFiber.pipe(Effect.forkIn(context.scope));
          context.activeFiber = fiber;

          return {
            threadId: input.threadId,
            turnId,
            ...(context.session.resumeCursor ? { resumeCursor: context.session.resumeCursor } : {}),
          };
        }),
      );

    const interruptTurn = (
      threadId: ThreadId,
      turnId?: TurnId,
    ): Effect.Effect<void, ProviderAdapterError> =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const context = sessions.get(threadId);
          if (!context) {
            return;
          }
          if (turnId && context.activeTurnId && context.activeTurnId !== turnId) {
            return;
          }
          if (context.activeFiber) {
            yield* Fiber.interrupt(context.activeFiber);
            context.activeFiber = undefined;
          }
        }),
      );

    const respondToRequest = (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void;

    const respondToUserInput = (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void;

    const stopSession = (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const context = sessions.get(threadId);
          if (!context) {
            return;
          }
          yield* Ref.set(context.stopped, true);
          if (context.activeFiber) {
            yield* Fiber.interrupt(context.activeFiber);
            context.activeFiber = undefined;
          }
          yield* Scope.close(context.scope, Exit.void);
          sessions.delete(threadId);
        }),
      );

    const listSessions = (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => Array.from(sessions.values()).map((ctx) => ctx.session));

    const hasSession = (threadId: ThreadId): Effect.Effect<boolean> =>
      Effect.sync(() => sessions.has(threadId));

    const readThread = (
      threadId: ThreadId,
    ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        return {
          threadId,
          turns: context.turns.map((t) => ({
            id: t.id,
            items: t.items,
          })),
        };
      });

    const rollbackThread = (
      threadId: ThreadId,
      numTurns: number,
    ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        if (numTurns > 0) {
          context.turns.splice(-numTurns);
        }
        return {
          threadId,
          turns: context.turns.map((t) => ({
            id: t.id,
            items: t.items,
          })),
        };
      });

    const stopAll = (): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        const allThreadIds = Array.from(sessions.keys());
        yield* Effect.forEach(allThreadIds, (id) => stopSession(id), { discard: true });
      });

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
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies AntigravityAdapterShape;
  });
}
