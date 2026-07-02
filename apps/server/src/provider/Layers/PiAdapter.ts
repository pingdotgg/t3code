import {
  EventId,
  type PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import {
  parsePiApprovalTitle,
  parsePiModelSlug,
  PI_APPROVAL_EXTENSION_SOURCE,
  type PiApprovalRequestPayload,
  type PiRpcEvent,
  type PiRpcHandle,
  PiRuntimeError,
  piRuntimeErrorDetail,
  spawnPiRpcSession,
  toPiApprovalSelection,
} from "../piRuntime.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("pi");

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

interface PiTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface PiPendingDialog {
  readonly method: string;
  readonly title: string;
  readonly options: ReadonlyArray<string>;
}

interface PiSessionContext {
  session: ProviderSession;
  readonly rpc: PiRpcHandle;
  readonly pendingApprovals: Map<string, PiApprovalRequestPayload>;
  readonly pendingDialogs: Map<string, PiPendingDialog>;
  activeTurnId: TurnId | undefined;
  currentModelSlug: string | undefined;
  currentThinking: string | undefined;
  lastStopReason: string | undefined;
  messageSequence: number;
  compactionSequence: number;
  readonly stopped: Ref.Ref<boolean>;
  readonly sessionScope: Scope.Closeable;
}

export interface PiAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

type EventBaseInput = {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly raw?: unknown;
};

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (normalized.includes("task") || normalized.includes("agent")) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function approvalRequestType(
  tool: string,
): "command_execution_approval" | "file_change_approval" | "unknown" {
  if (tool === "bash") return "command_execution_approval";
  if (tool === "edit" || tool === "write") return "file_change_approval";
  return "unknown";
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function toolDetailFromArgs(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  if (toolName === "bash") return stringField(record, "command");
  return stringField(record, "path") ?? stringField(record, "file_path");
}

function textFromContentBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
}

function toolResultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const content = (result as Record<string, unknown>).content;
  const text = textFromContentBlocks(content);
  return text.length > 0 ? text : undefined;
}

function tokenUsageFromStats(stats: unknown): ThreadTokenUsageSnapshot | undefined {
  if (!stats || typeof stats !== "object") return undefined;
  const record = stats as Record<string, unknown>;
  const tokens =
    record.tokens && typeof record.tokens === "object"
      ? (record.tokens as Record<string, unknown>)
      : undefined;
  const contextUsage =
    record.contextUsage && typeof record.contextUsage === "object"
      ? (record.contextUsage as Record<string, unknown>)
      : undefined;
  const asCount = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.round(value)
      : undefined;
  const usedTokens = asCount(contextUsage?.tokens) ?? asCount(tokens?.total);
  if (usedTokens === undefined) return undefined;
  const maxTokens = asCount(contextUsage?.contextWindow);
  return {
    usedTokens,
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
    ...(asCount(tokens?.input) !== undefined ? { inputTokens: asCount(tokens?.input) } : {}),
    ...(asCount(tokens?.cacheRead) !== undefined
      ? { cachedInputTokens: asCount(tokens?.cacheRead) }
      : {}),
    ...(asCount(tokens?.output) !== undefined ? { outputTokens: asCount(tokens?.output) } : {}),
    ...(asCount(record.toolCalls) !== undefined ? { toolUses: asCount(record.toolCalls) } : {}),
  };
}

function dialogQuestion(uiRequestId: string, dialog: PiPendingDialog): UserInputQuestion {
  const options =
    dialog.method === "confirm"
      ? [
          { label: "Yes", description: "Confirm" },
          { label: "No", description: "Decline" },
        ]
      : dialog.options.map((option) => ({ label: option, description: option }));
  return {
    id: uiRequestId,
    header: "Pi",
    question: dialog.title,
    options,
    multiSelect: false,
  };
}

function ensureSessionContext(
  sessions: ReadonlyMap<ThreadId, PiSessionContext>,
  threadId: ThreadId,
): PiSessionContext {
  const session = sessions.get(threadId);
  if (!session) {
    throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
  }
  if (Ref.getUnsafe(session.stopped)) {
    throw new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
  }
  return session;
}

