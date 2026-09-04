import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ThreadId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { planPiSkillDispatch } from "../Drivers/PiSkillDispatch.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  makePiRpcClient,
  type PiRpcClient,
  type PiRpcClientError,
  type PiRpcClientOptions,
} from "../pi/PiRpcClient.ts";
import {
  PiResumeCursor,
  cumulativeToolOutputDelta,
  isPiRpcAgentEndEvent,
  isPiRpcAgentSettledEvent,
  isPiRpcAgentStartEvent,
  isPiRpcCompactionEndEvent,
  isPiRpcCompactionStartEvent,
  isPiRpcExtensionUIRequest,
  isPiRpcMessageUpdateEvent,
  isPiRpcToolExecutionEndEvent,
  isPiRpcToolExecutionStartEvent,
  isPiRpcToolExecutionUpdateEvent,
  type CumulativeToolOutputState,
  type PiImageContent,
  type PiRpcEnvelope,
} from "../pi/PiRpcProtocol.ts";
import { buildPiAgentSkills } from "./PiAgentProvider.ts";

const PROVIDER = ProviderDriverKind.make("piAgent");
const decodeResumeCursor = Schema.decodeUnknownOption(PiResumeCursor);
const T3_PROGRESS_PROMPT =
  "You are running inside T3 Code. For multi-step work that uses tools, communicate before acting: send a concise preamble explaining what you will do, then provide brief milestone updates before each substantial tool batch or after roughly a minute of quiet work. Keep updates concrete and avoid narrating trivial actions. For simple answers that need no tools, answer directly.";

export interface PiAgentAdapterSettings {
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly agentDir: string;
  readonly sessionDir: string;
}

export interface PiAgentAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: Record<string, string>;
  readonly makeClient?: (
    options: PiRpcClientOptions,
  ) => Effect.Effect<PiRpcClient, PiRpcClientError, Scope.Scope>;
}

type Adapter = ProviderAdapterShape<ProviderAdapterError>;

type PendingDialog =
  | { readonly method: "confirm"; readonly title: string }
  | { readonly method: "select"; readonly title: string }
  | { readonly method: "input" | "editor"; readonly title: string };

interface StreamItem {
  readonly itemId: RuntimeItemId;
  readonly itemType: "assistant_message" | "reasoning";
}

interface ToolState {
  readonly itemId: RuntimeItemId;
  readonly itemType:
    | "command_execution"
    | "file_change"
    | "mcp_tool_call"
    | "dynamic_tool_call"
    | "web_search"
    | "image_view";
  output: CumulativeToolOutputState | undefined;
}

interface PendingTurnOutcome {
  readonly state: "completed" | "cancelled" | "failed";
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

interface ThreadLock {
  readonly semaphore: Semaphore.Semaphore;
  users: number;
  reclaimable: boolean;
}

interface SessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly client: PiRpcClient;
  readonly commandLock: Semaphore.Semaphore;
  readonly dialogs: Map<ApprovalRequestId, PendingDialog>;
  readonly streamItems: Map<string, StreamItem>;
  readonly tools: Map<string, ToolState>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  eventFiber: Fiber.Fiber<void, unknown> | undefined;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  abortingTurnId: TurnId | undefined;
  abortSettlement: Deferred.Deferred<void> | undefined;
  compactionItemId: RuntimeItemId | undefined;
  lastUsage: unknown;
  pendingTurnOutcome: PendingTurnOutcome | undefined;
  startupFinished: boolean;
  stopped: boolean;
}

interface PiState {
  readonly sessionFile: string;
  readonly sessionId: string;
  readonly model?: { readonly provider?: string; readonly id?: string } | null;
  readonly thinkingLevel?: string;
}

function readPiState(input: unknown): PiState | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  if (typeof value.sessionFile !== "string" || !value.sessionFile.trim()) return undefined;
  if (typeof value.sessionId !== "string" || !value.sessionId.trim()) return undefined;
  const model =
    value.model && typeof value.model === "object"
      ? (value.model as { readonly provider?: string; readonly id?: string })
      : value.model === null
        ? null
        : undefined;
  return {
    sessionFile: value.sessionFile,
    sessionId: value.sessionId,
    ...(model !== undefined ? { model } : {}),
    ...(typeof value.thinkingLevel === "string" ? { thinkingLevel: value.thinkingLevel } : {}),
  };
}

function readLastEntryId(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const entries = (input as { readonly entries?: unknown }).entries;
  if (!Array.isArray(entries)) return undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { readonly entryId?: unknown; readonly id?: unknown };
    const id = typeof record.entryId === "string" ? record.entryId : record.id;
    if (typeof id === "string" && id.trim()) return id;
  }
  return undefined;
}

function modelSlug(state: PiState): string | undefined {
  const provider = state.model?.provider?.trim();
  const id = state.model?.id?.trim();
  return provider && id ? `${provider}/${id}` : undefined;
}

