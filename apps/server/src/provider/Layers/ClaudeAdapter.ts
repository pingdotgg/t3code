/**
 * ClaudeAdapterLive - CLI-based live implementation for the Claude Code provider adapter.
 *
 * Spawns `claude -p --output-format stream-json` per turn, parses NDJSON
 * stdout into canonical ProviderRuntimeEvent events, and manages session
 * continuity via `--session-id`.
 *
 * @module ClaudeAdapterLive
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";

import {
  type CanonicalItemType,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type RuntimeMode,
  EventId,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import { ProviderAdapterSessionNotFoundError } from "../Errors.ts";
import { ClaudeAdapter, type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import type {
  ProviderAdapterCapabilities,
  ProviderThreadSnapshot,
} from "../Services/ProviderAdapter.ts";

const PROVIDER = "claude" as const;
const SIGINT_TIMEOUT_MS = 5_000;

// ── Types ─────────────────────────────────────────────────────────

interface ClaudeSession {
  threadId: ThreadId;
  model: string;
  cwd: string;
  /** Claude session ID from the `system` init message, used for `--session-id`. */
  claudeSessionId: string | null;
  activeTurnId: TurnId | null;
  activeProcess: ChildProcess | null;
  status: "ready" | "running" | "stopped";
  runtimeMode: RuntimeMode;
  createdAt: string;
  updatedAt: string;
}

// ── Stream message types ──────────────────────────────────────────

interface ClaudeSystemMessage {
  type: "system";
  subtype: "init";
  session_id: string;
  tools: Array<{ name: string; type?: string }>;
  model?: string;
  cwd?: string;
}

interface ClaudeContentBlockText {
  type: "text";
  text: string;
}

interface ClaudeContentBlockThinking {
  type: "thinking";
  thinking: string;
}

interface ClaudeContentBlockToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

type ClaudeContentBlock =
  | ClaudeContentBlockText
  | ClaudeContentBlockThinking
  | ClaudeContentBlockToolUse;

interface ClaudeAssistantMessage {
  type: "assistant";
  message: {
    id: string;
    content: ClaudeContentBlock[];
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    stop_reason?: string | null;
  };
}

interface ClaudeToolResultMessage {
  type: "tool_result";
  tool_use_id: string;
  content?: string;
  is_error?: boolean;
}

interface ClaudeResultMessage {
  type: "result";
  subtype: "success" | "error";
  session_id: string;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  result?: string;
  error?: string;
}

type ClaudeStreamMessage =
  | ClaudeSystemMessage
  | ClaudeAssistantMessage
  | ClaudeToolResultMessage
  | ClaudeResultMessage;

// ── Tool normalization ────────────────────────────────────────────

