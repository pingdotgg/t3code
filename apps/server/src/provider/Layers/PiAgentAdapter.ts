/**
 * PiAgentAdapter — per-instance Pi adapter.
 *
 * Maps the pi JSONL RPC protocol (via {@link PiAgentSessionRuntime}) onto the
 * canonical `ProviderRuntimeEvent` stream.
 *
 * Design decisions (pi has no turn ids and no permission system):
 *
 * - **Turn correlation.** Pi's `prompt` RPC accepts an optional correlation
 *   `id`; we mint one per sendTurn and await the matching `response` record,
 *   so `sendTurn` returns once pi acknowledges the prompt. The turn's
 *   terminal event comes from `agent_settled` (pi fires it only when no
 *   retry/queue work remains), mapped to `turn.completed` with state
 *   `"completed"` — or `"interrupted"` when the turn was aborted first.
 *   A sendTurn issued while a run is still in flight is a *steer*
 *   (`streamingBehavior: "steer"`); it reuses the active turn id, mirroring
 *   the Grok adapter, because pi folds it into the ongoing run and emits a
 *   single `agent_settled`.
 * - **Tool calls.** `tool_execution_start/update/end` map to
 *   `item.started/updated/completed` with a best-effort canonical type
 *   (bash → command_execution, write/edit → file_change, everything else →
 *   unknown — pi's tool names are unverified).
 * - **Extension UI.** `confirm`/`select` become `user-input.requested` and
 *   answers are written back as `extension_ui_response`. `input`/`editor`
 *   requests are auto-cancelled with a `runtime.warning` because T3 Code has
 *   no free-text user input path. `notify` surfaces as a `runtime.warning`
 *   row. `setStatus`/`setWidget`/`setTitle`/`set_editor_text` are ignored
 *   (they only affect pi's own extension chrome, which T3 never renders).
 * - **Token usage.** On `agent_settled` we try `get_session_stats` and emit
 *   `thread.token-usage.updated` when it yields usable numbers.
 * - **rollback.** Pi has `fork`/`/tree` branching but no turn rollback, so
 *   `rollbackThread` fails with `ProviderAdapterValidationError`;
 *   checkpoint revert still restores the workspace.
 *
 * @module provider/Layers/PiAgentAdapter
 */
import {
  ApprovalRequestId,
  EventId,
  type PiAgentSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type PiAgentAdapterShape } from "../Services/PiAgentAdapter.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  makePiAgentSessionRuntime,
  parsePiResumeCursor,
  type PiAvailableModel,
  type PiSessionRuntimeShape,
} from "./PiAgentSessionRuntime.ts";

const PROVIDER = ProviderDriverKind.make("piAgent");

export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export function isPiThinkingLevel(value: unknown): value is PiThinkingLevel {
  return typeof value === "string" && (PI_THINKING_LEVELS as readonly string[]).includes(value);
}

export interface PiAgentAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly value?: unknown; readonly confirmed?: boolean }
  | { readonly _tag: "cancelled" };

interface PendingUserInput {
  readonly extensionRequestId: string;
  readonly turnId: TurnId | undefined;
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly runtime: PiSessionRuntimeShape;
  eventFiber: Fiber.Fiber<void, never> | undefined;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  promptsInFlight: number;
  readonly interruptedTurnIds: Set<TurnId>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Resolve a T3 model slug (`provider/modelId` or bare `modelId`) against the
 * pi catalog so `set_model` receives a concrete provider + model id. Bare ids
 * fall back to `anthropic` when the catalog has no match. */
export function resolvePiModelSelection(
  slug: string,
  availableModels: ReadonlyArray<PiAvailableModel>,
): { readonly provider: string; readonly modelId: string } {
  const trimmed = slug.trim();
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
  }
  const match = availableModels.find((model) => model.id === trimmed);
  return {
    provider: match?.provider ?? match?.api ?? "anthropic",
    modelId: trimmed,
  };
}

