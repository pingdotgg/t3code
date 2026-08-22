import {
  type CanonicalItemType,
  type AntigravitySettings,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type AntigravityAdapterShape } from "../Services/AntigravityAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("antigravity");
const decodeJsonExit = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

export interface AntigravityAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

interface ActiveProcessHandle {
  readonly kill: () => Effect.Effect<void, never, never>;
}

interface AntigravitySessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  cwd: string;
  antigravityConversationId: string | undefined;
  activeProcess: ActiveProcessHandle | undefined;
  activeTurnId: TurnId | undefined;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  stopped: boolean;
}

function toolNameToItemType(toolName: string): CanonicalItemType {
  switch (toolName) {
    case "run_command":
    case "command_status":
    case "send_command_input":
      return "command_execution";
    case "replace_file_content":
    case "multi_replace_file_content":
    case "write_to_file":
    case "sed_file":
    case "notebook_edit":
      return "file_change";
    case "view_file":
    case "list_dir":
    case "read_resource":
      return "dynamic_tool_call";
    case "search_web":
    case "read_url_content":
    case "grep_search":
    case "find_by_name":
      return "web_search";
    case "call_mcp_tool":
      return "mcp_tool_call";
    case "invoke_subagent":
    case "define_subagent":
    case "manage_subagents":
    case "send_message":
      return "collab_agent_tool_call";
    default:
      return "dynamic_tool_call";
  }
}

function toolParamsToDetail(parameters: unknown): string | undefined {
  if (!parameters || typeof parameters !== "object") return undefined;
  const p = parameters as Record<string, unknown>;
  const candidate =
    p.CommandLine ??
    p.TargetFile ??
    p.AbsolutePath ??
    p.DirectoryPath ??
    p.Query ??
    p.query ??
    p.Url ??
    p.Prompt;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}