function parseModelSlug(
  slug: string,
): { readonly provider: string; readonly modelId: string } | undefined {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return undefined;
  return { provider: slug.slice(0, separator), modelId: slug.slice(separator + 1) };
}

function toolItemType(toolName: string): ToolState["itemType"] {
  const normalized = toolName.toLowerCase();
  if (normalized === "bash" || normalized.includes("shell") || normalized.includes("command")) {
    return "command_execution";
  }
  if (normalized === "edit" || normalized === "write" || normalized.includes("patch")) {
    return "file_change";
  }
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("web") && normalized.includes("search")) return "web_search";
  if (normalized.includes("image") || normalized.includes("screenshot")) return "image_view";
  return "dynamic_tool_call";
}

function toolOutput(content: ReadonlyArray<{ readonly text?: string }>): string {
  return content.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("");
}

function answerString(answers: ProviderUserInputAnswers): string | undefined {
  const value = answers.value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((entry): entry is string => typeof entry === "string");
    return first;
  }
  return undefined;
}

function turnOutcomeFromMessages(messages: ReadonlyArray<unknown>): PendingTurnOutcome {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const assistant = message as Record<string, unknown>;
    if (assistant.role !== "assistant" || typeof assistant.stopReason !== "string") continue;
    const stopReason = assistant.stopReason.trim();
    if (!stopReason) break;
    if (stopReason === "error") {
      const errorMessage =
        typeof assistant.errorMessage === "string" && assistant.errorMessage.trim()
          ? assistant.errorMessage.trim()
          : "Pi Agent model request failed.";
      return { state: "failed", stopReason, errorMessage };
    }
    if (stopReason === "aborted") return { state: "cancelled", stopReason };
    return { state: "completed", stopReason };
  }
  return { state: "completed" };
}

