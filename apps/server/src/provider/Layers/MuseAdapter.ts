// @effect-diagnostics globalTimers:off
// Native deadlines belong to the SDK Promise boundary and must also run during Effect interruption.
import {
  createUuidV7Mint,
  type NotificationHandler,
  type SendUserTurnOptions,
} from "@muse-code/sdk";
import {
  EventId,
  MUSE_REASONING_EFFORT_OPTIONS,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  TurnId,
  type MuseSettings,
  type ProviderRuntimeEvent,
  type ProviderRuntimeEventBase,
  type ProviderSession,
  type RuntimeContentStreamKind,
  type ThreadId,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  MuseApproval,
  MuseCompactResult,
  MuseContextUsage,
  MuseDelta,
  MuseItem,
  MuseItemEvent,
  MuseResumeCursor,
  MuseSessionResult,
  MuseTodoList,
  MuseTokenUsageEvent,
  MuseTurnCompleted,
  MuseTurnStartResult,
  MuseUserInput,
  MuseUserInputSettled,
  MuseViewPage,
  museApprovalDecision,
  museApprovalChoices,
  museItemType,
  museRequestType,
} from "../museProtocol.ts";
import { createMuseSdkHost, museApprovalMode, type MuseSdkHost } from "../museSdk.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("muse");
const DEFAULT_MODEL = "muse-spark-1.3-contributor";
const SUPPORTED_EFFORTS = new Set<string>(
  MUSE_REASONING_EFFORT_OPTIONS.map((option) => option.id) satisfies ReadonlyArray<
    NonNullable<SendUserTurnOptions<never>["reasoningEffort"]>
  >,
);
const decodeTurnStart = Schema.decodeUnknownSync(MuseTurnStartResult);
const decodeItemEvent = Schema.decodeUnknownSync(MuseItemEvent);
const decodeDelta = Schema.decodeUnknownSync(MuseDelta);
const decodeTurnCompleted = Schema.decodeUnknownSync(MuseTurnCompleted);
const decodeApproval = Schema.decodeUnknownSync(MuseApproval);
const decodeUserInput = Schema.decodeUnknownSync(MuseUserInput);
const decodeUserInputSettled = Schema.decodeUnknownSync(MuseUserInputSettled);
const decodeTokenUsage = Schema.decodeUnknownSync(MuseTokenUsageEvent);
const decodeContextUsage = Schema.decodeUnknownSync(MuseContextUsage);
const decodeTodoList = Schema.decodeUnknownSync(MuseTodoList);
const decodeToolArgs = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeResume = Schema.decodeUnknownSync(MuseResumeCursor);
const decodeSessionResult = Schema.decodeUnknownSync(MuseSessionResult);
const decodeViewPage = Schema.decodeUnknownSync(MuseViewPage);
const decodeCompactResult = Schema.decodeUnknownSync(MuseCompactResult);
const decodeAnswer = Schema.decodeUnknownSync(
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);
const isSessionNotFoundError = Schema.is(ProviderAdapterSessionNotFoundError);
const isValidationError = Schema.is(ProviderAdapterValidationError);
type Notification = Parameters<NotificationHandler>[0];
type RuntimeEmission = {
  [K in ProviderRuntimeEvent["type"]]: Pick<
    Extract<ProviderRuntimeEvent, { type: K }>,
    "type" | "payload"
  > &
    Partial<Pick<ProviderRuntimeEventBase, "turnId" | "itemId" | "requestId" | "raw">>;
}[ProviderRuntimeEvent["type"]];

interface TurnState {
  readonly id: TurnId;
  readonly done: Promise<void>;
  readonly resolve: () => void;
  readonly surfaces: Map<string, string>;
  readonly completedItems: Set<string>;
  observedUsage: TurnTokenUsage | undefined;
}

interface SessionContext {
  session: ProviderSession;
  nativeSessionId: string;
  readonly host: MuseSdkHost;
  readonly items: Map<string, MuseItem>;
  readonly approvals: Map<string, MuseApproval>;
  readonly openedApprovals: Set<string>;
  readonly questions: Map<string, MuseUserInput>;
  readonly turns: Set<TurnId>;
  active: TurnState | undefined;
  stopped: boolean;
  closing: Promise<void> | undefined;
  notificationTail: Promise<void>;
  reasoningEffort: string;
}

export interface MuseAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly createHost?: typeof createMuseSdkHost;
  readonly requestTimeoutMs?: number;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function makeTurn(id: TurnId): TurnState {
  let resolve = () => {};
  const done = new Promise<void>((complete) => {
    resolve = complete;
  });
  return {
    id,
    done,
    resolve,
    surfaces: new Map(),
    completedItems: new Set(),
    observedUsage: undefined,
  };
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));
const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());

