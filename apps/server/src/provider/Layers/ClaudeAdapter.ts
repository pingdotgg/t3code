import { spawn } from "node:child_process";

import {
  type CanonicalItemType,
  EventId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { ClaudeAdapter, type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";

const PROVIDER = "claude" as const;

export interface ClaudeAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface ClaudeToolState {
  readonly itemId: ProviderItemId;
  readonly itemType: CanonicalItemType;
  readonly title: string;
}

interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly child: ReturnType<typeof spawn>;
  readonly toolStates: Map<string, ClaudeToolState>;
  assistantItemId?: ProviderItemId;
  completed: boolean;
  interrupted: boolean;
}

interface ClaudeSessionState {
  session: ProviderSession;
  readonly binaryPath: string;
  hasConversation: boolean;
  currentTurn: ClaudeTurnState | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomEventId(): ReturnType<typeof EventId.makeUnsafe> {
  return EventId.makeUnsafe(crypto.randomUUID());
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function coerceDetail(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    const joined = value
      .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
      .join("\n")
      .trim();
    return joined.length > 0 ? joined : undefined;
  }

  if (value !== undefined) {
    try {
      const serialized = JSON.stringify(value);
      return serialized.length > 2 ? serialized : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function toValidationError(operation: string, issue: string, cause?: unknown) {
  return new ProviderAdapterValidationError({
    provider: PROVIDER,
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function toRequestError(method: string, detail: string, cause?: unknown) {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function toProcessError(threadId: ThreadId, detail: string, cause?: unknown) {
  return new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function buildSession(input: {
  readonly threadId: ThreadId;
  readonly cwd?: string;
  readonly model?: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly sessionId: string;
}): ProviderSession {
  const createdAt = nowIso();
  return {
    provider: PROVIDER,
    status: "ready",
    runtimeMode: input.runtimeMode,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.model ? { model: input.model } : {}),
    threadId: input.threadId,
    resumeCursor: input.sessionId,
    createdAt,
    updatedAt: createdAt,
  };
}

function permissionModeFor(input: {
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly interactionMode: ProviderSendTurnInput["interactionMode"];
}): "default" | "bypassPermissions" | "plan" {
  if (input.interactionMode === "plan") {
    return "plan";
  }
  return input.runtimeMode === "approval-required" ? "default" : "bypassPermissions";
}

function toolItemType(name: string): CanonicalItemType {
  const normalized = name.trim().toLowerCase();
  if (normalized === "bash") return "command_execution";
  if (normalized === "edit" || normalized === "write" || normalized === "notebookedit")
    return "file_change";
  if (normalized === "websearch" || normalized === "webfetch") return "web_search";
  if (normalized.startsWith("mcp__")) return "mcp_tool_call";
  return "dynamic_tool_call";
}

function toolTitle(name: string): string {
  switch (toolItemType(name)) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "web_search":
      return "Web search";
    case "mcp_tool_call":
      return "MCP tool call";
    default:
      return name.trim() || "Tool call";
  }
}

function toolDetail(name: string, input: unknown): string | undefined {
  const record = asRecord(input);
  const detail =
    asString(record?.command) ??
    asString(record?.description) ??
    asString(record?.file_path) ??
    asString(record?.path) ??
    asString(record?.query);

  return detail ?? coerceDetail(input);
}

function buildRaw(record: unknown, method: string): ProviderRuntimeEvent["raw"] {
  return {
    source: "claude.cli",
    method,
    payload: record,
  };
}

function buildBaseEvent(input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly itemId?: ProviderItemId;
  readonly raw?: ProviderRuntimeEvent["raw"];
}) {
  return {
    eventId: randomEventId(),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.makeUnsafe(input.itemId) } : {}),
    ...(input.raw ? { raw: input.raw } : {}),
  } satisfies Omit<ProviderRuntimeEvent, "type" | "payload">;
}

export function makeClaudeAdapterLive(options?: ClaudeAdapterLiveOptions) {
  return Layer.effect(
    ClaudeAdapter,
    Effect.gen(function* () {
      const nativeEventLogger =
        options?.nativeEventLogger ??
        (options?.nativeEventLogPath !== undefined
          ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
              stream: "native",
            })
          : undefined);

      const sessions = new Map<ThreadId, ClaudeSessionState>();
      const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

      const publish = (event: ProviderRuntimeEvent) =>
        Effect.gen(function* () {
          if (nativeEventLogger) {
            yield* nativeEventLogger.write(event.raw ?? event, event.threadId);
          }
          yield* Queue.offer(eventQueue, event).pipe(Effect.asVoid);
        });

      const publishFork = (event: ProviderRuntimeEvent) => {
        void Effect.runFork(publish(event));
      };

      const getSessionState = (threadId: ThreadId) => {
        const state = sessions.get(threadId);
        if (!state) {
          return Effect.fail(
            new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            }),
          );
        }
        return Effect.succeed(state);
      };

      const emitSessionReady = (state: ClaudeSessionState) =>
        Effect.all([
          publish({
            ...buildBaseEvent({
              threadId: state.session.threadId,
              raw: buildRaw(
                { sessionId: state.session.resumeCursor, model: state.session.model },
                "session/started",
              ),
            }),
            type: "session.started",
            payload: {
              message: "Claude Code session ready",
              resume: state.session.resumeCursor,
            },
          }),
          publish({
            ...buildBaseEvent({
              threadId: state.session.threadId,
              raw: buildRaw({ state: "ready" }, "session/state"),
            }),
            type: "session.state.changed",
            payload: {
              state: "ready",
              reason: "Claude Code session ready",
            },
          }),
        ]).pipe(Effect.asVoid);

      const finalizeTurn = (input: {
        readonly threadId: ThreadId;
        readonly turnId: TurnId;
        readonly state: "completed" | "failed" | "interrupted";
        readonly stopReason?: string | null;
        readonly usage?: unknown;
        readonly modelUsage?: Record<string, unknown>;
        readonly totalCostUsd?: number;
        readonly errorMessage?: string;
      }) =>
        Effect.gen(function* () {
          const state = yield* getSessionState(input.threadId);
          state.currentTurn = null;
          state.session = {
            ...state.session,
            status: input.state === "failed" ? "error" : "ready",
            activeTurnId: undefined,
            updatedAt: nowIso(),
            ...(input.errorMessage ? { lastError: input.errorMessage } : {}),
          };
          sessions.set(input.threadId, state);

          yield* publish({
            ...buildBaseEvent({
              threadId: input.threadId,
              turnId: input.turnId,
              raw: buildRaw(
                {
                  state: input.state,
                  stopReason: input.stopReason,
                  usage: input.usage,
                  modelUsage: input.modelUsage,
                  totalCostUsd: input.totalCostUsd,
                  errorMessage: input.errorMessage,
                },
                "turn/completed",
              ),
            }),
            type: "turn.completed",
            payload: {
              state: input.state,
              ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
              ...(input.usage !== undefined ? { usage: input.usage } : {}),
              ...(input.modelUsage !== undefined ? { modelUsage: input.modelUsage } : {}),
              ...(input.totalCostUsd !== undefined ? { totalCostUsd: input.totalCostUsd } : {}),
              ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
            },
          });

          yield* publish({
            ...buildBaseEvent({
              threadId: input.threadId,
              raw: buildRaw({ state: state.session.status }, "session/state"),
            }),
            type: "session.state.changed",
            payload: {
              state: input.state === "failed" ? "error" : "ready",
              ...(input.errorMessage ? { reason: input.errorMessage } : {}),
            },
          });
        });

      const startSession: ClaudeAdapterShape["startSession"] = (input) =>
        Effect.gen(function* () {
          if (input.provider && input.provider !== PROVIDER) {
            return yield* toValidationError(
              "ClaudeAdapter.startSession",
              `Expected provider '${PROVIDER}', received '${input.provider}'.`,
            );
          }

          const resumeCursor =
            typeof input.resumeCursor === "string" && input.resumeCursor.trim().length > 0
              ? input.resumeCursor.trim()
              : crypto.randomUUID();

          const binaryPath =
            input.providerOptions?.claude?.binaryPath?.trim() || "claude";
          const session = buildSession({
            threadId: input.threadId,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.model ? { model: input.model } : {}),
            runtimeMode: input.runtimeMode,
            sessionId: resumeCursor,
          });

          const existing = sessions.get(input.threadId);
          if (existing?.currentTurn) {
            existing.currentTurn.interrupted = true;
            existing.currentTurn.child.kill("SIGTERM");
          }

          const nextState: ClaudeSessionState = {
            session,
            binaryPath,
            hasConversation: input.resumeCursor !== undefined,
            currentTurn: null,
          };
          sessions.set(input.threadId, nextState);
          yield* emitSessionReady(nextState);
          return session;
        });

      const sendTurn: ClaudeAdapterShape["sendTurn"] = (input) =>
        Effect.gen(function* () {
          if (input.attachments && input.attachments.length > 0) {
            return yield* toValidationError(
              "ClaudeAdapter.sendTurn",
              "Claude Code CLI image attachments are not supported yet.",
            );
          }

          const state = yield* getSessionState(input.threadId);
          if (state.currentTurn) {
            return yield* toRequestError(
              "claude.sendTurn",
              `A Claude turn is already running for thread '${input.threadId}'.`,
            );
          }

          const turnId = TurnId.makeUnsafe(crypto.randomUUID());
          const sessionId = String(state.session.resumeCursor ?? crypto.randomUUID());
          const model = input.model ?? state.session.model;
          const args = [
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--permission-mode",
            permissionModeFor({
              runtimeMode: state.session.runtimeMode,
              interactionMode: input.interactionMode,
            }),
          ];

          if (model) {
            args.push("--model", model);
          }

          if (state.hasConversation) {
            args.push("--resume", sessionId);
          } else {
            args.push("--session-id", sessionId);
          }

          if (input.input) {
            args.push(input.input);
          }

          const child = yield* Effect.try({
            try: () =>
              spawn(state.binaryPath, args, {
                cwd: state.session.cwd ?? process.cwd(),
                env: process.env,
                stdio: ["ignore", "pipe", "pipe"],
              }),
            catch: (cause) =>
              toProcessError(
                input.threadId,
                `Failed to spawn Claude Code CLI '${state.binaryPath}'.`,
                cause,
              ),
          });

          const turnState: ClaudeTurnState = {
            turnId,
            child,
            toolStates: new Map(),
            completed: false,
            interrupted: false,
          };
          state.currentTurn = turnState;
          state.session = {
            ...state.session,
            ...(model ? { model } : {}),
            status: "running",
            activeTurnId: turnId,
            updatedAt: nowIso(),
          };
          state.session = {
            ...state.session,
            resumeCursor: sessionId,
          };
          sessions.set(input.threadId, state);

          yield* publish({
            ...buildBaseEvent({
              threadId: input.threadId,
              turnId,
              raw: buildRaw({ model }, "turn/started"),
            }),
            type: "turn.started",
            payload: model ? { model } : {},
          });

          yield* publish({
            ...buildBaseEvent({
              threadId: input.threadId,
              raw: buildRaw({ state: "running" }, "session/state"),
            }),
            type: "session.state.changed",
            payload: {
              state: "running",
              reason: "Claude Code turn started",
            },
          });

          let stdoutBuffer = "";
          let stderrBuffer = "";

          const processClaudeRecord = (record: Record<string, unknown>) => {
            const type = asString(record.type);
            if (!type) {
              return;
            }

            if (type === "stream_event") {
              const event = asRecord(record.event);
              const eventType = asString(event?.type);
              if (eventType === "message_start") {
                const message = asRecord(event?.message);
                const messageId = asString(message?.id);
                if (messageId) {
                  turnState.assistantItemId = ProviderItemId.makeUnsafe(messageId);
                }
                return;
              }

              if (eventType === "content_block_delta") {
                const delta = asRecord(event?.delta);
                const deltaType = asString(delta?.type);
                if (deltaType === "text_delta" && turnState.assistantItemId) {
                  publishFork({
                    ...buildBaseEvent({
                      threadId: input.threadId,
                      turnId,
                      itemId: turnState.assistantItemId,
                      raw: buildRaw(record, "stream_event/content_block_delta"),
                    }),
                    type: "content.delta",
                    payload: {
                      streamKind: "assistant_text",
                      delta: asString(delta?.text) ?? "",
                    },
                  });
                }
                return;
              }

              return;
            }

            if (type === "assistant") {
              const message = asRecord(record.message);
              const messageId = asString(message?.id);
              const content = Array.isArray(message?.content) ? message.content : [];
              for (const block of content) {
                const contentBlock = asRecord(block);
                const contentType = asString(contentBlock?.type);
                if (contentType === "thinking") {
                  const thinking = asString(contentBlock?.thinking);
                  if (thinking) {
                    publishFork({
                      ...buildBaseEvent({
                        threadId: input.threadId,
                        turnId,
                        raw: buildRaw(record, "assistant/thinking"),
                      }),
                      type: "task.progress",
                      payload: {
                        taskId: RuntimeTaskId.makeUnsafe(`claude-thinking:${turnId}`),
                        description: thinking,
                      },
                    });
                  }
                  continue;
                }

                if (contentType === "tool_use") {
                  const toolId = asString(contentBlock?.id);
                  const toolName = asString(contentBlock?.name) ?? "Tool";
                  if (!toolId || turnState.toolStates.has(toolId)) {
                    continue;
                  }
                  const itemId = ProviderItemId.makeUnsafe(toolId);
                  const nextToolState: ClaudeToolState = {
                    itemId,
                    itemType: toolItemType(toolName),
                    title: toolTitle(toolName),
                  };
                  turnState.toolStates.set(toolId, nextToolState);
                  publishFork({
                    ...buildBaseEvent({
                      threadId: input.threadId,
                      turnId,
                      itemId,
                      raw: buildRaw(record, `assistant/tool_use/${toolName}`),
                    }),
                    type: "item.started",
                    payload: {
                      itemType: nextToolState.itemType,
                      status: "inProgress",
                      title: nextToolState.title,
                      ...(toolDetail(toolName, contentBlock?.input)
                        ? { detail: toolDetail(toolName, contentBlock?.input) }
                        : {}),
                      data: contentBlock,
                    },
                  });
                  continue;
                }

                if (contentType === "text") {
                  const text = asString(contentBlock?.text);
                  const itemId = messageId
                    ? ProviderItemId.makeUnsafe(messageId)
                    : turnState.assistantItemId;
                  if (text && itemId) {
                    publishFork({
                      ...buildBaseEvent({
                        threadId: input.threadId,
                        turnId,
                        itemId,
                        raw: buildRaw(record, "assistant/message"),
                      }),
                      type: "item.completed",
                      payload: {
                        itemType: "assistant_message",
                        status: "completed",
                        title: "Assistant message",
                        detail: text,
                        data: contentBlock,
                      },
                    });
                  }
                }
              }
              return;
            }

            if (type === "user") {
              const message = asRecord(record.message);
              const content = Array.isArray(message?.content) ? message.content : [];
              for (const block of content) {
                const contentBlock = asRecord(block);
                if (asString(contentBlock?.type) !== "tool_result") {
                  continue;
                }
                const toolUseId = asString(contentBlock?.tool_use_id);
                if (!toolUseId) {
                  continue;
                }
                const toolState = turnState.toolStates.get(toolUseId);
                const itemId = toolState?.itemId ?? ProviderItemId.makeUnsafe(toolUseId);
                publishFork({
                  ...buildBaseEvent({
                    threadId: input.threadId,
                    turnId,
                    itemId,
                    raw: buildRaw(record, "user/tool_result"),
                  }),
                  type: "item.completed",
                  payload: {
                    itemType: toolState?.itemType ?? "dynamic_tool_call",
                    status: contentBlock?.is_error === true ? "failed" : "completed",
                    title: toolState?.title ?? "Tool call",
                    ...(coerceDetail(contentBlock?.content)
                      ? { detail: coerceDetail(contentBlock?.content) }
                      : {}),
                    data: contentBlock,
                  },
                });
                turnState.toolStates.delete(toolUseId);
              }
              return;
            }

            if (type === "result") {
              turnState.completed = true;
              const permissionDenials = Array.isArray(record.permission_denials)
                ? record.permission_denials
                : [];
              const errorMessage =
                record.is_error === true
                  ? coerceDetail(record.errors) ?? asString(record.result) ?? "Claude turn failed"
                  : permissionDenials.length > 0
                    ? `Claude denied ${permissionDenials.length} tool request(s).`
                    : undefined;
              const stopReason =
                asString(record.stop_reason) ??
                (record.subtype === "success" ? "end_turn" : asString(record.subtype)) ??
                null;

              void Effect.runFork(
                finalizeTurn({
                  threadId: input.threadId,
                  turnId,
                  state: errorMessage ? "failed" : "completed",
                  ...(stopReason !== null ? { stopReason } : {}),
                  ...(record.usage !== undefined ? { usage: record.usage } : {}),
                  ...(asRecord(record.modelUsage) ? { modelUsage: record.modelUsage as Record<string, unknown> } : {}),
                  ...(typeof record.total_cost_usd === "number"
                    ? { totalCostUsd: record.total_cost_usd }
                    : {}),
                  ...(errorMessage ? { errorMessage } : {}),
                }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to finalize Claude turn", {
                      threadId: input.threadId,
                      error,
                    }),
                  ),
                ),
              );
            }
          };

          const drainStdout = (chunk: Buffer) => {
            stdoutBuffer += chunk.toString("utf8");
            while (true) {
              const newlineIndex = stdoutBuffer.indexOf("\n");
              if (newlineIndex === -1) {
                return;
              }
              const line = stdoutBuffer.slice(0, newlineIndex).trim();
              stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
              if (!line) {
                continue;
              }
              try {
                const record = JSON.parse(line) as Record<string, unknown>;
                processClaudeRecord(record);
              } catch (error) {
                publishFork({
                  ...buildBaseEvent({
                    threadId: input.threadId,
                    turnId,
                    raw: buildRaw({ line }, "stdout/parse-error"),
                  }),
                  type: "runtime.warning",
                  payload: {
                    message: "Received invalid JSON from Claude Code CLI.",
                    detail: error instanceof Error ? error.message : String(error),
                  },
                });
              }
            }
          };

          child.stdout.on("data", drainStdout);
          child.stderr.on("data", (chunk: Buffer) => {
            stderrBuffer += chunk.toString("utf8");
          });
          child.once("error", (error) => {
            publishFork({
              ...buildBaseEvent({
                threadId: input.threadId,
                turnId,
                raw: buildRaw({ error: String(error) }, "process/error"),
              }),
              type: "runtime.error",
              payload: {
                message: `Claude Code process error: ${error.message}`,
                class: "provider_error",
              },
            });
          });
          child.once("exit", (code, signal) => {
            if (turnState.completed) {
              const current = sessions.get(input.threadId);
              if (current) {
                current.hasConversation = true;
                sessions.set(input.threadId, current);
              }
              return;
            }

            const interrupted = turnState.interrupted;
            const errorMessage =
              interrupted
                ? "Claude turn interrupted."
                : stderrBuffer.trim().length > 0
                  ? stderrBuffer.trim()
                  : `Claude Code exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`;

            void Effect.runFork(
              finalizeTurn({
                threadId: input.threadId,
                turnId,
                state: interrupted ? "interrupted" : "failed",
                ...(interrupted ? {} : { errorMessage }),
              }).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("failed to finalize Claude turn after exit", {
                    threadId: input.threadId,
                    error,
                  }),
                ),
              ),
            );
          });

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: sessionId,
          };
        });

      const interruptTurn: ClaudeAdapterShape["interruptTurn"] = (threadId) =>
        Effect.gen(function* () {
          const state = yield* getSessionState(threadId);
          if (!state.currentTurn) {
            return;
          }
          state.currentTurn.interrupted = true;
          state.currentTurn.child.kill("SIGTERM");
        });

      const stopSession: ClaudeAdapterShape["stopSession"] = (threadId) =>
        Effect.gen(function* () {
          const state = yield* getSessionState(threadId);
          if (state.currentTurn) {
            state.currentTurn.interrupted = true;
            state.currentTurn.child.kill("SIGTERM");
          }
          sessions.delete(threadId);
          yield* publish({
            ...buildBaseEvent({
              threadId,
              raw: buildRaw({ exitKind: "graceful" }, "session/exited"),
            }),
            type: "session.exited",
            payload: {
              exitKind: "graceful",
            },
          });
        });

      const stopAll: ClaudeAdapterShape["stopAll"] = () =>
        Effect.forEach([...sessions.keys()], (threadId) => stopSession(threadId)).pipe(Effect.asVoid);

      const unsupportedRequest = (method: string, detail: string) =>
        Effect.fail(toRequestError(method, detail));

      return {
        provider: PROVIDER,
        capabilities: {
          sessionModelSwitch: "in-session",
        },
        startSession,
        sendTurn,
        interruptTurn,
        respondToRequest: () =>
          unsupportedRequest(
            "claude.respondToRequest",
            "Claude Code CLI approval responses are not supported in print mode.",
          ),
        respondToUserInput: () =>
          unsupportedRequest(
            "claude.respondToUserInput",
            "Claude Code CLI structured user input is not supported in print mode.",
          ),
        stopSession,
        listSessions: () => Effect.sync(() => [...sessions.values()].map((state) => state.session)),
        hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
        readThread: (threadId) =>
          Effect.sync(
            () =>
              ({
                threadId,
                turns: [],
              }) satisfies ProviderThreadSnapshot,
          ),
        rollbackThread: (threadId) =>
          unsupportedRequest(
            "claude.rollbackThread",
            `Claude Code CLI does not support rolling back thread '${threadId}'.`,
          ) as Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError>,
        stopAll,
        streamEvents: Stream.fromQueue(eventQueue),
      } satisfies ClaudeAdapterShape;
    }),
  );
}