export const makePiAgentAdapter = Effect.fn("makePiAgentAdapter")(function* (
  settings: PiAgentAdapterSettings,
  options?: PiAgentAdapterOptions,
) {
  const instanceId = options?.instanceId ?? ProviderInstanceId.make("piAgent");
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* ServerConfig;
  const ownerScope = yield* Effect.scope;
  const sessions = new Map<ThreadId, SessionContext>();
  const threadLocks = yield* SynchronizedRef.make(new Map<ThreadId, ThreadLock>());
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Could not create a Pi Agent runtime identifier.",
          cause,
        }),
    ),
  );
  const stamp = Effect.all({
    eventId: Effect.map(randomId, EventId.make),
    createdAt: nowIso,
  });
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);
  const clientFactory: NonNullable<PiAgentAdapterOptions["makeClient"]> =
    options?.makeClient ??
    ((input) =>
      makePiRpcClient(input).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ));
  const withThreadLock = <A, E, R>(threadId: ThreadId, task: Effect.Effect<A, E, R>) =>
    SynchronizedRef.modifyEffect(threadLocks, (current) => {
      const existing = current.get(threadId);
      if (existing) {
        existing.users += 1;
        return Effect.succeed([existing, current] as const);
      }
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const lock: ThreadLock = { semaphore, users: 1, reclaimable: false };
          return [lock, new Map(current).set(threadId, lock)] as const;
        }),
      );
    }).pipe(
      Effect.flatMap((lock) =>
        lock.semaphore.withPermit(task).pipe(
          Effect.ensuring(
            SynchronizedRef.update(threadLocks, (current) => {
              if (current.get(threadId) !== lock) return current;
              lock.users -= 1;
              if (lock.reclaimable && lock.users === 0) {
                const next = new Map(current);
                next.delete(threadId);
                return next;
              }
              return current;
            }),
          ),
        ),
      ),
    );

  const retireThreadLock = (threadId: ThreadId) =>
    SynchronizedRef.update(threadLocks, (current) => {
      const lock = current.get(threadId);
      if (!lock) return current;
      lock.reclaimable = true;
      if (lock.users === 0) {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      }
      return current;
    });

  const isProviderAdapterError = (cause: unknown): cause is ProviderAdapterError =>
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    typeof cause._tag === "string" &&
    cause._tag.startsWith("ProviderAdapter");

  const mapClientError = (threadId: ThreadId, method: string, cause: unknown) =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail:
        cause instanceof Error && cause.message.trim() ? cause.message : `Pi rejected ${method}.`,
      cause,
    });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<SessionContext, ProviderAdapterSessionNotFoundError> => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const ensureCurrentContext = (context: SessionContext) =>
    context.stopped || sessions.get(context.threadId) !== context
      ? Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: context.threadId,
          }),
        )
      : Effect.void;

  const ensureReadyContext = (context: SessionContext) =>
    Effect.gen(function* () {
      yield* ensureCurrentContext(context);
      if (!context.startupFinished || context.session.status === "connecting") {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "prompt",
          detail: "Pi Agent session is still starting.",
        });
      }
    });

  const takeAbortSettlement = (context: SessionContext) => {
    const settlement = context.abortSettlement;
    context.abortSettlement = undefined;
    return settlement;
  };

  const settleAbort = (context: SessionContext, settlement: Deferred.Deferred<void> | undefined) =>
    settlement === undefined
      ? Effect.void
      : Effect.uninterruptible(
          Effect.sync(() => {
            if (context.abortSettlement === settlement) context.abortSettlement = undefined;
          }).pipe(Effect.andThen(Deferred.succeed(settlement, undefined))),
        ).pipe(Effect.asVoid);

  const finishTurn = (context: SessionContext, outcome: PendingTurnOutcome) => {
    let abortSettlement: Deferred.Deferred<void> | undefined;
    return Effect.gen(function* () {
      const turnId = context.activeTurnId;
      abortSettlement = context.abortSettlement;
      if (turnId === undefined || context.stopped) return;
      const { state } = outcome;
      context.activeTurnId = undefined;
      context.abortingTurnId = undefined;
      context.pendingTurnOutcome = undefined;
      context.streamItems.clear();
      context.tools.clear();
      const { lastError: _lastError, ...sessionWithoutLastError } = context.session;
      context.session = {
        ...sessionWithoutLastError,
        status: state === "failed" ? "error" : "ready",
        activeTurnId: undefined,
        updatedAt: yield* nowIso,
        ...(outcome.errorMessage ? { lastError: outcome.errorMessage } : {}),
      };
      const existing = context.turns.find((turn) => turn.id === turnId);
      if (!existing) context.turns.push({ id: turnId, items: [] });
      yield* emit({
        type: "turn.completed",
        ...(yield* stamp),
        provider: PROVIDER,
        providerInstanceId: instanceId,
        threadId: context.threadId,
        turnId,
        payload: {
          state,
          ...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}),
          ...(context.lastUsage !== undefined ? { usage: context.lastUsage } : {}),
          ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
        },
      });
      context.lastUsage = undefined;
    }).pipe(Effect.ensuring(Effect.suspend(() => settleAbort(context, abortSettlement))));
  };

  const abortTurn = (context: SessionContext, turnId: TurnId) => {
    let abortSettlement: Deferred.Deferred<void> | undefined;
    return Effect.gen(function* () {
      abortSettlement = context.abortSettlement;
      if (context.activeTurnId !== turnId || context.stopped) return;
      context.activeTurnId = undefined;
      context.abortingTurnId = undefined;
      context.pendingTurnOutcome = undefined;
      context.lastUsage = undefined;
      context.streamItems.clear();
      context.tools.clear();
      const { lastError: _lastError, ...sessionWithoutLastError } = context.session;
      context.session = {
        ...sessionWithoutLastError,
        status: "ready",
        activeTurnId: undefined,
        updatedAt: yield* nowIso,
      };
      yield* emit({
        type: "turn.aborted",
        ...(yield* stamp),
        provider: PROVIDER,
        providerInstanceId: instanceId,
        threadId: context.threadId,
        turnId,
        payload: { reason: "Pi Agent turn interrupted" },
      });
    }).pipe(Effect.ensuring(Effect.suspend(() => settleAbort(context, abortSettlement))));
  };

  const emitToolOutput = (context: SessionContext, tool: ToolState, output: string) =>
    Effect.gen(function* () {
      const update = cumulativeToolOutputDelta(tool.output, output);
      tool.output = update.state;
      if (!update.replaced && update.delta.length > 0) {
        yield* emit({
          type: "content.delta",
          ...(yield* stamp),
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: context.threadId,
          turnId: context.activeTurnId,
          itemId: tool.itemId,
          payload: {
            streamKind:
              tool.itemType === "command_execution"
                ? "command_output"
                : tool.itemType === "file_change"
                  ? "file_change_output"
                  : "unknown",
            delta: update.delta,
          },
        });
      } else if (update.replaced) {
        yield* emit({
          type: "item.updated",
          ...(yield* stamp),
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: context.threadId,
          turnId: context.activeTurnId,
          itemId: tool.itemId,
          payload: {
            itemType: tool.itemType,
            status: "inProgress",
            data: { outputSnapshot: update.delta, replaced: true },
          },
        });
      }
    });

  const handleDialog = (context: SessionContext, event: PiRpcEnvelope) =>
    Effect.gen(function* () {
      if (!isPiRpcExtensionUIRequest(event)) return;
      if (
        event.method === "notify" ||
        event.method === "setStatus" ||
        event.method === "setWidget" ||
        event.method === "setTitle" ||
        event.method === "set_editor_text"
      ) {
        return;
      }
      const title =
        typeof event.title === "string" && event.title.trim() ? event.title : "Pi Agent";
      const requestId = ApprovalRequestId.make(event.id);
      const runtimeRequestId = RuntimeRequestId.make(event.id);
      context.dialogs.set(requestId, { method: event.method, title });
      if (event.method === "confirm") {
        yield* emit({
          type: "request.opened",
          ...(yield* stamp),
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: context.threadId,
          turnId: context.activeTurnId,
          requestId: runtimeRequestId,
          payload: {
            requestType: "dynamic_tool_call",
            detail: event.message.trim() || title,
            options: [
              { decision: "accept", label: "Confirm" },
              { decision: "decline", label: "Decline" },
            ],
            args: { title },
          },
        });
        return;
      }
      yield* emit({
        type: "user-input.requested",
        ...(yield* stamp),
        provider: PROVIDER,
        providerInstanceId: instanceId,
        threadId: context.threadId,
        turnId: context.activeTurnId,
        requestId: runtimeRequestId,
        payload: {
          questions: [
            {
              id: "value",
              header: title,
              question: title,
              options:
                event.method === "select"
                  ? event.options.map((option) => ({
                      label: option,
                      description: "",
                      value: option,
                    }))
                  : [],
              allowCustomAnswer: event.method !== "select",
            },
          ],
        },
      });
    });

  const handleEvent = (context: SessionContext, event: PiRpcEnvelope) =>
    Effect.gen(function* () {
      if (context.stopped) return;
      if (isPiRpcAgentStartEvent(event)) {
        context.pendingTurnOutcome = undefined;
        context.session = {
          ...context.session,
          status: "running",
          updatedAt: yield* nowIso,
        };
        yield* emit({
          type: "session.state.changed",
          ...(yield* stamp),
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: context.threadId,
          turnId: context.activeTurnId,
          payload: { state: "running", reason: "Pi is processing the turn" },
        });
        return;
      }
      if (isPiRpcMessageUpdateEvent(event)) {
        context.lastUsage = event.usage ?? context.lastUsage;
        const update = event.assistantMessageEvent;
        const isReasoning = update.type.startsWith("thinking_");
        const isAssistant = update.type.startsWith("text_");
        if (!isReasoning && !isAssistant) return;
        const key = `${isReasoning ? "reasoning" : "text"}:${update.contentIndex}`;
        let item = context.streamItems.get(key);
        if (update.type.endsWith("_start") && item === undefined) {
          item = {
            itemId: RuntimeItemId.make(`pi-${yield* randomId}`),
            itemType: isReasoning ? "reasoning" : "assistant_message",
          };
          context.streamItems.set(key, item);
          yield* emit({
            type: "item.started",
            ...(yield* stamp),
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            itemId: item.itemId,
            payload: { itemType: item.itemType, status: "inProgress" },
          });
        }
        if (update.type.endsWith("_delta") && update.delta !== undefined) {
          item ??= {
            itemId: RuntimeItemId.make(`pi-${yield* randomId}`),
            itemType: isReasoning ? "reasoning" : "assistant_message",
          };
          context.streamItems.set(key, item);
          yield* emit({
            type: "content.delta",
            ...(yield* stamp),
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            itemId: item.itemId,
            payload: {
              streamKind: isReasoning ? "reasoning_text" : "assistant_text",
              delta: update.delta,
              contentIndex: update.contentIndex,
            },
          });
        }
        if (update.type.endsWith("_end") && item !== undefined) {
          yield* emit({
            type: "item.completed",
            ...(yield* stamp),
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            itemId: item.itemId,
            payload: { itemType: item.itemType, status: "completed" },
          });
          context.streamItems.delete(key);
        }
        return;
      }
      if (isPiRpcToolExecutionStartEvent(event)) {
        const itemType = toolItemType(event.toolName);
        const tool: ToolState = {
          itemId: RuntimeItemId.make(event.toolCallId),
          itemType,
          output: undefined,
        };
        context.tools.set(event.toolCallId, tool);
        yield* emit({
          type: "item.started",
          ...(yield* stamp),
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: context.threadId,
          turnId: context.activeTurnId,
          itemId: tool.itemId,
          providerRefs: { providerItemId: ProviderItemId.make(event.toolCallId) },
          payload: {
            itemType,
            status: "inProgress",
            title: event.toolName,
            data: { args: event.args },
          },
        });
        return;
      }
      if (isPiRpcToolExecutionUpdateEvent(event)) {
        const tool = context.tools.get(event.toolCallId);
        if (tool) yield* emitToolOutput(context, tool, toolOutput(event.partialResult.content));
        return;
      }
      if (isPiRpcToolExecutionEndEvent(event)) {
        const tool = context.tools.get(event.toolCallId) ?? {
          itemId: RuntimeItemId.make(event.toolCallId),
          itemType: toolItemType(event.toolName),
          output: undefined,
        };
        yield* emitToolOutput(context, tool, toolOutput(event.result.content));
        yield* emit({
          type: "item.completed",
          ...(yield* stamp),
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: context.threadId,
          turnId: context.activeTurnId,
          itemId: tool.itemId,
          providerRefs: { providerItemId: ProviderItemId.make(event.toolCallId) },
          payload: {
            itemType: tool.itemType,
            status: event.isError ? "failed" : "completed",
            title: event.toolName,
            data: { result: event.result.details },
          },
        });
        context.tools.delete(event.toolCallId);
        return;
      }
      if (isPiRpcCompactionStartEvent(event)) {
        const itemId = RuntimeItemId.make(`pi-compaction-${yield* randomId}`);
        context.compactionItemId = itemId;
        yield* emit({
          type: "item.started",
          ...(yield* stamp),
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: context.threadId,
          turnId: context.activeTurnId,
          itemId,
          payload: {
            itemType: "context_compaction",
            status: "inProgress",
            title: "Compacting context",
            data: { reason: event.reason },
          },
        });
        return;
      }
      if (isPiRpcCompactionEndEvent(event)) {
        const itemId = context.compactionItemId;
        if (itemId) {
          yield* emit({
            type: "item.completed",
            ...(yield* stamp),
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            itemId,
            payload: {
              itemType: "context_compaction",
              status: event.aborted || event.errorMessage ? "failed" : "completed",
              title: "Context compacted",
              data: { reason: event.reason, result: event.result, willRetry: event.willRetry },
            },
          });
          context.compactionItemId = undefined;
        }
        if (!event.aborted && !event.errorMessage) {
          yield* emit({
            type: "thread.state.changed",
            ...(yield* stamp),
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: context.threadId,
            payload: { state: "compacted", detail: event.result },
          });
        }
        return;
      }
      if (isPiRpcExtensionUIRequest(event)) {
        yield* handleDialog(context, event);
        return;
      }
      // `agent_end` may precede an automatic retry or overflow compaction. Retain only
      // the final run's outcome, then wait for Pi's authoritative settled boundary.
      if (isPiRpcAgentEndEvent(event)) {
        context.pendingTurnOutcome = event.willRetry
          ? undefined
          : turnOutcomeFromMessages(event.messages ?? []);
        return;
      }
      if (isPiRpcAgentSettledEvent(event)) {
        if (context.abortingTurnId !== undefined) {
          yield* abortTurn(context, context.abortingTurnId);
        } else {
          const outcome = context.pendingTurnOutcome ?? { state: "completed" as const };
          if (outcome.state === "failed" && outcome.errorMessage) {
            yield* emit({
              type: "runtime.error",
              ...(yield* stamp),
              provider: PROVIDER,
              providerInstanceId: instanceId,
              threadId: context.threadId,
              turnId: context.activeTurnId,
              payload: { message: outcome.errorMessage, class: "provider_error" },
            });
          }
          yield* finishTurn(context, outcome);
        }
      }
    });

  const stopContext = (context: SessionContext) =>
    Effect.gen(function* () {
      if (context.stopped) {
        yield* settleAbort(context, takeAbortSettlement(context));
        return;
      }
      context.stopped = true;
      yield* retireThreadLock(context.threadId);
      yield* settleAbort(context, takeAbortSettlement(context));
      for (const [requestId] of context.dialogs) {
        yield* Effect.ignore(
          context.client.send({
            type: "extension_ui_response",
            id: requestId,
            cancelled: true,
          }),
        );
      }
      context.dialogs.clear();
      if (context.eventFiber) yield* Fiber.interrupt(context.eventFiber);
      yield* Effect.ignore(context.client.close);
      yield* Scope.close(context.scope, Exit.void);
      if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
      yield* emit({
        type: "session.exited",
        ...(yield* stamp),
        provider: PROVIDER,
        providerInstanceId: instanceId,
        threadId: context.threadId,
        payload: { exitKind: "graceful" },
      });
    }).pipe(Effect.uninterruptible);

  const startSession: Adapter["startSession"] = (input) => {
    let startedContext: SessionContext | undefined;
    let startedScope: Scope.Closeable | undefined;
    return withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (!settings.enabled) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Enable Pi Agent in provider settings before starting a thread.",
          });
        }
        if (
          (input.provider !== undefined && input.provider !== PROVIDER) ||
          (input.providerInstanceId !== undefined && input.providerInstanceId !== instanceId) ||
          (input.modelSelection !== undefined && input.modelSelection.instanceId !== instanceId)
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The Pi Agent provider instance does not match the requested session.",
          });
        }
        if (input.runtimeMode !== "full-access") {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue:
              "Pi Agent currently supports only full-access mode because RPC does not enforce T3 Code approval policies without a policy bridge.",
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The session requires a workspace directory.",
          });
        }
        const resume = decodeResumeCursor(input.resumeCursor);
        if (input.resumeCursor !== undefined && Option.isNone(resume)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The saved Pi Agent session is invalid. Start a new thread.",
          });
        }
        const previous = sessions.get(input.threadId);
        if (previous) yield* stopContext(previous);
        const cwd = path.resolve(input.cwd.trim());
        const sessionScope = yield* Scope.make("sequential");
        startedScope = sessionScope;
        const env = {
          ...options?.environment,
          ...(settings.agentDir.trim()
            ? {
                PI_CODING_AGENT_DIR: path.resolve(cwd, expandHomePath(settings.agentDir.trim())),
              }
            : {}),
        };
        const args = [
          "--mode",
          "rpc",
          "--approve",
          "--append-system-prompt",
          T3_PROGRESS_PROMPT,
          ...(settings.sessionDir.trim()
            ? ["--session-dir", path.resolve(cwd, expandHomePath(settings.sessionDir.trim()))]
            : []),
        ];
        const client = yield* clientFactory({
          binaryPath: expandHomePath(settings.binaryPath.trim() || "pi"),
          args,
          cwd,
          ...(Object.keys(env).length > 0 ? { env } : {}),
        }).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: "Could not start Pi Agent RPC.",
                cause,
              }),
          ),
        );
        const createdAt = yield* nowIso;
        const context: SessionContext = {
          threadId: input.threadId,
          scope: sessionScope,
          client,
          commandLock: yield* Semaphore.make(1),
          dialogs: new Map(),
          streamItems: new Map(),
          tools: new Map(),
          turns: [],
          eventFiber: undefined,
          session: {
            provider: PROVIDER,
            providerInstanceId: instanceId,
            status: "connecting",
            runtimeMode: "full-access",
            cwd,
            threadId: input.threadId,
            createdAt,
            updatedAt: createdAt,
          },
          activeTurnId: undefined,
          abortingTurnId: undefined,
          abortSettlement: undefined,
          compactionItemId: undefined,
          lastUsage: undefined,
          pendingTurnOutcome: undefined,
          startupFinished: false,
          stopped: false,
        };
        startedContext = context;
        sessions.set(input.threadId, context);
        context.eventFiber = yield* client.events.pipe(
          Stream.runForEach((event) => handleEvent(context, event)),
          Effect.catch((cause) => {
            const handleTransportFailure = Effect.gen(function* () {
              if (context.stopped) {
                yield* settleAbort(context, takeAbortSettlement(context));
                return;
              }
              const shouldReportTransportFailure = sessions.get(context.threadId) === context;
              context.stopped = true;
              yield* retireThreadLock(context.threadId);
              yield* settleAbort(context, takeAbortSettlement(context));
              if (shouldReportTransportFailure) {
                if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
                context.session = {
                  ...context.session,
                  status: "error",
                  lastError: cause.message,
                  updatedAt: yield* nowIso,
                };
                yield* emit({
                  type: "runtime.error",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  providerInstanceId: instanceId,
                  threadId: input.threadId,
                  turnId: context.activeTurnId,
                  payload: { message: cause.message, class: "transport_error" },
                });
                yield* emit({
                  type: "session.exited",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  providerInstanceId: instanceId,
                  threadId: input.threadId,
                  payload: {
                    exitKind: "error",
                    recoverable: true,
                    reason: cause.message,
                  },
                });
              }
              yield* Scope.close(context.scope, Exit.fail(cause)).pipe(
                Effect.ignore,
                Effect.forkIn(ownerScope),
              );
            });
            return (
              context.startupFinished
                ? withThreadLock(context.threadId, handleTransportFailure)
                : handleTransportFailure
            ).pipe(Effect.forkIn(ownerScope), Effect.asVoid);
          }),
          Effect.forkIn(sessionScope),
        );
        return yield* Effect.gen(function* () {
          if (Option.isSome(resume)) {
            const switched = yield* client.request({
              type: "switch_session",
              sessionPath: resume.value.sessionFile,
            });
            if (
              switched.data &&
              typeof switched.data === "object" &&
              (switched.data as { readonly cancelled?: unknown }).cancelled === true
            ) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "switch_session",
                detail: "Pi cancelled the saved session restore.",
              });
            }
          }
          const stateResponse = yield* client.request({ type: "get_state" });
          const state = readPiState(stateResponse.data);
          if (!state) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "get_state",
              detail: "Pi returned a state without a durable session file and id.",
            });
          }
          const previousEntryId = Option.isSome(resume) ? resume.value.lastEntryId : undefined;
          const entries = previousEntryId
            ? yield* client.request({ type: "get_entries", since: previousEntryId })
            : undefined;
          const lastEntryId = readLastEntryId(entries?.data) ?? previousEntryId;
          const cursor = PiResumeCursor.make({
            schemaVersion: 1,
            sessionFile: state.sessionFile,
            sessionId: state.sessionId,
            ...(lastEntryId ? { lastEntryId } : {}),
          });
          if (input.title?.trim()) {
            yield* client.request({ type: "set_session_name", name: input.title.trim() });
          }
          yield* ensureCurrentContext(context);
          const session: ProviderSession = {
            ...context.session,
            status: "ready",
            ...(modelSlug(state) ? { model: modelSlug(state) } : {}),
            resumeCursor: cursor,
            updatedAt: yield* nowIso,
          };
          context.session = session;
          yield* applyModelSelection(context, input.modelSelection);
          yield* ensureCurrentContext(context);
          yield* emit({
            type: "session.started",
            ...(yield* stamp),
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: input.threadId,
            payload: { resume: cursor },
          });
          yield* ensureCurrentContext(context);
          yield* emit({
            type: "session.state.changed",
            ...(yield* stamp),
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Pi Agent RPC session ready" },
          });
          yield* ensureCurrentContext(context);
          yield* emit({
            type: "thread.started",
            ...(yield* stamp),
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: input.threadId,
            payload: { providerThreadId: state.sessionId },
          });
          context.startupFinished = true;
          return context.session;
        }).pipe(
          Effect.mapError((cause) =>
            isProviderAdapterError(cause)
              ? cause
              : mapClientError(input.threadId, "session/start", cause),
          ),
        );
      }),
    ).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.uninterruptible(
              Effect.gen(function* () {
                yield* retireThreadLock(input.threadId);
                if (startedContext) {
                  yield* stopContext(startedContext);
                } else if (startedScope) {
                  yield* Scope.close(startedScope, Exit.void).pipe(Effect.ignore);
                }
              }),
            ),
      ),
    );
  };

  const applyModelSelection = (
    context: SessionContext,
    selection: Parameters<Adapter["sendTurn"]>[0]["modelSelection"],
  ) =>
    Effect.gen(function* () {
      yield* ensureCurrentContext(context);
      if (!selection) return;
      if (selection.instanceId !== instanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "The selected model belongs to another provider instance.",
        });
      }
      if (selection.model !== context.session.model) {
        const parsed = parseModelSlug(selection.model);
        if (!parsed) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Pi model identifiers must use the provider/model format.",
          });
        }
        yield* context.client.request({ type: "set_model", ...parsed });
        yield* ensureCurrentContext(context);
        context.session = { ...context.session, model: selection.model };
      }
      const thinking = getModelSelectionStringOptionValue(selection, "reasoningEffort");
      if (thinking) {
        yield* context.client.request({ type: "set_thinking_level", level: thinking });
        yield* ensureCurrentContext(context);
      }
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterValidationError"
          ? cause
          : mapClientError(context.threadId, "model/configure", cause),
      ),
    );

  const readImages = (input: Parameters<Adapter["sendTurn"]>[0]) =>
    Effect.forEach(
      (input.attachments ?? []).filter((attachment) => attachment.type === "image"),
      (attachment) =>
        Effect.gen(function* () {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "prompt",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "prompt",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          return {
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          } satisfies PiImageContent;
        }),
    );

  const sendTurn: Adapter["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const context = yield* requireSession(input.threadId);
      yield* ensureReadyContext(context);
      if (context.abortingTurnId !== undefined && context.abortSettlement) {
        yield* Deferred.await(context.abortSettlement);
        if (context.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
      }
      const message = input.input?.trim();
      if (!message) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Pi Agent requires a non-empty prompt.",
        });
      }
      const images = yield* readImages(input);
      return yield* context.commandLock.withPermit(
        Effect.gen(function* () {
          const abortSettlement = context.abortSettlement;
          if (context.abortingTurnId !== undefined && abortSettlement) {
            yield* Deferred.await(abortSettlement);
          }
          yield* ensureReadyContext(context);
          yield* applyModelSelection(context, input.modelSelection);
          const promptMessage = message.includes("$")
            ? yield* context.client.request({ type: "get_commands" }).pipe(
                Effect.map((response) => {
                  const skillNames = new Set(
                    buildPiAgentSkills(response.data).map((skill) => skill.name),
                  );
                  return planPiSkillDispatch(message, skillNames)?.commandText ?? message;
                }),
              )
            : message;
          yield* ensureReadyContext(context);
          const steering = context.activeTurnId !== undefined;
          const turnId = context.activeTurnId ?? TurnId.make(yield* randomId);
          if (!steering) {
            context.activeTurnId = turnId;
            context.pendingTurnOutcome = undefined;
            context.session = {
              ...context.session,
              status: "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };
            yield* emit({
              type: "turn.started",
              ...(yield* stamp),
              provider: PROVIDER,
              providerInstanceId: instanceId,
              threadId: input.threadId,
              turnId,
              payload: {
                ...(context.session.model ? { model: context.session.model } : {}),
                ...(getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort")
                  ? {
                      effort: getModelSelectionStringOptionValue(
                        input.modelSelection,
                        "reasoningEffort",
                      ),
                    }
                  : {}),
              },
            });
          }
          yield* context.client
            .request({
              type: "prompt",
              message: promptMessage,
              ...(steering ? { streamingBehavior: "steer" as const } : {}),
              ...(images.length > 0 ? { images } : {}),
            })
            .pipe(
              Effect.tapError((cause) =>
                steering
                  ? Effect.void
                  : finishTurn(context, {
                      state: "failed",
                      errorMessage:
                        cause instanceof Error && cause.message.trim()
                          ? cause.message
                          : "Pi rejected the prompt.",
                    }),
              ),
            );
          yield* ensureReadyContext(context);
          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: context.session.resumeCursor,
          };
        }).pipe(
          Effect.mapError((cause) =>
            isProviderAdapterError(cause) ? cause : mapClientError(input.threadId, "prompt", cause),
          ),
        ),
      );
    });

  const interruptTurn: Adapter["interruptTurn"] = (threadId, turnId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      yield* context.commandLock.withPermit(
        Effect.gen(function* () {
          yield* ensureCurrentContext(context);
          const activeTurnId = context.activeTurnId;
          if (activeTurnId === undefined || (turnId !== undefined && activeTurnId !== turnId))
            return;
          if (context.abortingTurnId === activeTurnId && context.abortSettlement) return;

          const abortSettlement = yield* Deferred.make<void>();
          context.abortingTurnId = activeTurnId;
          context.abortSettlement = abortSettlement;
          yield* context.client.request({ type: "clear_queue" }).pipe(
            Effect.andThen(context.client.request({ type: "abort" })),
            Effect.mapError((cause) => mapClientError(threadId, "abort", cause)),
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : Effect.uninterruptible(
                    Effect.sync(() => {
                      if (
                        context.abortingTurnId === activeTurnId &&
                        context.abortSettlement === abortSettlement
                      ) {
                        context.abortingTurnId = undefined;
                        context.abortSettlement = undefined;
                      }
                    }).pipe(Effect.andThen(Deferred.succeed(abortSettlement, undefined))),
                  ),
            ),
          );
        }),
      );
    });

  const respondToRequest: Adapter["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.dialogs.get(requestId);
      if (!pending || pending.method !== "confirm") {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "extension_ui_response",
          detail: "This Pi confirmation is no longer pending.",
        });
      }
      yield* context.client
        .send(
          decision === "cancel"
            ? { type: "extension_ui_response", id: requestId, cancelled: true }
            : {
                type: "extension_ui_response",
                id: requestId,
                confirmed:
                  decision === "accept" ||
                  decision === "acceptAlways" ||
                  decision === "acceptForSession",
              },
        )
        .pipe(Effect.mapError((cause) => mapClientError(threadId, "extension_ui_response", cause)));
      context.dialogs.delete(requestId);
      yield* emit({
        type: "request.resolved",
        ...(yield* stamp),
        provider: PROVIDER,
        providerInstanceId: instanceId,
        threadId,
        turnId: context.activeTurnId,
        requestId: RuntimeRequestId.make(requestId),
        payload: { requestType: "dynamic_tool_call", decision },
      });
    });

  const respondToUserInput: Adapter["respondToUserInput"] = (threadId, requestId, answers) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.dialogs.get(requestId);
      if (!pending || pending.method === "confirm") {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "extension_ui_response",
          detail: "This Pi input request is no longer pending.",
        });
      }
      const answer = answerString(answers);
      yield* context.client
        .send(
          answer === undefined
            ? { type: "extension_ui_response", id: requestId, cancelled: true }
            : { type: "extension_ui_response", id: requestId, value: answer },
        )
        .pipe(Effect.mapError((cause) => mapClientError(threadId, "extension_ui_response", cause)));
      context.dialogs.delete(requestId);
      yield* emit({
        type: "user-input.resolved",
        ...(yield* stamp),
        provider: PROVIDER,
        providerInstanceId: instanceId,
        threadId,
        turnId: context.activeTurnId,
        requestId: RuntimeRequestId.make(requestId),
        payload: { answers },
      });
    });

  const compactThread: NonNullable<Adapter["compactThread"]> = (threadId, modelSelection) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      yield* context.commandLock.withPermit(
        applyModelSelection(context, modelSelection).pipe(
          Effect.andThen(context.client.request({ type: "compact" })),
          Effect.asVoid,
          Effect.mapError((cause) =>
            isProviderAdapterError(cause) ? cause : mapClientError(threadId, "compact", cause),
          ),
        ),
      );
    });

  const stopSession: Adapter["stopSession"] = (threadId) =>
    requireSession(threadId).pipe(Effect.flatMap(stopContext));
  const listSessions: Adapter["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (context) => ({ ...context.session })));
  const hasSession: Adapter["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });
  const readThread: Adapter["readThread"] = (threadId) =>
    requireSession(threadId).pipe(Effect.map((context) => ({ threadId, turns: context.turns })));
  const rollbackThread: Adapter["rollbackThread"] = (threadId, _numTurns) =>
    requireSession(threadId).pipe(
      Effect.flatMap(
        () =>
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "Pi Agent RPC does not support conversation rollback.",
          }),
      ),
    );
  const stopAll: Adapter["stopAll"] = () =>
    Effect.forEach([...sessions.values()], stopContext, { discard: true });

  yield* Effect.addFinalizer(() =>
    stopAll().pipe(Effect.ignore, Effect.andThen(PubSub.shutdown(events))),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      supportsConversationRollback: false,
    },
    startSession,
    sendTurn,
    compactThread,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromPubSub(events),
  } satisfies Adapter;
});
