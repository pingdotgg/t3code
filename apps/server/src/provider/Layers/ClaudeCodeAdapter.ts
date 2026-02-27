/**
 * ClaudeCodeAdapterLive - Scoped live implementation for the Claude Code provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeCodeAdapterLive
 */
import {
  type CanUseTool,
  query,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeToolKind,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  ProviderSessionId,
  type ProviderSession,
  ProviderThreadId,
  ProviderTurnId,
} from "@t3tools/contracts";
import { Cause, DateTime, Deferred, Effect, Layer, Queue, Random, Ref, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { ClaudeCodeAdapter, type ClaudeCodeAdapterShape } from "../Services/ClaudeCodeAdapter.ts";

const PROVIDER = "claudeCode" as const;

type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

interface ClaudeResumeState {
  readonly threadId?: ProviderThreadId;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
}

interface ClaudeTurnState {
  readonly turnId: ProviderTurnId;
  readonly assistantItemId: string;
  readonly startedAt: string;
  readonly items: Array<unknown>;
  readonly messageCompleted: boolean;
}

interface PendingApproval {
  readonly requestKind: "command" | "file-change";
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface ToolInFlight {
  readonly itemId: string;
  readonly toolKind: ProviderRuntimeToolKind;
  readonly title: string;
  readonly detail?: string;
}

interface ClaudeSessionContext {
  session: ProviderSession;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
  readonly startedAt: string;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{
    id: ReturnType<typeof ProviderTurnId.makeUnsafe>;
    items: Array<unknown>;
  }>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  turnState: ClaudeTurnState | undefined;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: ProviderThreadId | undefined;
  stopped: boolean;
}

interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly close: () => void;
}

export interface ClaudeCodeAdapterLiveOptions {
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toPermissionMode(value: unknown): PermissionMode | undefined {
  switch (value) {
    case "default":
    case "acceptEdits":
    case "bypassPermissions":
    case "plan":
    case "dontAsk":
      return value;
    default:
      return undefined;
  }
}

function readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as {
    threadId?: unknown;
    resume?: unknown;
    sessionId?: unknown;
    resumeSessionAt?: unknown;
    turnCount?: unknown;
  };

  const threadId = typeof cursor.threadId === "string" ? cursor.threadId : undefined;
  const resume =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;
  const resumeSessionAt =
    typeof cursor.resumeSessionAt === "string" ? cursor.resumeSessionAt : undefined;
  const turnCountValue = typeof cursor.turnCount === "number" ? cursor.turnCount : undefined;

  return {
    ...(threadId ? { threadId: ProviderThreadId.makeUnsafe(threadId) } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnCountValue !== undefined && Number.isInteger(turnCountValue) && turnCountValue >= 0
      ? { turnCount: turnCountValue }
      : {}),
  };
}

function classifyToolKind(toolName: string): ProviderRuntimeToolKind {
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file-change";
  }
  return "other";
}

function classifyRequestKind(toolName: string): "command" | "file-change" {
  return classifyToolKind(toolName) === "command" ? "command" : "file-change";
}