export const makeMuseAdapter = Effect.fn("makeMuseAdapter")(function* (
  settings: MuseSettings,
  options?: MuseAdapterOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const serverConfig = yield* ServerConfig;
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const instanceId = options?.instanceId ?? ProviderInstanceId.make("muse");
  const createHost = options?.createHost ?? createMuseSdkHost;
  const timeoutMs = options?.requestTimeoutMs ?? 20_000;
  const sessions = new Map<ThreadId, SessionContext>();
  const locks = new Map<ThreadId, { semaphore: Semaphore.Semaphore; users: number }>();
  const mintId = createUuidV7Mint();
  let disposed = false;

  const writeNativeEvent = (threadId: ThreadId, event: unknown) =>
    options?.nativeEventLogger
      ? runPromise(
          options.nativeEventLogger
            .write({ observedAt: nowIso(), event }, threadId)
            .pipe(Effect.ignoreCause),
        )
      : Promise.resolve();

  const emit = (context: SessionContext, event: RuntimeEmission) => {
    Queue.offerUnsafe(events, {
      eventId: EventId.make(mintId()),
      provider: PROVIDER,
      providerInstanceId: instanceId,
      threadId: context.session.threadId,
      createdAt: nowIso(),
      ...(context.active ? { turnId: context.active.id } : {}),
      ...event,
    });
  };

  const settleRequests = (context: SessionContext) => {
    for (const [id, approval] of context.approvals) {
      if (!context.openedApprovals.delete(id)) continue;
      emit(context, {
        type: "request.resolved",
        requestId: RuntimeRequestId.make(id),
        payload: { requestType: museRequestType(approval), decision: "cancel" },
      });
    }
    context.approvals.clear();
    for (const id of context.questions.keys()) {
      emit(context, {
        type: "user-input.resolved",
        requestId: RuntimeRequestId.make(id),
        payload: { answers: {} },
      });
    }
    context.questions.clear();
  };

  const beginTurn = (context: SessionContext, id: TurnId, effort?: string) => {
    if (context.active?.id === id) return;
    if (context.turns.has(id)) return;
    if (context.active)
      throw new Error("Muse started a turn before completing its preceding turn.");
    context.active = makeTurn(id);
    context.turns.add(id);
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: id,
      updatedAt: nowIso(),
    };
    emit(context, {
      type: "turn.started",
      payload: {
        ...(context.session.model ? { model: context.session.model } : {}),
        ...(effort ? { effort } : {}),
      },
    });
    emit(context, { type: "session.state.changed", payload: { state: "running" } });
  };

  const finishTurn = (
    context: SessionContext,
    state: "completed" | "failed" | "interrupted" | "cancelled",
    errorMessage?: string,
    tokenUsage?: TurnTokenUsage,
  ) => {
    const turn = context.active;
    if (!turn) return;
    tokenUsage ??= turn.observedUsage;
    settleRequests(context);
    emit(context, {
      type: "turn.completed",
      turnId: turn.id,
      payload: {
        state,
        ...(errorMessage ? { errorMessage } : {}),
        ...(tokenUsage ? { tokenUsage } : {}),
      },
    });
    context.active = undefined;
    const { activeTurnId: _, ...session } = context.session;
    context.session = {
      ...session,
      status: state === "failed" ? "error" : "ready",
      updatedAt: nowIso(),
    };
    turn.resolve();
    emit(context, {
      type: "session.state.changed",
      payload: { state: state === "failed" ? "error" : "ready" },
    });
  };

  const closeContext = (context: SessionContext, reason: string, failed = false) => {
    if (context.closing) return context.closing;
    context.stopped = true;
    if (failed)
      emit(context, {
        type: "runtime.error",
        payload: { message: reason, class: "transport_error" },
      });
    finishTurn(context, failed ? "failed" : "interrupted", failed ? reason : undefined);
    for (const item of context.items.values()) {
      if (item.kind !== "subagent" || item.status !== "inProgress") continue;
      const stoppedItem = {
        ...item,
        status: failed ? "failed" : "cancelled",
        failureReason: reason,
      };
      context.items.set(item.itemId, stoppedItem);
      recordSubagent(context, stoppedItem, item);
    }
    settleRequests(context);
    context.session = {
      ...context.session,
      status: failed ? "error" : "closed",
      updatedAt: nowIso(),
    };
    emit(context, {
      type: "session.exited",
      payload: { reason, recoverable: true, exitKind: failed ? "error" : "graceful" },
    });
    context.closing = context.host.close().finally(() => {
      if (sessions.get(context.session.threadId) === context)
        sessions.delete(context.session.threadId);
    });
    return context.closing;
  };

  const bounded = async <A>(
    context: SessionContext,
    method: string,
    operation: Promise<A>,
  ): Promise<A> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Muse ${method} timed out.`));
          }, timeoutMs);
          timer.unref();
        }),
      ]);
    } catch (error) {
      if (timedOut) await closeContext(context, describeError(error), true);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const command = (
    context: SessionContext,
    method: string,
    params: Record<string, unknown>,
    commandId?: string,
  ) =>
    bounded(
      context,
      method,
      context.host.connection.command(
        method,
        {
          sessionId: context.nativeSessionId,
          ...params,
        },
        { maxAttempts: 1, ...(commandId ? { commandId } : {}) },
      ),
    );

  const loadHistory = async (context: SessionContext, result: typeof MuseSessionResult.Type) => {
    const rememberItem = (item: MuseItem) => {
      const previous = context.items.get(item.itemId);
      if (!previous || previous.revision < item.revision) context.items.set(item.itemId, item);
      if (item.turnId && item.turnId !== result.session.activeTurnId)
        context.turns.add(TurnId.make(item.turnId));
    };
    const history = result.history;
    if (!history) return;
    const snapshot = history.snapshot;
    const items =
      history.items ??
      (snapshot?.schemaVersion === undefined || snapshot.schemaVersion === 1
        ? snapshot?.state.items
        : undefined);
    if (items) {
      items.forEach(rememberItem);
      return;
    }
    // Large histories may exceed the inline/snapshot budget. Page the durable
    // view and fold item revisions without replaying old events into the UI.
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      const page = decodeViewPage(
        await bounded(
          context,
          "view/page",
          context.host.connection.request("view/page", {
            sessionId: context.nativeSessionId,
            direction: "forward",
            limit: 1000,
            ...(cursor ? { cursor } : {}),
          }),
        ),
      );
      for (const event of page.events) {
        if (
          event.method === "item/started" ||
          event.method === "item/updated" ||
          event.method === "item/completed"
        )
          rememberItem(decodeItemEvent(event.params).item);
        else if (event.method === "turn/started" || event.method === "turn/completed") {
          const turn = decodeTurnStart(event.params);
          if (turn.turnId !== result.session.activeTurnId)
            context.turns.add(TurnId.make(turn.turnId));
        }
      }
      cursor = page.nextCursor;
      if (cursor) {
        if (cursors.has(cursor)) throw new Error("Muse history paging did not advance.");
        cursors.add(cursor);
      }
    } while (cursor);
  };

  const recordSubagent = (context: SessionContext, item: MuseItem, previous?: MuseItem) => {
    if (item.kind !== "subagent") return;
    const taskId = RuntimeTaskId.make(item.subagentId || item.itemId);
    const title = item.objective?.trim() || item.role?.trim() || "Muse agent";
    const linkage = {
      taskId,
      taskType: "subagent",
      title,
      ...(item.role?.trim() ? { role: item.role.trim() } : {}),
    };
    const identity = {
      ...(item.turnId ? { turnId: TurnId.make(item.turnId) } : {}),
      itemId: RuntimeItemId.make(item.itemId),
    };
    if (!previous)
      emit(context, {
        ...identity,
        type: "task.started",
        payload: { ...linkage, description: title },
      });
    const terminal = item.status !== "inProgress";
    const summary = (item.failureReason || item.result?.summary || item.fallbackText)?.trim();
    const usage = item.usage;
    if (terminal) {
      emit(context, {
        ...identity,
        type: "task.completed",
        payload: {
          ...linkage,
          status:
            item.status === "completed"
              ? "completed"
              : item.status === "cancelled"
                ? "stopped"
                : "failed",
          ...(summary ? { summary } : {}),
          // Child usage is transitive and remains separate from main-agent turn totals.
          ...(usage ? { usage } : {}),
        },
      });
    } else {
      emit(context, {
        ...identity,
        type: "task.progress",
        payload: {
          ...linkage,
          description: title,
          status:
            item.controlStatus === "accepted" || item.controlStatus === "starting"
              ? "pending"
              : item.controlStatus === "resultReady" || item.controlStatus === "closing"
                ? "idle"
                : item.controlStatus === "recoveryPending" ||
                    item.controlStatus === "manualReconciliation"
                  ? "waiting"
                  : "running",
          ...(summary ? { summary } : {}),
          ...(usage ? { usage } : {}),
        },
      });
    }
  };

  const recordItem = (context: SessionContext, item: MuseItem, notification: Notification) => {
    const previous = context.items.get(item.itemId);
    if (previous && previous.revision >= item.revision) return;
    context.items.set(item.itemId, item);
    recordSubagent(context, item, previous);
    if (item.kind === "compaction" && item.status !== "inProgress") {
      if (item.outcome === "compacted")
        emit(context, { type: "thread.state.changed", payload: { state: "compacted" } });
      else if (item.outcome === "failed")
        emit(context, {
          type: "runtime.error",
          payload: {
            message: item.reason || item.failureReason || "Muse context compaction failed.",
          },
        });
    }
    const turn = context.active;
    if (!turn || item.turnId !== turn.id) return;
    const itemId = RuntimeItemId.make(item.itemId);
    const itemType = museItemType(item);
    const terminal = item.status !== "inProgress";
    let args: Record<string, unknown> | undefined;
    if (item.args) {
      try {
        args = decodeToolArgs(item.args);
      } catch {
        // Muse preserves model-authored arguments even when they are incomplete JSON.
      }
    }
    const detail = [
      item.failureReason,
      item.fallbackText,
      item.commandText,
      args?.command,
      args?.cmd,
      args?.file_path,
      args?.path,
      args?.description,
      item.objective,
    ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const data = {
      item,
      ...(item.tool ? { toolName: item.tool } : {}),
      ...(args ? { input: args, rawInput: args } : {}),
      ...(item.commandText ? { command: item.commandText } : {}),
      ...(item.visibleOutput !== undefined ? { rawOutput: item.visibleOutput } : {}),
    };
    if (!previous) {
      emit(context, {
        type: "item.started",
        itemId,
        payload: {
          itemType,
          status: "inProgress",
          ...(item.tool ? { title: item.tool } : {}),
          ...(detail ? { detail } : {}),
          data,
        },
      });
    }
    const appendSurface = (
      field: string,
      text: string | undefined,
      streamKind: RuntimeContentStreamKind,
    ) => {
      if (!text) return;
      const key = `${item.itemId}:${field}`;
      const streamed = turn.surfaces.get(key) ?? "";
      // Full snapshots repeat accumulated deltas. Only append the unobserved suffix.
      if (text.startsWith(streamed)) {
        const delta = text.slice(streamed.length);
        if (delta) emit(context, { type: "content.delta", itemId, payload: { streamKind, delta } });
      }
      turn.surfaces.set(key, text);
    };
    if (item.kind === "agentMessage") appendSurface("text", item.text, "assistant_text");
    if (item.kind === "reasoning") {
      appendSurface("text", item.text, "reasoning_text");
      item.summary?.forEach((text, index) =>
        appendSurface(`summary.${index}`, text, "reasoning_summary_text"),
      );
    }
    if (item.kind === "toolCall" || item.kind === "userShell")
      appendSurface("output", item.visibleOutput, "command_output");
    const payload = {
      itemType,
      status: terminal
        ? item.status === "completed"
          ? ("completed" as const)
          : item.status === "rejected"
            ? ("declined" as const)
            : ("failed" as const)
        : ("inProgress" as const),
      ...(item.tool ? { title: item.tool } : {}),
      ...(detail ? { detail } : {}),
      data,
    };
    if (!terminal || !turn.completedItems.has(item.itemId)) {
      emit(context, {
        type: terminal ? "item.completed" : "item.updated",
        itemId,
        payload,
        raw: {
          source: "muse.sdk.event",
          method: notification.method,
          payload: notification.params,
        },
      });
    }
    if (terminal) turn.completedItems.add(item.itemId);
  };

  const handleNotification = async (context: SessionContext, notification: Notification) => {
    if (context.stopped) return;
    const params = notification.params ?? {};
    if (params.sessionId !== context.nativeSessionId) return;
    const raw = { source: "muse.sdk.event" as const, method: notification.method, payload: params };
    switch (notification.method) {
      case "turn/started": {
        const started = decodeTurnStart(params);
        beginTurn(context, TurnId.make(started.turnId));
        break;
      }
      case "item/started":
      case "item/updated":
      case "item/completed":
        recordItem(context, decodeItemEvent(params).item, notification);
        break;
      case "item/delta": {
        const delta = decodeDelta(params);
        const item = context.items.get(delta.itemId);
        const turn = context.active;
        if (!item || !turn || item.turnId !== turn.id || turn.completedItems.has(item.itemId))
          break;
        const field = delta.field ?? "text";
        let streamKind: RuntimeContentStreamKind = "unknown";
        if (item.kind === "agentMessage" && field === "text") streamKind = "assistant_text";
        else if (item.kind === "reasoning")
          streamKind = field.startsWith("summary.") ? "reasoning_summary_text" : "reasoning_text";
        else if (field === "output") streamKind = "command_output";
        else break;
        const key = `${item.itemId}:${field}`;
        turn.surfaces.set(key, (turn.surfaces.get(key) ?? "") + delta.delta);
        emit(context, {
          type: "content.delta",
          itemId: RuntimeItemId.make(item.itemId),
          payload: { streamKind, delta: delta.delta },
          raw,
        });
        break;
      }
      case "turn/completed": {
        const completed = decodeTurnCompleted(params);
        if (completed.turnId !== context.active?.id) break;
        const state =
          completed.terminal === "completed"
            ? "completed"
            : completed.terminal === "cancelled"
              ? "interrupted"
              : "failed";
        const usage = completed.usage;
        finishTurn(
          context,
          state,
          completed.error?.message ||
            (state === "failed" ? completed.reason || "Muse turn failed." : undefined),
          usage
            ? {
                usageScope: "main_agent",
                usageStatus: "complete",
                hasSubagents: [...context.items.values()].some(
                  (item) => item.turnId === completed.turnId && item.kind === "subagent",
                ),
                inputTokens: context.active?.observedUsage?.inputTokens ?? usage.inputTokens,
                outputTokens: usage.outputTokens,
                cachedInputTokens: usage.cacheReadTokens ?? usage.cachedTokens,
                ...(usage.cacheWriteTokens !== undefined
                  ? { cacheCreationTokens: usage.cacheWriteTokens }
                  : {}),
                reasoningTokens: usage.reasoningTokens,
              }
            : undefined,
        );
        break;
      }
      case "approval/requested":
      case "approval/updated": {
        const decoded = decodeApproval(params);
        if (decoded.turnId && decoded.turnId !== context.active?.id) break;
        const previous = context.approvals.get(decoded.approvalId);
        const approval = { ...previous, ...decoded };
        if (
          previous?.currentRequirementId.sourceIndex ===
            approval.currentRequirementId.sourceIndex &&
          JSON.stringify(previous.availableChoices) === JSON.stringify(approval.availableChoices)
        )
          break;
        context.approvals.set(approval.approvalId, approval);
        const nativeChoices = museApprovalChoices(approval);
        const acceptOnce = nativeChoices.get("accept");
        if (
          context.session.runtimeMode === "auto-accept-edits" &&
          approval.subject.kind === "fileAccess" &&
          (approval.subject.access === "write" || approval.subject.access === "readWrite") &&
          acceptOnce?.scope === "once"
        ) {
          try {
            await command(context, "approval/decide", {
              approvalId: approval.approvalId,
              requirementId: approval.currentRequirementId,
              choiceId: acceptOnce.choiceId,
            });
            break;
          } catch (error) {
            if (context.stopped) break;
            emit(context, {
              type: "runtime.warning",
              payload: {
                message: "Muse could not automatically approve this edit.",
                detail: describeError(error),
              },
            });
          }
        }
        const choices = [...nativeChoices].map(([decision, choice]) => ({
          decision,
          label: choice.label.trim() || decision,
        }));
        context.openedApprovals.add(approval.approvalId);
        emit(context, {
          type: "request.opened",
          requestId: RuntimeRequestId.make(approval.approvalId),
          payload: {
            requestType: museRequestType(approval),
            detail:
              approval.subject.command ||
              approval.subject.path ||
              approval.toolName ||
              "Muse tool approval",
            options: choices,
            args: params,
          },
          raw,
        });
        break;
      }
      case "approval/resolved": {
        if (typeof params.approvalId !== "string") break;
        const approval = context.approvals.get(params.approvalId);
        if (!approval) break;
        context.approvals.delete(params.approvalId);
        if (!context.openedApprovals.delete(params.approvalId)) break;
        emit(context, {
          type: "request.resolved",
          requestId: RuntimeRequestId.make(params.approvalId),
          payload: {
            requestType: museRequestType(approval),
            ...(typeof params.decision === "string"
              ? {
                  decision:
                    museApprovalDecision({
                      decision: params.decision,
                      scope:
                        approval.availableChoices.find(
                          (choice) => choice.decision === params.decision,
                        )?.scope ?? "",
                    }) ?? params.decision,
                }
              : {}),
          },
          raw,
        });
        break;
      }
      case "userInput/requested": {
        const request = decodeUserInput(params);
        if (request.turnId !== context.active?.id) break;
        if (context.questions.has(request.userInputId)) break;
        context.questions.set(request.userInputId, request);
        emit(context, {
          type: "user-input.requested",
          requestId: RuntimeRequestId.make(request.userInputId),
          payload: {
            questions: request.questions.map((question) => ({
              id: question.id,
              header: question.header.trim() || "Question",
              question: question.question.trim() || "Muse needs your input.",
              options: question.options
                .filter((option) => option.label.trim())
                .map((option) => ({
                  label: option.label,
                  description: option.description ?? "",
                })),
              allowCustomAnswer: true,
              multiSelect: question.selection.mode === "multiple",
            })),
          },
          raw,
        });
        break;
      }
      case "userInput/settled": {
        const settled = decodeUserInputSettled(params);
        if (!context.questions.delete(settled.userInputId)) break;
        emit(context, {
          type: "user-input.resolved",
          requestId: RuntimeRequestId.make(settled.userInputId),
          payload: {
            answers: Object.fromEntries(
              settled.answers.map((answer) => [
                answer.questionId,
                [
                  ...(answer.selectedLabels ?? []),
                  answer.selectedLabel,
                  answer.freeText,
                  answer.note,
                ]
                  .filter((value): value is string => value !== undefined)
                  .join("\n"),
              ]),
            ),
          },
          raw,
        });
        break;
      }
      case "session/modelChanged": {
        if (typeof params.modelId === "string")
          context.session = { ...context.session, model: params.modelId };
        break;
      }
      case "session/tokenUsage": {
        const usage = decodeTokenUsage(params);
        const turn = context.active;
        if (!turn || usage.turnId !== turn.id) break;
        const previous = turn.observedUsage;
        turn.observedUsage = {
          usageScope: "main_agent",
          usageStatus: "partial",
          hasSubagents: [...context.items.values()].some(
            (item) => item.turnId === turn.id && item.kind === "subagent",
          ),
          inputTokens: (previous?.inputTokens ?? 0) + usage.promptTokens,
          outputTokens: (previous?.outputTokens ?? 0) + usage.usage.outputTokens,
          cachedInputTokens:
            (previous?.cachedInputTokens ?? 0) +
            (usage.usage.cacheReadTokens ?? usage.usage.cachedTokens),
          reasoningTokens: (previous?.reasoningTokens ?? 0) + usage.usage.reasoningTokens,
          ...(usage.usage.cacheWriteTokens !== undefined ||
          previous?.cacheCreationTokens !== undefined
            ? {
                cacheCreationTokens:
                  (previous?.cacheCreationTokens ?? 0) + (usage.usage.cacheWriteTokens ?? 0),
              }
            : {}),
        };
        break;
      }
      case "session/contextUsage": {
        const usage = decodeContextUsage(params);
        emit(context, {
          type: "thread.token-usage.updated",
          payload: {
            usage: {
              usedTokens: usage.usedTokens,
              ...(usage.windowTokens !== undefined ? { maxTokens: usage.windowTokens } : {}),
            },
          },
          raw,
        });
        break;
      }
      case "session/todoListChanged": {
        const todo = decodeTodoList(params);
        if (!context.active) break;
        emit(context, {
          type: "turn.plan.updated",
          payload: {
            plan: todo.items
              .filter((item) => item.text.trim() && item.status !== "cancelled")
              .map((item) => ({
                step: item.text.trim(),
                status:
                  item.status === "completed"
                    ? "completed"
                    : item.status === "inProgress"
                      ? "inProgress"
                      : "pending",
              })),
          },
          raw,
        });
        break;
      }
      case "view/gap":
        throw new Error(
          "Muse's event stream lost updates. Resume this thread to restore its durable history.",
        );
    }
  };

  const getContext = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    if (!context || context.stopped)
      throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
    return context;
  };
  const asRequest = <A>(method: string, run: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        isSessionNotFoundError(cause) || isValidationError(cause)
          ? cause
          : new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: describeError(cause),
              cause,
            }),
    });
  const invalid = (operation: string, issue: string) =>
    new ProviderAdapterValidationError({ provider: PROVIDER, operation, issue });
  const withThreadLock = <A, E, R>(threadId: ThreadId, operation: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const lock = locks.get(threadId) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
      locks.set(threadId, lock);
      lock.users++;
      return lock.semaphore.withPermit(operation).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            // Queued operations count as users, so a new caller cannot bypass their lock.
            if (--lock.users === 0) locks.delete(threadId);
          }),
        ),
      );
    });

  const stopSession = (threadId: ThreadId) =>
    asRequest("stopSession", async () => {
      const context = sessions.get(threadId);
      if (!context) return;
      // Closing the owned host drains/cancels its in-flight commands and all pending requests.
      await closeContext(context, "Muse session stopped.");
    });

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    startSession: (input) =>
      withThreadLock(
        input.threadId,
        asRequest("startSession", async (signal) => {
          if (disposed) throw invalid("startSession", "Muse adapter has been stopped.");
          const previous = sessions.get(input.threadId);
          if (previous) await closeContext(previous, "Muse session restarted.");
          const resume =
            input.resumeCursor === undefined ? undefined : decodeResume(input.resumeCursor);
          const modelSelection =
            input.modelSelection?.instanceId === instanceId ? input.modelSelection : undefined;
          const model = modelSelection?.model || DEFAULT_MODEL;
          const host = await createHost({
            binaryPath: settings.binaryPath,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(options?.environment ? { environment: options.environment } : {}),
            runtimeMode: input.runtimeMode,
            signal,
          });
          if (disposed || signal.aborted) {
            await host.close();
            throw invalid("startSession", "Muse adapter was stopped during initialization.");
          }
          const now = nowIso();
          let releaseNotifications = () => {};
          const notificationsReady = new Promise<void>((resolve) => {
            releaseNotifications = resolve;
          });
          const context: SessionContext = {
            host,
            nativeSessionId: resume?.sessionId ?? mintId(),
            session: {
              provider: PROVIDER,
              providerInstanceId: instanceId,
              threadId: input.threadId,
              runtimeMode: input.runtimeMode,
              status: "connecting",
              model,
              ...(input.cwd ? { cwd: input.cwd } : {}),
              createdAt: now,
              updatedAt: now,
            },
            items: new Map(),
            approvals: new Map(),
            openedApprovals: new Set(),
            questions: new Map(),
            turns: new Set(),
            active: undefined,
            stopped: false,
            closing: undefined,
            // Resume can reissue pending requests before history loading finishes.
            // Process that suffix only after the active turn has been restored.
            notificationTail: notificationsReady,
            reasoningEffort:
              getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ?? "medium",
          };
          sessions.set(input.threadId, context);
          const fail = (error: unknown) => {
            void closeContext(context, describeError(error), true).catch(() => {});
          };
          host.connection.onNotification((notification) => {
            context.notificationTail = context.notificationTail
              .then(async () => {
                await writeNativeEvent(input.threadId, notification);
                await handleNotification(context, notification);
              })
              .catch(fail);
          });
          host.connection.onServerRequest(async (request) => {
            await writeNativeEvent(input.threadId, request);
            throw new Error(`Unsupported Muse server request: ${request.method}`);
          });
          host.connection.onProtocolError(fail);
          void host.connection.closed.then(() => {
            if (!context.stopped) fail(new Error("Muse SDK connection closed unexpectedly."));
          });
          void host.exited.then((exit) => {
            if (!context.stopped)
              fail(new Error(`Muse process exited (${exit.code ?? exit.signal}).`));
          }, fail);
          try {
            const result = decodeSessionResult(
              await command(
                context,
                resume ? "session/resume" : "session/start",
                resume
                  ? { history: "inline" }
                  : {
                      ...(input.cwd ? { workspaceRoot: input.cwd } : {}),
                      modelId: model,
                      providerId: "meta",
                      approvalMode: museApprovalMode(input.runtimeMode),
                    },
              ),
            );
            context.nativeSessionId = result.session.sessionId;
            if (resume) {
              await loadHistory(context, result);
              if (result.session.activeTurnId)
                beginTurn(context, TurnId.make(result.session.activeTurnId));
              const active = context.active;
              if (active) {
                for (const item of context.items.values()) {
                  if (item.turnId !== active.id) continue;
                  if (item.text !== undefined)
                    active.surfaces.set(`${item.itemId}:text`, item.text);
                  if (item.visibleOutput !== undefined)
                    active.surfaces.set(`${item.itemId}:output`, item.visibleOutput);
                  item.summary?.forEach((text, index) =>
                    active.surfaces.set(`${item.itemId}:summary.${index}`, text),
                  );
                  if (item.status !== "inProgress") active.completedItems.add(item.itemId);
                }
              }
              await command(context, "session/setApprovalMode", {
                mode: museApprovalMode(input.runtimeMode),
              });
              if (result.session.modelId !== model)
                await command(context, "session/setModel", {
                  model: { modelId: model, providerId: "meta" },
                });
            }
            if (disposed || context.stopped || signal.aborted)
              throw invalid("startSession", "Muse session was stopped during initialization.");
            const cursor = { sessionId: context.nativeSessionId };
            context.session = {
              ...context.session,
              resumeCursor: cursor,
              status: context.active ? "running" : "ready",
              updatedAt: nowIso(),
            };
            emit(context, { type: "session.started", payload: { resume: cursor } });
            emit(context, {
              type: "thread.started",
              payload: { providerThreadId: context.nativeSessionId },
            });
            emit(context, {
              type: "session.state.changed",
              payload: { state: context.active ? "running" : "ready" },
            });
            return context.session;
          } catch (error) {
            await closeContext(context, describeError(error), true);
            throw error;
          } finally {
            releaseNotifications();
          }
        }),
      ),
    sendTurn: (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const parts: Array<
            | { type: "text"; text: string }
            | { type: "image"; base64Data: string; mediaType: string }
          > = [];
          if (input.input) parts.push({ type: "text", text: input.input });
          for (const attachment of input.attachments ?? []) {
            if (attachment.type !== "image") continue;
            const path = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!path) return yield* invalid("sendTurn", "Invalid image attachment path.");
            const bytes = yield* fileSystem.readFile(path).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "readAttachment",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            parts.push({
              type: "image",
              base64Data: Buffer.from(bytes).toString("base64"),
              mediaType: attachment.mimeType,
            });
          }
          return yield* asRequest("sendTurn", async () => {
            if (!parts.length)
              throw invalid("sendTurn", "Muse needs text or an image to start a turn.");
            if (input.interactionMode === "plan")
              throw invalid("sendTurn", "Muse SDK does not expose a dedicated plan mode.");
            const context = getContext(input.threadId);
            await context.notificationTail;
            const modelSelection =
              input.modelSelection?.instanceId === instanceId ? input.modelSelection : undefined;
            const effort =
              getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
              context.reasoningEffort;
            if (effort && !SUPPORTED_EFFORTS.has(effort))
              throw invalid("sendTurn", `Muse SDK does not support '${effort}' reasoning effort.`);
            const model = modelSelection?.model;
            if (model && model !== context.session.model) {
              await command(context, "session/setModel", {
                model: { modelId: model, providerId: "meta" },
              });
              context.session = { ...context.session, model };
            }
            const commandId = context.host.connection.mintCommandId();
            context.reasoningEffort = effort;
            const started = context.active === undefined;
            if (started) {
              beginTurn(context, TurnId.make(commandId), effort);
            }
            const turnId = context.active!.id;
            try {
              const result = decodeTurnStart(
                await command(
                  context,
                  "turn/start",
                  {
                    input: [
                      {
                        type: "text",
                        text: buildRuntimeInstructions({
                          harness: "Muse Code",
                          model: context.session.model,
                          reasoningEffort: effort,
                        }),
                      },
                      ...parts,
                    ],
                    displayText: input.input?.trim() ? input.input : "Image attachment",
                    ifBusy: "steer",
                    ...(effort ? { reasoningEffort: effort } : {}),
                  },
                  commandId,
                ),
              );
              if (started && result.turnId !== turnId)
                throw new Error("Muse returned an unexpected fresh-turn identity.");
              // A steering submit can become a fresh turn if its predecessor finishes
              // before admission. The native ack owns that identity; turn/started owns
              // its lifecycle, including notifications that arrived before this ack.
              return {
                threadId: input.threadId,
                turnId: TurnId.make(result.turnId),
                resumeCursor: context.session.resumeCursor,
              };
            } catch (error) {
              if (started) finishTurn(context, "failed", describeError(error));
              throw error;
            }
          });
        }),
      ),
    interruptTurn: (threadId, turnId) =>
      asRequest("interruptTurn", async () => {
        const context = getContext(threadId);
        const turn = context.active;
        if (!turn) return;
        if (turnId && turnId !== turn.id)
          throw invalid("interruptTurn", "The requested Muse turn is no longer active.");
        await command(context, "turn/interrupt", { turnId: turn.id });
        await bounded(context, "turn/interrupt completion", turn.done);
      }),
    respondToRequest: (threadId, requestId, decision) =>
      asRequest("respondToRequest", async () => {
        const context = getContext(threadId);
        const approval = context.approvals.get(requestId);
        if (!approval)
          throw invalid("respondToRequest", "This Muse approval is no longer pending.");
        const choice = museApprovalChoices(approval).get(decision);
        if (!choice)
          throw invalid(
            "respondToRequest",
            `Muse does not offer the '${decision}' decision for this approval.`,
          );
        await command(context, "approval/decide", {
          approvalId: approval.approvalId,
          requirementId: approval.currentRequirementId,
          choiceId: choice.choiceId,
        });
      }),
    respondToUserInput: (threadId, requestId, answers) =>
      asRequest("respondToUserInput", async () => {
        const context = getContext(threadId);
        const request = context.questions.get(requestId);
        if (!request)
          throw invalid("respondToUserInput", "This Muse question is no longer pending.");
        const nativeAnswers = request.questions.map((question) => {
          const rawAnswer = answers[question.id];
          const values = decodeAnswer(rawAnswer);
          const labels = typeof values === "string" ? [values] : values;
          const selected = labels.filter((label) =>
            question.options.some((option) => option.label === label),
          );
          const freeText = labels.filter((label) => !selected.includes(label)).join("\n");
          if (freeText.length > 500)
            throw invalid(
              "respondToUserInput",
              "Muse accepts at most 500 characters of custom answer text.",
            );
          if (question.selection.mode === "single" && selected.length > 1)
            throw invalid(
              "respondToUserInput",
              "Muse requires a single selection for this question.",
            );
          if (selected.length === 0) {
            if (!freeText)
              throw invalid("respondToUserInput", "Muse requires an answer to every question.");
            return { questionId: question.id, freeText };
          }
          if (
            question.selection.minSelections !== undefined &&
            selected.length < question.selection.minSelections
          )
            throw invalid("respondToUserInput", "Too few options selected for this Muse question.");
          if (
            question.selection.maxSelections !== undefined &&
            selected.length > question.selection.maxSelections
          )
            throw invalid(
              "respondToUserInput",
              "Too many options selected for this Muse question.",
            );
          return {
            questionId: question.id,
            ...(question.selection.mode === "multiple"
              ? { selectedLabels: selected }
              : { selectedLabel: selected[0]! }),
            ...(freeText ? { note: freeText } : {}),
          };
        });
        await command(context, "userInput/answer", {
          userInputId: request.userInputId,
          answers: nativeAnswers,
        });
      }),
    compaction: {
      type: "native",
      start: (threadId) =>
        asRequest("compactThread", async () => {
          const context = getContext(threadId);
          const result = decodeCompactResult(await command(context, "session/compact", {}));
          if (result.status === "noop")
            emit(context, {
              type: "runtime.error",
              payload: { message: result.reason || "Muse has no context to compact." },
            });
        }),
    },
    stopSession,
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.values()]
          .filter((context) => !context.stopped)
          .map((context) => ({ ...context.session })),
      ),
    hasSession: (threadId) =>
      Effect.sync(() => Boolean(sessions.get(threadId) && !sessions.get(threadId)!.stopped)),
    readThread: (threadId) =>
      asRequest("readThread", async () => {
        const context = getContext(threadId);
        const result = decodeSessionResult(
          await bounded(
            context,
            "session/read",
            context.host.connection.request("session/read", {
              sessionId: context.nativeSessionId,
              excludeItems: false,
            }),
          ),
        );
        await loadHistory(context, result);
        return {
          threadId,
          turns: [...context.turns].map((id) => ({
            id,
            items: [...context.items.values()].filter((item) => item.turnId === id),
          })),
        };
      }),
    rollbackThread: () =>
      Effect.fail(invalid("rollbackThread", "Muse SDK does not support conversation rollback.")),
    stopAll: () =>
      Effect.forEach([...sessions.keys()], stopSession, {
        concurrency: "unbounded",
        discard: true,
      }),
    streamEvents: Stream.fromQueue(events),
  };
  yield* Effect.addFinalizer(() => {
    disposed = true;
    return adapter.stopAll().pipe(
      Effect.catch((cause) => Effect.logWarning("Failed to close a Muse SDK host", cause)),
      Effect.ensuring(Queue.shutdown(events)),
    );
  });
  return adapter;
});
