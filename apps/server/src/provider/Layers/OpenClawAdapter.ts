/**
 * OpenClawAdapter — per-instance OpenClaw adapter.
 *
 * Maps the OpenClaw Gateway WebSocket protocol onto the canonical
 * `ProviderRuntimeEvent` stream. One Gateway connection is shared by every
 * thread of this instance (see {@link OpenClawGatewayHolder}); each T3 thread
 * is bound to its own gateway **session** keyed by `sessions.create`, and that
 * key is the durable resume cursor.
 *
 * Design decisions:
 *
 * - **Sessions.** `sessions.create` (key `t3-<uuid>`) mints one gateway
 *   session per T3 thread. Resuming re-adopts the stored key. Session records
 *   live in the gateway, so `stopSession` only aborts in-flight work and
 *   drops the local context — the gateway transcript survives for resume.
 * - **Send.** The `agent` RPC with `sessionKey`, `cwd`, `idempotencyKey`, and
 *   optional `model`/`thinking`. It returns an immediate `status:"accepted"`
 *   ack with the run id; streamed `agent` events carry the deltas
 *   (`stream:"assistant"|"thinking"`), tool lifecycles (`stream:"tool"`),
 *   approvals (`stream:"approval"`), and the terminal lifecycle
 *   (`stream:"lifecycle"`, phase `start|end|error`). The final completion
 *   `res` for the same request id arrives later as a `response` event and is
 *   used as a fallback terminal.
 * - **Steering.** A `sendTurn` while a run is active reuses the active turn id
 *   and sends into the same session; the gateway queues it into the running
 *   lane.
 * - **Interrupts.** `chat.abort {sessionKey, runId}` cancels the active run;
 *   the lifecycle `end` then completes the turn as `interrupted`.
 * - **Approvals.** OpenClaw's tool-approval surface (`exec.approval.*`,
 *   `operator.approvals` scope) maps onto `request.opened`/`request.resolved`;
 *   `respondToRequest` resolves via `exec.approval.resolve {id, decision}`.
 *   `respondToUserInput` fails cleanly — OpenClaw has no free-text input RPC.
 * - **rollback.** Not supported (OpenClaw rewinds/branches by transcript entry
 *   id, not turn count); `rollbackThread` fails with a validation error.
 *
 * @module provider/Layers/OpenClawAdapter
 */
import {
  ApprovalRequestId,
  EventId,
  type OpenClawSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type OpenClawAdapterShape } from "../Services/OpenClawAdapter.ts";
import {
  openClawRuntimeErrorDetail,
  type OpenClawGatewayConnection,
  type OpenClawGatewayEvent,
  OpenClawRuntime,
  type OpenClawRuntimeError,
} from "../openclawRuntime.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("openclaw");

/**
 * Version tag stamped into the OpenClaw resume cursor. Bump if the cursor
 * shape changes so stale cursors written by older builds are ignored.
 */
const OPENCLAW_RESUME_VERSION = 1 as const;

export interface OpenClawAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  /** Isolated state dir for spawned gateways (see openclawRuntime). */
  readonly stateDir?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Shared gateway connection holder. The driver creates one per instance and
   * hands it to both the adapter and text generation so a single gateway is
   * spawned (or connected) lazily and shared by all consumers.
   */
  readonly gateway: OpenClawGatewayHolder;
}

export interface OpenClawGatewayHolder {
  /**
   * Resolve the instance gateway connection: connect to `gatewayUrl` when
   * configured, otherwise spawn a gateway process. The connection is cached
   * for the holder's lifetime and released when the driver's scope closes.
   */
  readonly acquire: (input: {
    readonly binaryPath: string;
    readonly gatewayUrl?: string;
    readonly gatewayToken?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly stateDir?: string;
    readonly launchArgs?: ReadonlyArray<string>;
  }) => Effect.Effect<OpenClawGatewayConnection, OpenClawRuntimeError>;
}