function updateProviderSession(
  context: PiSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): Effect.Effect<ProviderSession> {
  return Effect.gen(function* () {
    const updatedAt = yield* nowIso;
    const nextSession = {
      ...context.session,
      ...patch,
      updatedAt,
    } as ProviderSession & Record<string, unknown>;
    const mutableSession = nextSession as Record<string, unknown>;
    if (options?.clearActiveTurnId) {
      delete mutableSession.activeTurnId;
    }
    if (options?.clearLastError) {
      delete mutableSession.lastError;
    }
    context.session = nextSession;
    return nextSession;
  });
}

const toRequestError = (cause: PiRuntimeError): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: cause.operation,
    detail: cause.detail,
    cause,
  });

const stopPiContext = Effect.fn("stopPiContext")(function* (context: PiSessionContext) {
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return false;
  }
  yield* context.rpc
    .request({ type: "abort" }, { timeoutMs: 2_000 })
    .pipe(Effect.ignore({ log: false }));
  yield* Scope.close(context.sessionScope, Exit.void);
  return true;
});

export function makePiAdapter(piSettings: PiSettings, options?: PiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
    const serverConfig = yield* ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, PiSessionContext>();
    const extensionDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-" }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "makeTempDirectoryScoped",
            detail: "Failed to create Pi approval extension directory.",
            cause,
          }),
      ),
    );
    const approvalExtensionPath = path.join(extensionDir, "t3-approvals.ts");
    yield* fs.writeFileString(approvalExtensionPath, PI_APPROVAL_EXTENSION_SOURCE).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "writeFileString",
            detail: "Failed to write Pi approval extension.",
            cause,
          }),
      ),
    );

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
    const buildEventBase = (input: EventBaseInput) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: nowIso,
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? { raw: { source: "pi.rpc.event" as const, payload: input.raw } }
            : {}),
        })),
      );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(contexts, (context) => Effect.ignoreCause(stopPiContext(context)), {
          concurrency: "unbounded",
          discard: true,
        });
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    const writeNativeEventBestEffort = (threadId: ThreadId, event: PiRpcEvent) =>
      nativeEventLogger
        ? Effect.flatMap(nowIso, (observedAt) =>
            nativeEventLogger.write(
              {
                observedAt,
                event: {
                  provider: PROVIDER,
                  threadId,
                  type: event.type,
                  payload: event,
                },
              },
              threadId,
            ),
          ).pipe(Effect.catchCause(() => Effect.void))
        : Effect.void;

    const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
      context: PiSessionContext,
      message: string,
    ) {
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return;
      }
      const turnId = context.activeTurnId;
      sessions.delete(context.session.threadId);
      yield* emit({
        ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
        type: "runtime.error",
        payload: { message, class: "transport_error" },
      }).pipe(Effect.ignore);
      yield* emit({
        ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
        type: "session.exited",
        payload: { reason: message, recoverable: false, exitKind: "error" },
      }).pipe(Effect.ignore);
      yield* Scope.close(context.sessionScope, Exit.void);
    });

    const emitTokenUsage = Effect.fn("emitTokenUsage")(function* (context: PiSessionContext) {
      const statsExit = yield* Effect.exit(
        context.rpc.request({ type: "get_session_stats" }, { timeoutMs: 5_000 }),
      );
      if (statsExit._tag === "Failure") {
        return;
      }
      const usage = tokenUsageFromStats(statsExit.value.data);
      if (!usage) {
        return;
      }
      yield* emit({
        ...(yield* buildEventBase({ threadId: context.session.threadId })),
        type: "thread.token-usage.updated",
        payload: { usage },
      });
    });

    const handleExtensionUiRequest = Effect.fn("handleExtensionUiRequest")(function* (
      context: PiSessionContext,
      event: PiRpcEvent,
    ) {
      const threadId = context.session.threadId;
      const turnId = context.activeTurnId;
      const uiRequestId = stringField(event, "id");
      const method = stringField(event, "method") ?? "unknown";
      if (!uiRequestId) {
        return;
      }

      if (method === "notify") {
        if (stringField(event, "notifyType") === "error") {
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, raw: event })),
            type: "runtime.warning",
            payload: { message: stringField(event, "message") ?? "Pi extension error." },
          });
        }
        return;
      }
      if (
        method !== "select" &&
        method !== "confirm" &&
        method !== "input" &&
        method !== "editor"
      ) {
        return;
      }

      const title = stringField(event, "title") ?? "";
      const approval = method === "select" ? parsePiApprovalTitle(title) : null;
      if (approval) {
        context.pendingApprovals.set(uiRequestId, approval);
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId, requestId: uiRequestId, raw: event })),
          type: "request.opened",
          payload: {
            requestType: approvalRequestType(approval.tool),
            detail: approval.detail.length > 0 ? approval.detail : approval.tool,
          },
        });
        return;
      }

      if (method === "input" || method === "editor") {
        yield* context.rpc.notify({
          type: "extension_ui_response",
          id: uiRequestId,
          cancelled: true,
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId, raw: event })),
          type: "runtime.warning",
          payload: {
            message: `Cancelled unsupported Pi extension ${method} dialog: ${title}`,
          },
        });
        return;
      }

      const rawOptions = Array.isArray(event.options)
        ? event.options.filter((option): option is string => typeof option === "string")
        : [];
      const dialog: PiPendingDialog = {
        method,
        title:
          title.length > 0
            ? `${title}${stringField(event, "message") ? `\n${stringField(event, "message")}` : ""}`
            : "Pi extension request",
        options: rawOptions,
      };
      context.pendingDialogs.set(uiRequestId, dialog);
      yield* emit({
        ...(yield* buildEventBase({ threadId, turnId, requestId: uiRequestId, raw: event })),
        type: "user-input.requested",
        payload: { questions: [dialogQuestion(uiRequestId, dialog)] },
      });
    });

    const handlePiEvent = Effect.fn("handlePiEvent")(function* (
      context: PiSessionContext,
      event: PiRpcEvent,
    ) {
      const threadId = context.session.threadId;
      const turnId = context.activeTurnId;
      yield* writeNativeEventBestEffort(threadId, event);

      switch (event.type) {
        case "message_start": {
          context.messageSequence += 1;
          break;
        }

        case "message_update": {
          const delta =
            event.assistantMessageEvent && typeof event.assistantMessageEvent === "object"
              ? (event.assistantMessageEvent as Record<string, unknown>)
              : undefined;
          if (!delta) break;
          const deltaType = stringField(delta, "type");
          if (deltaType !== "text_delta" && deltaType !== "thinking_delta") break;
          const text = stringField(delta, "delta");
          if (!text) break;
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId: `pi-msg-${context.messageSequence}`,
            })),
            type: "content.delta",
            payload: {
              streamKind: deltaType === "thinking_delta" ? "reasoning_text" : "assistant_text",
              delta: text,
              ...(typeof delta.contentIndex === "number"
                ? { contentIndex: delta.contentIndex }
                : {}),
            },
          });
          break;
        }

        case "message_end": {
          const message =
            event.message && typeof event.message === "object"
              ? (event.message as Record<string, unknown>)
              : undefined;
          if (!message || message.role !== "assistant") break;
          context.lastStopReason = stringField(message, "stopReason");
          const text = textFromContentBlocks(message.content);
          if (text.length > 0) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId,
                turnId,
                itemId: `pi-msg-${context.messageSequence}`,
                raw: event,
              })),
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant message",
                detail: text,
              },
            });
          }
          break;
        }

        case "tool_execution_start":
        case "tool_execution_update":
        case "tool_execution_end": {
          const toolCallId =
            stringField(event, "toolCallId") ?? `pi-tool-${context.messageSequence}`;
          const toolName = stringField(event, "toolName") ?? "tool";
          const isEnd = event.type === "tool_execution_end";
          const isError = isEnd && event.isError === true;
          const detail = isEnd
            ? toolResultText(event.result)
            : event.type === "tool_execution_update"
              ? toolResultText(event.partialResult)
              : toolDetailFromArgs(toolName, event.args);
          const payload = {
            itemType: toToolLifecycleItemType(toolName),
            status: isError
              ? ("failed" as const)
              : isEnd
                ? ("completed" as const)
                : ("inProgress" as const),
            title: toolName,
            ...(detail ? { detail } : {}),
            data: {
              tool: toolName,
              ...(event.args !== undefined ? { args: event.args } : {}),
              ...(isEnd && event.result !== undefined ? { result: event.result } : {}),
            },
          };
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, itemId: toolCallId, raw: event })),
            type:
              event.type === "tool_execution_start"
                ? "item.started"
                : isEnd
                  ? "item.completed"
                  : "item.updated",
            payload,
          });
          break;
        }

        case "agent_end": {
          if (!turnId) break;
          context.activeTurnId = undefined;
          const failed = context.lastStopReason === "error";
          context.lastStopReason = undefined;
          yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId })),
            type: "turn.completed",
            payload: failed
              ? { state: "failed", errorMessage: "Pi reported an error while completing the turn." }
              : { state: "completed" },
          });
          yield* emitTokenUsage(context);
          break;
        }

        case "extension_ui_request": {
          yield* handleExtensionUiRequest(context, event);
          break;
        }

        case "compaction_start": {
          context.compactionSequence += 1;
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId: `pi-compaction-${context.compactionSequence}`,
              raw: event,
            })),
            type: "item.started",
            payload: {
              itemType: "context_compaction",
              status: "inProgress",
              title: "Compacting context",
            },
          });
          break;
        }

        case "compaction_end": {
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId: `pi-compaction-${context.compactionSequence}`,
              raw: event,
            })),
            type: "item.completed",
            payload: {
              itemType: "context_compaction",
              status: event.aborted === true ? "declined" : "completed",
              title: "Compacting context",
            },
          });
          break;
        }

        case "auto_retry_start": {
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, raw: event })),
            type: "runtime.warning",
            payload: {
              message: `Pi is retrying after a transient provider error (attempt ${String(event.attempt ?? "?")}).`,
              detail: event,
            },
          });
          break;
        }

        case "extension_error": {
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, raw: event })),
            type: "runtime.warning",
            payload: {
              message: `Pi extension error: ${stringField(event, "error") ?? "unknown"}`,
              detail: event,
            },
          });
          break;
        }

        default:
          break;
      }
    });

    const readAttachmentImages = (input: {
      readonly threadId: ThreadId;
      readonly attachments: Parameters<PiAdapterShape["sendTurn"]>[0]["attachments"];
    }) =>
      Effect.forEach(input.attachments ?? [], (attachment) =>
        Effect.gen(function* () {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return null;
          }
          const bytes = yield* fs.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "readAttachment",
                  detail: `Failed to read attachment '${attachment.name}'.`,
                  cause,
                }),
            ),
          );
          return {
            type: "image" as const,
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          };
        }),
      ).pipe(Effect.map((images) => images.filter((image) => image !== null)));

    const startSession: PiAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const directory = input.cwd ?? serverConfig.cwd;
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopPiContext(existing);
          sessions.delete(input.threadId);
        }

        const thinkingLevel = getModelSelectionStringOptionValue(input.modelSelection, "thinking");
        const started = yield* Effect.gen(function* () {
          const sessionScope = yield* Scope.make();
          const startedExit = yield* Effect.exit(
            Effect.gen(function* () {
              const rpc = yield* spawnPiRpcSession({
                binaryPath: piSettings.binaryPath,
                cwd: directory,
                ...(options?.environment ? { environment: options.environment } : {}),
                runtimeMode: input.runtimeMode,
                sessionName: `T3 Code ${input.threadId}`,
                ...(input.modelSelection ? { modelSlug: input.modelSelection.model } : {}),
                ...(thinkingLevel ? { thinkingLevel } : {}),
                approvalExtensionPath,
              }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
              // First round trip doubles as the readiness gate: Pi answers
              // once extensions and session storage are loaded.
              const state = yield* rpc.request({ type: "get_state" }, { timeoutMs: 20_000 });
              const stateData =
                state.data && typeof state.data === "object"
                  ? (state.data as Record<string, unknown>)
                  : {};
              return {
                sessionScope,
                rpc,
                piSessionId: stringField(stateData, "sessionId"),
              };
            }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
          );
          if (Exit.isFailure(startedExit)) {
            yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: piRuntimeErrorDetail(Cause.squash(startedExit.cause)),
              cause: startedExit.cause,
            });
          }
          return startedExit.value;
        });

        const raceWinner = sessions.get(input.threadId);
        if (raceWinner) {
          yield* Scope.close(started.sessionScope, Exit.void).pipe(Effect.ignore);
          return raceWinner.session;
        }

        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          createdAt,
          updatedAt: createdAt,
        };
        const context: PiSessionContext = {
          session,
          rpc: started.rpc,
          pendingApprovals: new Map(),
          pendingDialogs: new Map(),
          activeTurnId: undefined,
          currentModelSlug: input.modelSelection?.model,
          currentThinking: thinkingLevel,
          lastStopReason: undefined,
          messageSequence: 0,
          compactionSequence: 0,
          stopped: yield* Ref.make(false),
          sessionScope: started.sessionScope,
        };
        sessions.set(input.threadId, context);

        yield* Stream.fromQueue(started.rpc.events).pipe(
          Stream.runForEach((event) => handlePiEvent(context, event)),
          Effect.ignore,
          Effect.forkIn(started.sessionScope),
        );
        yield* started.rpc.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return;
              }
              yield* emitUnexpectedExit(context, `Pi process exited unexpectedly (${code}).`);
            }),
          ),
          Effect.forkIn(started.sessionScope),
        );

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: { message: "Pi session started" },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: started.piSessionId ? { providerThreadId: started.piSessionId } : {},
        });

        return session;
      },
    );

    const sendTurn: PiAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = ensureSessionContext(sessions, input.threadId);
      const steeringTurnId = context.activeTurnId;
      const turnId = steeringTurnId ?? TurnId.make(`pi-turn-${yield* randomUUIDv4}`);
      const modelSelection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Pi model selection is bound to instance '${modelSelection.instanceId}', expected '${boundInstanceId}'.`,
        });
      }

      const text = input.input?.trim();
      const images = yield* readAttachmentImages({
        threadId: input.threadId,
        attachments: input.attachments,
      });
      if ((!text || text.length === 0) && images.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Pi turns require text input or at least one image attachment.",
        });
      }
      if (modelSelection?.model && modelSelection.model !== context.currentModelSlug) {
        const parsedModel = parsePiModelSlug(modelSelection.model);
        if (!parsedModel) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Pi model selection must use the 'provider/model' format.",
          });
        }
        yield* context.rpc
          .request({
            type: "set_model",
            provider: parsedModel.provider,
            modelId: parsedModel.modelId,
          })
          .pipe(Effect.mapError(toRequestError));
        context.currentModelSlug = modelSelection.model;
      }
      const thinkingLevel = getModelSelectionStringOptionValue(modelSelection, "thinking");
      if (thinkingLevel && thinkingLevel !== context.currentThinking) {
        yield* context.rpc
          .request({ type: "set_thinking_level", level: thinkingLevel })
          .pipe(Effect.mapError(toRequestError));
        context.currentThinking = thinkingLevel;
      }

      context.activeTurnId = turnId;
      yield* updateProviderSession(
        context,
        {
          status: "running",
          activeTurnId: turnId,
          model: modelSelection?.model ?? context.session.model,
        },
        { clearLastError: true },
      );
      if (steeringTurnId === undefined) {
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
          type: "turn.started",
          payload: {
            model: modelSelection?.model ?? context.session.model,
            ...(thinkingLevel ? { effort: thinkingLevel } : {}),
          },
        });
      }

      yield* context.rpc
        .request({
          type: "prompt",
          message: text ?? "",
          ...(images.length > 0 ? { images } : {}),
          ...(steeringTurnId !== undefined ? { streamingBehavior: "steer" } : {}),
        })
        .pipe(
          Effect.mapError(toRequestError),
          Effect.tapError((requestError) =>
            steeringTurnId !== undefined
              ? Effect.void
              : Effect.gen(function* () {
                  context.activeTurnId = undefined;
                  yield* updateProviderSession(
                    context,
                    { status: "ready", lastError: requestError.detail },
                    { clearActiveTurnId: true },
                  );
                  yield* emit({
                    ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                    type: "turn.aborted",
                    payload: { reason: requestError.detail },
                  });
                }),
          ),
        );

      return { threadId: input.threadId, turnId };
    });

    const interruptTurn: PiAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = ensureSessionContext(sessions, threadId);
        const abortedTurnId = turnId ?? context.activeTurnId;
        yield* context.rpc.request({ type: "abort" }).pipe(Effect.mapError(toRequestError));
        context.activeTurnId = undefined;
        context.lastStopReason = undefined;
        yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
        if (abortedTurnId) {
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId: abortedTurnId })),
            type: "turn.aborted",
            payload: { reason: "Interrupted by user." },
          });
        }
      },
    );

    const respondToRequest: PiAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
      function* (threadId, requestId, decision) {
        const context = ensureSessionContext(sessions, threadId);
        const approval = context.pendingApprovals.get(requestId);
        if (!approval) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        context.pendingApprovals.delete(requestId);
        const selection = toPiApprovalSelection(decision);
        yield* context.rpc.notify(
          selection === null
            ? { type: "extension_ui_response", id: requestId, cancelled: true }
            : { type: "extension_ui_response", id: requestId, value: selection },
        );
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId: context.activeTurnId, requestId })),
          type: "request.resolved",
          payload: {
            requestType: approvalRequestType(approval.tool),
            decision,
          },
        });
      },
    );

    const respondToUserInput: PiAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = ensureSessionContext(sessions, threadId);
      const dialog = context.pendingDialogs.get(requestId);
      if (!dialog) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "extension_ui_response",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }
      context.pendingDialogs.delete(requestId);
      const rawAnswer = answers[requestId];
      const answer = Array.isArray(rawAnswer)
        ? rawAnswer.find((value): value is string => typeof value === "string")
        : typeof rawAnswer === "string"
          ? rawAnswer
          : undefined;
      yield* context.rpc.notify(
        answer === undefined
          ? { type: "extension_ui_response", id: requestId, cancelled: true }
          : dialog.method === "confirm"
            ? { type: "extension_ui_response", id: requestId, confirmed: answer === "Yes" }
            : { type: "extension_ui_response", id: requestId, value: answer },
      );
      yield* emit({
        ...(yield* buildEventBase({ threadId, turnId: context.activeTurnId, requestId })),
        type: "user-input.resolved",
        payload: { answers: { [requestId]: answer ?? "" } },
      });
    });

    const stopSession: PiAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }
        const stopped = yield* stopPiContext(context);
        sessions.delete(threadId);
        if (!stopped) {
          return;
        }
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: { reason: "Session stopped.", recoverable: false, exitKind: "graceful" },
        });
      },
    );

    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: PiAdapterShape["readThread"] = Effect.fn("readThread")(function* (threadId) {
      const context = ensureSessionContext(sessions, threadId);
      const response = yield* context.rpc
        .request({ type: "get_messages" })
        .pipe(Effect.mapError(toRequestError));
      const data =
        response.data && typeof response.data === "object"
          ? (response.data as Record<string, unknown>)
          : {};
      const messages = Array.isArray(data.messages) ? data.messages : [];

      const turns: Array<PiTurnSnapshot> = [];
      for (const message of messages) {
        if (!message || typeof message !== "object") continue;
        const role = (message as Record<string, unknown>).role;
        if (role === "assistant") {
          turns.push({ id: TurnId.make(`pi-turn-${turns.length}`), items: [message] });
        } else if (role === "toolResult" && turns.length > 0) {
          turns[turns.length - 1]?.items.push(message);
        }
      }
      return { threadId, turns };
    });

    const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: `Pi does not support rolling back thread ${threadId} turns in place. Fork the session from Pi's own UI instead.`,
        }),
      );

    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(contexts, (context) => Effect.ignoreCause(stopPiContext(context)), {
          concurrency: "unbounded",
          discard: true,
        });
      });

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
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies PiAdapterShape;
  });
}
