import { randomUUID } from "node:crypto";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";

import {
  type CanonicalItemType,
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  RuntimeItemId,
  RuntimeRequestId,
  type ProviderSession,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  resolveReasoningEffortForProvider,
  supportsReasoningEffortForModel,
} from "@t3tools/shared/model";
import { Effect, Layer, PubSub, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
} from "../Errors.ts";
import { ClaudeCodeAdapter, type ClaudeCodeAdapterShape } from "../Services/ClaudeCodeAdapter.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "claudeCode" as const;
const ASSISTANT_ITEM_PREFIX = "claude-assistant";
const TOOL_ITEM_PREFIX = "claude-tool";
const DEFAULT_BINARY_PATH = "claude";

export interface ClaudeCodeAdapterLiveOptions {
  readonly binaryPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface ClaudeResumeCursor {
  readonly sessionId: string;
}

interface ClaudeToolItemState {
  readonly itemId: RuntimeItemId;
  readonly itemType: Extract<
    CanonicalItemType,
    "command_execution" | "file_change" | "web_search" | "dynamic_tool_call" | "collab_agent_tool_call"
  >;
  readonly title: string;
  readonly detail?: string;
}

interface ActiveTurnState {
  readonly turnId: TurnId;
  readonly child: ChildProcessWithoutNullStreams;
  readonly assistantItemId: RuntimeItemId;
  readonly startedAt: string;
  readonly model: string | undefined;
  completed: boolean;
  interrupted: boolean;
  sawAssistantTextDelta: boolean;
  readonly toolsByUseId: Map<string, ClaudeToolItemState>;
}

interface ClaudeSessionState {
  session: ProviderSession;
  readonly providerSessionId: string;
  conversationStarted: boolean;
  activeTurn: ActiveTurnState | null;
  readonly turns: Array<{ id: TurnId; items: ReadonlyArray<unknown> }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function asResumeCursor(value: unknown): ClaudeResumeCursor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const sessionId = (value as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? { sessionId } : undefined;
}

function makeEventId(): EventId {
  return EventId.makeUnsafe(`provider:${PROVIDER}:${randomUUID()}`);
}

function makeTurnId(threadId: ThreadId): TurnId {
  return TurnId.makeUnsafe(`turn:${String(threadId)}:${randomUUID()}`);
}

function makeAssistantItemId(turnId: TurnId): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(`${ASSISTANT_ITEM_PREFIX}:${String(turnId)}`);
}

function makeToolItemId(toolUseId: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(`${TOOL_ITEM_PREFIX}:${toolUseId}`);
}

function emitProviderEvent(
  publish: (event: ProviderRuntimeEvent) => void,
  input: Omit<ProviderRuntimeEvent, "eventId" | "createdAt" | "provider">,
): void {
  publish({
    eventId: makeEventId(),
    provider: PROVIDER,
    createdAt: nowIso(),
    ...input,
  } as ProviderRuntimeEvent);
}

function writeNativeEvent(
  logger: EventNdjsonLogger | undefined,
  threadId: ThreadId,
  payload: unknown,
): void {
  if (!logger) {
    return;
  }
  Effect.runFork(logger.write(payload, threadId));
}

function mapToolNameToItemType(toolName: string): ClaudeToolItemState["itemType"] {
  switch (toolName) {
    case "Bash":
      return "command_execution";
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return "file_change";
    case "WebFetch":
    case "WebSearch":
      return "web_search";
    case "Task":
    case "TaskOutput":
      return "collab_agent_tool_call";
    default:
      return "dynamic_tool_call";
  }
}

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string | undefined {
  const keys = [
    "command",
    "description",
    "file_path",
    "path",
    "url",
    "prompt",
    "query",
  ] as const;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  if (toolName === "Task" && typeof input.description === "string") {
    return input.description.trim() || undefined;
  }
  return undefined;
}

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonLine(line: string): unknown | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function makeUnsupportedOperationError(method: string): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: "Claude Code does not support this operation in OSS Code yet.",
  });
}

function makeMissingSessionError(threadId: ThreadId): ProviderAdapterSessionNotFoundError {
  return new ProviderAdapterSessionNotFoundError({
    provider: PROVIDER,
    threadId,
  });
}