export function makeAntigravityAdapter(
  settings: AntigravitySettings,
  options?: AntigravityAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const processEnv = options?.environment ?? process.env;

    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("antigravity");
    const sessions = new Map<ThreadId, AntigravitySessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const publishEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

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
    const nextTurnId = Effect.map(randomUUIDv4, (id) => TurnId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<AntigravitySessionContext, ProviderAdapterError> =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        return ctx;
      });

    const startSession: AntigravityAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const threadId = input.threadId;
          const existing = sessions.get(threadId);
          if (existing && !existing.stopped) {
            return existing.session;
          }

          const sessionScope = yield* Scope.make();
          const createdAt = yield* nowIso;

          const isTargetInstance = input.modelSelection?.instanceId === boundInstanceId;
          const session: ProviderSession = {
            threadId,
            status: "ready",
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            runtimeMode: input.runtimeMode,
            model: isTargetInstance ? input.modelSelection?.model : undefined,
            options: isTargetInstance ? input.modelSelection?.options : undefined,
            createdAt,
            updatedAt: createdAt,
          };

          const ctx: AntigravitySessionContext = {
            threadId,
            session,
            scope: sessionScope,
            cwd: input.cwd ?? process.cwd(),
            antigravityConversationId: undefined,
            activeProcess: undefined,
            activeTurnId: undefined,
            turns: [],
            stopped: false,
          };

          sessions.set(threadId, ctx);

          const stamp = yield* makeEventStamp();
          yield* publishEvent({
            ...stamp,
            provider: PROVIDER,
            threadId,
            type: "session.started",
            payload: {},
          });

          return session;
        }),
      );

    const sendTurn: AntigravityAdapterShape["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const threadId = input.threadId;
          const ctx = yield* requireSession(threadId);

          if (ctx.activeProcess) {
            yield* ctx.activeProcess.kill();
            ctx.activeProcess = undefined;
          }

          if (ctx.activeTurnId) {
            const abortedStamp = yield* makeEventStamp();
            yield* publishEvent({
              ...abortedStamp,
              provider: PROVIDER,
              threadId,
              turnId: ctx.activeTurnId,
              type: "turn.aborted",
              payload: {
                reason: "Superseded by new turn",
              },
            });
            ctx.activeTurnId = undefined;
          }

          const turnId = yield* nextTurnId;

          ctx.activeTurnId = turnId;
          const turnStartedAt = yield* nowIso;
          const turnStartEventId = yield* nextEventId;

          const turnRecord = {
            id: turnId,
            items: [{ prompt: input.input ?? "" }],
          };
          ctx.turns.push(turnRecord);

          yield* publishEvent({
            eventId: turnStartEventId,
            provider: PROVIDER,
            threadId,
            turnId,
            createdAt: turnStartedAt,
            type: "turn.started",
            payload: {},
          });

          const binary = settings.binaryPath || "agy";
          const args = ["--output-format", "stream-json"];

          if (settings.dangerouslySkipPermissions !== false) {
            args.push("--dangerously-skip-permissions");
          }

          const selectedModel =
            input.modelSelection?.instanceId === boundInstanceId
              ? input.modelSelection.model
              : undefined;

          if (selectedModel) {
            args.push("--model", selectedModel);
          }

          const selectedEffort =
            input.modelSelection?.instanceId === boundInstanceId
              ? getModelSelectionStringOptionValue(input.modelSelection, "effort")
              : undefined;
          const effectiveEffort = selectedEffort || settings.effort;

          if (effectiveEffort) {
            args.push("--effort", effectiveEffort);
          }

          if (ctx.antigravityConversationId) {
            args.push("--conversation", ctx.antigravityConversationId);
          }

          const promptText = input.input ?? "";
          args.push("-p", promptText);

          const spawnCommand = yield* resolveSpawnCommand(binary, args, {
            env: processEnv,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId,
                  detail: `Failed to resolve spawn command (${binary})`,
                  cause,
                }),
            ),
            Effect.tapError((error) =>
              Effect.gen(function* () {
                ctx.activeTurnId = undefined;
                const completedStamp = yield* makeEventStamp();
                yield* publishEvent({
                  ...completedStamp,
                  provider: PROVIDER,
                  threadId,
                  turnId,
                  type: "turn.completed",
                  payload: {
                    state: "failed",
                    errorMessage: error.detail,
                  },
                });
              }),
            ),
          );

          const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: ctx.cwd,
            env: processEnv,
            shell: spawnCommand.shell,
            stdin: {
              stream: Stream.empty,
            },
          });

          const processHandle = yield* childProcessSpawner.spawn(command).pipe(
            Effect.provideService(Scope.Scope, ctx.scope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId,
                  detail: `Failed to spawn Antigravity CLI process (${binary})`,
                  cause,
                }),
            ),
            Effect.tapError((error) =>
              Effect.gen(function* () {
                ctx.activeTurnId = undefined;
                const completedStamp = yield* makeEventStamp();
                yield* publishEvent({
                  ...completedStamp,
                  provider: PROVIDER,
                  threadId,
                  turnId,
                  type: "turn.completed",
                  payload: {
                    state: "failed",
                    errorMessage: error.detail,
                  },
                });
              }),
            ),
          );

          ctx.activeProcess = {
            kill: () => Effect.asVoid(Effect.ignore(processHandle.kill())),
          };

          const monitorEffect = Effect.gen(function* () {
            yield* Stream.runDrain(processHandle.stderr).pipe(Effect.forkChild);
            const stdoutLines = processHandle.stdout.pipe(Stream.decodeText(), Stream.splitLines);

            yield* Stream.runForEach(stdoutLines, (line) =>
              Effect.gen(function* () {
                const trimmed = line.trim();
                if (!trimmed) return;

                const decoded = decodeJsonExit(trimmed);
                if (
                  Exit.isSuccess(decoded) &&
                  typeof decoded.value === "object" &&
                  decoded.value !== null
                ) {
                  const data = decoded.value as Record<string, unknown>;
                  const stamp = yield* makeEventStamp();

                  if (nativeEventLogger) {
                    yield* nativeEventLogger.write(data, threadId);
                  }

                  if (data.event === "init") {
                    if (typeof data.conversation_id === "string") {
                      ctx.antigravityConversationId = data.conversation_id;
                    }
                    yield* publishEvent({
                      ...stamp,
                      provider: PROVIDER,
                      threadId,
                      turnId,
                      type: "session.state.changed",
                      payload: { state: "running" },
                    });
                  } else if (
                    data.event === "step_update" &&
                    typeof data.step_update === "object" &&
                    data.step_update !== null
                  ) {
                    const step = data.step_update as Record<string, unknown>;
                    turnRecord.items.push(step);

                    if (step.step_type === "agent_response") {
                      if (typeof step.text_delta === "string") {
                        yield* publishEvent({
                          ...stamp,
                          provider: PROVIDER,
                          threadId,
                          turnId,
                          type: "content.delta",
                          payload: {
                            streamKind: "assistant_text",
                            delta: step.text_delta,
                          },
                        });
                      }

                      if (
                        step.state === "DONE" &&
                        typeof step.usage === "object" &&
                        step.usage !== null
                      ) {
                        const usage = step.usage as Record<string, unknown>;
                        const count = (v: unknown): number | undefined =>
                          typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
                        const usedTokens = count(usage.total_tokens) ?? 0;
                        const usageSnapshot: ThreadTokenUsageSnapshot = {
                          usedTokens,
                          ...(count(usage.input_tokens) !== undefined
                            ? { inputTokens: count(usage.input_tokens) }
                            : {}),
                          ...(count(usage.output_tokens) !== undefined
                            ? { outputTokens: count(usage.output_tokens) }
                            : {}),
                          ...(count(usage.thinking_tokens) !== undefined
                            ? { reasoningOutputTokens: count(usage.thinking_tokens) }
                            : {}),
                          compactsAutomatically: true,
                        };
                        yield* publishEvent({
                          ...stamp,
                          provider: PROVIDER,
                          threadId,
                          turnId,
                          type: "thread.token-usage.updated",
                          payload: { usage: usageSnapshot },
                        });
                      }
                    } else if (step.step_type === "tool" && typeof step.tool_name === "string") {
                      const toolItemType = toolNameToItemType(step.tool_name);
                      const toolInfo =
                        typeof step.tool_info === "object" && step.tool_info !== null
                          ? (step.tool_info as Record<string, unknown>)
                          : undefined;
                      const toolDetail = toolParamsToDetail(toolInfo?.parameters);
                      const itemId = RuntimeItemId.make(`step-${step.step_index}`);

                      if (step.state === "ACTIVE") {
                        yield* publishEvent({
                          ...stamp,
                          provider: PROVIDER,
                          threadId,
                          turnId,
                          itemId,
                          type: "item.started",
                          payload: {
                            itemType: toolItemType,
                            status: "inProgress",
                            title: step.tool_name,
                            ...(toolDetail ? { detail: toolDetail } : {}),
                            ...(toolInfo ? { data: toolInfo } : {}),
                          },
                        });
                      } else if (step.state === "DONE") {
                        yield* publishEvent({
                          ...stamp,
                          provider: PROVIDER,
                          threadId,
                          turnId,
                          itemId,
                          type: "item.completed",
                          payload: {
                            itemType: toolItemType,
                            status: "completed",
                            title: step.tool_name,
                            ...(toolDetail ? { detail: toolDetail } : {}),
                            ...(toolInfo ? { data: toolInfo } : {}),
                          },
                        });
                      }
                    }
                  } else if (
                    data.event === "result" &&
                    typeof data.result === "object" &&
                    data.result !== null
                  ) {
                    const resultObj = data.result as Record<string, unknown>;
                    turnRecord.items.push(resultObj);
                    if (typeof resultObj.conversation_id === "string") {
                      ctx.antigravityConversationId = resultObj.conversation_id;
                    }
                  }
                }
              }),
            );

            const exitCode = yield* processHandle.exitCode;
            const isSuccess = exitCode === 0;

            yield* withThreadLock(
              threadId,
              Effect.gen(function* () {
                if (ctx.activeTurnId !== turnId) return;
                if (ctx.activeProcess === processHandle) {
                  ctx.activeProcess = undefined;
                }
                ctx.activeTurnId = undefined;

                const completedStamp = yield* makeEventStamp();
                yield* publishEvent({
                  ...completedStamp,
                  provider: PROVIDER,
                  threadId,
                  turnId,
                  type: "turn.completed",
                  payload: {
                    state: isSuccess ? "completed" : "failed",
                    ...(!isSuccess
                      ? { errorMessage: `Antigravity CLI process exited with code ${exitCode}` }
                      : {}),
                  },
                });
              }),
            );
          }).pipe(
            Effect.catchCause((cause) =>
              withThreadLock(
                threadId,
                Effect.gen(function* () {
                  if (Cause.hasInterruptsOnly(cause)) {
                    return yield* Effect.failCause(cause);
                  }
                  if (ctx.activeTurnId !== turnId) return;
                  if (ctx.activeProcess === processHandle) {
                    yield* processHandle.kill();
                    ctx.activeProcess = undefined;
                  }
                  ctx.activeTurnId = undefined;

                  const completedStamp = yield* makeEventStamp();
                  yield* publishEvent({
                    ...completedStamp,
                    provider: PROVIDER,
                    threadId,
                    turnId,
                    type: "turn.completed",
                    payload: {
                      state: "failed",
                      errorMessage: "Antigravity CLI process monitor failed.",
                    },
                  });
                  yield* Effect.logWarning("Antigravity process monitor failed", {
                    cause,
                  });
                }),
              ),
            ),
          );

          yield* Effect.forkChild(monitorEffect);

          return {
            threadId,
            turnId,
          };
        }),
      );

    const interruptTurn: AntigravityAdapterShape["interruptTurn"] = (threadId, turnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx) return;

          if (turnId !== undefined && ctx.activeTurnId !== turnId) {
            return;
          }

          const effectiveTurnId = turnId ?? ctx.activeTurnId;
          if (ctx.activeProcess) {
            yield* ctx.activeProcess.kill();
            ctx.activeProcess = undefined;
          }

          if (effectiveTurnId) {
            ctx.activeTurnId = undefined;
            const stamp = yield* makeEventStamp();

            yield* publishEvent({
              ...stamp,
              provider: PROVIDER,
              threadId,
              turnId: effectiveTurnId,
              type: "turn.aborted",
              payload: {
                reason: "Turn interrupted by user",
              },
            });

            yield* publishEvent({
              ...stamp,
              provider: PROVIDER,
              threadId,
              turnId: effectiveTurnId,
              type: "turn.completed",
              payload: {
                state: "interrupted",
              },
            });
          }
        }),
      );

    const respondToRequest: AntigravityAdapterShape["respondToRequest"] = () => Effect.void;

    const respondToUserInput: AntigravityAdapterShape["respondToUserInput"] = () => Effect.void;

    const stopSessionInternal = (
      ctx: AntigravitySessionContext,
    ): Effect.Effect<void, ProviderAdapterError, never> =>
      Effect.gen(function* () {
        ctx.stopped = true;
        if (ctx.activeProcess) {
          yield* ctx.activeProcess.kill();
          ctx.activeProcess = undefined;
        }

        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
        sessions.delete(ctx.threadId);

        const stamp = yield* makeEventStamp();
        yield* publishEvent({
          ...stamp,
          provider: PROVIDER,
          threadId: ctx.threadId,
          type: "session.exited",
          payload: {
            exitKind: "graceful",
          },
        });
      });

    const stopSession: AntigravityAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx) return;
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: AntigravityAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: AntigravityAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const readThread: AntigravityAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return {
          threadId,
          turns: ctx.turns.map((turn) => ({
            id: turn.id,
            items: turn.items,
          })),
        };
      });

    const rollbackThread: AntigravityAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
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
          detail: "Antigravity CLI sessions do not support provider-side rollback.",
        });
      });

    const stopAll: AntigravityAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() =>
          managedNativeEventLogger ? managedNativeEventLogger.close() : Effect.void,
        ),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

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
    } satisfies AntigravityAdapterShape;
  });
}