function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }

  const serialized = JSON.stringify(input);
  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, 397)}...`;
}

function titleForTool(kind: ProviderRuntimeToolKind): string {
  switch (kind) {
    case "command":
      return "Command run";
    case "file-change":
      return "File change";
    case "other":
      return "Tool call";
  }
}

function buildUserMessage(input: ProviderSendTurnInput): SDKUserMessage {
  const fragments: string[] = [];

  if (input.input && input.input.trim().length > 0) {
    fragments.push(input.input.trim());
  }

  for (const attachment of input.attachments ?? []) {
    if (attachment.type === "image") {
      fragments.push(
        `Attached image: ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes).`,
      );
    }
  }

  const text = fragments.join("\n\n");

  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  } as SDKUserMessage;
}

function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus {
  if (result.subtype === "success") {
    return "completed";
  }

  const errors = result.errors.join(" ").toLowerCase();
  if (errors.includes("interrupt")) {
    return "interrupted";
  }
  if (errors.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

function toSessionError(
  sessionId: ReturnType<typeof ProviderSessionId.makeUnsafe>,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      sessionId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      sessionId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(
  sessionId: ReturnType<typeof ProviderSessionId.makeUnsafe>,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const sessionError = toSessionError(sessionId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function makeClaudeCodeAdapter(options?: ClaudeCodeAdapterLiveOptions) {
  return Effect.gen(function* () {
    const createQuery =
      options?.createQuery ??
      ((input: {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }) => query({ prompt: input.prompt, options: input.options }) as ClaudeQueryRuntime);

    const sessions = new Map<ProviderSessionId, ClaudeSessionContext>();
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

    const snapshotThread = (
      context: ClaudeSessionContext,
    ): Effect.Effect<{
      threadId: ReturnType<typeof ProviderThreadId.makeUnsafe>;
      turns: ReadonlyArray<{
        id: ReturnType<typeof ProviderTurnId.makeUnsafe>;
        items: ReadonlyArray<unknown>;
      }>;
    }> =>
      Effect.gen(function* () {
        const threadId =
          context.session.threadId ??
          ProviderThreadId.makeUnsafe(`claude-thread-${yield* Random.nextUUIDv4}`);
        return {
          threadId,
          turns: context.turns.map((turn) => ({
            id: turn.id,
            items: [...turn.items],
          })),
        };
      });

    const updateResumeCursor = (context: ClaudeSessionContext): Effect.Effect<void> =>
      Effect.gen(function* () {
        const threadId = context.session.threadId;
        if (!threadId) return;

        const resumeCursor = {
          threadId,
          resume: threadId,
          ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
          turnCount: context.turns.length,
        };

        context.session = {
          ...context.session,
          resumeCursor,
          updatedAt: yield* nowIso,
        };
      });

    const ensureThreadId = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const nextThreadId = ProviderThreadId.makeUnsafe(message.session_id);
        const changed = context.session.threadId !== nextThreadId;

        if (changed) {
          const updatedAt = yield* nowIso;
          context.session = {
            ...context.session,
            threadId: nextThreadId,
            updatedAt,
          };
          yield* updateResumeCursor(context);
        }

        if (context.lastThreadStartedId !== nextThreadId) {
          context.lastThreadStartedId = nextThreadId;
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "thread.started",
            eventId: stamp.eventId,
            provider: PROVIDER,
            sessionId: context.session.sessionId,
            createdAt: stamp.createdAt,
            threadId: nextThreadId,
          });
        }
      });

    const emitRuntimeError = (
      context: ClaudeSessionContext,
      message: string,
      cause?: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (cause !== undefined) {
          void cause;
        }
        const turnState = context.turnState;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "runtime.error",
          eventId: stamp.eventId,
          provider: PROVIDER,
          sessionId: context.session.sessionId,
          createdAt: stamp.createdAt,
          ...(context.session.threadId ? { threadId: context.session.threadId } : {}),
          ...(turnState ? { turnId: turnState.turnId } : {}),
          message,
        });
      });

    const completeTurn = (
      context: ClaudeSessionContext,
      status: ProviderRuntimeTurnStatus,
      errorMessage?: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "turn.completed",
            eventId: stamp.eventId,
            provider: PROVIDER,
            sessionId: context.session.sessionId,
            createdAt: stamp.createdAt,
            ...(context.session.threadId ? { threadId: context.session.threadId } : {}),
            status,
            ...(errorMessage ? { errorMessage } : {}),
          });
          return;
        }

        if (!turnState.messageCompleted) {
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "message.completed",
            eventId: stamp.eventId,
            provider: PROVIDER,
            sessionId: context.session.sessionId,
            createdAt: stamp.createdAt,
            itemId: ProviderItemId.makeUnsafe(turnState.assistantItemId),
            ...(context.session.threadId ? { threadId: context.session.threadId } : {}),
            turnId: turnState.turnId,
          });
        }

        context.turns.push({
          id: turnState.turnId,
          items: [...turnState.items],
        });

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          sessionId: context.session.sessionId,
          createdAt: stamp.createdAt,
          ...(context.session.threadId ? { threadId: context.session.threadId } : {}),
          turnId: turnState.turnId,
          status,
          ...(errorMessage ? { errorMessage } : {}),
        });

        const updatedAt = yield* nowIso;
        context.turnState = undefined;
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt,
          ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
        };
        yield* updateResumeCursor(context);
      });

    const handleStreamEvent = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "stream_event") {
          return;
        }

        const { event } = message;

        if (event.type === "content_block_delta") {
          if (
            event.delta.type === "text_delta" &&
            event.delta.text.length > 0 &&
            context.turnState
          ) {
            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "message.delta",
              eventId: stamp.eventId,
              provider: PROVIDER,
              sessionId: context.session.sessionId,
              createdAt: stamp.createdAt,
              ...(context.session.threadId ? { threadId: context.session.threadId } : {}),
              turnId: context.turnState.turnId,
              itemId: ProviderItemId.makeUnsafe(context.turnState.assistantItemId),
              delta: event.delta.text,
            });
          }
          return;
        }

        if (event.type === "content_block_start") {
          const { index, content_block: block } = event;
          if (
            block.type !== "tool_use" &&
            block.type !== "server_tool_use" &&
            block.type !== "mcp_tool_use"
          ) {
            return;
          }

          const toolName = block.name;
          const toolKind = classifyToolKind(toolName);
          const toolInput =
            typeof block.input === "object" && block.input !== null
              ? (block.input as Record<string, unknown>)
              : {};
          const itemId = block.id;
          const detail = summarizeToolRequest(toolName, toolInput);

          const tool: ToolInFlight = {
            itemId,
            toolKind,
            title: titleForTool(toolKind),
            detail,
          };
          context.inFlightTools.set(index, tool);

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "tool.started",
            eventId: stamp.eventId,
            provider: PROVIDER,
            sessionId: context.session.sessionId,
            createdAt: stamp.createdAt,
            ...(context.session.threadId ? { threadId: context.session.threadId } : {}),
            ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
            itemId: ProviderItemId.makeUnsafe(tool.itemId),
            toolKind: tool.toolKind,
            title: tool.title,
            ...(tool.detail ? { detail: tool.detail } : {}),
          });
          return;
        }

        if (event.type === "content_block_stop") {
          const { index } = event;
          const tool = context.inFlightTools.get(index);
          if (!tool) {
            return;
          }
          context.inFlightTools.delete(index);

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "tool.completed",
            eventId: stamp.eventId,
            provider: PROVIDER,
            sessionId: context.session.sessionId,
            createdAt: stamp.createdAt,
            ...(context.session.threadId ? { threadId: context.session.threadId } : {}),
            ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
            itemId: ProviderItemId.makeUnsafe(tool.itemId),
            toolKind: tool.toolKind,
            title: tool.title,
            ...(tool.detail ? { detail: tool.detail } : {}),
          });
        }
      });

    const handleAssistantMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "assistant") {
          return;
        }

        if (context.turnState) {
          context.turnState.items.push(message.message);
          if (!context.turnState.messageCompleted) {
            context.turnState = {
              ...context.turnState,
              messageCompleted: true,
            };
            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "message.completed",
              eventId: stamp.eventId,
              provider: PROVIDER,
              sessionId: context.session.sessionId,
              createdAt: stamp.createdAt,
              itemId: ProviderItemId.makeUnsafe(context.turnState.assistantItemId),
              ...(context.session.threadId ? { threadId: context.session.threadId } : {}),
              turnId: context.turnState.turnId,
            });
          }
        }

        context.lastAssistantUuid = message.uuid;
        yield* updateResumeCursor(context);
      });

    const handleResultMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "result") {
          return;
        }

        const status = turnStatusFromResult(message);
        const errorMessage = message.subtype === "success" ? undefined : message.errors[0];

        if (status === "failed") {
          yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
        }

        yield* completeTurn(context, status, errorMessage);
      });

    const handleSdkMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* ensureThreadId(context, message);

        switch (message.type) {
          case "stream_event":
            yield* handleStreamEvent(context, message);
            return;
          case "assistant":
            yield* handleAssistantMessage(context, message);
            return;
          case "result":
            yield* handleResultMessage(context, message);
            return;
          default:
            return;
        }
      });

    const runSdkStream = (context: ClaudeSessionContext): Effect.Effect<void> =>
      Stream.fromAsyncIterable(context.query, (cause) => cause).pipe(
        Stream.takeWhile(() => !context.stopped),
        Stream.runForEach((message) => handleSdkMessage(context, message)),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.hasInterruptsOnly(cause) || context.stopped) {
              return;
            }
            const message = toMessage(Cause.squash(cause), "Claude runtime stream failed.");
            yield* emitRuntimeError(context, message, cause);
            yield* completeTurn(context, "failed", message);
          }),
        ),
      );

    const stopSessionInternal = (
      context: ClaudeSessionContext,
      options?: { readonly emitExitEvent?: boolean },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (context.stopped) return;

        context.stopped = true;

        for (const [requestId, pending] of context.pendingApprovals) {
          yield* Deferred.succeed(pending.decision, "cancel");
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "approval.resolved",
            eventId: stamp.eventId,
            provider: PROVIDER,
            sessionId: context.session.sessionId,
            createdAt: stamp.createdAt,
            ...(context.session.threadId ? { threadId: context.session.threadId } : {}),
            ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
            requestId,
            requestKind: pending.requestKind,
            decision: "cancel",
          });
        }
        context.pendingApprovals.clear();

        if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Session stopped.");
        }

        yield* Queue.shutdown(context.promptQueue);

        context.query.close();

        const updatedAt = yield* nowIso;
        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt,
        };

        if (options?.emitExitEvent !== false) {
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "session.exited",
            eventId: stamp.eventId,
            provider: PROVIDER,
            sessionId: context.session.sessionId,
            createdAt: stamp.createdAt,
            ...(context.session.threadId ? { threadId: context.session.threadId } : {}),
            message: "Session stopped",
          });
        }

        sessions.delete(context.session.sessionId);
      });

    const requireSession = (
      sessionId: ReturnType<typeof ProviderSessionId.makeUnsafe>,
    ): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> => {
      const context = sessions.get(sessionId);
      if (!context) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            sessionId,
          }),
        );
      }
      if (context.stopped || context.session.status === "closed") {
        return Effect.fail(
          new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            sessionId,
          }),
        );
      }
      return Effect.succeed(context);
    };

    const startSession: ClaudeCodeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const startedAt = yield* nowIso;
        const sessionId = ProviderSessionId.makeUnsafe(
          `claude-session-${yield* Random.nextUUIDv4}`,
        );
        const resumeState = readClaudeResumeState(input.resumeCursor);
        const threadId =
          resumeState?.threadId ??
          ProviderThreadId.makeUnsafe(`claude-thread-${yield* Random.nextUUIDv4}`);

        const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
        const prompt = Stream.fromQueue(promptQueue).pipe(
          Stream.filter((item) => item.type === "message"),
          Stream.map((item) => item.message),
          Stream.toAsyncIterable,
        );

        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        const inFlightTools = new Map<number, ToolInFlight>();

        const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);

        const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const context = yield* Ref.get(contextRef);
              if (!context) {
                return {
                  behavior: "deny",
                  message: "Claude session context is unavailable.",
                } satisfies PermissionResult;
              }

              const approvalPolicy = input.approvalPolicy ?? "never";
              if (approvalPolicy === "never") {
                return {
                  behavior: "allow",
                  updatedInput: toolInput,
                } satisfies PermissionResult;
              }

              const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
              const requestKind = classifyRequestKind(toolName);
              const detail = summarizeToolRequest(toolName, toolInput);
              const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
              const pendingApproval: PendingApproval = {
                requestKind,
                detail,
                decision: decisionDeferred,
                ...(callbackOptions.suggestions
                  ? { suggestions: callbackOptions.suggestions }
                  : {}),
              };

              const requestedStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                type: "approval.requested",
                eventId: requestedStamp.eventId,
                provider: PROVIDER,
                sessionId: context.session.sessionId,
                createdAt: requestedStamp.createdAt,
                ...(context.session.threadId ? { threadId: context.session.threadId } : {}),
                ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
                requestId,
                requestKind,
                detail,
              });

              pendingApprovals.set(requestId, pendingApproval);

              const onAbort = () => {
                if (!pendingApprovals.has(requestId)) {
                  return;
                }
                pendingApprovals.delete(requestId);
                Effect.runFork(Deferred.succeed(decisionDeferred, "cancel"));
              };

              callbackOptions.signal.addEventListener("abort", onAbort, {
                once: true,
              });

              const decision = yield* Deferred.await(decisionDeferred);
              pendingApprovals.delete(requestId);

              const resolvedStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                type: "approval.resolved",
                eventId: resolvedStamp.eventId,
                provider: PROVIDER,
                sessionId: context.session.sessionId,
                createdAt: resolvedStamp.createdAt,
                ...(context.session.threadId ? { threadId: context.session.threadId } : {}),
                ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
                requestId,
                requestKind,
                decision,
              });

              if (decision === "accept" || decision === "acceptForSession") {
                return {
                  behavior: "allow",
                  updatedInput: toolInput,
                  ...(decision === "acceptForSession" && pendingApproval.suggestions
                    ? { updatedPermissions: [...pendingApproval.suggestions] }
                    : {}),
                } satisfies PermissionResult;
              }

              return {
                behavior: "deny",
                message:
                  decision === "cancel"
                    ? "User cancelled tool execution."
                    : "User declined tool execution.",
              } satisfies PermissionResult;
            }),
          );

        const providerOptions = input.providerOptions?.claudeCode;
        const permissionMode = toPermissionMode(providerOptions?.permissionMode);

        const queryOptions: ClaudeQueryOptions = {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(providerOptions?.binaryPath
            ? { pathToClaudeCodeExecutable: providerOptions.binaryPath }
            : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(permissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          ...(providerOptions?.maxThinkingTokens !== undefined
            ? { maxThinkingTokens: providerOptions.maxThinkingTokens }
            : {}),
          ...(resumeState?.resume ? { resume: resumeState.resume } : {}),
          ...(resumeState?.resumeSessionAt ? { resumeSessionAt: resumeState.resumeSessionAt } : {}),
          includePartialMessages: true,
          canUseTool,
          env: process.env,
          ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
        };

        const queryRuntime = yield* Effect.try({
          try: () =>
            createQuery({
              prompt,
              options: queryOptions,
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              sessionId,
              detail: toMessage(cause, "Failed to start Claude runtime session."),
              cause,
            }),
        });

        const session: ProviderSession = {
          sessionId,
          provider: PROVIDER,
          status: "ready",
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.model ? { model: input.model } : {}),
          threadId,
          resumeCursor: {
            threadId,
            resume: resumeState?.resume ?? threadId,
            ...(resumeState?.resumeSessionAt
              ? { resumeSessionAt: resumeState.resumeSessionAt }
              : {}),
            turnCount: resumeState?.turnCount ?? 0,
          },
          createdAt: startedAt,
          updatedAt: startedAt,
        };

        const context: ClaudeSessionContext = {
          session,
          promptQueue,
          query: queryRuntime,
          startedAt,
          pendingApprovals,
          turns: [],
          inFlightTools,
          turnState: undefined,
          lastAssistantUuid: resumeState?.resumeSessionAt,
          lastThreadStartedId: undefined,
          stopped: false,
        };
        yield* Ref.set(contextRef, context);
        sessions.set(sessionId, context);

        const sessionStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.started",
          eventId: sessionStartedStamp.eventId,
          provider: PROVIDER,
          sessionId,
          createdAt: sessionStartedStamp.createdAt,
          threadId,
        });

        Effect.runFork(runSdkStream(context));

        return {
          ...session,
        };
      });

    const sendTurn: ClaudeCodeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.sessionId);

        if (context.turnState) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Session '${input.sessionId}' already has an active turn '${context.turnState.turnId}'.`,
          });
        }

        if (input.model) {
          yield* Effect.tryPromise({
            try: () => context.query.setModel(input.model),
            catch: (cause) => toRequestError(input.sessionId, "turn/setModel", cause),
          });
        }

        const turnId = ProviderTurnId.makeUnsafe(`claude-turn-${yield* Random.nextUUIDv4}`);
        const turnState: ClaudeTurnState = {
          turnId,
          assistantItemId: `claude-message-${yield* Random.nextUUIDv4}`,
          startedAt: yield* nowIso,
          items: [],
          messageCompleted: false,
        };

        const updatedAt = yield* nowIso;
        context.turnState = turnState;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt,
        };

        const turnStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.started",
          eventId: turnStartedStamp.eventId,
          provider: PROVIDER,
          sessionId: context.session.sessionId,
          createdAt: turnStartedStamp.createdAt,
          ...(context.session.threadId ? { threadId: context.session.threadId } : {}),
          turnId,
        });

        const message = buildUserMessage(input);

        yield* Queue.offer(context.promptQueue, {
          type: "message",
          message,
        }).pipe(Effect.mapError((cause) => toRequestError(input.sessionId, "turn/start", cause)));

        const threadId = context.session.threadId;
        if (!threadId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Session thread id is not initialized.",
          });
        }

        return {
          threadId,
          turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        };
      });

    const interruptTurn: ClaudeCodeAdapterShape["interruptTurn"] = (sessionId, _turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(sessionId);
        yield* Effect.tryPromise({
          try: () => context.query.interrupt(),
          catch: (cause) => toRequestError(sessionId, "turn/interrupt", cause),
        });
      });

    const readThread: ClaudeCodeAdapterShape["readThread"] = (sessionId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(sessionId);
        return yield* snapshotThread(context);
      });

    const rollbackThread: ClaudeCodeAdapterShape["rollbackThread"] = (sessionId, numTurns) =>
      Effect.gen(function* () {
        const context = yield* requireSession(sessionId);
        const nextLength = Math.max(0, context.turns.length - numTurns);
        context.turns.splice(nextLength);
        yield* updateResumeCursor(context);
        return yield* snapshotThread(context);
      });

    const respondToRequest: ClaudeCodeAdapterShape["respondToRequest"] = (
      sessionId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(sessionId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/requestApproval/decision",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }

        context.pendingApprovals.delete(requestId);
        yield* Deferred.succeed(pending.decision, decision);
      });

    const stopSession: ClaudeCodeAdapterShape["stopSession"] = (sessionId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(sessionId);
        yield* stopSessionInternal(context, {
          emitExitEvent: true,
        });
      });

    const listSessions: ClaudeCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

    const hasSession: ClaudeCodeAdapterShape["hasSession"] = (sessionId) =>
      Effect.sync(() => {
        const context = sessions.get(sessionId);
        return context !== undefined && !context.stopped;
      });

    const stopAll: ClaudeCodeAdapterShape["stopAll"] = () =>
      Effect.forEach(
        sessions,
        ([, context]) =>
          stopSessionInternal(context, {
            emitExitEvent: true,
          }),
        { discard: true },
      );

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        sessions,
        ([, context]) =>
          stopSessionInternal(context, {
            emitExitEvent: false,
          }),
        { discard: true },
      ).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
    );

    return {
      provider: PROVIDER,
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies ClaudeCodeAdapterShape;
  });
}

export const ClaudeCodeAdapterLive = Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter());

export function makeClaudeCodeAdapterLive(options?: ClaudeCodeAdapterLiveOptions) {
  return Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter(options));
}