function buildClaudeArgs(input: {
  readonly prompt: string;
  readonly sessionId: string;
  readonly model?: string;
  readonly effort?: "low" | "medium" | "high";
  readonly addDirectories?: ReadonlyArray<string>;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly interactionMode?: "default" | "plan";
  readonly conversationStarted: boolean;
}): string[] {
  const args = [
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    input.runtimeMode === "full-access" ? "bypassPermissions" : "default",
  ];

  if (input.conversationStarted) {
    args.push("--resume", input.sessionId);
  } else {
    args.push("--session-id", input.sessionId);
  }

  if (input.model) {
    args.push("--model", input.model);
  }

  if (input.effort) {
    args.push("--effort", input.effort);
  }

  const addDirectories = input.addDirectories ?? [];
  if (addDirectories.length > 0) {
    args.push("--add-dir", ...addDirectories);
  }

  if (input.interactionMode === "plan") {
    args.push("--agent", "Plan");
  }

  return args;
}

function buildClaudeEnv(input: {
  readonly turn: ProviderSendTurnInput;
  readonly model: string | undefined;
}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!supportsReasoningEffortForModel(PROVIDER, input.model)) {
    delete env.CLAUDE_CODE_EFFORT_LEVEL;
    return env;
  }

  const requestedEffort = input.turn.modelOptions?.claudeCode?.reasoningEffort;
  const effort = resolveReasoningEffortForProvider(PROVIDER, requestedEffort);
  if (!effort || effort === "xhigh") {
    delete env.CLAUDE_CODE_EFFORT_LEVEL;
    return env;
  }

  env.CLAUDE_CODE_EFFORT_LEVEL = effort;
  return env;
}