/**
 * Build the driver-owned gateway holder. The connection's process lifetime is
 * bound to `gatewayScope`, which the caller (driver) closes on teardown.
 */
export const makeOpenClawGatewayHolder = (
  gatewayScope: Scope.Scope,
): Effect.Effect<OpenClawGatewayHolder, never, OpenClawRuntime> =>
  Effect.gen(function* () {
    const openClawRuntime = yield* OpenClawRuntime;
    const cached = yield* Ref.make<Option.Option<OpenClawGatewayConnection>>(Option.none());
    const mutex = yield* Semaphore.make(1);
    return {
      acquire: (input) =>
        mutex.withPermit(
          Effect.gen(function* () {
            const existing = yield* Ref.get(cached);
            if (Option.isSome(existing)) {
              return existing.value;
            }
            const connection = yield* openClawRuntime
              .connectToOpenClawGateway({
                binaryPath: input.binaryPath,
                ...(input.gatewayUrl?.trim() ? { gatewayUrl: input.gatewayUrl } : {}),
                ...(input.gatewayToken?.trim() ? { gatewayToken: input.gatewayToken } : {}),
                ...(input.environment !== undefined ? { environment: input.environment } : {}),
                ...(input.stateDir !== undefined ? { stateDir: input.stateDir } : {}),
                ...(input.launchArgs !== undefined ? { launchArgs: input.launchArgs } : {}),
              })
              .pipe(Effect.provideService(Scope.Scope, gatewayScope));
            yield* Ref.set(cached, Option.some(connection));
            return connection;
          }),
        ),
    };
  });

/**
 * Decode a persisted resume cursor into the gateway session key. Anything
 * that isn't a current-version cursor with a non-empty key means "no resume".
 */
export function parseOpenClawResume(raw: unknown): { readonly sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== OPENCLAW_RESUME_VERSION) {
    return undefined;
  }
  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    return undefined;
  }
  return { sessionId: record.sessionId.trim() };
}

/**
 * Whether an error definitively reports a missing gateway session. Only a
 * confirmed miss may silently start a fresh session; other failures must
 * propagate so a transient blip never resets a live thread. Decides on
 * structured signals only (a `NOT_FOUND`-family error code).
 */
export function isOpenClawSessionNotFound(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }
  const record = cause as Record<string, unknown>;
  const code = record.code;
  if (code === "NOT_FOUND" || code === "SESSION_NOT_FOUND") {
    return true;
  }
  const details = record.details;
  if (typeof details === "object" && details !== null) {
    const detailCode = (details as Record<string, unknown>).code;
    if (detailCode === "NOT_FOUND" || detailCode === "SESSION_NOT_FOUND") {
      return true;
    }
  }
  // The runtime wraps RPC failures in `OpenClawRuntimeError` and keeps the
  // structured gateway error (with the `code`) in `cause`. Recurse so a
  // NOT_FOUND-failure delivered through the runtime is still recognized.
  const nested = record.cause;
  if (typeof nested === "object" && nested !== null) {
    return isOpenClawSessionNotFound(nested);
  }
  return false;
}