function toCanonicalItemType(
  toolName: string | undefined | null,
): Extract<ProviderRuntimeEvent, { type: "item.started" }>["payload"]["itemType"] {
  const name = toolName?.toLowerCase().trim() ?? "";
  if (/^(bash|sh|shell|exec|run|command)/.test(name)) return "command_execution";
  if (/^(write|edit|patch|apply)/.test(name)) return "file_change";
  if (/^mcp/.test(name)) return "mcp_tool_call";
  if (/^(web|search)/.test(name)) return "web_search";
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

/** Map a pi `message_update.assistantMessageEvent` payload onto runtime events. */
function mapAssistantMessageEvent(
  event: ProviderEvent,
  turnId: TurnId | undefined,
  raw: Record<string, unknown>,
): ReadonlyArray<ProviderRuntimeEvent> {
  const assistantEvent = isRecord(raw.assistantMessageEvent) ? raw.assistantMessageEvent : raw;
  const kind =
    typeof assistantEvent.type === "string"
      ? assistantEvent.type
      : typeof assistantEvent.kind === "string"
        ? assistantEvent.kind
        : undefined;
  const base = {
    eventId: event.id,
    provider: event.provider,
    ...(event.providerInstanceId ? { providerInstanceId: event.providerInstanceId } : {}),
    threadId: event.threadId,
    createdAt: event.createdAt,
    ...(turnId ? { turnId } : {}),
  };

  switch (kind) {
    case "text_delta": {
      const delta = typeof assistantEvent.delta === "string" ? assistantEvent.delta : "";
      if (!delta) return [];
      return [
        {
          ...base,
          type: "content.delta" as const,
          payload: {
            streamKind: "assistant_text" as const,
            delta,
            ...(typeof assistantEvent.contentIndex === "number"
              ? { contentIndex: assistantEvent.contentIndex }
              : {}),
          },
        },
      ];
    }
    case "thinking_delta": {
      const delta = typeof assistantEvent.delta === "string" ? assistantEvent.delta : "";
      if (!delta) return [];
      return [
        {
          ...base,
          type: "content.delta" as const,
          payload: { streamKind: "reasoning_text" as const, delta },
        },
      ];
    }
    case "toolcall_start":
      return [
        {
          ...base,
          type: "item.started" as const,
          payload: { itemType: "unknown" as const, status: "inProgress" as const },
        },
      ];
    case "toolcall_delta":
      return [
        {
          ...base,
          type: "item.updated" as const,
          payload: { itemType: "unknown" as const, data: assistantEvent },
        },
      ];
    case "toolcall_end": {
      const toolCall = isRecord(assistantEvent.toolCall) ? assistantEvent.toolCall : undefined;
      const toolName = typeof toolCall?.name === "string" ? toolCall.name : undefined;
      const itemType = toCanonicalItemType(toolName);
      return [
        {
          ...base,
          type: "item.completed" as const,
          ...(toolCall?.id !== undefined
            ? { itemId: RuntimeItemId.make(String(toolCall.id)) }
            : {}),
          payload: {
            itemType,
            status: "completed" as const,
            ...(itemTitleForTool(itemType, toolName)
              ? { title: itemTitleForTool(itemType, toolName) }
              : {}),
          },
        },
      ];
    }
    default:
      return [];
  }
}

export const makePiAgentAdapter = Effect.fn("makePiAgentAdapter")(function* (
  piSettings: PiAgentSettings,
  options?: PiAgentAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("piAgent");
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig);
  const crypto = yield* Crypto.Crypto;
  const nativeEventLogger = options?.nativeEventLogger;

  const sessions = new Map<ThreadId, PiSessionContext>();
  const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Pi runtime identifier.",
          cause,
        }),
    ),
  );
  const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const getThreadSemaphore = (threadId: string) =>
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

  const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

  const writeNativeEvent = Effect.fnUntraced(function* (event: ProviderEvent) {
    if (!nativeEventLogger) {
      return;
    }
    yield* nativeEventLogger.write(event, event.threadId);
  });

  const requireSession = Effect.fn("requireSession")(function* (threadId: ThreadId) {
    const ctx = sessions.get(threadId);
    if (!ctx || ctx.stopped) {
      return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
    }
    return ctx;
  });

  const settlePendingUserInputsAsCancelled = (ctx: PiSessionContext) =>
    Effect.forEach(
      Array.from(ctx.pendingUserInputs.values()),
      (pending) => Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore),
      { discard: true },
    );

  const resetSessionToReady = (ctx: PiSessionContext) =>
    Effect.gen(function* () {
      ctx.promptsInFlight = 0;
      ctx.activeTurnId = undefined;
      ctx.session = {
        ...ctx.session,
        status: "ready",
        activeTurnId: undefined,
        updatedAt: yield* nowIso,
      };
    });

  const emitTurnCompleted = (
    ctx: PiSessionContext,
    state: "completed" | "failed" | "interrupted" | "cancelled",
    options?: { readonly errorMessage?: string; readonly usage?: unknown },
  ) =>
    Effect.gen(function* () {
      const turnId = ctx.activeTurnId;
      if (!turnId) {
        return;
      }
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
          state,
          ...(options?.errorMessage ? { errorMessage: options.errorMessage } : {}),
          ...(options?.usage !== undefined ? { usage: options.usage } : {}),
        },
      });
      yield* resetSessionToReady(ctx);
    });

  const emitTokenUsage = (ctx: PiSessionContext, usage: unknown) =>
    Effect.gen(function* () {
      if (!isRecord(usage)) {
        return;
      }
      // pi's stats shapes are unverified; only emit when we can derive a
      // positive token count. Accept either flat numbers or the
      // get_session_stats { tokens, cost, contextUsage } envelope.
      const tokens = isRecord(usage.tokens) ? usage.tokens : undefined;
      const contextUsage = isRecord(usage.contextUsage) ? usage.contextUsage : undefined;
      const inputTokens =
        asNumber(usage.inputTokens) ?? asNumber(tokens?.input) ?? asNumber(tokens?.inputTokens);
      const outputTokens =
        asNumber(usage.outputTokens) ?? asNumber(tokens?.output) ?? asNumber(tokens?.outputTokens);
      const usedTokens =
        asNumber(contextUsage?.usedTokens) ??
        asNumber(usage.usedTokens) ??
        (inputTokens !== undefined && outputTokens !== undefined
          ? inputTokens + outputTokens
          : undefined);
      if (usedTokens === undefined || usedTokens <= 0) {
        return;
      }
      yield* offerRuntimeEvent({
        type: "thread.token-usage.updated",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        ...(ctx.session.providerInstanceId
          ? { providerInstanceId: ctx.session.providerInstanceId }
          : {}),
        threadId: ctx.threadId,
        turnId: ctx.activeTurnId,
        payload: {
          usage: {
            usedTokens,
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          },
        },
      });
    });

  const settleActiveTurn = (ctx: PiSessionContext) =>
    Effect.gen(function* () {
      const turnId = ctx.activeTurnId;
      if (!turnId) {
        return;
      }
      const interrupted = ctx.interruptedTurnIds.has(turnId);
      ctx.interruptedTurnIds.delete(turnId);
      // Best-effort usage from pi's session stats; never fail the turn on it.
      const stats = yield* ctx.runtime.getSessionStats().pipe(Effect.option);
      if (Option.isSome(stats)) {
        yield* emitTokenUsage(ctx, stats.value);
      }
      yield* emitTurnCompleted(ctx, interrupted ? "interrupted" : "completed");
    });

  const toUserInputQuestions = (
    request: Record<string, unknown>,
  ): ReadonlyArray<UserInputQuestion> => {
    const method = typeof request.method === "string" ? request.method : "select";
    const requestId = typeof request.id === "string" ? request.id : "unknown";
    const header =
      trimText(typeof request.title === "string" ? request.title : undefined) ?? "Pi request";
    const message = trimText(typeof request.message === "string" ? request.message : undefined);
    const question = message ?? header;

    if (method === "confirm") {
      return [
        {
          id: `${requestId}:confirm`,
          header,
          question,
          options: [
            { label: "Allow", description: "Allow the requested action" },
            { label: "Deny", description: "Deny the requested action" },
          ],
        },
      ];
    }

    const rawOptions = Array.isArray(request.options) ? request.options : [];
    const options = rawOptions
      .map((entry): UserInputQuestion["options"][number] | undefined => {
        if (!isRecord(entry)) return undefined;
        const value = typeof entry.value === "string" ? entry.value : undefined;
        const label = trimText(typeof entry.label === "string" ? entry.label : value);
        if (!label) return undefined;
        return { label, description: value && value !== label ? value : label };
      })
      .filter((entry): entry is UserInputQuestion["options"][number] => entry !== undefined);

    if (options.length === 0) {
      return [];
    }
    return [{ id: `${requestId}:select`, header, question, options }];
  };

  const handleExtensionUiRequest = (ctx: PiSessionContext, event: ProviderEvent) =>
    Effect.gen(function* () {
      const raw = isRecord(event.payload) ? event.payload : {};
      const method = typeof raw.method === "string" ? raw.method : undefined;
      if (!method) {
        return;
      }
      const extensionRequestId = typeof raw.id === "string" ? raw.id : "";
      const requestId = ApprovalRequestId.make(event.requestId ?? (yield* randomUUIDv4));
      const runtimeRequestId = RuntimeRequestId.make(requestId);
      const turnId = ctx.activeTurnId;
      const rawPayload = raw;
      switch (method) {
        case "confirm":
        case "select": {
          const questions = toUserInputQuestions(raw);
          if (questions.length === 0) {
            // Nothing we can present; cancel the request so pi does not block.
            yield* ctx.runtime
              .respondToExtensionUi({ requestId: extensionRequestId, cancelled: true })
              .pipe(Effect.ignore);
            return;
          }
          const resolution = yield* Deferred.make<PendingUserInputResolution>();
          ctx.pendingUserInputs.set(requestId, {
            extensionRequestId,
            turnId,
            resolution,
          });
          yield* offerRuntimeEvent({
            type: "user-input.requested",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            ...(ctx.session.providerInstanceId
              ? { providerInstanceId: ctx.session.providerInstanceId }
              : {}),
            threadId: ctx.threadId,
            turnId,
            requestId: runtimeRequestId,
            payload: { questions },
            raw: { source: "acp.pi.extension", method, payload: rawPayload },
          });
          const resolved = yield* Deferred.await(resolution);
          ctx.pendingUserInputs.delete(requestId);
          yield* offerRuntimeEvent({
            type: "user-input.resolved",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            ...(ctx.session.providerInstanceId
              ? { providerInstanceId: ctx.session.providerInstanceId }
              : {}),
            threadId: ctx.threadId,
            turnId,
            requestId: runtimeRequestId,
            payload: {
              answers:
                resolved._tag === "answered"
                  ? { [questions[0]?.id ?? "answer"]: resolved.value ?? resolved.confirmed ?? "" }
                  : {},
            },
            raw: { source: "acp.pi.extension", method, payload: rawPayload },
          });
          if (resolved._tag === "answered") {
            yield* ctx.runtime.respondToExtensionUi({
              requestId: extensionRequestId,
              value: resolved.value,
              ...(resolved.confirmed !== undefined ? { confirmed: resolved.confirmed } : {}),
            });
          } else {
            yield* ctx.runtime
              .respondToExtensionUi({ requestId: extensionRequestId, cancelled: true })
              .pipe(Effect.ignore);
          }
          return;
        }
        case "input":
        case "editor": {
          yield* ctx.runtime
            .respondToExtensionUi({ requestId: extensionRequestId, cancelled: true })
            .pipe(Effect.ignore);
          yield* offerRuntimeEvent({
            type: "runtime.warning",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            ...(ctx.session.providerInstanceId
              ? { providerInstanceId: ctx.session.providerInstanceId }
              : {}),
            threadId: ctx.threadId,
            turnId,
            payload: {
              message:
                "Pi requested free-text input, which T3 Code does not support; request cancelled.",
            },
            raw: { source: "acp.pi.extension", method, payload: rawPayload },
          });
          return;
        }
        case "notify": {
          const summary =
            trimText(typeof raw.message === "string" ? raw.message : undefined) ??
            trimText(typeof raw.title === "string" ? raw.title : undefined) ??
            "Pi notification";
          yield* offerRuntimeEvent({
            type: "runtime.warning",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            ...(ctx.session.providerInstanceId
              ? { providerInstanceId: ctx.session.providerInstanceId }
              : {}),
            threadId: ctx.threadId,
            turnId,
            payload: { message: summary },
            raw: { source: "acp.pi.extension", method, payload: rawPayload },
          });
          return;
        }
        default:
          // setStatus / setWidget / setTitle / set_editor_text only affect
          // pi's own extension chrome, which T3 never renders. Ignore them.
          yield* Effect.logDebug("ignoring pi extension UI method", { method });
          return;
      }
    });

  const handlePiEvent = (ctx: PiSessionContext, event: ProviderEvent) =>
    Effect.gen(function* () {
      yield* writeNativeEvent(event);
      const activeTurnId = ctx.activeTurnId;
      const base = {
        eventId: event.id,
        provider: event.provider,
        ...(event.providerInstanceId ? { providerInstanceId: event.providerInstanceId } : {}),
        threadId: event.threadId,
        createdAt: event.createdAt,
        ...(activeTurnId ? { turnId: activeTurnId } : {}),
      };
      const raw = isRecord(event.payload) ? event.payload : {};

      switch (event.kind) {
        case "session":
          if (event.method === "session/connecting") {
            yield* offerRuntimeEvent({
              ...base,
              type: "session.state.changed",
              payload: { state: "starting", reason: event.message ?? "Starting Pi session." },
            });
            return;
          }
          if (event.method === "session/ready") {
            yield* offerRuntimeEvent({
              ...base,
              type: "session.state.changed",
              payload: { state: "ready", reason: "Pi session ready." },
            });
            return;
          }
          if (event.method === "session/exited") {
            const message = event.message ?? "Pi session exited.";
            const exitKind = message.includes("code") ? "error" : "graceful";
            // Clear run state so a later sendTurn cannot steer into the dead
            // process's turn.
            ctx.activeTurnId = undefined;
            ctx.promptsInFlight = 0;
            ctx.session = {
              ...ctx.session,
              status: exitKind === "error" ? "error" : "closed",
              activeTurnId: undefined,
            };
            if (activeTurnId && exitKind === "error") {
              yield* offerRuntimeEvent({
                ...base,
                type: "turn.completed",
                payload: { state: "failed", errorMessage: message },
              });
            }
            yield* offerRuntimeEvent({
              ...base,
              type: "session.exited",
              payload: { reason: message, exitKind },
            });
            return;
          }
          return;
        case "error":
          yield* offerRuntimeEvent({
            ...base,
            type: "runtime.error",
            payload: { message: event.message ?? "Pi runtime error", class: "provider_error" },
          });
          return;
        case "request":
          if (event.method === "extension_ui_request") {
            yield* handleExtensionUiRequest(ctx, event);
          }
          return;
        case "notification":
          break;
      }

      switch (event.method) {
        case "process/stderr": {
          const message = event.message ?? "Pi process stderr";
          yield* offerRuntimeEvent({
            ...base,
            type: "runtime.warning",
            payload: { message },
          });
          return;
        }
        case "agent_start": {
          // Ignore stale agent starts (e.g. arriving after a prompt failure
          // already completed the turn and cleared the active turn id).
          if (!ctx.activeTurnId) {
            return;
          }
          ctx.session = {
            ...ctx.session,
            status: "running",
            updatedAt: yield* nowIso,
          };
          return;
        }
        case "message_update": {
          for (const runtimeEvent of mapAssistantMessageEvent(event, activeTurnId, raw)) {
            yield* offerRuntimeEvent(runtimeEvent);
          }
          return;
        }
        case "tool_execution_start": {
          const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId : undefined;
          const toolName = typeof raw.toolName === "string" ? raw.toolName : undefined;
          const itemType = toCanonicalItemType(toolName);
          yield* offerRuntimeEvent({
            ...base,
            type: "item.started",
            ...(toolCallId ? { itemId: RuntimeItemId.make(toolCallId) } : {}),
            payload: {
              itemType,
              status: "inProgress",
              ...(itemTitleForTool(itemType, toolName)
                ? { title: itemTitleForTool(itemType, toolName) }
                : {}),
              ...(raw.args !== undefined ? { data: raw.args } : {}),
            },
          });
          return;
        }
        case "tool_execution_update": {
          const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId : undefined;
          yield* offerRuntimeEvent({
            ...base,
            type: "item.updated",
            ...(toolCallId ? { itemId: RuntimeItemId.make(toolCallId) } : {}),
            payload: {
              itemType: "unknown",
              data: raw.partialResult ?? raw,
            },
          });
          return;
        }
        case "tool_execution_end": {
          const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId : undefined;
          const toolName = typeof raw.toolName === "string" ? raw.toolName : undefined;
          const itemType = toCanonicalItemType(toolName);
          yield* offerRuntimeEvent({
            ...base,
            type: "item.completed",
            ...(toolCallId ? { itemId: RuntimeItemId.make(toolCallId) } : {}),
            payload: {
              itemType,
              status: raw.isError === true ? "failed" : "completed",
              ...(itemTitleForTool(itemType, toolName)
                ? { title: itemTitleForTool(itemType, toolName) }
                : {}),
              ...(raw.result !== undefined ? { data: raw.result } : {}),
            },
          });
          return;
        }
        case "agent_settled": {
          yield* settleActiveTurn(ctx);
          return;
        }
        case "agent_end": {
          if (raw.willRetry === true) {
            yield* offerRuntimeEvent({
              ...base,
              type: "runtime.warning",
              payload: { message: "Pi will retry the last operation." },
            });
          }
          return;
        }
        case "extension_error": {
          const message =
            typeof raw.message === "string" && raw.message.trim()
              ? raw.message
              : "Pi extension error";
          yield* offerRuntimeEvent({
            ...base,
            type: "runtime.error",
            payload: { message, class: "provider_error" },
          });
          if (activeTurnId) {
            yield* emitTurnCompleted(ctx, "failed", { errorMessage: message });
          }
          return;
        }
        case "compaction_start":
          yield* offerRuntimeEvent({
            ...base,
            type: "item.started",
            payload: {
              itemType: "context_compaction",
              status: "inProgress",
              title: "Compacting context",
            },
          });
          return;
        case "compaction_end":
          yield* offerRuntimeEvent({
            ...base,
            type: "item.completed",
            payload: {
              itemType: "context_compaction",
              status: "completed",
              title: "Compacting context",
            },
          });
          return;
        case "auto_retry_start":
          yield* offerRuntimeEvent({
            ...base,
            type: "runtime.warning",
            payload: { message: "Pi is retrying automatically." },
          });
          return;
        case "bash_execution_update":
        case "queue_update":
        case "turn_start":
        case "turn_end":
          // Informational; the session/turn lifecycle is driven by
          // agent_start/agent_settled.
          return;
        default:
          yield* Effect.logDebug("ignoring unhandled pi provider event", {
            method: event.method,
            threadId: event.threadId,
          });
          return;
      }
    });

  const stopSessionInternal = (ctx: PiSessionContext) =>
    Effect.gen(function* () {
      if (ctx.stopped) {
        return;
      }
      ctx.stopped = true;
      sessions.delete(ctx.threadId);
      yield* settlePendingUserInputsAsCancelled(ctx);
      if (ctx.eventFiber) {
        yield* Fiber.interrupt(ctx.eventFiber).pipe(Effect.ignore);
      }
      yield* ctx.runtime.close.pipe(Effect.ignore);
      yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
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

  const startSession: PiAgentAdapterShape["startSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.scoped(
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

          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resumeSessionId = parsePiResumeCursor(input.resumeCursor)?.sessionId;
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const thinkingLevel = modelSelection
            ? getModelSelectionStringOptionValue(modelSelection, "reasoningEffort")
            : undefined;

          const runtime = yield* makePiAgentSessionRuntime({
            threadId: input.threadId,
            providerInstanceId: boundInstanceId,
            binaryPath: piSettings.binaryPath || "pi",
            ...(piSettings.homePath ? { homePath: piSettings.homePath } : {}),
            ...(piSettings.launchArgs ? { launchArgs: piSettings.launchArgs } : {}),
            ...(options?.environment ? { environment: options.environment } : {}),
            cwd,
            runtimeMode: input.runtimeMode,
            ...(modelSelection?.model ? { model: modelSelection.model } : {}),
            ...(isPiThinkingLevel(thinkingLevel) ? { thinkingLevel } : {}),
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientName: "t3-code",
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          const sessionCreatedAt = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "connecting",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(modelSelection?.model ? { model: modelSelection.model } : {}),
            threadId: input.threadId,
            createdAt: sessionCreatedAt,
            updatedAt: sessionCreatedAt,
          };

          const ctx: PiSessionContext = {
            threadId: input.threadId,
            scope: sessionScope,
            runtime,
            eventFiber: undefined,
            session,
            activeTurnId: undefined,
            promptsInFlight: 0,
            interruptedTurnIds: new Set(),
            pendingUserInputs: new Map(),
            stopped: false,
          };

          const eventFiber = yield* Stream.runForEach(runtime.events, (event) =>
            handlePiEvent(ctx, event).pipe(
              Effect.catch((cause) =>
                Effect.logError("Failed to process Pi runtime notification.", { cause }),
              ),
            ),
          ).pipe(Effect.forkChild);
          ctx.eventFiber = eventFiber;

          const started = yield* runtime.start().pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          ctx.session = started;

          // Apply the requested model + thinking level in-session. pi's
          // `--model` is a pattern, so an explicit set_model makes the
          // selection deterministic. Best-effort: a catalog RPC failure must
          // not fail session start.
          const availableModels = yield* ctx.runtime
            .getAvailableModels()
            .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<PiAvailableModel>)));
          if (modelSelection?.model) {
            const resolved = resolvePiModelSelection(modelSelection.model, availableModels);
            yield* ctx.runtime
              .setModel(resolved.provider, resolved.modelId)
              .pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to apply Pi model selection.", { cause }),
                ),
              );
            ctx.session = { ...ctx.session, model: modelSelection.model };
          }
          if (isPiThinkingLevel(thinkingLevel)) {
            yield* ctx.runtime
              .setThinkingLevel(thinkingLevel)
              .pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to apply Pi thinking level.", { cause }),
                ),
              );
          }
          ctx.session = {
            ...ctx.session,
            status: "ready",
            updatedAt: yield* nowIso,
          };

          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: { resume: resumeSessionId !== undefined },
          });
          yield* offerRuntimeEvent({
            type: "session.configured",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: {
              config: {
                binaryPath: piSettings.binaryPath,
                homePath: piSettings.homePath,
                launchArgs: piSettings.launchArgs,
                ...(modelSelection?.model ? { model: modelSelection.model } : {}),
              },
            },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Pi session ready" },
          });
          const providerThreadId = parsePiResumeCursor(ctx.session.resumeCursor)?.sessionId;
          if (providerThreadId) {
            yield* offerRuntimeEvent({
              type: "thread.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              payload: { providerThreadId },
            });
          }

          return ctx.session;
        }),
      ),
    );

  const resolveAttachment = Effect.fn("resolveAttachment")(function* (
    attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
  ) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }
    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: `Failed to read attachment file: ${cause.message}.`,
            cause,
          }),
      ),
    );
    return {
      type: "image" as const,
      data: Buffer.from(bytes).toString("base64"),
      mimeType: attachment.mimeType,
    };
  });

  const sendTurn: PiAgentAdapterShape["sendTurn"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // A sendTurn while a run is still active (not yet settled) is a
        // steer: pi folds it into the ongoing run and emits a single
        // agent_settled, so the existing turn id is reused.
        const steering = ctx.activeTurnId !== undefined;
        const turnId =
          steering && ctx.activeTurnId ? ctx.activeTurnId : TurnId.make(yield* randomUUIDv4);
        ctx.promptsInFlight += 1;
        ctx.activeTurnId = turnId;
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        const images = yield* Effect.forEach(input.attachments ?? [], resolveAttachment, {
          concurrency: 1,
        });
        const text = input.input?.trim();
        if (!text && images.length === 0) {
          yield* resetSessionToReady(ctx);
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        // In-session model / thinking switches (pi has no turn-level model
        // selection; set_model applies to the whole session).
        const modelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        if (modelSelection?.model) {
          const availableModels = yield* ctx.runtime
            .getAvailableModels()
            .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<PiAvailableModel>)));
          const resolved = resolvePiModelSelection(modelSelection.model, availableModels);
          yield* ctx.runtime
            .setModel(resolved.provider, resolved.modelId)
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to apply Pi model selection on turn.", { cause }),
              ),
            );
          ctx.session = { ...ctx.session, model: modelSelection.model };
        }
        const thinkingLevel = modelSelection
          ? getModelSelectionStringOptionValue(modelSelection, "reasoningEffort")
          : undefined;
        if (isPiThinkingLevel(thinkingLevel)) {
          yield* ctx.runtime
            .setThinkingLevel(thinkingLevel)
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to apply Pi thinking level on turn.", { cause }),
              ),
            );
        }

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
              ...(ctx.session.model ? { model: ctx.session.model } : {}),
              ...(isPiThinkingLevel(thinkingLevel) ? { effort: thinkingLevel } : {}),
            },
          });
        }

        const promptResult = yield* ctx.runtime
          .sendPrompt({
            ...(text ? { message: text } : {}),
            ...(images.length > 0 ? { images } : {}),
            streamingBehavior: steering ? "steer" : "followUp",
          })
          .pipe(Effect.result);

        if (Result.isFailure(promptResult)) {
          ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
          const errorMessage = promptResult.failure.message;
          if (!ctx.interruptedTurnIds.has(turnId)) {
            yield* emitTurnCompleted(ctx, "failed", { errorMessage });
          }
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: errorMessage,
            cause: promptResult.failure,
          });
        }

        ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        } satisfies ProviderTurnStartResult;
      }),
    );

  const interruptTurn: PiAgentAdapterShape["interruptTurn"] = (threadId, turnId) =>
    withThreadLock(
      threadId,
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
        // Pi's `abort` stops the current operation; the subsequent
        // `agent_settled` completes the turn as interrupted.
        yield* ctx.runtime.abort().pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/interrupt",
                detail: cause.message,
                cause,
              }),
          ),
        );
      }),
    );

  const respondToRequest: PiAgentAdapterShape["respondToRequest"] = () =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "respondToRequest",
        issue: "Pi has no built-in permission system; there are no approval requests to answer.",
      }),
    );

  const respondToUserInput: PiAgentAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers: ProviderUserInputAnswers,
  ) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown Pi user input request '${requestId}'.`,
          });
        }
        const firstEntry = Object.entries(answers)[0];
        const rawValue = firstEntry?.[1];
        const stringValue = Array.isArray(rawValue)
          ? rawValue.map((entry) => String(entry))[0]
          : typeof rawValue === "string"
            ? rawValue
            : undefined;
        const confirmed =
          stringValue === "Allow" || stringValue === "Yes"
            ? true
            : stringValue === "Deny" || stringValue === "No"
              ? false
              : undefined;
        yield* Deferred.succeed(pending.resolution, {
          _tag: "answered",
          value: stringValue ?? rawValue,
          ...(confirmed !== undefined ? { confirmed } : {}),
        }).pipe(Effect.ignore);
      }),
    );

  const readThread: PiAgentAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const messages = yield* ctx.runtime.readMessages().pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "get_messages",
              detail: cause.message,
              cause,
            }),
        ),
      );
      // Group the flat AgentMessage list into turns: each assistant message
      // opens a turn, and the user messages before it attach to that turn.
      const turns: Array<{ id: TurnId; items: Array<unknown> }> = [];
      let pendingUserItems: Array<unknown> = [];
      for (const message of messages) {
        const record = isRecord(message) ? message : {};
        if (record.role === "assistant") {
          const id =
            typeof record.id === "string" && record.id ? record.id : `pi-msg-${turns.length + 1}`;
          turns.push({ id: TurnId.make(id), items: [...pendingUserItems, message] });
          pendingUserItems = [];
        } else {
          pendingUserItems.push(message);
        }
      }
      return { threadId, turns };
    });

  const rollbackThread: PiAgentAdapterShape["rollbackThread"] = () =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "rollbackThread",
        issue:
          "Pi has no turn rollback (it offers fork/branching instead); checkpoint revert restores the workspace.",
      }),
    );

  const stopSession: PiAgentAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = sessions.get(threadId);
      if (!ctx) {
        return;
      }
      yield* stopSessionInternal(ctx);
    });

  const listSessions: PiAgentAdapterShape["listSessions"] = () =>
    Effect.forEach(
      Array.from(sessions.values()).filter((ctx) => !ctx.stopped),
      (ctx) => Effect.succeed(ctx.session),
      { concurrency: 1 },
    );

  const hasSession: PiAgentAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(Boolean(sessions.get(threadId) && !sessions.get(threadId)?.stopped));

  const stopAll: PiAgentAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), stopSessionInternal, {
      concurrency: 1,
      discard: true,
    }).pipe(Effect.asVoid);

  yield* Effect.acquireRelease(Effect.void, () =>
    stopAll().pipe(
      Effect.andThen(Queue.shutdown(runtimeEventQueue)),
      Effect.andThen(nativeEventLogger?.close() ?? Effect.void),
      Effect.ignore,
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
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
  } satisfies PiAgentAdapterShape;
});