function formatAttachmentPrompt(input: {
  readonly prompt: string;
  readonly attachments: ReadonlyArray<{
    readonly path: string;
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
  }>;
}): string {
  if (input.attachments.length === 0) {
    return input.prompt;
  }

  const attachmentLines = input.attachments.map(
    (attachment, index) =>
      `${index + 1}. ${attachment.path} (${attachment.name}, ${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
  );

  return [
    "Image attachments are available as local files.",
    "Open and inspect these image paths directly before answering:",
    ...attachmentLines,
    "",
    "User request:",
    input.prompt,
  ].join("\n");
}

function killChild(child: ChildProcessWithoutNullStreams): void {
  child.kill("SIGTERM");
  setTimeout(() => {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  }, 1_000).unref();
}

function createLineReader(onLine: (line: string) => void) {
  let buffer = "";
  return (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        onLine(line);
      }
    }
  };
}

export function makeClaudeCodeAdapterLive(options?: ClaudeCodeAdapterLiveOptions) {
  return Layer.effect(
    ClaudeCodeAdapter,
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const sessions = new Map<ThreadId, ClaudeSessionState>();
      const binaryPath = options?.binaryPath ?? DEFAULT_BINARY_PATH;

      const publish = (event: ProviderRuntimeEvent): void => {
        Effect.runFork(PubSub.publish(runtimeEventPubSub, event));
      };

      const startSession: ClaudeCodeAdapterShape["startSession"] = (input) =>
        Effect.sync(() => {
          const existing = sessions.get(input.threadId);
          if (existing?.activeTurn) {
            existing.activeTurn.interrupted = true;
            killChild(existing.activeTurn.child);
          }

          const resumeCursor = asResumeCursor(input.resumeCursor);
          const providerSessionId = resumeCursor?.sessionId ?? randomUUID();
          const timestamp = nowIso();
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            threadId: input.threadId,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.model ? { model: input.model } : {}),
            resumeCursor: { sessionId: providerSessionId },
            createdAt: existing?.session.createdAt ?? timestamp,
            updatedAt: timestamp,
          };
          sessions.set(input.threadId, {
            session,
            providerSessionId,
            conversationStarted: resumeCursor !== undefined,
            activeTurn: null,
            turns: existing?.turns ?? [],
          });

          if (input.runtimeMode === "approval-required") {
            emitProviderEvent(publish, {
              type: "runtime.warning",
              threadId: input.threadId,
              payload: {
                message:
                  "Claude Code runs in resumable print mode here, so interactive approval prompts are not currently surfaced in the desktop app.",
              },
            });
          }

          return session;
        });

      const sendTurn: ClaudeCodeAdapterShape["sendTurn"] = (input) =>
        Effect.gen(function* () {
          const state = sessions.get(input.threadId);
          if (!state) {
            return yield* makeMissingSessionError(input.threadId);
          }
          if (state.activeTurn) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: "Claude Code already has an active turn for this thread.",
            });
          }

          const prompt = input.input?.trim();
          if (!prompt) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: "Claude Code requires a text prompt for each turn.",
            });
          }

          const resolvedAttachments = (input.attachments ?? []).map((attachment) => {
            const attachmentPath = resolveAttachmentPath({
              stateDir: serverConfig.stateDir,
              attachment,
            });
            if (!attachmentPath) {
              return null;
            }
            return {
              path: attachmentPath,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
            };
          });

          const missingAttachment = resolvedAttachments.find((attachment) => attachment === null);
          if (missingAttachment) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: "One or more Claude Code image attachments could not be resolved on disk.",
            });
          }

          const attachmentInputs = resolvedAttachments.filter(
            (
              attachment,
            ): attachment is {
              readonly path: string;
              readonly name: string;
              readonly mimeType: string;
              readonly sizeBytes: number;
            } => attachment !== null,
          );
          const promptWithAttachments = formatAttachmentPrompt({
            prompt,
            attachments: attachmentInputs,
          });
          const addDirectories = [
            ...new Set(attachmentInputs.map((attachment) => path.dirname(attachment.path))),
          ];

          const turnId = makeTurnId(input.threadId);
          const assistantItemId = makeAssistantItemId(turnId);
          const requestedModel = input.model ?? state.session.model;
          const requestedEffort = input.modelOptions?.claudeCode?.reasoningEffort;
          const child = spawn(
            binaryPath,
            buildClaudeArgs({
              prompt: promptWithAttachments,
              sessionId: state.providerSessionId,
              ...(requestedModel ? { model: requestedModel } : {}),
              ...(requestedEffort ? { effort: requestedEffort } : {}),
              ...(addDirectories.length > 0 ? { addDirectories } : {}),
              runtimeMode: state.session.runtimeMode,
              ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
              conversationStarted: state.conversationStarted,
            }),
            {
              cwd: state.session.cwd,
              stdio: "pipe",
              env: buildClaudeEnv({
                turn: input,
                model: requestedModel,
              }),
              shell: process.platform === "win32",
            },
          );
          child.stdin.end();

          const activeTurn: ActiveTurnState = {
            turnId,
            child,
            assistantItemId,
            startedAt: nowIso(),
            model: requestedModel,
            completed: false,
            interrupted: false,
            sawAssistantTextDelta: false,
            toolsByUseId: new Map(),
          };

          state.activeTurn = activeTurn;
          state.session = {
            ...state.session,
            status: "running",
            ...(requestedModel ? { model: requestedModel } : {}),
            updatedAt: activeTurn.startedAt,
            activeTurnId: turnId,
          };

          emitProviderEvent(publish, {
            type: "session.started",
            threadId: input.threadId,
            payload: {
              resume: { sessionId: state.providerSessionId },
            },
          });
          emitProviderEvent(publish, {
            type: "thread.started",
            threadId: input.threadId,
            turnId,
            payload: {
              providerThreadId: state.providerSessionId,
            },
          });
          emitProviderEvent(publish, {
            type: "session.state.changed",
            threadId: input.threadId,
            turnId,
            payload: {
              state: "running",
            },
          });
          emitProviderEvent(publish, {
            type: "turn.started",
            threadId: input.threadId,
            turnId,
            payload: activeTurn.model ? { model: activeTurn.model } : {},
          });

          const finalizeTurn = (
            payload:
              | {
                  readonly state: "completed" | "failed";
                  readonly errorMessage?: string;
                  readonly usage?: unknown;
                  readonly modelUsage?: Record<string, unknown>;
                  readonly totalCostUsd?: number;
                }
              | {
                  readonly state: "interrupted";
                  readonly errorMessage?: string;
                },
          ) => {
            if (activeTurn.completed) {
              return;
            }
            activeTurn.completed = true;
            state.activeTurn = null;
            state.conversationStarted = true;
            const nextSessionBase: ProviderSession = {
              ...state.session,
              status: payload.state === "failed" ? "error" : "ready",
              updatedAt: nowIso(),
              activeTurnId: undefined,
            };
            state.session = payload.errorMessage
              ? {
                  ...nextSessionBase,
                  lastError: payload.errorMessage,
                }
              : nextSessionBase;
            state.turns.push({ id: turnId, items: [] });

            emitProviderEvent(publish, {
              type: "turn.completed",
              threadId: input.threadId,
              turnId,
              payload: {
                state: payload.state,
                ...(payload.errorMessage ? { errorMessage: payload.errorMessage } : {}),
                ...("usage" in payload && payload.usage !== undefined ? { usage: payload.usage } : {}),
                ...("modelUsage" in payload && payload.modelUsage !== undefined
                  ? { modelUsage: payload.modelUsage }
                  : {}),
                ...("totalCostUsd" in payload && payload.totalCostUsd !== undefined
                  ? { totalCostUsd: payload.totalCostUsd }
                  : {}),
              },
            });
            emitProviderEvent(publish, {
              type: "session.state.changed",
              threadId: input.threadId,
              turnId,
              payload: {
                state: payload.state === "failed" ? "error" : "ready",
                ...(payload.errorMessage ? { reason: payload.errorMessage } : {}),
              },
            });
          };

          const handleJsonMessage = (jsonLine: unknown) => {
            writeNativeEvent(options?.nativeEventLogger, input.threadId, jsonLine);
            const message = asRecord(jsonLine);
            if (!message) {
              return;
            }

            if (message.type === "system" && message.subtype === "init") {
              const configuredSessionId = toTrimmedString(message.session_id);
              if (configuredSessionId && configuredSessionId !== state.providerSessionId) {
                state.session = {
                  ...state.session,
                  resumeCursor: { sessionId: configuredSessionId },
                  updatedAt: nowIso(),
                };
              }

              emitProviderEvent(publish, {
                type: "session.configured",
                threadId: input.threadId,
                turnId,
                payload: {
                  config: {
                    model: message.model,
                    permissionMode: message.permissionMode,
                    claudeCodeVersion: message.claude_code_version,
                  },
                },
              });
              return;
            }

            if (message.type === "stream_event") {
              const event = asRecord(message.event);
              if (!event) {
                return;
              }

              const delta = asRecord(event.delta);
              if (event.type === "content_block_delta" && delta?.type === "text_delta") {
                const text = toTrimmedString(delta.text) ?? (typeof delta.text === "string" ? delta.text : "");
                if (text.length > 0) {
                  activeTurn.sawAssistantTextDelta = true;
                  emitProviderEvent(publish, {
                    type: "content.delta",
                    threadId: input.threadId,
                    turnId,
                    itemId: assistantItemId,
                    payload: {
                      streamKind: "assistant_text",
                      delta: text,
                    },
                  });
                }
              }
              return;
            }

            if (message.type === "assistant") {
              const assistantMessage = asRecord(message.message);
              const content = Array.isArray(assistantMessage?.content) ? assistantMessage.content : [];
              const assistantText = content
                .map((block) => {
                  const contentBlock = asRecord(block);
                  return contentBlock?.type === "text" && typeof contentBlock.text === "string"
                    ? contentBlock.text
                    : null;
                })
                .filter((text): text is string => text !== null)
                .join("");

              if (assistantText.length > 0) {
                emitProviderEvent(publish, {
                  type: "item.completed",
                  threadId: input.threadId,
                  turnId,
                  itemId: assistantItemId,
                  payload: {
                    itemType: "assistant_message",
                    status: "completed",
                    title: "Assistant message",
                    detail: assistantText,
                  },
                });
              }

              for (const block of content) {
                const contentBlock = asRecord(block);
                if (!contentBlock || contentBlock.type !== "tool_use") {
                  continue;
                }
                const toolUseId = toTrimmedString(contentBlock.id);
                const toolName = toTrimmedString(contentBlock.name);
                const toolInput = asRecord(contentBlock.input) ?? {};
                if (!toolUseId || !toolName) {
                  continue;
                }

                const toolDetail = summarizeToolInput(toolName, toolInput);
                const toolState: ClaudeToolItemState = {
                  itemId: makeToolItemId(toolUseId),
                  itemType: mapToolNameToItemType(toolName),
                  title: toolName,
                  ...(toolDetail ? { detail: toolDetail } : {}),
                };
                activeTurn.toolsByUseId.set(toolUseId, toolState);
                emitProviderEvent(publish, {
                  type: "item.started",
                  threadId: input.threadId,
                  turnId,
                  itemId: toolState.itemId,
                  requestId: RuntimeRequestId.makeUnsafe(toolUseId),
                  payload: {
                    itemType: toolState.itemType,
                    title: toolState.title,
                    ...(toolState.detail ? { detail: toolState.detail } : {}),
                    data: toolInput,
                  },
                });
              }
              return;
            }

            if (message.type === "user") {
              const content = Array.isArray(asRecord(message.message)?.content)
                ? (asRecord(message.message)?.content as unknown[])
                : [];
              for (const block of content) {
                const toolResultBlock = asRecord(block);
                if (!toolResultBlock || toolResultBlock.type !== "tool_result") {
                  continue;
                }
                const toolUseId = toTrimmedString(toolResultBlock.tool_use_id);
                if (!toolUseId) {
                  continue;
                }
                const toolState = activeTurn.toolsByUseId.get(toolUseId);
                const contentText =
                  typeof toolResultBlock.content === "string"
                    ? toolResultBlock.content
                    : Array.isArray(toolResultBlock.content)
                      ? toolResultBlock.content
                          .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
                          .join("\n")
                      : undefined;
                emitProviderEvent(publish, {
                  type: "item.completed",
                  threadId: input.threadId,
                  turnId,
                  itemId: toolState?.itemId ?? makeToolItemId(toolUseId),
                  requestId: RuntimeRequestId.makeUnsafe(toolUseId),
                  payload: {
                    itemType: toolState?.itemType ?? "dynamic_tool_call",
                    status: toolResultBlock.is_error === true ? "failed" : "completed",
                    title: toolState?.title ?? "Tool",
                    ...(contentText ? { detail: contentText } : {}),
                  },
                });
              }
              return;
            }

            if (message.type === "rate_limit_event") {
              emitProviderEvent(publish, {
                type: "account.rate-limits.updated",
                threadId: input.threadId,
                turnId,
                payload: {
                  rateLimits: message.rate_limit_info,
                },
              });
              return;
            }

            if (message.type === "result") {
              if (Array.isArray(message.permission_denials) && message.permission_denials.length > 0) {
                emitProviderEvent(publish, {
                  type: "runtime.warning",
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    message: "Claude Code denied one or more tool actions during this turn.",
                    detail: message.permission_denials,
                  },
                });
              }

              if (message.subtype === "success" && message.is_error !== true) {
                const completionPayload: {
                  state: "completed";
                  usage?: unknown;
                  modelUsage?: Record<string, unknown>;
                  totalCostUsd?: number;
                } = {
                  state: "completed",
                  ...(message.usage !== undefined ? { usage: message.usage } : {}),
                };
                const modelUsage = asRecord(message.modelUsage);
                if (modelUsage) {
                  completionPayload.modelUsage = modelUsage;
                }
                if (typeof message.total_cost_usd === "number") {
                  completionPayload.totalCostUsd = message.total_cost_usd;
                }
                finalizeTurn({
                  ...completionPayload,
                });
              } else {
                const errorMessage =
                  toTrimmedString(message.result) ??
                  toTrimmedString(message.stop_reason) ??
                  "Claude Code turn failed.";
                emitProviderEvent(publish, {
                  type: "runtime.error",
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    message: errorMessage,
                    class: "provider_error",
                    detail: message,
                  },
                });
                const failurePayload: {
                  state: "failed";
                  errorMessage: string;
                  usage?: unknown;
                  modelUsage?: Record<string, unknown>;
                  totalCostUsd?: number;
                } = {
                  state: "failed",
                  errorMessage,
                  ...(message.usage !== undefined ? { usage: message.usage } : {}),
                };
                const modelUsage = asRecord(message.modelUsage);
                if (modelUsage) {
                  failurePayload.modelUsage = modelUsage;
                }
                if (typeof message.total_cost_usd === "number") {
                  failurePayload.totalCostUsd = message.total_cost_usd;
                }
                finalizeTurn({
                  ...failurePayload,
                });
              }
            }
          };

          const handleTextLine = (line: string, stream: "stdout" | "stderr") => {
            const jsonLine = parseJsonLine(line);
            if (jsonLine !== undefined) {
              handleJsonMessage(jsonLine);
              return;
            }
            writeNativeEvent(options?.nativeEventLogger, input.threadId, { stream, line });
            emitProviderEvent(publish, {
              type: "runtime.warning",
              threadId: input.threadId,
              turnId,
              payload: {
                message: line,
                detail: { stream },
              },
            });
          };

          child.once("error", (error) => {
            emitProviderEvent(publish, {
              type: "runtime.error",
              threadId: input.threadId,
              turnId,
              payload: {
                message: error.message,
                class: "transport_error",
                detail: error,
              },
            });
            finalizeTurn({
              state: "failed",
              errorMessage: error.message,
            });
          });

          child.stdout.on("data", createLineReader((line) => handleTextLine(line, "stdout")));
          child.stderr.on("data", createLineReader((line) => handleTextLine(line, "stderr")));

          child.once("close", (code, signal) => {
            if (activeTurn.completed) {
              return;
            }

            if (activeTurn.interrupted) {
              finalizeTurn({
                state: "interrupted",
                errorMessage: "Claude Code turn interrupted.",
              });
              return;
            }

            const detail = `Claude Code exited before reporting a result (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
            emitProviderEvent(publish, {
              type: "runtime.error",
              threadId: input.threadId,
              turnId,
              payload: {
                message: detail,
                class: "transport_error",
              },
            });
            finalizeTurn({
              state: "failed",
              errorMessage: detail,
            });
          });

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: { sessionId: state.providerSessionId },
          };
        });

      const interruptTurn: ClaudeCodeAdapterShape["interruptTurn"] = (threadId) =>
        Effect.gen(function* () {
          const state = sessions.get(threadId);
          if (!state) {
            return yield* makeMissingSessionError(threadId);
          }
          if (!state.activeTurn) {
            return;
          }
          state.activeTurn.interrupted = true;
          killChild(state.activeTurn.child);
        });

      const stopSession: ClaudeCodeAdapterShape["stopSession"] = (threadId) =>
        Effect.gen(function* () {
          const state = sessions.get(threadId);
          if (!state) {
            return yield* makeMissingSessionError(threadId);
          }
          if (state.activeTurn) {
            state.activeTurn.interrupted = true;
            killChild(state.activeTurn.child);
          }
          sessions.delete(threadId);
          emitProviderEvent(publish, {
            type: "session.exited",
            threadId,
            payload: {
              reason: "Session stopped",
              recoverable: true,
              exitKind: "graceful",
            },
          });
        });

      const stopAll: ClaudeCodeAdapterShape["stopAll"] = () =>
        Effect.sync(() => {
          for (const [threadId, state] of sessions) {
            if (state.activeTurn) {
              state.activeTurn.interrupted = true;
              killChild(state.activeTurn.child);
            }
            emitProviderEvent(publish, {
              type: "session.exited",
              threadId,
              payload: {
                reason: "Provider shutdown",
                recoverable: true,
                exitKind: "graceful",
              },
            });
          }
          sessions.clear();
        });

      const listSessions: ClaudeCodeAdapterShape["listSessions"] = () =>
        Effect.succeed(Array.from(sessions.values(), (entry) => entry.session));

      const hasSession: ClaudeCodeAdapterShape["hasSession"] = (threadId) =>
        Effect.succeed(sessions.has(threadId));

      const readThread: ClaudeCodeAdapterShape["readThread"] = (threadId) => {
        const state = sessions.get(threadId);
        if (!state) {
          return Effect.fail(makeMissingSessionError(threadId));
        }
        return Effect.succeed({
          threadId,
          turns: [...state.turns],
        });
      };

      const rollbackThread: ClaudeCodeAdapterShape["rollbackThread"] = () =>
        Effect.fail(makeUnsupportedOperationError("rollbackThread"));

      const respondToRequest: ClaudeCodeAdapterShape["respondToRequest"] = () =>
        Effect.fail(makeUnsupportedOperationError("respondToRequest"));

      const respondToUserInput: ClaudeCodeAdapterShape["respondToUserInput"] = () =>
        Effect.fail(makeUnsupportedOperationError("respondToUserInput"));

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
      } satisfies ClaudeCodeAdapterShape;
    }),
  );
}
