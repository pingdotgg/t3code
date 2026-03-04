/**
 * CursorAdapterLive - Scoped live implementation for the Cursor ACP provider adapter.
 *
 * Spawns `agent acp` over stdio, manages JSON-RPC session lifecycle, and maps
 * ACP notifications/requests into canonical provider runtime events.
 *
 * @module CursorAdapterLive
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import {
  ApprovalRequestId,
  EventId,
  type CanonicalItemType,
  type CanonicalRequestType,
  ProviderItemId,
  ProviderSessionId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderThreadId,
  ProviderTurnId,
  type ProviderTurnStartResult,
  type RuntimeMode,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { DateTime, Effect, Layer, Queue, Random, Schema, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  CursorAdapter,
  type CursorAdapterShape,
  CursorAcpInitializeResult,
  CursorAcpPermissionRequest,
  CursorAcpSessionNewResult,
  CursorAcpSessionPromptResult,
  CursorAcpSessionUpdateNotification,
} from "../Services/CursorAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "cursor" as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const CURSOR_ACP_PROTOCOL_VERSION = 1;

interface CursorResumeState {
  readonly acpSessionId?: string;
}

interface PendingRequest {
  readonly method: string;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface PendingPermission {
  readonly jsonRpcId: string | number;
  readonly requestType: CanonicalRequestType;
  readonly options: ReadonlyArray<{ optionId: string }>;
}

interface CursorTurnState {
  readonly turnId: ReturnType<typeof ProviderTurnId.makeUnsafe>;
  readonly assistantItemId: ReturnType<typeof ProviderItemId.makeUnsafe>;
  readonly startedToolCalls: Set<string>;
  readonly toolCalls: Map<string, { itemType: CanonicalItemType; title: string }>;
  readonly items: Array<unknown>;
}

interface CursorSessionContext {
  session: ProviderSession;
  runtimeMode: RuntimeMode;
  readonly child: ChildProcessWithoutNullStreams;
  readonly output: readline.Interface;
  readonly pending: Map<string, PendingRequest>;
  readonly pendingPermissions: Map<ApprovalRequestId, PendingPermission>;
  readonly turns: Array<{
    id: ReturnType<typeof ProviderTurnId.makeUnsafe>;
    items: Array<unknown>;
  }>;
  turnState: CursorTurnState | undefined;
  acpSessionId: string;
  nextRpcId: number;
  stopping: boolean;
}

export interface CursorAdapterLiveOptions {
  readonly createProcess?: (input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly model?: string;
  }) => ChildProcessWithoutNullStreams;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function asRuntimeSessionId(value: ProviderSessionId): RuntimeSessionId {
  return RuntimeSessionId.makeUnsafe(value);
}

function asRuntimeThreadId(value: ProviderThreadId): ThreadId {
  return ThreadId.makeUnsafe(value);
}

function asRuntimeTurnId(value: ProviderTurnId): TurnId {
  return TurnId.makeUnsafe(value);
}

function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(value);
}

function asProviderItemId(value: string): ProviderItemId {
  return ProviderItemId.makeUnsafe(value);
}

function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(value);
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

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeToolItemType(kind: unknown, title: unknown): CanonicalItemType {
  const normalizedKind = asString(kind)?.toLowerCase();
  const normalizedTitle = asString(title)?.toLowerCase();

  if (normalizedKind === "execute") {
    return "command_execution";
  }
  if (normalizedKind === "edit" || normalizedKind === "write") {
    return "file_change";
  }
  if (normalizedKind === "mcp") {
    return "mcp_tool_call";
  }
  if (normalizedTitle?.includes("terminal")) {
    return "command_execution";
  }
  return "dynamic_tool_call";
}

function normalizeRequestType(toolCall: unknown): CanonicalRequestType {
  const record = asObject(toolCall);
  const kind = asString(record?.kind)?.toLowerCase();
  if (kind === "execute") {
    return "command_execution_approval";
  }
  if (kind === "edit" || kind === "write") {
    return "file_change_approval";
  }
  return "unknown";
}

function selectCursorPermissionOption(
  options: ReadonlyArray<{ optionId: string }>,
  decision: "acceptForSession" | "accept" | "decline" | "cancel",
): string | undefined {
  const allowAlways = options.find((option) => option.optionId === "allow-always");
  const allowOnce = options.find((option) => option.optionId === "allow-once");
  const rejectOnce = options.find((option) => option.optionId === "reject-once");

  if (decision === "acceptForSession") {
    return allowAlways?.optionId ?? allowOnce?.optionId;
  }
  if (decision === "accept") {
    return allowOnce?.optionId ?? allowAlways?.optionId;
  }
  return rejectOnce?.optionId ?? options[0]?.optionId;
}

function selectCursorAutoApprovalOption(
  options: ReadonlyArray<{ optionId: string }>,
): { optionId: string; decision: "acceptForSession" | "accept" } | undefined {
  const allowAlways = options.find((option) => option.optionId === "allow-always");
  if (allowAlways) {
    return {
      optionId: allowAlways.optionId,
      decision: "acceptForSession",
    };
  }
  const allowOnce = options.find((option) => option.optionId === "allow-once");
  if (allowOnce) {
    return {
      optionId: allowOnce.optionId,
      decision: "accept",
    };
  }
  return undefined;
}

function titleForItemType(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

function summarizeToolOutput(rawOutput: unknown): string | undefined {
  const output = asObject(rawOutput);
  if (!output) return undefined;

  const stdout = asString(output.stdout);
  if (stdout && stdout.trim().length > 0) {
    return stdout.trim().slice(0, 400);
  }

  const summary = JSON.stringify(output);
  return summary.length > 400 ? `${summary.slice(0, 397)}...` : summary;
}

function mapStopReasonToTurnState(
  stopReason: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  if (stopReason === "cancelled") return "cancelled";
  if (stopReason === "interrupted") return "interrupted";
  return "completed";
}

function readCursorResumeState(resumeCursor: unknown): CursorResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }

  const cursor = resumeCursor as {
    acpSessionId?: unknown;
    sessionId?: unknown;
  };

  const acpSessionId =
    typeof cursor.acpSessionId === "string"
      ? cursor.acpSessionId
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;

  if (!acpSessionId) {
    return {};
  }
  return { acpSessionId };
}

function writeCursorMessage(context: CursorSessionContext, message: unknown): void {
  if (!context.child.stdin.writable) {
    throw new Error("Cannot write to Cursor ACP stdin.");
  }
  context.child.stdin.write(`${JSON.stringify(message)}\n`);
}

function makeCursorAdapter(options?: CursorAdapterLiveOptions) {
  return Effect.gen(function* () {
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const sessions = new Map<ProviderSessionId, CursorSessionContext>();
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

    const spawnCursorAcp = (input: {
      readonly binaryPath: string;
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly model?: string;
    }): ChildProcessWithoutNullStreams => {
      if (options?.createProcess) {
        return options.createProcess(input);
      }
      const args = input.model ? ["--model", input.model, "acp"] : ["acp"];
      return spawn(input.binaryPath, args, {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    };

    const sendRequest = (
      context: CursorSessionContext,
      method: string,
      params: unknown,
      timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    ): Promise<unknown> => {
      const id = context.nextRpcId;
      context.nextRpcId += 1;

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          context.pending.delete(String(id));
          reject(new Error(`Timed out waiting for ${method}.`));
        }, timeoutMs);

        context.pending.set(String(id), {
          method,
          timeout,
          resolve,
          reject,
        });

        writeCursorMessage(context, {
          jsonrpc: "2.0",
          id,
          method,
          params,
        });
      });
    };

    const resolvePendingRequest = (
      context: CursorSessionContext,
      message: Record<string, unknown>,
    ) => {
      const id = message.id;
      if (typeof id !== "string" && typeof id !== "number") {
        return;
      }
      const pending = context.pending.get(String(id));
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      context.pending.delete(String(id));

      const error = asObject(message.error);
      if (error) {
        pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(error)}`));
        return;
      }

      pending.resolve(message.result);
    };

    const decodePermissionRequest = Schema.decodeUnknownSync(CursorAcpPermissionRequest);
    const decodeSessionUpdateNotification = Schema.decodeUnknownSync(
      CursorAcpSessionUpdateNotification,
    );

    const emitRuntimeWarning = (
      context: CursorSessionContext,
      message: string,
      detail?: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "runtime.warning",
          eventId: stamp.eventId,
          provider: PROVIDER,
          sessionId: asRuntimeSessionId(context.session.sessionId),
          createdAt: stamp.createdAt,
          ...((context.session.threadId ? { threadId: asRuntimeThreadId(context.session.threadId) } : {})),
          ...((context.turnState ? { turnId: asRuntimeTurnId(context.turnState.turnId) } : {})),
          payload: {
            message,
            ...(detail !== undefined ? { detail } : {}),
          },
          providerRefs: {
            providerSessionId: context.session.sessionId,
            ...(context.session.threadId ? { providerThreadId: context.session.threadId } : {}),
            ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
          },
        });
      });

    const completeTurn = (
      context: CursorSessionContext,
      state: "completed" | "failed" | "interrupted" | "cancelled",
      errorMessage?: string,
      stopReason?: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          return;
        }

        const itemStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.completed",
          eventId: itemStamp.eventId,
          provider: PROVIDER,
          sessionId: asRuntimeSessionId(context.session.sessionId),
          createdAt: itemStamp.createdAt,
          ...((context.session.threadId ? { threadId: asRuntimeThreadId(context.session.threadId) } : {})),
          turnId: asRuntimeTurnId(turnState.turnId),
          itemId: asRuntimeItemId(turnState.assistantItemId),
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
          },
          providerRefs: {
            providerSessionId: context.session.sessionId,
            ...(context.session.threadId ? { providerThreadId: context.session.threadId } : {}),
            providerTurnId: turnState.turnId,
            providerItemId: turnState.assistantItemId,
          },
        });

        context.turns.push({
          id: turnState.turnId,
          items: [...turnState.items],
        });

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          sessionId: asRuntimeSessionId(context.session.sessionId),
          createdAt: stamp.createdAt,
          ...((context.session.threadId ? { threadId: asRuntimeThreadId(context.session.threadId) } : {})),
          turnId: asRuntimeTurnId(turnState.turnId),
          payload: {
            state,
            ...(stopReason ? { stopReason } : {}),
            ...(errorMessage ? { errorMessage } : {}),
          },
          providerRefs: {
            providerSessionId: context.session.sessionId,
            ...(context.session.threadId ? { providerThreadId: context.session.threadId } : {}),
            providerTurnId: turnState.turnId,
          },
        });

        context.turnState = undefined;
        context.session = {
          ...context.session,
          status: state === "failed" ? "error" : "ready",
          activeTurnId: undefined,
          ...(errorMessage ? { lastError: errorMessage } : {}),
          updatedAt: yield* nowIso,
        };
      });

    const handlePermissionRequest = (
      context: CursorSessionContext,
      request: unknown,
    ): Effect.Effect<void> => {
      let decoded: ReturnType<typeof decodePermissionRequest>;
      try {
        decoded = decodePermissionRequest(request);
      } catch (error) {
        return emitRuntimeWarning(
          context,
          "Failed to decode Cursor ACP permission request.",
          error,
        );
      }

      return Effect.gen(function* () {
        const requestId = ApprovalRequestId.makeUnsafe(randomUUID());
        const requestType = normalizeRequestType(decoded.params.toolCall);
        const options = decoded.params.options.map((entry) => ({ optionId: entry.optionId }));
        const detail = asString(asObject(decoded.params.toolCall)?.title);

        if (context.runtimeMode === "full-access") {
          const selection =
            selectCursorAutoApprovalOption(options) ??
            (options[0]
              ? {
                  optionId: options[0].optionId,
                  decision: "accept",
                }
              : undefined);
          if (!selection) {
            return yield* emitRuntimeWarning(
              context,
              "Cursor ACP permission request contained no selectable options.",
              decoded.params,
            );
          }

          writeCursorMessage(context, {
            jsonrpc: "2.0",
            id: decoded.id,
            result: {
              outcome: {
                outcome: "selected",
                optionId: selection.optionId,
              },
            },
          });

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "request.resolved",
            eventId: stamp.eventId,
            provider: PROVIDER,
            sessionId: asRuntimeSessionId(context.session.sessionId),
            createdAt: stamp.createdAt,
            ...((context.session.threadId ? { threadId: asRuntimeThreadId(context.session.threadId) } : {})),
            ...((context.turnState ? { turnId: asRuntimeTurnId(context.turnState.turnId) } : {})),
            requestId: asRuntimeRequestId(requestId),
            payload: {
              requestType,
              decision: selection.decision,
              resolution: {
                optionId: selection.optionId,
                autoApproved: true,
              },
            },
            providerRefs: {
              providerSessionId: context.session.sessionId,
              ...(context.session.threadId ? { providerThreadId: context.session.threadId } : {}),
              ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
              providerRequestId: String(decoded.id),
            },
            raw: {
              source: "cursor.acp.response",
              method: "session/request_permission",
              payload: {
                optionId: selection.optionId,
                autoApproved: true,
              },
            },
          });
          return;
        }

        context.pendingPermissions.set(requestId, {
          jsonRpcId: decoded.id,
          requestType,
          options,
        });

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "request.opened",
          eventId: stamp.eventId,
          provider: PROVIDER,
          sessionId: asRuntimeSessionId(context.session.sessionId),
          createdAt: stamp.createdAt,
          ...((context.session.threadId ? { threadId: asRuntimeThreadId(context.session.threadId) } : {})),
          ...((context.turnState ? { turnId: asRuntimeTurnId(context.turnState.turnId) } : {})),
          requestId: asRuntimeRequestId(requestId),
          payload: {
            requestType,
            ...(detail ? { detail } : {}),
            args: decoded.params,
          },
          providerRefs: {
            providerSessionId: context.session.sessionId,
            ...(context.session.threadId ? { providerThreadId: context.session.threadId } : {}),
            ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
            providerRequestId: String(decoded.id),
          },
          raw: {
            source: "cursor.acp.request",
            method: decoded.method,
            payload: decoded,
          },
        });
      });
    };

    const handleSessionUpdateNotification = (
      context: CursorSessionContext,
      notification: unknown,
    ): Effect.Effect<void> => {
      let decoded: ReturnType<typeof decodeSessionUpdateNotification>;
      try {
        decoded = decodeSessionUpdateNotification(notification);
      } catch (error) {
        return emitRuntimeWarning(
          context,
          "Failed to decode Cursor ACP session/update notification.",
          error,
        );
      }

      return Effect.gen(function* () {
        const update = decoded.params.update;

        const base = {
          provider: PROVIDER,
          sessionId: asRuntimeSessionId(context.session.sessionId),
          ...((context.session.threadId ? { threadId: asRuntimeThreadId(context.session.threadId) } : {})),
          ...((context.turnState ? { turnId: asRuntimeTurnId(context.turnState.turnId) } : {})),
          providerRefs: {
            providerSessionId: context.session.sessionId,
            ...(context.session.threadId ? { providerThreadId: context.session.threadId } : {}),
            ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
          },
          raw: {
            source: "cursor.acp.notification" as const,
            method: decoded.method,
            messageType: update.sessionUpdate,
            payload: decoded,
          },
        };

        switch (update.sessionUpdate) {
          case "available_commands_update": {
            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              ...base,
              type: "session.configured",
              eventId: stamp.eventId,
              createdAt: stamp.createdAt,
              payload: {
                config: {
                  availableCommands: update.availableCommands,
                },
              },
            });
            return;
          }

          case "agent_thought_chunk": {
            if (!context.turnState) return;
            if (update.content.text.length === 0) return;
            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              ...base,
              type: "content.delta",
              eventId: stamp.eventId,
              createdAt: stamp.createdAt,
              turnId: asRuntimeTurnId(context.turnState.turnId),
              itemId: asRuntimeItemId(context.turnState.assistantItemId),
              payload: {
                streamKind: "reasoning_text",
                delta: update.content.text,
              },
            });
            return;
          }

          case "agent_message_chunk": {
            if (!context.turnState) return;
            if (update.content.text.length === 0) return;
            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              ...base,
              type: "content.delta",
              eventId: stamp.eventId,
              createdAt: stamp.createdAt,
              turnId: asRuntimeTurnId(context.turnState.turnId),
              itemId: asRuntimeItemId(context.turnState.assistantItemId),
              payload: {
                streamKind: "assistant_text",
                delta: update.content.text,
              },
            });
            return;
          }

          case "tool_call": {
            if (!context.turnState) return;
            const seen = context.turnState.startedToolCalls.has(update.toolCallId);
            const itemType = normalizeToolItemType(update.kind, update.title);
            const title = update.title ?? titleForItemType(itemType);
            context.turnState.toolCalls.set(update.toolCallId, { itemType, title });
            const detail = asString(asObject(update.rawInput)?.command);

            if (!seen) {
              context.turnState.startedToolCalls.add(update.toolCallId);
              const stamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                ...base,
                type: "item.started",
                eventId: stamp.eventId,
                createdAt: stamp.createdAt,
                turnId: asRuntimeTurnId(context.turnState.turnId),
                itemId: asRuntimeItemId(update.toolCallId),
                payload: {
                  itemType,
                  status: "inProgress",
                  title,
                  ...(detail ? { detail } : {}),
                  ...(update.rawInput !== undefined ? { data: update.rawInput } : {}),
                },
              });
              return;
            }

            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              ...base,
              type: "item.updated",
              eventId: stamp.eventId,
              createdAt: stamp.createdAt,
              turnId: asRuntimeTurnId(context.turnState.turnId),
              itemId: asRuntimeItemId(update.toolCallId),
              payload: {
                itemType,
                status: "inProgress",
                title,
                ...(detail ? { detail } : {}),
                ...(update.rawInput !== undefined ? { data: update.rawInput } : {}),
              },
            });
            return;
          }

          case "tool_call_update": {
            if (!context.turnState) return;
            const status = update.status === "completed" ? "completed" : "inProgress";
            const trackedTool = context.turnState.toolCalls.get(update.toolCallId);
            const itemType = trackedTool?.itemType ?? "dynamic_tool_call";
            const title = trackedTool?.title ?? titleForItemType(itemType);
            const stamp = yield* makeEventStamp();
            const eventType = update.status === "completed" ? "item.completed" : "item.updated";
            yield* offerRuntimeEvent({
              ...base,
              type: eventType,
              eventId: stamp.eventId,
              createdAt: stamp.createdAt,
              turnId: asRuntimeTurnId(context.turnState.turnId),
              itemId: asRuntimeItemId(update.toolCallId),
              payload: {
                itemType,
                status,
                title,
                ...(summarizeToolOutput(update.rawOutput)
                  ? { detail: summarizeToolOutput(update.rawOutput) }
                  : {}),
                ...(update.rawOutput !== undefined ? { data: update.rawOutput } : {}),
              },
            });
            if (update.status === "completed") {
              context.turnState.toolCalls.delete(update.toolCallId);
            }
            return;
          }
        }
      });
    };

    const handleStdoutLine = (context: CursorSessionContext, line: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        Effect.runFork(
          emitRuntimeWarning(context, "Received invalid JSON from Cursor ACP.", {
            line,
          }),
        );
        return;
      }

      const message = asObject(parsed);
      if (!message) {
        Effect.runFork(
          emitRuntimeWarning(context, "Received non-object protocol message from Cursor ACP."),
        );
        return;
      }

      if (nativeEventLogger) {
        try {
          const nativeMethod =
            typeof message.method === "string"
              ? message.method
              : typeof message.id === "string" || typeof message.id === "number"
                ? "cursor/acp/response"
                : "cursor/acp/message";
          const nativeKind =
            typeof message.method === "string" &&
            (typeof message.id === "string" || typeof message.id === "number")
              ? "request"
              : typeof message.method === "string"
                ? "notification"
                : "session";
          Effect.runFork(
            nativeEventLogger
              .write(
                {
                  observedAt: new Date().toISOString(),
                  event: {
                    id: EventId.makeUnsafe(randomUUID()),
                    kind: nativeKind,
                    provider: PROVIDER,
                    sessionId: asRuntimeSessionId(context.session.sessionId),
                    createdAt: new Date().toISOString(),
                    method: nativeMethod,
                    ...(context.session.threadId ? { threadId: context.session.threadId } : {}),
                    ...(context.turnState ? { turnId: String(context.turnState.turnId) } : {}),
                    payload: message,
                  },
                },
                null,
              ),
          );
        } catch {
          // Native logging must never block or break protocol handling.
        }
      }

      if (
        (typeof message.id === "string" || typeof message.id === "number") &&
        typeof message.method === "string"
      ) {
        if (message.method === "session/request_permission") {
          Effect.runFork(handlePermissionRequest(context, message));
          return;
        }

        writeCursorMessage(context, {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32601,
            message: `Unsupported server request: ${message.method}`,
          },
        });
        return;
      }

      if (
        (typeof message.id === "string" || typeof message.id === "number") &&
        ("result" in message || "error" in message)
      ) {
        resolvePendingRequest(context, message);
        return;
      }

      if (typeof message.method === "string") {
        if (message.method === "session/update") {
          Effect.runFork(handleSessionUpdateNotification(context, message));
          return;
        }

        Effect.runFork(
          emitRuntimeWarning(
            context,
            `Unhandled Cursor ACP notification '${message.method}'.`,
            message,
          ),
        );
        return;
      }

      Effect.runFork(
        emitRuntimeWarning(context, "Received unrecognized protocol message from Cursor ACP.", {
          message,
        }),
      );
    };

    const stopSessionInternal = (
      context: CursorSessionContext,
      options?: { readonly emitExitEvent?: boolean },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (context.stopping) return;
        context.stopping = true;

        for (const pending of context.pending.values()) {
          clearTimeout(pending.timeout);
          pending.reject(new Error("Cursor session stopped before request completion."));
        }
        context.pending.clear();

        if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Session stopped.", "cancelled");
        }

        context.output.close();
        if (!context.child.killed) {
          context.child.kill();
        }

        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
        };

        if (options?.emitExitEvent !== false) {
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "session.exited",
            eventId: stamp.eventId,
            provider: PROVIDER,
            sessionId: asRuntimeSessionId(context.session.sessionId),
            createdAt: stamp.createdAt,
            ...((context.session.threadId ? { threadId: asRuntimeThreadId(context.session.threadId) } : {})),
            payload: {
              reason: "Session stopped",
              exitKind: "graceful",
            },
            providerRefs: {
              providerSessionId: context.session.sessionId,
              ...(context.session.threadId ? { providerThreadId: context.session.threadId } : {}),
            },
          });
        }

        sessions.delete(context.session.sessionId);
      });

    const requireSession = (
      sessionId: ReturnType<typeof ProviderSessionId.makeUnsafe>,
    ): Effect.Effect<CursorSessionContext, ProviderAdapterError> => {
      const context = sessions.get(sessionId);
      if (!context) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            sessionId,
          }),
        );
      }
      if (context.stopping || context.session.status === "closed") {
        return Effect.fail(
          new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            sessionId,
          }),
        );
      }
      return Effect.succeed(context);
    };

    const startSession: CursorAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const startedAt = yield* nowIso;
        const sessionId = ProviderSessionId.makeUnsafe(yield* Random.nextUUIDv4);
        const cwd = input.cwd ?? process.cwd();
        const cursorOptions = input.providerOptions?.cursor as { binaryPath?: string } | undefined;
        const binaryPath = cursorOptions?.binaryPath ?? "agent";
        const resumeState = readCursorResumeState(input.resumeCursor);

        const child = yield* Effect.try({
          try: () =>
            spawnCursorAcp({
              binaryPath,
              cwd,
              env: process.env,
              ...(input.model ? { model: input.model } : {}),
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              sessionId,
              detail: toMessage(cause, "Failed to spawn Cursor ACP process."),
              cause,
            }),
        });

        const output = readline.createInterface({ input: child.stdout });

        const session: ProviderSession = {
          sessionId,
          provider: PROVIDER,
          status: "connecting",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.model ? { model: input.model } : {}),
          createdAt: startedAt,
          updatedAt: startedAt,
        };

        const context: CursorSessionContext = {
          session,
          runtimeMode: input.runtimeMode,
          child,
          output,
          pending: new Map(),
          pendingPermissions: new Map(),
          turns: [],
          turnState: undefined,
          acpSessionId: resumeState?.acpSessionId ?? "",
          nextRpcId: 1,
          stopping: false,
        };

        output.on("line", (line) => {
          handleStdoutLine(context, line);
        });

        child.stderr.on("data", (chunk: Buffer) => {
          const message = chunk.toString().trim();
          if (message.length === 0) {
            return;
          }
          Effect.runFork(
            emitRuntimeWarning(context, "Cursor ACP stderr output", {
              message,
            }),
          );
        });

        child.on("error", (error) => {
          Effect.runFork(
            Effect.gen(function* () {
              const stamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                type: "runtime.error",
                eventId: stamp.eventId,
                provider: PROVIDER,
                sessionId: asRuntimeSessionId(context.session.sessionId),
                createdAt: stamp.createdAt,
                ...((context.session.threadId ? { threadId: asRuntimeThreadId(context.session.threadId) } : {})),
                ...((context.turnState ? { turnId: asRuntimeTurnId(context.turnState.turnId) } : {})),
                payload: {
                  message: error.message || "Cursor ACP process error.",
                  class: "transport_error",
                  detail: error,
                },
              });
            }),
          );
        });

        child.on("exit", (code, signal) => {
          if (context.stopping) {
            return;
          }
          Effect.runFork(
            Effect.gen(function* () {
              if (context.turnState) {
                yield* completeTurn(
                  context,
                  "failed",
                  `Cursor ACP exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
                );
              }

              const stamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                type: "session.exited",
                eventId: stamp.eventId,
                provider: PROVIDER,
                sessionId: asRuntimeSessionId(context.session.sessionId),
                createdAt: stamp.createdAt,
                ...((context.session.threadId ? { threadId: asRuntimeThreadId(context.session.threadId) } : {})),
                payload: {
                  reason: `Cursor ACP exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
                  exitKind: code === 0 ? "graceful" : "error",
                  recoverable: code === 0,
                },
              });

              sessions.delete(context.session.sessionId);
            }),
          );
        });

        sessions.set(sessionId, context);

        const initializeResult = yield* Effect.tryPromise({
          try: async () =>
            sendRequest(context, "initialize", {
              protocolVersion: CURSOR_ACP_PROTOCOL_VERSION,
            }),
          catch: (cause) => toRequestError(sessionId, "initialize", cause),
        });
        const decodedInitialize = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(CursorAcpInitializeResult)(initializeResult),
          catch: (cause) =>
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "Cursor initialize response did not match expected schema.",
              cause,
            }),
        });

        const initStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.configured",
          eventId: initStamp.eventId,
          provider: PROVIDER,
          sessionId: asRuntimeSessionId(sessionId),
          createdAt: initStamp.createdAt,
          payload: {
            config: decodedInitialize,
          },
          providerRefs: {
            providerSessionId: sessionId,
          },
          raw: {
            source: "cursor.acp.response",
            method: "initialize",
            payload: initializeResult,
          },
        });

        const authenticateRequest = { methodId: "cursor_login" };
        const authStartStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "auth.status",
          eventId: authStartStamp.eventId,
          provider: PROVIDER,
          sessionId: asRuntimeSessionId(sessionId),
          createdAt: authStartStamp.createdAt,
          payload: {
            isAuthenticating: true,
          },
          providerRefs: {
            providerSessionId: sessionId,
          },
          raw: {
            source: "cursor.acp.request",
            method: "authenticate",
            payload: authenticateRequest,
          },
        });

        const authenticateResult = yield* Effect.tryPromise({
          try: async () => sendRequest(context, "authenticate", authenticateRequest),
          catch: (cause) => toRequestError(sessionId, "authenticate", cause),
        }).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (value) => ({ ok: true as const, value }),
          }),
        );
        const authEndStamp = yield* makeEventStamp();
        if (!authenticateResult.ok) {
          yield* offerRuntimeEvent({
            type: "auth.status",
            eventId: authEndStamp.eventId,
            provider: PROVIDER,
            sessionId: asRuntimeSessionId(sessionId),
            createdAt: authEndStamp.createdAt,
            payload: {
              isAuthenticating: false,
              error: toMessage(authenticateResult.error, "Cursor authentication failed."),
            },
            providerRefs: {
              providerSessionId: sessionId,
            },
            raw: {
              source: "cursor.acp.response",
              method: "authenticate",
              payload: {
                error: toMessage(authenticateResult.error, "Cursor authentication failed."),
              },
            },
          });
        } else {
          yield* offerRuntimeEvent({
            type: "auth.status",
            eventId: authEndStamp.eventId,
            provider: PROVIDER,
            sessionId: asRuntimeSessionId(sessionId),
            createdAt: authEndStamp.createdAt,
            payload: {
              isAuthenticating: false,
            },
            providerRefs: {
              providerSessionId: sessionId,
            },
            raw: {
              source: "cursor.acp.response",
              method: "authenticate",
              payload: authenticateResult.value,
            },
          });
        }

        const acpSessionId = yield* Effect.tryPromise({
          try: async () => {
            if (resumeState?.acpSessionId) {
              await sendRequest(context, "session/load", {
                sessionId: resumeState.acpSessionId,
                cwd,
                mcpServers: [],
              });
              return resumeState.acpSessionId;
            }

            const sessionNewParams: {
              cwd: string;
              mcpServers: [];
              model?: string;
            } = {
              cwd,
              mcpServers: [],
            };
            if (input.model) {
              sessionNewParams.model = input.model;
            }
            const result = await sendRequest(context, "session/new", sessionNewParams);
            const decoded = Schema.decodeUnknownSync(CursorAcpSessionNewResult)(result);
            return decoded.sessionId;
          },
          catch: (cause) => toRequestError(sessionId, "session/new|session/load", cause),
        });

        const threadId = ProviderThreadId.makeUnsafe(acpSessionId);
        context.acpSessionId = acpSessionId;
        context.session = {
          ...context.session,
          status: "ready",
          threadId,
          resumeCursor: {
            acpSessionId,
          },
          updatedAt: yield* nowIso,
        };

        const sessionStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.started",
          eventId: sessionStartedStamp.eventId,
          provider: PROVIDER,
          sessionId: asRuntimeSessionId(sessionId),
          createdAt: sessionStartedStamp.createdAt,
          threadId: asRuntimeThreadId(threadId),
          payload: resumeState?.acpSessionId ? { resume: input.resumeCursor } : {},
          providerRefs: {
            providerSessionId: sessionId,
            providerThreadId: threadId,
          },
        });

        const threadStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "thread.started",
          eventId: threadStartedStamp.eventId,
          provider: PROVIDER,
          sessionId: asRuntimeSessionId(sessionId),
          createdAt: threadStartedStamp.createdAt,
          threadId: asRuntimeThreadId(threadId),
          payload: {
            providerThreadId: threadId,
          },
          providerRefs: {
            providerSessionId: sessionId,
            providerThreadId: threadId,
          },
        });

        const readyStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          eventId: readyStamp.eventId,
          provider: PROVIDER,
          sessionId: asRuntimeSessionId(sessionId),
          createdAt: readyStamp.createdAt,
          threadId: asRuntimeThreadId(threadId),
          payload: {
            state: "ready",
          },
          providerRefs: {
            providerSessionId: sessionId,
            providerThreadId: threadId,
          },
        });

        return {
          ...context.session,
        };
      });

    const sendTurn: CursorAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.sessionId);

        if (context.turnState) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Session '${input.sessionId}' already has an active turn '${context.turnState.turnId}'.`,
          });
        }

        const promptText = input.input?.trim();
        if (!promptText || promptText.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn input must be non-empty.",
          });
        }

        const turnId = ProviderTurnId.makeUnsafe(yield* Random.nextUUIDv4);
        const turnState: CursorTurnState = {
          turnId,
          assistantItemId: asProviderItemId(yield* Random.nextUUIDv4),
          startedToolCalls: new Set(),
          toolCalls: new Map(),
          items: [],
        };

        context.turnState = turnState;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        const startedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.started",
          eventId: startedStamp.eventId,
          provider: PROVIDER,
          sessionId: asRuntimeSessionId(context.session.sessionId),
          createdAt: startedStamp.createdAt,
          ...((context.session.threadId ? { threadId: asRuntimeThreadId(context.session.threadId) } : {})),
          turnId: asRuntimeTurnId(turnId),
          payload: {
            ...(input.model ? { model: input.model } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
          },
          providerRefs: {
            providerSessionId: context.session.sessionId,
            ...(context.session.threadId ? { providerThreadId: context.session.threadId } : {}),
            providerTurnId: turnId,
          },
        });

        const promptResultRaw = yield* Effect.tryPromise({
          try: async () =>
            sendRequest(context, "session/prompt", {
              sessionId: context.acpSessionId,
              prompt: [{ type: "text", text: promptText }],
            }),
          catch: (cause) => toRequestError(input.sessionId, "session/prompt", cause),
        });

        const promptResult = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(CursorAcpSessionPromptResult)(promptResultRaw),
          catch: (cause) =>
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Cursor session/prompt response did not match expected schema.",
              cause,
            }),
        });
        const turnStateValue = mapStopReasonToTurnState(promptResult.stopReason);
        yield* completeTurn(
          context,
          turnStateValue,
          turnStateValue === "failed" ? "Cursor prompt failed." : undefined,
          promptResult.stopReason,
        );

        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
          resumeCursor: {
            acpSessionId: context.acpSessionId,
          },
        };

        return {
          ...(context.session.threadId ? { threadId: context.session.threadId } : {}),
          turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        } satisfies ProviderTurnStartResult;
      });

    const interruptTurn: CursorAdapterShape["interruptTurn"] = (sessionId, _turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(sessionId);
        if (!context.turnState) {
          return;
        }

        const cancelResult = yield* Effect.tryPromise({
          try: async () =>
            sendRequest(context, "session/cancel", { sessionId: context.acpSessionId }, 15_000),
          catch: (cause) => toRequestError(sessionId, "session/cancel", cause),
        }).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: () => ({ ok: true as const }),
          }),
        );

        if (!cancelResult.ok) {
          yield* emitRuntimeWarning(
            context,
            "Cursor ACP session/cancel is unavailable; marking turn as interrupted.",
            cancelResult.error,
          );
        }

        yield* completeTurn(context, "interrupted", "Turn interrupted by user.", "cancelled");
      });

    const readThread: CursorAdapterShape["readThread"] = (sessionId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(sessionId);
        return {
          threadId: ProviderThreadId.makeUnsafe(context.acpSessionId),
          turns: context.turns.map((turn) => ({
            id: turn.id,
            items: [...turn.items],
          })),
        };
      });

    const rollbackThread: CursorAdapterShape["rollbackThread"] = (sessionId, _numTurns) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: `Cursor ACP does not support thread rollback for session '${sessionId}'.`,
        }),
      );

    const respondToRequest: CursorAdapterShape["respondToRequest"] = (
      sessionId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(sessionId);
        const pending = context.pendingPermissions.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending permission request: ${requestId}`,
          });
        }

        const optionId = selectCursorPermissionOption(pending.options, decision);

        if (!optionId) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `No selectable permission options for request: ${requestId}`,
          });
        }

        writeCursorMessage(context, {
          jsonrpc: "2.0",
          id: pending.jsonRpcId,
          result: {
            outcome: {
              outcome: "selected",
              optionId,
            },
          },
        });

        context.pendingPermissions.delete(requestId);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "request.resolved",
          eventId: stamp.eventId,
          provider: PROVIDER,
          sessionId: asRuntimeSessionId(context.session.sessionId),
          createdAt: stamp.createdAt,
          ...((context.session.threadId ? { threadId: asRuntimeThreadId(context.session.threadId) } : {})),
          ...((context.turnState ? { turnId: asRuntimeTurnId(context.turnState.turnId) } : {})),
          requestId: asRuntimeRequestId(requestId),
          payload: {
            requestType: pending.requestType,
            decision,
            resolution: {
              optionId,
            },
          },
          providerRefs: {
            providerSessionId: context.session.sessionId,
            ...(context.session.threadId ? { providerThreadId: context.session.threadId } : {}),
            ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
            providerRequestId: String(pending.jsonRpcId),
          },
          raw: {
            source: "cursor.acp.response",
            method: "session/request_permission",
            payload: {
              optionId,
            },
          },
        });
      });

    const stopSession: CursorAdapterShape["stopSession"] = (sessionId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(sessionId);
        yield* stopSessionInternal(context, {
          emitExitEvent: true,
        });
      });

    const listSessions: CursorAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

    const hasSession: CursorAdapterShape["hasSession"] = (sessionId) =>
      Effect.sync(() => {
        const context = sessions.get(sessionId);
        return context !== undefined && !context.stopping;
      });

    const stopAll: CursorAdapterShape["stopAll"] = () =>
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
      capabilities: {
        sessionModelSwitch: "unsupported",
      },
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
    } satisfies CursorAdapterShape;
  });
}

export const CursorAdapterLive = Layer.effect(CursorAdapter, makeCursorAdapter());

export function makeCursorAdapterLive(options?: CursorAdapterLiveOptions) {
  return Layer.effect(CursorAdapter, makeCursorAdapter(options));
}
