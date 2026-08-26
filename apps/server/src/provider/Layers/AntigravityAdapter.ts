/**
 * AntigravityAdapterLive — Antigravity agent CLI via native stream-json protocol.
 *
 * @module AntigravityAdapterLive
 */

import {
  type AntigravitySettings,
  type ApprovalRequestId,
  type CanonicalItemType,
  EventId,
  type ItemLifecyclePayload,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type AntigravityAdapterShape } from "../Services/AntigravityAdapter.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("antigravity");
const ANTIGRAVITY_RESUME_VERSION = 1 as const;

export interface AntigravityAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly nativeEventLogPath?: string | undefined;
  readonly nativeEventLogger?: EventNdjsonLogger | undefined;
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly resolveSettings?: Effect.Effect<AntigravitySettings> | undefined;
}

interface AntigravitySessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  activeHandle?: ChildProcessSpawner.ChildProcessHandle | undefined;
  activeScope?: Scope.Scope | undefined;
  activeTurnId?: TurnId | undefined;
  resume?: { readonly version: number; readonly conversationId: string } | undefined;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAntigravityResume(raw: unknown): { conversationId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.conversationId === "string" && raw.conversationId.trim()) {
    return { conversationId: raw.conversationId.trim() };
  }
  return undefined;
}

interface ToolDetailMapping {
  readonly itemType: CanonicalItemType;
  readonly title: string;
  readonly detail?: string | undefined;
}

function resolveToolDetails(
  toolName: string,
  args: Record<string, unknown> | undefined,
): ToolDetailMapping {
  switch (toolName) {
    case "run_command": {
      const command =
        (typeof args?.CommandLine === "string" && args.CommandLine) ||
        (typeof args?.command === "string" && args.command) ||
        undefined;
      return {
        itemType: "command_execution",
        title: "Command run",
        detail: command,
      };
    }
    case "replace_file_content":
    case "write_to_file": {
      const target =
        (typeof args?.TargetFile === "string" && args.TargetFile) ||
        (typeof args?.path === "string" && args.path) ||
        (typeof args?.file === "string" && args.file) ||
        undefined;
      return {
        itemType: "file_change",
        title: "File change",
        detail: target,
      };
    }
    case "view_file":
    case "list_dir":
    case "grep_search":
    case "find_by_name": {
      const target =
        (typeof args?.AbsolutePath === "string" && args.AbsolutePath) ||
        (typeof args?.DirectoryPath === "string" && args.DirectoryPath) ||
        (typeof args?.SearchPath === "string" && args.SearchPath) ||
        (typeof args?.Pattern === "string" && args.Pattern) ||
        (typeof args?.Query === "string" && args.Query) ||
        undefined;
      return {
        itemType: "dynamic_tool_call",
        title: toolName,
        detail: target,
      };
    }
    case "search_web":
    case "read_url_content": {
      const query =
        (typeof args?.query === "string" && args.query) ||
        (typeof args?.Url === "string" && args.Url) ||
        undefined;
      return {
        itemType: "web_search",
        title: "Web search",
        detail: query,
      };
    }
    case "invoke_subagent": {
      return {
        itemType: "collab_agent_tool_call",
        title: "Subagent task",
        detail: typeof args?.Prompt === "string" ? args.Prompt.slice(0, 100) : undefined,
      };
    }
    default: {
      return {
        itemType: "dynamic_tool_call",
        title: toolName || "Tool call",
        detail: undefined,
      };
    }
  }
}

const parseJsonValue = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const isProviderAdapterProcessError = Schema.is(ProviderAdapterProcessError);