function normalizeToolName(name: string): CanonicalItemType {
  switch (name) {
    case "Read":
    case "Glob":
    case "Grep":
      return "file_read";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return "file_change";
    case "Bash":
      return "command_execution";
    case "Agent":
    case "Skill":
      return "collab_agent_tool_call";
    case "WebSearch":
    case "WebFetch":
      return "web_search";
    default:
      if (name.startsWith("mcp__")) return "mcp_tool_call";
      return "unknown";
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function nextEventId(): string {
  return crypto.randomUUID();
}

function makeEvent(
  threadId: ThreadId,
  type: ProviderRuntimeEvent["type"],
  payload: ProviderRuntimeEvent["payload"],
  extra?: Partial<
    Pick<ProviderRuntimeEvent, "turnId" | "itemId" | "requestId" | "providerRefs" | "raw">
  >,
): ProviderRuntimeEvent {
  return {
    eventId: EventId.makeUnsafe(nextEventId()),
    provider: PROVIDER,
    threadId,
    createdAt: nowIso(),
    type,
    payload,
    ...extra,
  } as ProviderRuntimeEvent;
}

// ── NDJSON line parser ────────────────────────────────────────────

function parseNdjsonLines(buffer: string): { lines: string[]; remainder: string } {
  const parts = buffer.split("\n");
  const remainder = parts.pop() ?? "";
  return { lines: parts.filter((line) => line.trim().length > 0), remainder };
}

function tryParseJson(line: string): ClaudeStreamMessage | null {
  try {
    return JSON.parse(line) as ClaudeStreamMessage;
  } catch {
    return null;
  }
}

// ── CLI arg builder ───────────────────────────────────────────────

function buildCliArgs(options: {
  model: string;
  userMessage: string;
  claudeSessionId: string | null;
  runtimeMode: RuntimeMode;
}): string[] {
  const args: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    options.model,
  ];

  if (options.claudeSessionId) {
    args.push("--resume", options.claudeSessionId);
  }

  if (options.runtimeMode === "full-access") {
    args.push("--dangerously-skip-permissions");
  }

  args.push(options.userMessage);
  return args;
}

// ── Adapter implementation ────────────────────────────────────────

export interface ClaudeAdapterLiveOptions {
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly binaryPath?: string;
}

export function makeClaudeAdapterLive(options?: ClaudeAdapterLiveOptions) {
  return Layer.effect(
    ClaudeAdapter,
    Effect.gen(function* () {
      const sessions = new Map<string, ClaudeSession>();
      const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const nativeEventLogger = options?.nativeEventLogger;
      const binaryPath = options?.binaryPath || "claude";

      const emit = (event: ProviderRuntimeEvent) => {
        Effect.runSync(Queue.offer(eventQueue, event));
        if (nativeEventLogger) {
          Effect.runFork(nativeEventLogger.write(event, event.threadId));
        }
      };

      const streamEvents: ClaudeAdapterShape["streamEvents"] = Stream.fromQueue(eventQueue);

      const getSession = (threadId: ThreadId): Effect.Effect<ClaudeSession, ProviderAdapterSessionNotFoundError> =>
        Effect.gen(function* () {
          const session = sessions.get(threadId);
          if (!session) {
            return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
          }
          return session;
        });

      const capabilities: ProviderAdapterCapabilities = {
        sessionModelSwitch: "in-session",
      };

      // ── Stream message handler ────────────────────────────────

      function handleStreamMessages(
        session: ClaudeSession,
        turnId: TurnId,
      ): (message: ClaudeStreamMessage) => void {
        let currentTextItemId: string | null = null;
        let currentThinkingItemId: string | null = null;

        return (message: ClaudeStreamMessage) => {
          const threadId = session.threadId;

          switch (message.type) {
            case "system": {
              if (message.subtype === "init") {
                session.claudeSessionId = message.session_id;
                if (message.model) session.model = message.model;
                if (message.cwd) session.cwd = message.cwd;
              }
              break;
            }

            case "assistant": {
              const content = message.message?.content;
              if (!Array.isArray(content)) break;

              for (const block of content) {
                switch (block.type) {
                  case "text": {
                    if (!currentTextItemId) {
                      currentTextItemId = nextEventId();
                      emit(
                        makeEvent(
                          threadId,
                          "item.started",
                          { itemType: "assistant_message", title: "Response" },
                          {
                            turnId,
                            itemId: RuntimeItemId.makeUnsafe(currentTextItemId),
                          },
                        ),
                      );
                    }
                    if (block.text) {
                      emit(
                        makeEvent(
                          threadId,
                          "content.delta",
                          { streamKind: "assistant_text", delta: block.text },
                          {
                            turnId,
                            itemId: RuntimeItemId.makeUnsafe(currentTextItemId),
                          },
                        ),
                      );
                    }
                    break;
                  }

                  case "thinking": {
                    if (!currentThinkingItemId) {
                      currentThinkingItemId = nextEventId();
                      emit(
                        makeEvent(
                          threadId,
                          "item.started",
                          { itemType: "reasoning", title: "Thinking" },
                          {
                            turnId,
                            itemId: RuntimeItemId.makeUnsafe(currentThinkingItemId),
                          },
                        ),
                      );
                    }
                    if (block.thinking) {
                      emit(
                        makeEvent(
                          threadId,
                          "content.delta",
                          { streamKind: "reasoning_text", delta: block.thinking },
                          {
                            turnId,
                            itemId: RuntimeItemId.makeUnsafe(currentThinkingItemId),
                          },
                        ),
                      );
                    }
                    break;
                  }

                  case "tool_use": {
                    // Close open text/thinking items before tool use
                    if (currentTextItemId) {
                      emit(
                        makeEvent(
                          threadId,
                          "item.completed",
                          { itemType: "assistant_message", status: "completed" },
                          {
                            turnId,
                            itemId: RuntimeItemId.makeUnsafe(currentTextItemId),
                          },
                        ),
                      );
                      currentTextItemId = null;
                    }
                    if (currentThinkingItemId) {
                      emit(
                        makeEvent(
                          threadId,
                          "item.completed",
                          { itemType: "reasoning", status: "completed" },
                          {
                            turnId,
                            itemId: RuntimeItemId.makeUnsafe(currentThinkingItemId),
                          },
                        ),
                      );
                      currentThinkingItemId = null;
                    }

                    const canonicalType = normalizeToolName(block.name);
                    const toolItemId = block.id;
                    emit(
                      makeEvent(
                        threadId,
                        "item.started",
                        {
                          itemType: canonicalType,
                          title: block.name,
                          data: block.input,
                        },
                        {
                          turnId,
                          itemId: RuntimeItemId.makeUnsafe(toolItemId),
                        },
                      ),
                    );
                    break;
                  }
                }
              }
              break;
            }

            case "tool_result": {
              emit(
                makeEvent(
                  threadId,
                  "item.completed",
                  {
                    itemType: "unknown",
                    status: message.is_error ? "failed" : "completed",
                    detail: message.content,
                  },
                  {
                    turnId,
                    itemId: RuntimeItemId.makeUnsafe(message.tool_use_id),
                  },
                ),
              );
              break;
            }

            case "result": {
              // Close any open items
              if (currentTextItemId) {
                emit(
                  makeEvent(
                    threadId,
                    "item.completed",
                    { itemType: "assistant_message", status: "completed" },
                    {
                      turnId,
                      itemId: RuntimeItemId.makeUnsafe(currentTextItemId),
                    },
                  ),
                );
                currentTextItemId = null;
              }
              if (currentThinkingItemId) {
                emit(
                  makeEvent(
                    threadId,
                    "item.completed",
                    { itemType: "reasoning", status: "completed" },
                    {
                      turnId,
                      itemId: RuntimeItemId.makeUnsafe(currentThinkingItemId),
                    },
                  ),
                );
                currentThinkingItemId = null;
              }

              const isError = message.subtype === "error";
              emit(
                makeEvent(
                  threadId,
                  "turn.completed",
                  {
                    state: isError ? "failed" : "completed",
                    stopReason: isError ? (message.error ?? "error") : "end_turn",
                    totalCostUsd: message.total_cost_usd ?? message.cost_usd,
                    usage: message.usage,
                    ...(isError && message.error ? { errorMessage: message.error } : {}),
                  },
                  { turnId },
                ),
              );
              break;
            }
          }
        };
      }

      // ── Process runner ──────────────────────────────────────────

      function runClaudeProcess(session: ClaudeSession, turnId: TurnId, userMessage: string): void {
        const args = buildCliArgs({
          model: session.model,
          userMessage,
          claudeSessionId: session.claudeSessionId,
          runtimeMode: session.runtimeMode,
        });

        const { CLAUDECODE: _, ...cleanEnv } = process.env;
        const proc = spawn(binaryPath, args, {
          cwd: session.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: cleanEnv,
        });

        session.activeProcess = proc;
        session.status = "running";
        session.updatedAt = nowIso();

        // Close stdin so the CLI does not wait for interactive input.
        proc.stdin?.end();

        const handler = handleStreamMessages(session, turnId);
        let buffer = "";

        proc.stdout?.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf-8");
          buffer += text;
          const { lines, remainder } = parseNdjsonLines(buffer);
          buffer = remainder;

          for (const line of lines) {
            if (nativeEventLogger) {
              Effect.runFork(
                nativeEventLogger.write(
                  { source: "claude.sdk.stream-json", payload: line },
                  session.threadId,
                ),
              );
            }

            const parsed = tryParseJson(line);
            if (parsed) {
              handler(parsed);
            }
          }
        });

        proc.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf-8").trim();
          if (text) {
            emit(
              makeEvent(session.threadId, "runtime.warning", {
                message: text,
              }, { turnId }),
            );
          }
        });

        proc.on("error", (error) => {
          emit(
            makeEvent(session.threadId, "runtime.error", {
              message: error.message,
              class: "transport_error",
            }, { turnId }),
          );
          emit(
            makeEvent(session.threadId, "session.exited", {
              reason: error.message,
              exitKind: "error",
              recoverable: false,
            }),
          );
          session.activeProcess = null;
          session.status = "ready";
          session.updatedAt = nowIso();
        });

        proc.on("close", (code) => {
          session.activeProcess = null;
          session.status = "ready";
          session.updatedAt = nowIso();

          // Process any remaining buffer
          if (buffer.trim()) {
            const parsed = tryParseJson(buffer.trim());
            if (parsed) {
              handler(parsed);
            }
          }

          // If exit code is non-zero and no result event was emitted, emit error
          if (code !== null && code !== 0) {
            emit(
              makeEvent(session.threadId, "runtime.error", {
                message: `Claude process exited with code ${code}`,
                class: "transport_error",
              }, { turnId }),
            );
          }
        });
      }

      // ── Adapter methods ─────────────────────────────────────────

      const startSession: ClaudeAdapterShape["startSession"] = (input) =>
        Effect.sync(() => {
          const now = nowIso();
          const threadId = input.threadId;
          const model = input.model ?? "claude-sonnet-4-6";
          const cwd = input.cwd ?? process.cwd();
          const runtimeMode = input.runtimeMode ?? "full-access";

          const session: ClaudeSession = {
            threadId,
            model,
            cwd,
            claudeSessionId: null,
            activeTurnId: null,
            activeProcess: null,
            status: "ready",
            runtimeMode,
            createdAt: now,
            updatedAt: now,
          };
          sessions.set(threadId, session);

          emit(
            makeEvent(threadId, "session.started", {
              message: `Claude Code session started (model: ${model})`,
            }),
          );
          emit(
            makeEvent(threadId, "session.state.changed", {
              state: "ready",
            }),
          );

          return {
            provider: PROVIDER,
            status: "ready",
            runtimeMode,
            cwd,
            model,
            threadId,
            createdAt: now,
            updatedAt: now,
          } as ProviderSession;
        });

      const sendTurn: ClaudeAdapterShape["sendTurn"] = (input) =>
        Effect.gen(function* () {
          const session = yield* getSession(input.threadId);
          const turnId = TurnId.makeUnsafe(`turn-${nextEventId()}`);

          if (input.model) {
            session.model = input.model;
          }

          session.activeTurnId = turnId;
          session.updatedAt = nowIso();

          emit(
            makeEvent(session.threadId, "session.state.changed", {
              state: "running",
            }),
          );
          emit(
            makeEvent(session.threadId, "turn.started", {
              model: session.model,
            }, { turnId }),
          );

          const userMessage = input.input ?? "";
          runClaudeProcess(session, turnId, userMessage);

          return {
            threadId: session.threadId,
            turnId,
          } satisfies ProviderTurnStartResult;
        });

      const interruptTurn: ClaudeAdapterShape["interruptTurn"] = (threadId) =>
        Effect.gen(function* () {
          const session = yield* getSession(threadId);
          const proc = session.activeProcess;
          if (!proc) return;

          proc.kill("SIGINT");

          // If still alive after timeout, force kill
          const killTimeout = setTimeout(() => {
            if (!proc.killed) {
              proc.kill("SIGKILL");
            }
          }, SIGINT_TIMEOUT_MS);

          proc.once("close", () => {
            clearTimeout(killTimeout);
          });

          const turnId = session.activeTurnId;
          if (turnId) {
            emit(
              makeEvent(threadId, "turn.completed", {
                state: "interrupted",
                stopReason: "user_interrupt",
              }, { turnId }),
            );
          }

          session.activeProcess = null;
          session.status = "ready";
          session.activeTurnId = null;
          session.updatedAt = nowIso();

          emit(
            makeEvent(threadId, "session.state.changed", {
              state: "ready",
            }),
          );
        });

      const respondToRequest: ClaudeAdapterShape["respondToRequest"] = () =>
        Effect.void;

      const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = () =>
        Effect.void;

      const stopSession: ClaudeAdapterShape["stopSession"] = (threadId) =>
        Effect.gen(function* () {
          const session = sessions.get(threadId);
          if (!session) return;

          if (session.activeProcess) {
            session.activeProcess.kill("SIGINT");
            // Wait briefly then force kill
            const proc = session.activeProcess;
            const killTimeout = setTimeout(() => {
              if (proc && !proc.killed) {
                proc.kill("SIGKILL");
              }
            }, SIGINT_TIMEOUT_MS);
            proc.once("close", () => clearTimeout(killTimeout));
            session.activeProcess = null;
          }

          session.status = "stopped";
          session.updatedAt = nowIso();
          sessions.delete(threadId);

          emit(
            makeEvent(threadId, "session.state.changed", {
              state: "stopped",
              reason: "stopped",
            }),
          );
          emit(
            makeEvent(threadId, "session.exited", {
              reason: "stopped",
              exitKind: "graceful",
            }),
          );
        });

      const listSessions: ClaudeAdapterShape["listSessions"] = () =>
        Effect.sync(() =>
          Array.from(sessions.values()).map(
            (s) =>
              ({
                provider: PROVIDER,
                status: s.status === "stopped" ? "closed" : s.status,
                runtimeMode: s.runtimeMode,
                cwd: s.cwd,
                model: s.model,
                threadId: s.threadId,
                createdAt: s.createdAt,
                updatedAt: s.updatedAt,
              }) as ProviderSession,
          ),
        );

      const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
        Effect.sync(() => sessions.has(threadId));

      const readThread: ClaudeAdapterShape["readThread"] = (threadId) =>
        Effect.gen(function* () {
          yield* getSession(threadId);
          return {
            threadId,
            turns: [],
          } satisfies ProviderThreadSnapshot;
        });

      const rollbackThread: ClaudeAdapterShape["rollbackThread"] = (threadId) =>
        Effect.gen(function* () {
          yield* getSession(threadId);
          // Claude CLI does not support turn-level rollback; return empty snapshot.
          return {
            threadId,
            turns: [],
          } satisfies ProviderThreadSnapshot;
        });

      const stopAll: ClaudeAdapterShape["stopAll"] = () =>
        Effect.gen(function* () {
          for (const threadId of sessions.keys()) {
            yield* stopSession(ThreadId.makeUnsafe(threadId));
          }
        });

      return {
        provider: PROVIDER,
        capabilities,
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
      } satisfies ClaudeAdapterShape;
    }),
  );
}
