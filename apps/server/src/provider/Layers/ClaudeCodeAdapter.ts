/**
 * ClaudeCodeAdapterLive - Live implementation for the Claude Code provider adapter.
 *
 * Wraps the `@anthropic-ai/claude-agent-sdk` behind the `ClaudeCodeAdapter` service
 * contract and maps SDK messages into canonical `ProviderRuntimeEvent` events.
 *
 * @module ClaudeCodeAdapterLive
 */
import {
  type ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  EventId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Schema, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  ClaudeCodeAdapter,
  type ClaudeCodeAdapterShape,
} from "../Services/ClaudeCodeAdapter.ts";
import type {
  ProviderAdapterCapabilities,
  ProviderThreadSnapshot,
} from "../Services/ProviderAdapter.ts";
import { ServerConfig } from "../../config.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

import type {
  Query as ClaudeQuery,
  SDKMessage,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
  SDKTaskNotificationMessage,
  SDKTaskStartedMessage,
  SDKTaskProgressMessage,
  SDKHookStartedMessage,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKToolProgressMessage,
  SDKToolUseSummaryMessage,
  SDKAuthStatusMessage,
  SDKFilesPersistedEvent,
  SDKRateLimitEvent,
  PermissionResult,
  Options as ClaudeQueryOptions,
} from "@anthropic-ai/claude-agent-sdk";

const PROVIDER: "claudeCode" = "claudeCode";