export function makeAntigravityAdapter(
  antigravitySettings: AntigravitySettings,
  options?: AntigravityAdapterLiveOptions,
): Effect.Effect<
  AntigravityAdapterShape,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

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

    const emit = (event: Omit<ProviderRuntimeEvent, "eventId" | "createdAt">) =>
      Effect.gen(function* () {
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({ ...event, ...stamp } as ProviderRuntimeEvent);
      });

    const getThreadSemaphore = (threadId: string): Effect.Effect<Semaphore.Semaphore> =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = current.get(threadId);
        if (existing) {
          return Effect.succeed([existing, current] as const);
        }
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const next = new Map(current);
            next.set(threadId, semaphore);
            return [semaphore, next] as const;
          }),
        );
      });

    const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const startSession = (
      input: ProviderSessionStartInput,
    ): Effect.Effect<ProviderSession, ProviderAdapterError> =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (sessions.has(input.threadId)) {
            const existing = sessions.get(input.threadId)!;
            return existing.session;
          }

          const now = yield* nowIso;
          const resumeParsed = parseAntigravityResume(input.resumeCursor);
          const session: ProviderSession = {
            threadId: input.threadId,
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode ?? "full-access",
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
            ...(resumeParsed
              ? {
                  resumeCursor: {
                    version: ANTIGRAVITY_RESUME_VERSION,
                    conversationId: resumeParsed.conversationId,
                  },
                }
              : {}),
            createdAt: now,
            updatedAt: now,
          };

          const ctx: AntigravitySessionContext = {
            threadId: input.threadId,
            session,
            ...(resumeParsed
              ? {
                  resume: {
                    version: ANTIGRAVITY_RESUME_VERSION,
                    conversationId: resumeParsed.conversationId,
                  },
                }
              : {}),
            stopped: false,
          };
          sessions.set(input.threadId, ctx);

          yield* emit({
            type: "session.started",
            provider: PROVIDER,
            threadId: input.threadId,
            payload: {
              message: "Antigravity session started.",
              ...(resumeParsed ? { resume: { conversationId: resumeParsed.conversationId } } : {}),
            },
          });

          return session;
        }),
      );

    const stopSession = (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx) {
            return;
          }

          ctx.stopped = true;
          if (ctx.activeHandle) {
            yield* ctx.activeHandle.kill().pipe(Effect.ignore);
            ctx.activeHandle = undefined;
          }
          if (ctx.activeScope) {
            yield* Scope.close(ctx.activeScope, Exit.void);
            ctx.activeScope = undefined;
          }

          sessions.delete(threadId);

          yield* emit({
            type: "session.exited",
            provider: PROVIDER,
            threadId,
            payload: {
              exitKind: "graceful",
              reason: "Session stopped by user.",
            },
          });
        }),
      );

    const hasSession = (threadId: ThreadId): Effect.Effect<boolean> =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const listSessions = (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => [...sessions.values()].map((ctx) => ctx.session));

    const sendTurn = (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(input.threadId);
          if (!ctx || ctx.stopped) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }

          const turnId = TurnId.make(yield* randomUUIDv4);
          ctx.activeTurnId = turnId;

          const promptText = typeof input.input === "string" ? input.input : "";
          if (!promptText.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn prompt text cannot be empty.",
            });
          }

          const model = input.modelSelection?.model;

          yield* emit({
            type: "turn.started",
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: model ? { model } : {},
          });

          const settings = options?.resolveSettings
            ? yield* options.resolveSettings
            : antigravitySettings;

          const command = settings.binaryPath || "agy";
          const resumeData = ctx.resume;

          const args: string[] = [
            "--output-format",
            "stream-json",
            "--dangerously-skip-permissions",
          ];
          if (resumeData?.conversationId) {
            args.push("--conversation", resumeData.conversationId);
          }
          if (model) {
            args.push("--model", model);
          }
          args.push("--print", promptText);

          const processEnv = options?.environment ?? process.env;
          const spawnCommand = yield* resolveSpawnCommand(
            command,
            args,
            processEnv ? { env: processEnv } : {},
          );

          const startedItemIds = new Set<string>();
          let conversationId: string | null = resumeData?.conversationId ?? null;
          let finalStatus: "completed" | "failed" = "completed";

          const turnScope = yield* Scope.make("sequential");
          ctx.activeScope = turnScope;

          const runProcess = Effect.gen(function* () {
            const child = yield* spawner
              .spawn(
                ChildProcess.make(spawnCommand.command, spawnCommand.args, {
                  ...(ctx.session.cwd ? { cwd: ctx.session.cwd } : {}),
                  ...(processEnv ? { env: processEnv } : { extendEnv: true }),
                  shell: spawnCommand.shell,
                }),
              )
              .pipe(
                Scope.provide(turnScope),
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId: input.threadId,
                      detail: `Failed to spawn Antigravity CLI process: ${String(cause)}`,
                      cause,
                    }),
                ),
              );

            ctx.activeHandle = child;

            yield* child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runForEach((line: string) =>
                Effect.gen(function* () {
                  const trimmed = line.trim();
                  if (!trimmed) return;

                  const parsedOpt = parseJsonValue(trimmed);
                  if (Option.isNone(parsedOpt) || !isRecord(parsedOpt.value)) {
                    return;
                  }
                  const data = parsedOpt.value;

                  if (data.event === "init" && typeof data.conversation_id === "string") {
                    conversationId = data.conversation_id;
                  } else if (data.event === "step_update" && isRecord(data.step_update)) {
                    const step = data.step_update;
                    if (typeof step.conversation_id === "string") {
                      conversationId = step.conversation_id;
                    }

                    if (step.step_type === "agent_response") {
                      const itemId = `step_${step.step_index}`;
                      if (!startedItemIds.has(itemId)) {
                        startedItemIds.add(itemId);
                        yield* emit({
                          type: "item.started",
                          provider: PROVIDER,
                          threadId: input.threadId,
                          turnId,
                          itemId: RuntimeItemId.make(itemId),
                          payload: {
                            itemType: "assistant_message",
                            status: "inProgress",
                          },
                        });
                      }

                      if (typeof step.thought === "string" || typeof step.thinking === "string") {
                        const thoughtDelta = (
                          typeof step.thought === "string" ? step.thought : step.thinking
                        ) as string;
                        yield* emit({
                          type: "content.delta",
                          provider: PROVIDER,
                          threadId: input.threadId,
                          turnId,
                          itemId: RuntimeItemId.make(itemId),
                          payload: {
                            streamKind: "reasoning_text",
                            delta: thoughtDelta,
                          },
                        });
                      }

                      if (typeof step.text_delta === "string" && step.text_delta) {
                        yield* emit({
                          type: "content.delta",
                          provider: PROVIDER,
                          threadId: input.threadId,
                          turnId,
                          itemId: RuntimeItemId.make(itemId),
                          payload: {
                            streamKind: "assistant_text",
                            delta: step.text_delta,
                          },
                        });
                      }

                      if (step.state === "DONE") {
                        yield* emit({
                          type: "item.completed",
                          provider: PROVIDER,
                          threadId: input.threadId,
                          turnId,
                          itemId: RuntimeItemId.make(itemId),
                          payload: {
                            itemType: "assistant_message",
                            status: "completed",
                          },
                        });
                      }
                    } else if (
                      step.step_type === "tool_call" ||
                      step.step_type === "command_execution"
                    ) {
                      const itemId = `tool_${step.step_index}`;
                      const toolName =
                        (typeof step.tool_name === "string" && step.tool_name) ||
                        (Array.isArray(step.tool_calls) &&
                          typeof step.tool_calls[0]?.name === "string" &&
                          step.tool_calls[0].name) ||
                        (step.step_type === "command_execution" ? "run_command" : "tool_call");

                      const toolArgs =
                        (isRecord(step.parameters) && step.parameters) ||
                        (isRecord(step.input) && step.input) ||
                        (isRecord(step.args) && step.args) ||
                        (Array.isArray(step.tool_calls) &&
                          isRecord(step.tool_calls[0]?.input) &&
                          step.tool_calls[0].input) ||
                        (typeof step.command === "string" ? { command: step.command } : undefined);

                      const toolMapping = resolveToolDetails(toolName, toolArgs);

                      if (step.state === "ACTIVE" && !startedItemIds.has(itemId)) {
                        startedItemIds.add(itemId);
                        const payload: ItemLifecyclePayload = {
                          itemType: toolMapping.itemType,
                          status: "inProgress",
                          title: toolMapping.title,
                          ...(toolMapping.detail ? { detail: toolMapping.detail } : {}),
                          ...(toolArgs ? { data: toolArgs } : {}),
                        };
                        yield* emit({
                          type: "item.started",
                          provider: PROVIDER,
                          threadId: input.threadId,
                          turnId,
                          itemId: RuntimeItemId.make(itemId),
                          payload,
                        });
                      }

                      const outputText =
                        (typeof step.output === "string" && step.output) ||
                        (typeof step.result === "string" && step.result) ||
                        (typeof step.stdout === "string" && step.stdout) ||
                        undefined;

                      if (outputText) {
                        const streamKind =
                          toolMapping.itemType === "command_execution"
                            ? "command_output"
                            : toolMapping.itemType === "file_change"
                              ? "file_change_output"
                              : "assistant_text";

                        yield* emit({
                          type: "content.delta",
                          provider: PROVIDER,
                          threadId: input.threadId,
                          turnId,
                          itemId: RuntimeItemId.make(itemId),
                          payload: {
                            streamKind,
                            delta: outputText,
                          },
                        });
                      }

                      if (step.state === "DONE") {
                        const isError = step.status === "ERROR" || step.error !== undefined;
                        yield* emit({
                          type: "item.completed",
                          provider: PROVIDER,
                          threadId: input.threadId,
                          turnId,
                          itemId: RuntimeItemId.make(itemId),
                          payload: {
                            itemType: toolMapping.itemType,
                            status: isError ? "failed" : "completed",
                            title: toolMapping.title,
                            ...(toolMapping.detail ? { detail: toolMapping.detail } : {}),
                          },
                        });
                      }
                    }
                  } else if (data.event === "result" && isRecord(data.result)) {
                    if (typeof data.result.conversation_id === "string") {
                      conversationId = data.result.conversation_id;
                    }
                    finalStatus = data.result.status === "SUCCESS" ? "completed" : "failed";
                  }
                }),
              ),
            );

            const exitCode = yield* child.exitCode;
            ctx.activeHandle = undefined;

            if (exitCode !== 0 && finalStatus === "completed") {
              finalStatus = "failed";
            }
          });

          yield* runProcess.pipe(
            Effect.catch((cause: unknown) =>
              isProviderAdapterProcessError(cause)
                ? Effect.fail(cause)
                : Effect.fail(
                    new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId: input.threadId,
                      detail: String(cause),
                      cause,
                    }),
                  ),
            ),
          );

          yield* Scope.close(turnScope, Exit.void);
          ctx.activeScope = undefined;

          if (conversationId) {
            ctx.resume = {
              version: ANTIGRAVITY_RESUME_VERSION,
              conversationId,
            };
          }

          yield* emit({
            type: "turn.completed",
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: {
              state: finalStatus,
            },
          });

          ctx.activeTurnId = undefined;

          return {
            threadId: input.threadId,
            turnId,
          } satisfies ProviderTurnStartResult;
        }),
      );

    const interruptTurn = (
      threadId: ThreadId,
      _turnId?: TurnId,
    ): Effect.Effect<void, ProviderAdapterError> =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx || !ctx.activeHandle) {
            return;
          }

          yield* ctx.activeHandle.kill().pipe(Effect.ignore);
          ctx.activeHandle = undefined;
          if (ctx.activeScope) {
            yield* Scope.close(ctx.activeScope, Exit.void);
            ctx.activeScope = undefined;
          }

          if (ctx.activeTurnId) {
            yield* emit({
              type: "turn.completed",
              provider: PROVIDER,
              threadId,
              turnId: ctx.activeTurnId,
              payload: {
                state: "interrupted",
              },
            });
            ctx.activeTurnId = undefined;
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

    const readThread = (
      threadId: ThreadId,
    ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
      Effect.sync(() => ({
        threadId,
        turns: [],
      }));

    const rollbackThread = (
      threadId: ThreadId,
      _numTurns: number,
    ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
      Effect.sync(() => ({
        threadId,
        turns: [],
      }));

    const stopAll = (): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        for (const ctx of sessions.values()) {
          if (ctx.activeHandle) {
            yield* ctx.activeHandle.kill().pipe(Effect.ignore);
            ctx.activeHandle = undefined;
          }
          if (ctx.activeScope) {
            yield* Scope.close(ctx.activeScope, Exit.void);
            ctx.activeScope = undefined;
          }
          ctx.stopped = true;
        }
        sessions.clear();
        if (managedNativeEventLogger) {
          yield* managedNativeEventLogger.close();
        }
      });

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
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
    } satisfies AntigravityAdapterShape;
  });
}