interface OpenClawSessionContext {
  readonly threadId: ThreadId;
  readonly sessionKey: string;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  activeRunId: string | undefined;
  readonly interruptedTurnIds: Set<TurnId>;
  /** T3 request id → gateway approval id, for respondToRequest. */
  readonly pendingApprovals: Map<ApprovalRequestId, string>;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toCanonicalItemType(
  toolName: string | undefined,
): Extract<ProviderRuntimeEvent, { type: "item.started" }>["payload"]["itemType"] {
  const name = toolName?.toLowerCase().trim() ?? "";
  if (/^(bash|sh|shell|exec|run|command)/.test(name)) return "command_execution";
  if (/^(write|edit|patch|apply|fs\.)/.test(name)) return "file_change";
  if (/^mcp/.test(name)) return "mcp_tool_call";
  if (/^(web|search|fetch)/.test(name)) return "web_search";
  return "unknown";
}

function itemTitleForTool(
  itemType: ReturnType<typeof toCanonicalItemType>,
  toolName: string | undefined,
): string | undefined {
  if (itemType === "command_execution") return "Ran command";
  if (itemType === "file_change") return "File change";
  if (itemType === "mcp_tool_call") return "MCP tool call";
  if (itemType === "web_search") return "Web search";
  return trimText(toolName) ? `Tool: ${toolName}` : undefined;
}

function mapApprovalRequestType(
  kind: unknown,
): Extract<ProviderRuntimeEvent, { type: "request.opened" }>["payload"]["requestType"] {
  if (kind === "exec") return "command_execution_approval";
  return "unknown";
}

function toApprovalDecision(
  decision: "accept" | "acceptForSession" | "decline" | "cancel",
): string {
  switch (decision) {
    case "accept":
    case "acceptForSession":
      return "allow";
    case "decline":
    case "cancel":
    default:
      return "deny";
  }
}

function parseLaunchArgs(launchArgs: string | undefined): ReadonlyArray<string> | undefined {
  if (!launchArgs || launchArgs.trim().length === 0) {
    return undefined;
  }
  const args = launchArgs
    .trim()
    .split(/\s+/)
    .filter((arg) => arg.length > 0);
  return args.length > 0 ? args : undefined;
}

export const makeOpenClawAdapter = Effect.fn("makeOpenClawAdapter")(function* (
  openClawSettings: OpenClawSettings,
  options: OpenClawAdapterLiveOptions,
) {
  const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("openclaw");
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const nativeEventLogger = options.nativeEventLogger;

  const sessions = new Map<ThreadId, OpenClawSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const lifecycleScope = yield* Scope.make();
  const eventPumpFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | undefined>(undefined);

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate OpenClaw runtime identifier.",
          cause,
        }),
    ),
  );
  const makeEventStamp = () =>
    Effect.all({
      eventId: Effect.map(randomUUIDv4, EventId.make),
      createdAt: nowIso,
    });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  type GatewayAcquireInput = Parameters<OpenClawGatewayHolder["acquire"]>[0];
  const gatewayAcquireInput = (): GatewayAcquireInput => {
    const launchArgs = parseLaunchArgs(openClawSettings.launchArgs);
    const input: GatewayAcquireInput = {
      binaryPath: openClawSettings.binaryPath,
      ...(openClawSettings.gatewayUrl?.trim() ? { gatewayUrl: openClawSettings.gatewayUrl } : {}),
      ...(openClawSettings.gatewayToken?.trim()
        ? { gatewayToken: openClawSettings.gatewayToken }
        : {}),
      ...(options.environment !== undefined ? { environment: options.environment } : {}),
      ...(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}),
    };
    return launchArgs !== undefined ? { ...input, launchArgs } : input;
  };

  const acquireGateway = (method: string, threadId: ThreadId) =>
    options.gateway.acquire(gatewayAcquireInput()).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: cause.detail,
            cause,
          }),
      ),
    );

  const requireSession = Effect.fn("requireSession")(function* (threadId: ThreadId) {
    const ctx = sessions.get(threadId);
    if (!ctx || ctx.stopped) {
      return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
    }
    return ctx;
  });

  const resetSessionToReady = (ctx: OpenClawSessionContext) =>
    Effect.gen(function* () {
      ctx.activeTurnId = undefined;
      ctx.activeRunId = undefined;
      ctx.session = {
        ...ctx.session,
        status: "ready",
        activeTurnId: undefined,
        updatedAt: yield* nowIso,
      };
    });

  const emitTurnCompleted = (
    ctx: OpenClawSessionContext,
    state: "completed" | "failed" | "interrupted" | "cancelled",
    options?: { readonly errorMessage?: string },
  ) =>
    Effect.gen(function* () {
      const turnId = ctx.activeTurnId;
      if (!turnId) {
        return;
      }
      const interrupted = ctx.interruptedTurnIds.has(turnId);
      ctx.interruptedTurnIds.delete(turnId);
      const terminalState = state === "completed" && interrupted ? "interrupted" : state;
      yield* offerRuntimeEvent({
        type: "turn.completed",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        ...(ctx.session.providerInstanceId
          ? { providerInstanceId: ctx.session.providerInstanceId }
          : {}),
        threadId: ctx.threadId,
        turnId,
        payload: {
          state: terminalState,
          ...(options?.errorMessage ? { errorMessage: options.errorMessage } : {}),
        },
      });
      yield* resetSessionToReady(ctx);
    });

  const markSessionsClosed = (reason: string) =>
    Effect.gen(function* () {
      for (const ctx of Array.from(sessions.values())) {
        if (ctx.stopped) {
          continue;
        }
        ctx.stopped = true;
        sessions.delete(ctx.threadId);
        const turnId = ctx.activeTurnId;
        if (turnId) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            ...(ctx.session.providerInstanceId
              ? { providerInstanceId: ctx.session.providerInstanceId }
              : {}),
            threadId: ctx.threadId,
            turnId,
            payload: { state: "failed", errorMessage: reason },
          });
        }
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          ...(ctx.session.providerInstanceId
            ? { providerInstanceId: ctx.session.providerInstanceId }
            : {}),
          threadId: ctx.threadId,
          payload: { reason, exitKind: "error", recoverable: false },
        });
      }
    });

  const handleAgentEvent = Effect.fn("handleAgentEvent")(function* (
    ctx: OpenClawSessionContext,
    runId: string,
    stream: string,
    data: Record<string, unknown>,
  ) {
    const turnId = ctx.activeTurnId;
    const base = {
      provider: PROVIDER,
      ...(ctx.session.providerInstanceId
        ? { providerInstanceId: ctx.session.providerInstanceId }
        : {}),
      threadId: ctx.threadId,
      ...(turnId ? { turnId } : {}),
    };
    switch (stream) {
      case "lifecycle": {
        const phase = asString(data.phase);
        if (phase === "end") {
          yield* emitTurnCompleted(ctx, "completed");
        } else if (phase === "error") {
          const message =
            trimText(data.error) ?? trimText(data.message) ?? "OpenClaw agent run failed.";
          yield* emitTurnCompleted(ctx, "failed", { errorMessage: message });
          yield* offerRuntimeEvent({
            type: "runtime.error",
            ...(yield* makeEventStamp()),
            ...base,
            payload: { message, class: "provider_error", detail: data },
          });
        }
        return;
      }
      case "assistant": {
        const delta = trimText(data.delta) ?? trimText(data.text);
        if (!delta) {
          return;
        }
        yield* offerRuntimeEvent({
          type: "content.delta",
          ...(yield* makeEventStamp()),
          ...base,
          payload: { streamKind: "assistant_text", delta },
        });
        return;
      }
      case "thinking": {
        const delta = trimText(data.delta) ?? trimText(data.text);
        if (!delta) {
          return;
        }
        yield* offerRuntimeEvent({
          type: "content.delta",
          ...(yield* makeEventStamp()),
          ...base,
          payload: { streamKind: "reasoning_text", delta },
        });
        return;
      }
      case "tool": {
        // The gateway tool stream shape is not part of the documented
        // protocol schema; map defensively and skip unknown shapes.
        const state = asString(data.state);
        const toolName = asString(data.toolName);
        if (!state || !toolName) {
          return;
        }
        const itemType = toCanonicalItemType(toolName);
        const itemId = asString(data.toolCallId) ?? `${toolName}-${runId}`;
        const title = itemTitleForTool(itemType, toolName);
        const payload = {
          itemType,
          ...(title ? { title } : {}),
          ...(data.result !== undefined ? { data: data.result } : {}),
        };
        const normalized = state.toLowerCase();
        if (normalized === "start" || normalized === "running" || normalized === "pending") {
          yield* offerRuntimeEvent({
            type: "item.started",
            ...(yield* makeEventStamp()),
            ...base,
            itemId: RuntimeItemId.make(itemId),
            payload: { ...payload, status: "inProgress" },
          });
        } else if (normalized === "end" || normalized === "completed") {
          yield* offerRuntimeEvent({
            type: "item.completed",
            ...(yield* makeEventStamp()),
            ...base,
            itemId: RuntimeItemId.make(itemId),
            payload: {
              ...payload,
              status: data.isError === true ? "failed" : "completed",
            },
          });
        } else if (normalized === "update") {
          yield* offerRuntimeEvent({
            type: "item.updated",
            ...(yield* makeEventStamp()),
            ...base,
            itemId: RuntimeItemId.make(itemId),
            payload,
          });
        }
        return;
      }
      case "approval": {
        const phase = asString(data.phase);
        if (phase === "requested") {
          const approvalId = asString(data.approvalId) ?? asString(data.toolCallId) ?? runId;
          const t3RequestId = ApprovalRequestId.make(approvalId);
          ctx.pendingApprovals.set(t3RequestId, approvalId);
          const detail = trimText(data.command) ?? trimText(data.title) ?? trimText(data.message);
          yield* offerRuntimeEvent({
            type: "request.opened",
            ...(yield* makeEventStamp()),
            ...base,
            requestId: RuntimeRequestId.make(approvalId),
            payload: {
              requestType: mapApprovalRequestType(data.kind),
              ...(detail ? { detail } : {}),
              args: data,
            },
          });
        } else if (phase === "resolved") {
          const approvalId = asString(data.approvalId) ?? asString(data.toolCallId);
          if (approvalId) {
            ctx.pendingApprovals.delete(ApprovalRequestId.make(approvalId));
            yield* offerRuntimeEvent({
              type: "request.resolved",
              ...(yield* makeEventStamp()),
              ...base,
              requestId: RuntimeRequestId.make(approvalId),
              payload: {
                requestType: "unknown",
                decision: asString(data.status) ?? "unknown",
              },
            });
          }
        }
        return;
      }
      case "usage": {
        const inputTokens = typeof data.inputTokens === "number" ? data.inputTokens : undefined;
        const outputTokens = typeof data.outputTokens === "number" ? data.outputTokens : undefined;
        const usedTokens =
          typeof data.usedTokens === "number"
            ? data.usedTokens
            : inputTokens !== undefined && outputTokens !== undefined
              ? inputTokens + outputTokens
              : undefined;
        if (usedTokens === undefined || usedTokens <= 0) {
          return;
        }
        yield* offerRuntimeEvent({
          type: "thread.token-usage.updated",
          ...(yield* makeEventStamp()),
          ...base,
          payload: {
            usage: {
              usedTokens,
              ...(inputTokens !== undefined ? { inputTokens } : {}),
              ...(outputTokens !== undefined ? { outputTokens } : {}),
            },
          },
        });
        return;
      }
      default:
        return;
    }
  });

  const handleGatewayEvent = Effect.fn("handleGatewayEvent")(function* (
    event: OpenClawGatewayEvent,
  ) {
    if (event.kind === "closed") {
      yield* markSessionsClosed(event.reason);
      return;
    }
    if (event.kind === "response") {
      // Late final `res` for an agent request: fallback terminal when the
      // lifecycle stream did not emit end/error.
      const payload = isRecord(event.frame.payload) ? event.frame.payload : {};
      const runId = asString(payload.runId);
      if (!runId) {
        return;
      }
      const status = asString(payload.status);
      for (const ctx of Array.from(sessions.values())) {
        if (ctx.stopped || ctx.activeRunId !== runId) {
          continue;
        }
        if (status === "ok") {
          yield* emitTurnCompleted(ctx, "completed");
        } else if (status === "error") {
          const message =
            trimText(payload.error) ?? trimText(payload.summary) ?? "OpenClaw agent run failed.";
          yield* emitTurnCompleted(ctx, "failed", { errorMessage: message });
        }
        return;
      }
      return;
    }
    const frame = event.frame;
    if (frame.event !== "agent") {
      return;
    }
    const payload = isRecord(frame.payload) ? frame.payload : {};
    const runId = asString(payload.runId);
    const stream = asString(payload.stream);
    const data = isRecord(payload.data) ? payload.data : {};
    if (!runId || !stream) {
      return;
    }
    for (const ctx of Array.from(sessions.values())) {
      if (ctx.stopped || ctx.activeRunId !== runId) {
        continue;
      }
      yield* handleAgentEvent(ctx, runId, stream, data);
      return;
    }
  });

  const startEventPump = Effect.fn("startEventPump")(function* (
    connection: OpenClawGatewayConnection,
  ) {
    const existing = yield* Ref.get(eventPumpFiberRef);
    if (existing !== undefined) {
      return;
    }
    const fiber = yield* Stream.runForEach(connection.events, handleGatewayEvent).pipe(
      Effect.catch(() => Effect.void),
      Effect.forkIn(lifecycleScope),
    );
    yield* Ref.set(eventPumpFiberRef, fiber);
  });

  const stopSessionInternal = (ctx: OpenClawSessionContext) =>
    Effect.gen(function* () {
      if (ctx.stopped) {
        return;
      }
      ctx.stopped = true;
      sessions.delete(ctx.threadId);
      yield* offerRuntimeEvent({
        type: "session.exited",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        ...(ctx.session.providerInstanceId
          ? { providerInstanceId: ctx.session.providerInstanceId }
          : {}),
        threadId: ctx.threadId,
        payload: { exitKind: "graceful", reason: "Session stopped" },
      });
    });

  const startSession: OpenClawAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }
      if (!input.cwd?.trim()) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "cwd is required and must be non-empty.",
        });
      }
      const cwd = path.resolve(input.cwd.trim());
      const existing = sessions.get(input.threadId);
      if (existing && !existing.stopped) {
        yield* stopSessionInternal(existing);
      }

      const resumeKey = parseOpenClawResume(input.resumeCursor)?.sessionId;
      const connection = yield* acquireGateway("connect", input.threadId);

      const modelSelection =
        input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
      const modelSlug = modelSelection?.model;
      const thinkingLevel = modelSelection
        ? getModelSelectionStringOptionValue(modelSelection, "reasoningEffort")
        : undefined;

      const resolved = yield* Effect.gen(function* () {
        if (resumeKey) {
          const describeResult = yield* connection
            .request("sessions.describe", { key: resumeKey })
            .pipe(Effect.result);
          if (Result.isSuccess(describeResult)) {
            return { key: resumeKey, created: false };
          }
          if (isOpenClawSessionNotFound(describeResult.failure)) {
            yield* Effect.logWarning(
              `OpenClaw session '${resumeKey}' no longer exists; starting a fresh session.`,
            );
          } else {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sessions.describe",
              detail: openClawRuntimeErrorDetail(describeResult.failure),
              cause: describeResult.failure,
            });
          }
        }
        const key = `t3-${yield* randomUUIDv4}`;
        const createParams: Record<string, unknown> = {
          key,
          label: `T3 Code: ${cwd.split("/").filter(Boolean).pop() ?? cwd}`,
          ...(modelSlug ? { model: modelSlug } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
        };
        const created = yield* connection.request("sessions.create", createParams);
        const payload = isRecord(created) ? created : {};
        if (payload.ok === false) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sessions.create",
            detail: openClawRuntimeErrorDetail(payload),
            cause: payload,
          });
        }
        const createdKey = asString(payload.key) ?? key;
        return { key: createdKey, created: true };
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof ProviderAdapterRequestError
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "sessions.create",
                detail: openClawRuntimeErrorDetail(cause),
                cause,
              }),
        ),
      );

      yield* startEventPump(connection);

      const createdAt = yield* nowIso;
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd,
        ...(modelSlug ? { model: modelSlug } : {}),
        threadId: input.threadId,
        resumeCursor: {
          schemaVersion: OPENCLAW_RESUME_VERSION,
          sessionId: resolved.key,
        },
        createdAt,
        updatedAt: createdAt,
      };
      const ctx: OpenClawSessionContext = {
        threadId: input.threadId,
        sessionKey: resolved.key,
        session,
        activeTurnId: undefined,
        activeRunId: undefined,
        interruptedTurnIds: new Set(),
        pendingApprovals: new Map(),
        stopped: false,
      };
      sessions.set(input.threadId, ctx);

      yield* offerRuntimeEvent({
        type: "session.started",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: input.threadId,
        payload: { resume: resumeKey !== undefined },
      });
      yield* offerRuntimeEvent({
        type: "session.configured",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: input.threadId,
        payload: {
          config: {
            binaryPath: openClawSettings.binaryPath,
            gatewayUrl: openClawSettings.gatewayUrl,
            launchArgs: openClawSettings.launchArgs,
            ...(modelSlug ? { model: modelSlug } : {}),
          },
        },
      });
      yield* offerRuntimeEvent({
        type: "session.state.changed",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: input.threadId,
        payload: { state: "ready", reason: "OpenClaw session ready" },
      });
      yield* offerRuntimeEvent({
        type: "thread.started",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: input.threadId,
        payload: { providerThreadId: resolved.key },
      });

      return session;
    });

  const sendTurn: OpenClawAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const ctx = yield* requireSession(input.threadId);
    const connection = yield* acquireGateway("turn/start", input.threadId);

    const steering = ctx.activeTurnId !== undefined;
    const turnId =
      steering && ctx.activeTurnId
        ? ctx.activeTurnId
        : TurnId.make(`openclaw-turn-${yield* randomUUIDv4}`);
    ctx.activeTurnId = turnId;
    ctx.session = {
      ...ctx.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt: yield* nowIso,
    };

    const text = input.input?.trim();
    if (!text) {
      yield* resetSessionToReady(ctx);
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Turn requires non-empty text.",
      });
    }

    const modelSelection =
      input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
    const modelSlug = modelSelection?.model ?? ctx.session.model;
    const thinkingLevel = modelSelection
      ? getModelSelectionStringOptionValue(modelSelection, "reasoningEffort")
      : undefined;

    if (!steering) {
      yield* offerRuntimeEvent({
        type: "turn.started",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        ...(ctx.session.providerInstanceId
          ? { providerInstanceId: ctx.session.providerInstanceId }
          : {}),
        threadId: input.threadId,
        turnId,
        payload: {
          ...(modelSlug ? { model: modelSlug } : {}),
          ...(thinkingLevel ? { effort: thinkingLevel } : {}),
        },
      });
    }

    const agentParams: Record<string, unknown> = {
      sessionKey: ctx.sessionKey,
      message: text,
      idempotencyKey: yield* randomUUIDv4,
      cwd: ctx.session.cwd ?? serverConfig.cwd,
      ...(modelSlug ? { model: modelSlug } : {}),
      ...(thinkingLevel ? { thinking: thinkingLevel } : {}),
    };

    const result = yield* connection.request("agent", agentParams).pipe(Effect.result);
    if (Result.isFailure(result)) {
      const errorMessage = result.failure.detail;
      yield* emitTurnCompleted(ctx, "failed", { errorMessage });
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: errorMessage,
        cause: result.failure,
      });
    }
    const payload = isRecord(result.success) ? result.success : {};
    const runId = asString(payload.runId);
    if (runId) {
      ctx.activeRunId = runId;
    }

    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: ctx.session.resumeCursor,
    } satisfies ProviderTurnStartResult;
  });

  const interruptTurn: OpenClawAdapterShape["interruptTurn"] = (threadId, turnId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
      if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
        return;
      }
      const target = turnId ?? activeTurnId;
      if (!target) {
        return;
      }
      ctx.interruptedTurnIds.add(target);
      if (ctx.activeRunId) {
        const connection = yield* acquireGateway("turn/interrupt", threadId);
        yield* connection
          .request("chat.abort", {
            sessionKey: ctx.sessionKey,
            runId: ctx.activeRunId,
          })
          .pipe(Effect.ignore);
      }
    });

  const respondToRequest: OpenClawAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const gatewayApprovalId = ctx.pendingApprovals.get(requestId);
      if (!gatewayApprovalId) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "exec.approval.resolve",
          detail: `Unknown OpenClaw approval request '${requestId}'.`,
        });
      }
      const connection = yield* acquireGateway("exec.approval.resolve", threadId);
      if (!connection.hello.scopes.includes("operator.approvals")) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToRequest",
          issue:
            "The OpenClaw gateway connection does not hold the operator.approvals scope; approvals cannot be resolved.",
        });
      }
      yield* connection
        .request("exec.approval.resolve", {
          id: gatewayApprovalId,
          decision: toApprovalDecision(decision),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "exec.approval.resolve",
                detail: cause.detail,
                cause,
              }),
          ),
        );
    });

  const respondToUserInput: OpenClawAdapterShape["respondToUserInput"] = (
    _threadId,
    _requestId,
    _answers: ProviderUserInputAnswers,
  ) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "respondToUserInput",
        issue:
          "OpenClaw has no free-text user-input RPC; tool approvals are answered through respondToRequest.",
      }),
    );

  const readThread: OpenClawAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const connection = yield* acquireGateway("chat.history", threadId);
      const history = yield* connection
        .request("chat.history", { sessionKey: ctx.sessionKey })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "chat.history",
                detail: cause.detail,
                cause,
              }),
          ),
        );
      const payload = isRecord(history) ? history : {};
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      // Group the flat history into turns: each assistant row opens a turn and
      // the rows before it attach to that turn.
      const turns: Array<{ id: TurnId; items: Array<unknown> }> = [];
      let pendingUserItems: Array<unknown> = [];
      for (const message of messages) {
        const record = isRecord(message) ? message : {};
        const role = asString(record.role);
        if (role === "assistant") {
          const id =
            asString(record.id) ?? asString(record.messageId) ?? `openclaw-msg-${turns.length + 1}`;
          turns.push({ id: TurnId.make(id), items: [...pendingUserItems, message] });
          pendingUserItems = [];
        } else {
          pendingUserItems.push(message);
        }
      }
      return { threadId, turns };
    });

  const rollbackThread: OpenClawAdapterShape["rollbackThread"] = () =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "rollbackThread",
        issue:
          "OpenClaw has no turn-count rollback (it rewinds/branches by transcript entry id); checkpoint revert restores the workspace.",
      }),
    );

  const stopSession: OpenClawAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = sessions.get(threadId);
      if (!ctx) {
        return;
      }
      if (ctx.activeRunId) {
        const connection = yield* acquireGateway("chat.abort", threadId).pipe(Effect.option);
        if (Option.isSome(connection)) {
          yield* connection.value
            .request("chat.abort", { sessionKey: ctx.sessionKey, runId: ctx.activeRunId })
            .pipe(Effect.ignore);
        }
      }
      yield* stopSessionInternal(ctx);
    });

  const listSessions: OpenClawAdapterShape["listSessions"] = () =>
    Effect.forEach(
      Array.from(sessions.values()).filter((ctx) => !ctx.stopped),
      (ctx) => Effect.succeed(ctx.session),
      { concurrency: 1 },
    );

  const hasSession: OpenClawAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(Boolean(sessions.get(threadId) && !sessions.get(threadId)?.stopped));

  const stopAll: OpenClawAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), stopSessionInternal, {
      concurrency: 1,
      discard: true,
    }).pipe(Effect.asVoid);

  yield* Effect.acquireRelease(Effect.void, () =>
    stopAll().pipe(
      Effect.andThen(Scope.close(lifecycleScope, Exit.void)),
      Effect.andThen(Queue.shutdown(runtimeEventQueue)),
      Effect.andThen(nativeEventLogger?.close() ?? Effect.void),
      Effect.ignore,
    ),
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
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies OpenClawAdapterShape;
});