export interface ClaudeCodeAdapterLiveOptions {
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toRequestError(
  threadId: ThreadId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const message = toMessage(cause, "").toLowerCase();
  if (message.includes("unknown session") || message.includes("no active session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (message.includes("session is closed") || message.includes("query closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeEventId(): EventId {
  return EventId.makeUnsafe(crypto.randomUUID());
}

function makeRuntimeTurnId(): TurnId {
  return TurnId.makeUnsafe(`claude-turn:${crypto.randomUUID()}`);
}

interface ClaudeSessionContext {
  readonly threadId: ThreadId;
  readonly query: ClaudeQuery;
  readonly pendingApprovals: Map<
    string,
    { resolve: (value: { decision: "accept" | "acceptForSession" | "decline" | "cancel" }) => void }
  >;
  readonly pushPrompt: (msg: SDKUserMessage) => void;
  sessionId: string | null;
  currentTurnId: TurnId | null;
  status: "connecting" | "ready" | "running" | "error" | "closed";
  model: string | undefined;
  cwd: string | undefined;
  createdAt: string;
  updatedAt: string;
  lastError: string | undefined;
  resumeCursor: unknown | undefined;
}

// ── SDK Message → ProviderRuntimeEvent mapping ────────────────────────

function mapSdkMessageToEvents(
  threadId: ThreadId,
  ctx: ClaudeSessionContext,
  msg: SDKMessage,
): ProviderRuntimeEvent[] {
  const base: RuntimeEventBase = {
    eventId: makeEventId(),
    provider: PROVIDER,
    threadId,
    createdAt: nowIso(),
    ...(ctx.currentTurnId ? { turnId: ctx.currentTurnId } : {}),
  };

  switch (msg.type) {
    case "system":
      return mapSystemMessage(base, ctx, msg);
    case "assistant":
      return mapAssistantMessage(base, ctx, msg as SDKAssistantMessage);
    case "stream_event":
      return mapStreamEvent(base, msg as SDKPartialAssistantMessage);
    case "result":
      return mapResultMessage(base, ctx, msg as SDKResultMessage);
    case "tool_progress": {
      const toolMsg = msg as SDKToolProgressMessage;
      return [
        {
          ...base,
          type: "tool.progress" as const,
          itemId: RuntimeItemId.makeUnsafe(toolMsg.tool_use_id),
          payload: {
            toolUseId: toolMsg.tool_use_id,
            toolName: toolMsg.tool_name,
            elapsedSeconds: toolMsg.elapsed_time_seconds,
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "tool_use_summary": {
      const summaryMsg = msg as SDKToolUseSummaryMessage;
      return [
        {
          ...base,
          type: "tool.summary" as const,
          payload: {
            summary: summaryMsg.summary,
            precedingToolUseIds: summaryMsg.preceding_tool_use_ids,
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "auth_status": {
      const authMsg = msg as SDKAuthStatusMessage;
      return [
        {
          ...base,
          type: "auth.status" as const,
          payload: {
            isAuthenticating: authMsg.isAuthenticating,
            output: authMsg.output,
            ...(authMsg.error ? { error: authMsg.error } : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "rate_limit_event": {
      const rlMsg = msg as SDKRateLimitEvent;
      return [
        {
          ...base,
          type: "account.rate-limits.updated" as const,
          payload: { rateLimits: rlMsg.rate_limit_info },
        } as ProviderRuntimeEvent,
      ];
    }
    default:
      return [];
  }
}

type RuntimeEventBase = {
  eventId: EventId;
  provider: "claudeCode";
  threadId: ThreadId;
  createdAt: string;
  turnId?: TurnId;
};

function mapSystemMessage(
  base: RuntimeEventBase,
  ctx: ClaudeSessionContext,
  msg: SDKMessage & { type: "system" },
): ProviderRuntimeEvent[] {
  // SDKSystemMessage narrows subtype to "init" only. Cast to access all subtypes.
  const subtype = (msg as unknown as { subtype: string }).subtype;
  switch (subtype) {
    case "init": {
      const initMsg = msg as SDKSystemMessage;
      ctx.sessionId = initMsg.session_id;
      ctx.model = initMsg.model;
      ctx.resumeCursor = { resume: initMsg.session_id };
      return [
        {
          ...base,
          type: "session.started" as const,
          payload: { message: `Claude Code session initialized (model: ${initMsg.model})` },
        } as ProviderRuntimeEvent,
        {
          ...base,
          eventId: makeEventId(),
          type: "session.configured" as const,
          payload: {
            config: {
              model: initMsg.model,
              cwd: initMsg.cwd,
              tools: initMsg.tools,
              permissionMode: initMsg.permissionMode,
            },
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "hook_started": {
      const hookMsg = msg as unknown as SDKHookStartedMessage;
      return [
        {
          ...base,
          type: "hook.started" as const,
          payload: {
            hookId: hookMsg.hook_id,
            hookName: hookMsg.hook_name,
            hookEvent: hookMsg.hook_event,
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "hook_progress": {
      const hookMsg = msg as unknown as SDKHookProgressMessage;
      return [
        {
          ...base,
          type: "hook.progress" as const,
          payload: {
            hookId: hookMsg.hook_id,
            output: hookMsg.output,
            stdout: hookMsg.stdout,
            stderr: hookMsg.stderr,
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "hook_response": {
      const hookMsg = msg as unknown as SDKHookResponseMessage;
      return [
        {
          ...base,
          type: "hook.completed" as const,
          payload: {
            hookId: hookMsg.hook_id,
            outcome: hookMsg.outcome,
            output: hookMsg.output,
            stdout: hookMsg.stdout,
            stderr: hookMsg.stderr,
            ...(hookMsg.exit_code !== undefined ? { exitCode: hookMsg.exit_code } : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "task_started": {
      const taskMsg = msg as unknown as SDKTaskStartedMessage;
      return [
        {
          ...base,
          type: "task.started" as const,
          payload: {
            taskId: taskMsg.task_id,
            ...(taskMsg.description ? { description: taskMsg.description } : {}),
            ...(taskMsg.task_type ? { taskType: taskMsg.task_type } : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "task_progress": {
      const taskMsg = msg as unknown as SDKTaskProgressMessage;
      return [
        {
          ...base,
          type: "task.progress" as const,
          payload: {
            taskId: taskMsg.task_id,
            description: taskMsg.description,
            usage: taskMsg.usage,
            ...(taskMsg.last_tool_name ? { lastToolName: taskMsg.last_tool_name } : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "task_notification": {
      const taskMsg = msg as unknown as SDKTaskNotificationMessage;
      return [
        {
          ...base,
          type: "task.completed" as const,
          payload: {
            taskId: taskMsg.task_id,
            status: taskMsg.status,
            summary: taskMsg.summary,
            ...(taskMsg.usage ? { usage: taskMsg.usage } : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "files_persisted": {
      const fpMsg = msg as unknown as SDKFilesPersistedEvent;
      return [
        {
          ...base,
          type: "files.persisted" as const,
          payload: {
            files: fpMsg.files.map((f) => ({ filename: f.filename, fileId: f.file_id })),
            ...(fpMsg.failed && fpMsg.failed.length > 0
              ? {
                  failed: fpMsg.failed.map((f) => ({ filename: f.filename, error: f.error })),
                }
              : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    default:
      return [];
  }
}

function mapAssistantMessage(
  base: RuntimeEventBase,
  ctx: ClaudeSessionContext,
  msg: SDKAssistantMessage,
): ProviderRuntimeEvent[] {
  const events: ProviderRuntimeEvent[] = [];
  const betaMessage = msg.message;
  if (!betaMessage?.content) return events;

  // Update resume cursor with the latest assistant message UUID
  if (ctx.sessionId && msg.uuid) {
    ctx.resumeCursor = { resume: ctx.sessionId, resumeSessionAt: msg.uuid };
  }

  for (const block of betaMessage.content) {
    if (block.type === "text") {
      events.push({
        ...base,
        eventId: makeEventId(),
        type: "content.delta" as const,
        payload: { streamKind: "assistant_text" as const, delta: block.text },
      } as ProviderRuntimeEvent);
    } else if (block.type === "thinking") {
      events.push({
        ...base,
        eventId: makeEventId(),
        type: "content.delta" as const,
        payload: {
          streamKind: "reasoning_text" as const,
          delta: (block as { thinking: string }).thinking,
        },
      } as ProviderRuntimeEvent);
    } else if (block.type === "tool_use") {
      const toolBlock = block as { id: string; name: string; input: unknown };
      events.push({
        ...base,
        eventId: makeEventId(),
        type: "item.started" as const,
        itemId: RuntimeItemId.makeUnsafe(toolBlock.id),
        payload: {
          itemType: mapToolNameToItemType(toolBlock.name),
          title: toolBlock.name,
          data: { item: { type: toolBlock.name, input: toolBlock.input } },
        },
      } as ProviderRuntimeEvent);
    }
  }

  return events;
}

function mapStreamEvent(
  base: RuntimeEventBase,
  msg: SDKPartialAssistantMessage,
): ProviderRuntimeEvent[] {
  const event = msg.event;
  if (!event) return [];

  switch (event.type) {
    case "content_block_delta": {
      const delta = event.delta as { type: string; text?: string; thinking?: string };
      if (delta.type === "text_delta" && delta.text) {
        return [
          {
            ...base,
            type: "content.delta" as const,
            payload: { streamKind: "assistant_text" as const, delta: delta.text },
          } as ProviderRuntimeEvent,
        ];
      }
      if (delta.type === "thinking_delta" && delta.thinking) {
        return [
          {
            ...base,
            type: "content.delta" as const,
            payload: { streamKind: "reasoning_text" as const, delta: delta.thinking },
          } as ProviderRuntimeEvent,
        ];
      }
      return [];
    }
    case "content_block_start": {
      const contentBlock = (
        event as { content_block?: { type: string; id?: string; name?: string } }
      ).content_block;
      if (contentBlock?.type === "tool_use" && contentBlock.id) {
        return [
          {
            ...base,
            type: "item.started" as const,
            itemId: RuntimeItemId.makeUnsafe(contentBlock.id),
            payload: {
              itemType: mapToolNameToItemType(contentBlock.name ?? "tool"),
              title: contentBlock.name ?? "Tool use",
            },
          } as ProviderRuntimeEvent,
        ];
      }
      return [];
    }
    default:
      return [];
  }
}

function mapResultMessage(
  base: RuntimeEventBase,
  ctx: ClaudeSessionContext,
  msg: SDKResultMessage,
): ProviderRuntimeEvent[] {
  const isError = msg.is_error;
  const state = isError ? ("failed" as const) : ("completed" as const);
  ctx.status = "ready";

  return [
    {
      ...base,
      type: "turn.completed" as const,
      payload: {
        state,
        stopReason: msg.stop_reason ?? null,
        usage: msg.usage,
        modelUsage: msg.modelUsage,
        totalCostUsd: msg.total_cost_usd,
        ...(isError && "errors" in msg && (msg as { errors?: string[] }).errors?.length
          ? { errorMessage: (msg as { errors: string[] }).errors.join("; ") }
          : {}),
      },
    } as ProviderRuntimeEvent,
  ];
}

function mapToolNameToItemType(
  name: string,
): "command_execution" | "file_change" | "mcp_tool_call" | "unknown" {
  const lower = name.toLowerCase();
  if (lower === "bash" || lower === "execute" || lower.includes("command")) return "command_execution";
  if (lower === "edit" || lower === "write" || lower.includes("file") || lower.includes("patch"))
    return "file_change";
  if (lower.startsWith("mcp__") || lower.startsWith("mcp_")) return "mcp_tool_call";
  return "unknown";
}

function mapToolNameToRequestType(
  toolName: string,
): "command_execution_approval" | "file_change_approval" | "file_read_approval" | "unknown" {
  const lower = toolName.toLowerCase();
  if (lower === "bash" || lower === "execute" || lower.includes("command"))
    return "command_execution_approval";
  if (lower === "edit" || lower === "write" || lower.includes("patch") || lower.includes("notebookedit"))
    return "file_change_approval";
  if (lower === "read" || lower === "glob" || lower === "grep") return "file_read_approval";
  return "unknown";
}

function formatToolApprovalDetail(toolName: string, input: Record<string, unknown>): string {
  const command = input.command ?? input.file_path ?? input.path ?? input.pattern;
  if (typeof command === "string") return `${toolName}: ${command}`;
  return toolName;
}

// ── Adapter construction ──────────────────────────────────────────────

const makeClaudeCodeAdapter = (options?: ClaudeCodeAdapterLiveOptions) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const sessions = new Map<string, ClaudeSessionContext>();
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const emitEvents = (events: ProviderRuntimeEvent[]) => {
      if (events.length > 0) {
        Effect.runSync(Queue.offerAll(runtimeEventQueue, events));
      }
    };

    const writeNativeEvent = (threadId: ThreadId, msg: SDKMessage) => {
      if (!options?.nativeEventLogger) return;
      const event = {
        source: "claude-code.sdk.event",
        threadId,
        type: msg.type,
        timestamp: nowIso(),
        payload: msg,
      };
      Effect.runSync(options.nativeEventLogger.write(event, threadId));
    };

    const capabilities: ProviderAdapterCapabilities = {
      sessionModelSwitch: "in-session",
    };

    const getSession = (threadId: ThreadId): ClaudeSessionContext | undefined =>
      sessions.get(threadId);

    const requireSession = (threadId: ThreadId) => {
      const session = getSession(threadId);
      if (!session) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      if (session.status === "closed") {
        return Effect.fail(
          new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(session);
    };

    const startSession: ClaudeCodeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        const threadId = input.threadId;

        // Stop existing session
        const existing = getSession(threadId);
        if (existing && existing.status !== "closed") {
          existing.query.close();
          existing.status = "closed";
        }

        const pendingApprovals = new Map<
          string,
          {
            resolve: (value: {
              decision: "accept" | "acceptForSession" | "decline" | "cancel";
            }) => void;
          }
        >();

        const providerOptions = input.providerOptions as
          | {
              claudeCode?: {
                binaryPath?: string;
                permissionMode?: string;
                maxThinkingTokens?: number;
              };
            }
          | undefined;
        const claudeOpts = providerOptions?.claudeCode;
        const binaryPath = claudeOpts?.binaryPath;
        const permissionMode: "default" | "acceptEdits" | "bypassPermissions" =
          input.runtimeMode === "full-access"
            ? "bypassPermissions"
            : (claudeOpts?.permissionMode as "default" | "acceptEdits") ?? "default";

        const resumeInfo = input.resumeCursor as
          | { resume?: string; resumeSessionAt?: string }
          | undefined;

        const cwd = input.cwd ?? config.cwd ?? process.cwd();

        // Prompt source: we'll create an async iterable backed by a simple queue
        type PromptResolve = (msg: SDKUserMessage) => void;
        let pendingPromptResolve: PromptResolve | null = null;
        const promptBuffer: SDKUserMessage[] = [];

        const pushPrompt = (msg: SDKUserMessage) => {
          if (pendingPromptResolve) {
            const resolve = pendingPromptResolve;
            pendingPromptResolve = null;
            resolve(msg);
          } else {
            promptBuffer.push(msg);
          }
        };

        const promptSource: AsyncIterable<SDKUserMessage> = {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<SDKUserMessage, void>> {
                const buffered = promptBuffer.shift();
                if (buffered) {
                  return Promise.resolve({ value: buffered, done: false as const });
                }
                return new Promise<IteratorResult<SDKUserMessage, void>>((resolve) => {
                  pendingPromptResolve = (msg) =>
                    resolve({ value: msg, done: false as const });
                });
              },
            };
          },
        };

        // We need a forward reference to ctx for the canUseTool callback
        let ctx: ClaudeSessionContext;

        const queryOptions: ClaudeQueryOptions = {
          cwd,
          ...(input.model ? { model: input.model } : {}),
          ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
          permissionMode,
          ...(permissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          includePartialMessages: true,
          enableFileCheckpointing: true,
          ...(resumeInfo?.resume ? { resume: resumeInfo.resume } : {}),
          ...(resumeInfo?.resumeSessionAt
            ? { resumeSessionAt: resumeInfo.resumeSessionAt }
            : {}),
          canUseTool: async (toolName, toolInput, opts) => {
            const requestId = opts.toolUseID;
            const requestType = mapToolNameToRequestType(toolName);

            emitEvents([
              {
                eventId: makeEventId(),
                provider: PROVIDER,
                threadId,
                createdAt: nowIso(),
                ...(ctx.currentTurnId ? { turnId: ctx.currentTurnId } : {}),
                requestId: RuntimeRequestId.makeUnsafe(requestId),
                type: "request.opened",
                payload: {
                  requestType,
                  detail: formatToolApprovalDetail(toolName, toolInput),
                  args: { toolName, input: toolInput },
                },
              } as ProviderRuntimeEvent,
            ]);

            const decision = await new Promise<{
              decision: "accept" | "acceptForSession" | "decline" | "cancel";
            }>((resolve) => {
              pendingApprovals.set(requestId, { resolve });
            });

            pendingApprovals.delete(requestId);

            emitEvents([
              {
                eventId: makeEventId(),
                provider: PROVIDER,
                threadId,
                createdAt: nowIso(),
                ...(ctx.currentTurnId ? { turnId: ctx.currentTurnId } : {}),
                requestId: RuntimeRequestId.makeUnsafe(requestId),
                type: "request.resolved",
                payload: { requestType, decision: decision.decision },
              } as ProviderRuntimeEvent,
            ]);

            const permResult: PermissionResult =
              decision.decision === "accept" || decision.decision === "acceptForSession"
                ? {
                    behavior: "allow" as const,
                    ...(decision.decision === "acceptForSession" && opts.suggestions
                      ? { updatedPermissions: opts.suggestions }
                      : {}),
                  }
                : { behavior: "deny" as const, message: "User denied the request" };
            return permResult;
          },
        };

        // Dynamically import the SDK
        const claudeSdk = yield* Effect.tryPromise({
          try: () => import("@anthropic-ai/claude-agent-sdk"),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: toMessage(cause, "Failed to import Claude Agent SDK"),
              cause,
            }),
        });
        const sdkQuery = claudeSdk.query({
          prompt: promptSource,
          options: queryOptions,
        });

        const now = nowIso();
        ctx = {
          threadId,
          query: sdkQuery,
          pendingApprovals,
          pushPrompt,
          sessionId: null,
          currentTurnId: null,
          status: "connecting",
          model: input.model,
          cwd,
          createdAt: now,
          updatedAt: now,
          lastError: undefined,
          resumeCursor: resumeInfo,
        };
        sessions.set(threadId, ctx);

        // Consume the SDK stream in background
        void (async () => {
          try {
            for await (const msg of sdkQuery) {
              if (ctx.status === "closed") break;
              ctx.updatedAt = nowIso();
              const events = mapSdkMessageToEvents(threadId, ctx, msg);
              emitEvents(events);
              writeNativeEvent(threadId, msg);
            }
          } catch (error) {
            if (ctx.status !== "closed") {
              ctx.status = "error";
              ctx.lastError = toMessage(error, "SDK stream error");
              ctx.updatedAt = nowIso();
              emitEvents([
                {
                  eventId: makeEventId(),
                  provider: PROVIDER,
                  threadId,
                  createdAt: nowIso(),
                  type: "session.exited",
                  payload: {
                    reason: ctx.lastError,
                    exitKind: "error",
                    recoverable: false,
                  },
                } as ProviderRuntimeEvent,
              ]);
            }
          } finally {
            if (ctx.status !== "closed") {
              ctx.status = "closed";
              ctx.updatedAt = nowIso();
            }
            for (const [, entry] of pendingApprovals) {
              entry.resolve({ decision: "cancel" });
            }
            pendingApprovals.clear();
          }
        })();

        ctx.status = "ready";
        ctx.updatedAt = nowIso();

        return {
          provider: PROVIDER,
          status: "ready" as const,
          runtimeMode: input.runtimeMode,
          ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
          ...(ctx.model ? { model: ctx.model } : {}),
          threadId,
          ...(ctx.resumeCursor !== undefined ? { resumeCursor: ctx.resumeCursor } : {}),
          createdAt: ctx.createdAt,
          updatedAt: ctx.updatedAt,
        };
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(ProviderAdapterProcessError)(error)
            ? error
            : new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: toMessage(error, "Failed to start Claude Code session"),
                cause: error,
              }),
        ),
      );

    const sendTurn: ClaudeCodeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const turnId = makeRuntimeTurnId();
        ctx.currentTurnId = turnId;
        ctx.status = "running";
        ctx.updatedAt = nowIso();

        if (input.model && input.model !== ctx.model) {
          yield* Effect.tryPromise({
            try: () => ctx.query.setModel(input.model!),
            catch: () => undefined,
          }).pipe(Effect.ignore);
          ctx.model = input.model;
        }

        emitEvents([
          {
            eventId: makeEventId(),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            createdAt: nowIso(),
            type: "turn.started",
            payload: { ...(ctx.model ? { model: ctx.model } : {}) },
          } as ProviderRuntimeEvent,
        ]);

        ctx.pushPrompt({
          type: "user",
          message: { role: "user", content: input.input ?? "" },
          parent_tool_use_id: null,
          session_id: ctx.sessionId ?? "",
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.resumeCursor,
        };
      });

    const interruptTurn: ClaudeCodeAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* Effect.tryPromise({
          try: () => ctx.query.interrupt(),
          catch: (error) => toRequestError(threadId, "interruptTurn", error),
        });
      });

    const respondToRequest: ClaudeCodeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToRequest",
            detail: `Unknown pending permission request: ${requestId}`,
          });
        }
        pending.resolve({ decision });
      });

    const respondToUserInput: ClaudeCodeAdapterShape["respondToUserInput"] = (
      _threadId,
      _requestId,
      _answers,
    ) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: "User input responses are not yet supported for Claude Code",
        }),
      );

    const stopSession: ClaudeCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = getSession(threadId);
        if (!ctx || ctx.status === "closed") return;

        ctx.query.close();
        ctx.status = "closed";
        ctx.updatedAt = nowIso();

        for (const [, entry] of ctx.pendingApprovals) {
          entry.resolve({ decision: "cancel" });
        }
        ctx.pendingApprovals.clear();

        yield* Queue.offerAll(runtimeEventQueue, [
          {
            eventId: makeEventId(),
            provider: PROVIDER,
            threadId,
            createdAt: nowIso(),
            type: "session.exited",
            payload: { reason: "Session stopped by user", exitKind: "graceful" },
          } as ProviderRuntimeEvent,
        ]);
      });

    const listSessions: ClaudeCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() =>
        Array.from(sessions.values())
          .filter((ctx) => ctx.status !== "closed")
          .map((ctx) => ({
            provider: PROVIDER,
            status: ctx.status as "connecting" | "ready" | "running" | "error" | "closed",
            runtimeMode: "full-access" as const,
            ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
            ...(ctx.model ? { model: ctx.model } : {}),
            threadId: ctx.threadId,
            ...(ctx.resumeCursor !== undefined ? { resumeCursor: ctx.resumeCursor } : {}),
            createdAt: ctx.createdAt,
            updatedAt: ctx.updatedAt,
            ...(ctx.lastError ? { lastError: ctx.lastError } : {}),
          })),
      );

    const hasSession: ClaudeCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = getSession(threadId);
        return ctx !== undefined && ctx.status !== "closed";
      });

    const readThread: ClaudeCodeAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return { threadId, turns: [] } satisfies ProviderThreadSnapshot;
      });

    const rollbackThread: ClaudeCodeAdapterShape["rollbackThread"] = (_threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "Claude Code does not support native thread rollback. Use rewindFiles instead.",
        }),
      );

    const stopAll: ClaudeCodeAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        for (const [, ctx] of sessions) {
          if (ctx.status === "closed") continue;
          ctx.query.close();
          ctx.status = "closed";
          ctx.updatedAt = nowIso();
          for (const [, entry] of ctx.pendingApprovals) {
            entry.resolve({ decision: "cancel" });
          }
          ctx.pendingApprovals.clear();
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
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies ClaudeCodeAdapterShape;
  });

export const ClaudeCodeAdapterLive = Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter());

export function makeClaudeCodeAdapterLive(options?: ClaudeCodeAdapterLiveOptions) {
  return Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter(options));
}
