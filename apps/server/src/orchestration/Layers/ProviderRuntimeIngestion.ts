import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  CommandId,
  MessageId,
  type OrchestrationEvent,
  CheckpointRef,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { Cache, Cause, Duration, Effect, Layer, Option, Queue, Ref, Stream } from "effect";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { isGitRepository } from "../../git/isRepo.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${crypto.randomUUID()}`);

const DEFAULT_ASSISTANT_DELIVERY_MODE: AssistantDeliveryMode = "buffered";
const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    };

type AssistantSegmentState = {
  baseMessageId: MessageId;
  currentSegmentIndex: number | null;
  nextSegmentIndex: number;
};

const assistantSegmentStateKey = (threadId: ThreadId, baseMessageId: MessageId) =>
  `${threadId}:${baseMessageId}`;

const assistantSegmentMessageId = (baseMessageId: MessageId, segmentIndex: number): MessageId =>
  segmentIndex === 0
    ? baseMessageId
    : MessageId.makeUnsafe(`${baseMessageId}:segment:${segmentIndex}`);

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.makeUnsafe(String(value));
}

function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.makeUnsafe(value);
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function normalizeProposedPlanMarkdown(planMarkdown: string | undefined): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function runtimePayloadRecord(event: ProviderRuntimeEvent): Record<string, unknown> | undefined {
  const payload = (event as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  return payload as Record<string, unknown>;
}

function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

function runtimeTurnState(
  event: ProviderRuntimeEvent,
): "completed" | "failed" | "interrupted" | "cancelled" {
  const payloadState = asString(runtimePayloadRecord(event)?.state);
  return normalizeRuntimeTurnState(payloadState);
}

function runtimeTurnErrorMessage(event: ProviderRuntimeEvent): string | undefined {
  const payloadErrorMessage = asString(runtimePayloadRecord(event)?.errorMessage);
  return payloadErrorMessage;
}

function runtimeErrorMessageFromEvent(event: ProviderRuntimeEvent): string | undefined {
  const payloadMessage = asString(runtimePayloadRecord(event)?.message);
  return payloadMessage;
}

function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return undefined;
  }
}

function isToolLifecycleItemType(itemType: string): boolean {
  return (
    itemType === "command_execution" ||
    itemType === "file_change" ||
    itemType === "mcp_tool_call" ||
    itemType === "dynamic_tool_call" ||
    itemType === "collab_agent_tool_call" ||
    itemType === "web_search" ||
    itemType === "image_view"
  );
}

function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();
  switch (event.type) {
    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            requestKind === "command"
              ? "Command approval requested"
              : requestKind === "file-read"
                ? "File-read approval requested"
              : requestKind === "file-change"
                ? "File-change approval requested"
                : "Approval requested",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      const message = runtimeErrorMessageFromEvent(event);
      if (!message) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(message),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          summary: "Runtime warning",
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.plan.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined ? { explanation: event.payload.explanation } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description ? { detail: truncateDetail(event.payload.description) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            taskId: event.payload.taskId,
            detail: truncateDetail(event.payload.description),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(event.payload.summary ? { detail: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.completed": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: `${event.payload.title ?? "Tool"} complete`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.started": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  return [];
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;

  const assistantDeliveryModeRef = yield* Ref.make<AssistantDeliveryMode>(
    DEFAULT_ASSISTANT_DELIVERY_MODE,
  );

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<
    MessageId,
    { text: string; createdAt: string }
  >({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  const assistantMessageSawDeltaByMessageId = yield* Cache.make<MessageId, boolean>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(false),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  const assistantSegmentStateByKey = new Map<string, AssistantSegmentState>();
  const assistantSegmentKeysByTurnKey = new Map<string, Set<string>>();

  const isGitRepoForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return false;
    }
    const workspaceCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    if (!workspaceCwd) {
      return false;
    }
    return isGitRepository(workspaceCwd);
  });

  const rememberAssistantMessageId = (
    threadId: ThreadId,
    turnId: TurnId,
    messageId: MessageId,
  ) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (
    threadId: ThreadId,
    turnId: TurnId,
    messageId: MessageId,
  ) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const appendBufferedAssistantText = (messageId: MessageId, delta: string, createdAt: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existing) =>
        Effect.gen(function* () {
          const prev = Option.getOrUndefined(existing);
          const nextText = `${prev?.text ?? ""}${delta}`;
          const nextCreatedAt =
            prev?.createdAt && prev.createdAt.length > 0 ? prev.createdAt : createdAt;
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, {
              text: nextText,
              createdAt: nextCreatedAt,
            });
            return { spillChunk: "", createdAt: nextCreatedAt };
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return { spillChunk: nextText, createdAt: nextCreatedAt };
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existing) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(
            Option.match(existing, {
              onNone: () => ({ text: "", createdAt: "" }),
              onSome: (entry) => entry,
            }),
          ),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const markAssistantMessageSawDelta = (messageId: MessageId) =>
    Cache.set(assistantMessageSawDeltaByMessageId, messageId, true);

  const takeAssistantMessageSawDelta = (messageId: MessageId) =>
    Cache.getOption(assistantMessageSawDeltaByMessageId, messageId).pipe(
      Effect.flatMap((existing) =>
        Cache.invalidate(assistantMessageSawDeltaByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existing, () => false)),
        ),
      ),
    );

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt: existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const takeBufferedProposedPlan = (planId: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedProposedPlanById, planId).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const rememberAssistantSegmentKeyForTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    stateKey: string,
  ): void => {
    const turnKey = providerTurnKey(threadId, turnId);
    const existing = assistantSegmentKeysByTurnKey.get(turnKey);
    if (existing) {
      existing.add(stateKey);
      return;
    }
    assistantSegmentKeysByTurnKey.set(turnKey, new Set([stateKey]));
  };

  const clearAssistantSegmentsForTurn = (threadId: ThreadId, turnId: TurnId): void => {
    const turnKey = providerTurnKey(threadId, turnId);
    const stateKeys = assistantSegmentKeysByTurnKey.get(turnKey);
    if (!stateKeys) {
      return;
    }
    for (const stateKey of stateKeys) {
      assistantSegmentStateByKey.delete(stateKey);
    }
    assistantSegmentKeysByTurnKey.delete(turnKey);
  };

  const clearAssistantSegment = (input: {
    threadId: ThreadId;
    baseMessageId: MessageId;
    turnId?: TurnId;
  }): void => {
    const stateKey = assistantSegmentStateKey(input.threadId, input.baseMessageId);
    assistantSegmentStateByKey.delete(stateKey);
    if (!input.turnId) {
      return;
    }
    const turnKey = providerTurnKey(input.threadId, input.turnId);
    const stateKeys = assistantSegmentKeysByTurnKey.get(turnKey);
    if (!stateKeys) {
      return;
    }
    stateKeys.delete(stateKey);
    if (stateKeys.size === 0) {
      assistantSegmentKeysByTurnKey.delete(turnKey);
    }
  };

  const clearAssistantSegmentsForThread = (threadId: ThreadId): void => {
    const prefix = `${threadId}:`;
    for (const key of assistantSegmentKeysByTurnKey.keys()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const stateKeys = assistantSegmentKeysByTurnKey.get(key);
      if (stateKeys) {
        for (const stateKey of stateKeys) {
          assistantSegmentStateByKey.delete(stateKey);
        }
      }
      assistantSegmentKeysByTurnKey.delete(key);
    }
  };

  const openAssistantSegment = (input: {
    threadId: ThreadId;
    baseMessageId: MessageId;
    turnId?: TurnId;
  }): MessageId => {
    const stateKey = assistantSegmentStateKey(input.threadId, input.baseMessageId);
    const existingState = assistantSegmentStateByKey.get(stateKey);
    if (existingState && existingState.currentSegmentIndex !== null) {
      if (input.turnId) {
        rememberAssistantSegmentKeyForTurn(input.threadId, input.turnId, stateKey);
      }
      return assistantSegmentMessageId(existingState.baseMessageId, existingState.currentSegmentIndex);
    }

    const segmentIndex = existingState?.nextSegmentIndex ?? 0;
    assistantSegmentStateByKey.set(stateKey, {
      baseMessageId: input.baseMessageId,
      currentSegmentIndex: segmentIndex,
      nextSegmentIndex: segmentIndex + 1,
    });
    if (input.turnId) {
      rememberAssistantSegmentKeyForTurn(input.threadId, input.turnId, stateKey);
    }
    return assistantSegmentMessageId(input.baseMessageId, segmentIndex);
  };

  const takeOpenAssistantSegmentMessageId = (input: {
    threadId: ThreadId;
    baseMessageId: MessageId;
  }): { messageId: MessageId; hadAnySegment: boolean } | null => {
    const stateKey = assistantSegmentStateKey(input.threadId, input.baseMessageId);
    const state = assistantSegmentStateByKey.get(stateKey);
    if (!state) {
      return { messageId: input.baseMessageId, hadAnySegment: false };
    }
    if (state.currentSegmentIndex === null) {
      return state.nextSegmentIndex > 0 ? null : { messageId: input.baseMessageId, hadAnySegment: false };
    }
    return {
      messageId: assistantSegmentMessageId(state.baseMessageId, state.currentSegmentIndex),
      hadAnySegment: state.nextSegmentIndex > 0,
    };
  };

  const closeOpenAssistantSegmentsForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    existingAssistantMessageById: ReadonlyMap<
      MessageId,
      { readonly id: MessageId; readonly text: string; readonly streaming: boolean }
    >;
  }) =>
    Effect.gen(function* () {
      const turnKey = providerTurnKey(input.threadId, input.turnId);
      const stateKeys = Array.from(assistantSegmentKeysByTurnKey.get(turnKey) ?? []);
      yield* Effect.forEach(
        stateKeys,
        (stateKey) =>
          Effect.gen(function* () {
            const state = assistantSegmentStateByKey.get(stateKey);
            if (!state || state.currentSegmentIndex === null) {
              return;
            }
            const messageId = assistantSegmentMessageId(state.baseMessageId, state.currentSegmentIndex);
            assistantSegmentStateByKey.set(stateKey, {
              ...state,
              currentSegmentIndex: null,
            });
            yield* finalizeAssistantMessage({
              event: input.event,
              threadId: input.threadId,
              messageId,
              turnId: input.turnId,
              createdAt: input.createdAt,
              commandTag: "assistant-complete-tool-boundary",
              finalDeltaCommandTag: "assistant-delta-tool-boundary",
              existingMessage: input.existingAssistantMessageById.get(messageId),
            });
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    });

  const clearAssistantMessageState = (messageId: MessageId) =>
    Effect.all([
      clearBufferedAssistantText(messageId),
      Cache.invalidate(assistantMessageSawDeltaByMessageId, messageId),
    ]).pipe(Effect.asVoid);

  const finalizeAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
    existingMessage?: {
      readonly id: MessageId;
      readonly text: string;
      readonly streaming: boolean;
    } | undefined;
  }) =>
    Effect.gen(function* () {
      if (input.existingMessage && !input.existingMessage.streaming) {
        yield* clearAssistantMessageState(input.messageId);
        return;
      }

      const buffered = yield* takeBufferedAssistantText(input.messageId);
      const bufferedText = buffered.text;

      const sawDelta = yield* takeAssistantMessageSawDelta(input.messageId);
      const text =
        bufferedText.length > 0
          ? bufferedText
          : !sawDelta && (input.fallbackText?.trim().length ?? 0) > 0
            ? input.fallbackText!
            : "";

      if (text.length === 0 && !input.existingMessage) {
        yield* clearAssistantMessageState(input.messageId);
        return;
      }

      // Use the original timestamp from when the first delta arrived, not the
      // finalization time.  This ensures assistant text messages are positioned
      // chronologically relative to tool activities in the timeline instead of
      // all appearing at the end when the turn completes.
      const deltaCreatedAt =
        buffered.createdAt.length > 0 ? buffered.createdAt : input.createdAt;

      if (text.length > 0) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: providerCommandId(input.event, input.finalDeltaCommandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          delta: text,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: deltaCreatedAt,
        });
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: providerCommandId(input.event, input.commandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
      yield* clearAssistantMessageState(input.messageId);
    });

  const upsertProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
    }>;
    planId: string;
    turnId?: TurnId;
    planMarkdown: string | undefined;
    createdAt: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const planMarkdown = normalizeProposedPlanMarkdown(input.planMarkdown);
      if (!planMarkdown) {
        return;
      }

      const existingPlan = input.threadProposedPlans.find((entry) => entry.id === input.planId);
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: providerCommandId(input.event, "proposed-plan-upsert"),
        threadId: input.threadId,
        proposedPlan: {
          id: input.planId,
          turnId: input.turnId ?? null,
          planMarkdown,
          createdAt: existingPlan?.createdAt ?? input.createdAt,
          updatedAt: input.updatedAt,
        },
        createdAt: input.updatedAt,
      });
    });

  const finalizeBufferedProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
    }>;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const bufferedPlan = yield* takeBufferedProposedPlan(input.planId);
      const bufferedMarkdown = normalizeProposedPlanMarkdown(bufferedPlan?.text);
      const fallbackMarkdown = normalizeProposedPlanMarkdown(input.fallbackMarkdown);
      const planMarkdown = bufferedMarkdown ?? fallbackMarkdown;
      if (!planMarkdown) {
        return;
      }

      yield* upsertProposedPlan({
        event: input.event,
        threadId: input.threadId,
        threadProposedPlans: input.threadProposedPlans,
        planId: input.planId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        planMarkdown,
        createdAt:
          bufferedPlan?.createdAt && bufferedPlan.createdAt.length > 0
            ? bufferedPlan.createdAt
            : input.updatedAt,
        updatedAt: input.updatedAt,
      });
      yield* clearBufferedProposedPlan(input.planId);
    });

  const clearTurnStateForSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const prefix = `${threadId}:`;
      const proposedPlanPrefix = `plan:${threadId}:`;
      const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
      const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
      yield* Effect.forEach(
        turnKeys,
        (key) =>
          Effect.gen(function* () {
            if (!key.startsWith(prefix)) {
              return;
            }

            const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
            if (Option.isSome(messageIds)) {
              yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
                concurrency: 1,
              }).pipe(Effect.asVoid);
            }

            yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        proposedPlanKeys,
        (key) =>
          key.startsWith(proposedPlanPrefix)
            ? Cache.invalidate(bufferedProposedPlanById, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      clearAssistantSegmentsForThread(threadId);
    });

  // Accumulate token usage from thread.token-usage.updated events so
  // providers like Copilot and Amp (which emit usage separately from
  // turn.completed) still get turn-level usage in the completion summary.
  const pendingTokenUsageByThread = new Map<string, Record<string, unknown>>();

  const processRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      // Accumulate token usage events per thread
      if (event.type === "thread.token-usage.updated") {
        const payload = runtimePayloadRecord(event);
        const raw = payload?.usage;
        if (raw && typeof raw === "object") {
          const prev = pendingTokenUsageByThread.get(event.threadId) ?? {};
          const incoming = raw as Record<string, unknown>;
          // Merge by summing numeric fields
          const merged: Record<string, unknown> = { ...prev };
          for (const [k, v] of Object.entries(incoming)) {
            if (typeof v === "number" && typeof (prev[k] ?? 0) === "number") {
              merged[k] = ((prev[k] as number) ?? 0) + v;
            } else {
              merged[k] = v;
            }
          }
          pendingTokenUsageByThread.set(event.threadId, merged);
        }
      }

      // Clear accumulated usage when a new turn starts
      if (event.type === "turn.started") {
        pendingTokenUsageByThread.delete(event.threadId);
      }

      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === event.threadId);
      if (!thread) return;

      const now = event.createdAt;
      const eventTurnId = toTurnId(event.turnId);
      const activeTurnId = thread.session?.activeTurnId ?? null;

      const existingAssistantMessageById = new Map(
        thread.messages.map((message) => [message.id, message] as const),
      );

      const assistantBaseMessageId =
        event.type === "content.delta" ||
        (event.type === "item.completed" && event.payload.itemType === "assistant_message")
          ? MessageId.makeUnsafe(`assistant:${event.itemId ?? event.turnId ?? event.eventId}`)
          : undefined;

      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;

      const shouldApplyThreadLifecycle = (() => {
        if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
          return true;
        }
        switch (event.type) {
          case "session.exited":
            return true;
          case "session.started":
          case "thread.started":
            return true;
          case "turn.started":
            return !conflictsWithActiveTurn;
          case "turn.completed":
            if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            // If no active turn is tracked, accept completion scoped to this thread.
            return true;
          default:
            return true;
        }
      })();

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed"
      ) {
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : event.type === "turn.completed" || event.type === "session.exited"
              ? null
              : activeTurnId;
        const status = (() => {
          switch (event.type) {
            case "session.state.changed":
              return orchestrationSessionStatusFromRuntimeState(event.payload.state);
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed":
              return runtimeTurnState(event) === "failed" ? "error" : "ready";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active turn; preserve turn-running state in that case.
              return activeTurnId !== null ? "running" : "ready";
          }
        })();
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" && runtimeTurnState(event) === "failed"
              ? (runtimeTurnErrorMessage(event) ?? thread.session?.lastError ?? "Turn failed")
              : status === "ready"
              ? null
              : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle) {
          const turnUsagePayload =
            event.type === "turn.completed" ? runtimePayloadRecord(event) : undefined;
          let turnUsage =
            turnUsagePayload?.usage !== undefined &&
            turnUsagePayload.usage !== null &&
            typeof turnUsagePayload.usage === "object"
              ? (turnUsagePayload.usage as Record<string, unknown>)
              : undefined;

          // Fall back to accumulated thread.token-usage.updated data
          // for providers (Copilot, Amp) that emit usage separately.
          if (!turnUsage && event.type === "turn.completed") {
            const pending = pendingTokenUsageByThread.get(event.threadId);
            if (pending) {
              turnUsage = pending;
            }
          }
          if (event.type === "turn.completed") {
            pendingTokenUsageByThread.delete(event.threadId);
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "thread-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: nextActiveTurnId,
              lastError,
              updatedAt: now,
            },
            ...(turnUsage ? { turnUsage } : {}),
            createdAt: now,
          });
        }
      }

      const isToolLifecycleEvent =
        eventTurnId !== undefined &&
        ((event.type === "item.started" && isToolLifecycleItemType(event.payload.itemType)) ||
          (event.type === "item.updated" && isToolLifecycleItemType(event.payload.itemType)) ||
          (event.type === "item.completed" && isToolLifecycleItemType(event.payload.itemType)));
      if (isToolLifecycleEvent) {
        yield* closeOpenAssistantSegmentsForTurn({
          event,
          threadId: thread.id,
          turnId: eventTurnId,
          createdAt: now,
          existingAssistantMessageById,
        });
      }

      const assistantDelta =
        event.type === "content.delta" && event.payload.streamKind === "assistant_text"
          ? event.payload.delta
          : undefined;
      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      if (assistantDelta && assistantDelta.length > 0) {
        const assistantMessageId = openAssistantSegment({
          threadId: thread.id,
          baseMessageId: assistantBaseMessageId!,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
        });
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }
        yield* markAssistantMessageSawDelta(assistantMessageId);

        const assistantDeliveryMode = yield* Ref.get(assistantDeliveryModeRef);
        if (assistantDeliveryMode === "buffered") {
          const spillResult = yield* appendBufferedAssistantText(
            assistantMessageId,
            assistantDelta,
            now,
          );
          if (spillResult.spillChunk.length > 0) {
            yield* orchestrationEngine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: providerCommandId(event, "assistant-delta-buffer-spill"),
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillResult.spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: spillResult.createdAt,
            });
          }
        } else {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: providerCommandId(event, "assistant-delta"),
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: assistantDelta,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      }

      if (proposedPlanDelta && proposedPlanDelta.length > 0) {
        const planId = proposedPlanIdFromEvent(event, thread.id);
        yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
      }

      const assistantCompletion =
        event.type === "item.completed" && event.payload.itemType === "assistant_message"
          ? (() => {
              const existingAssistantMessage = thread.messages.find(
                (entry) => entry.id === assistantBaseMessageId,
              );
              const shouldApplyFallbackCompletionText =
                !existingAssistantMessage || existingAssistantMessage.text.length === 0;
              return {
                fallbackText: shouldApplyFallbackCompletionText
                  ? event.payload.detail
                  : undefined,
              };
            })()
          : undefined;
      const proposedPlanCompletion =
        event.type === "turn.proposed.completed"
          ? {
              planId: proposedPlanIdFromEvent(event, thread.id),
              turnId: toTurnId(event.turnId),
              planMarkdown: event.payload.planMarkdown,
            }
          : undefined;

      if (assistantCompletion) {
        const turnId = toTurnId(event.turnId);
        const assistantMessageId = assistantBaseMessageId
          ? takeOpenAssistantSegmentMessageId({
              threadId: thread.id,
              baseMessageId: assistantBaseMessageId,
            })?.messageId
          : undefined;
        if (!assistantMessageId) {
          if (assistantBaseMessageId) {
            clearAssistantSegment({
              threadId: thread.id,
              baseMessageId: assistantBaseMessageId,
              ...(turnId ? { turnId } : {}),
            });
          }
        } else if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        if (assistantMessageId) {
          // Upstream fix: avoid duplicating streamed text by checking the resolved
          // segment message, not just the base message, for existing content.
          const existingSegmentMessage =
            existingAssistantMessageById.get(assistantMessageId) ??
            thread.messages.find((entry) => entry.id === assistantMessageId);
          const shouldApplyFallbackCompletionText =
            !existingSegmentMessage || existingSegmentMessage.text.length === 0;

          yield* finalizeAssistantMessage({
            event,
            threadId: thread.id,
            messageId: assistantMessageId,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
            commandTag: "assistant-complete",
            finalDeltaCommandTag: "assistant-delta-finalize",
            ...(assistantCompletion.fallbackText !== undefined && shouldApplyFallbackCompletionText
              ? { fallbackText: assistantCompletion.fallbackText }
              : {}),
            existingMessage: existingAssistantMessageById.get(assistantMessageId),
          });
        }

        if (assistantBaseMessageId) {
          clearAssistantSegment({
            threadId: thread.id,
            baseMessageId: assistantBaseMessageId,
            ...(turnId ? { turnId } : {}),
          });
        }
        if (turnId && assistantMessageId) {
          yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
        }
      }

      if (proposedPlanCompletion) {
        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          threadProposedPlans: thread.proposedPlans,
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
      }

      if (event.type === "turn.completed") {
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
          yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              finalizeAssistantMessage({
                event,
                threadId: thread.id,
                messageId: assistantMessageId,
                turnId,
                createdAt: now,
                commandTag: "assistant-complete-finalize",
                finalDeltaCommandTag: "assistant-delta-finalize-fallback",
                existingMessage: existingAssistantMessageById.get(assistantMessageId),
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          yield* clearAssistantMessageIdsForTurn(thread.id, turnId);
          clearAssistantSegmentsForTurn(thread.id, turnId);

          yield* finalizeBufferedProposedPlan({
            event,
            threadId: thread.id,
            threadProposedPlans: thread.proposedPlans,
            planId: proposedPlanIdForTurn(thread.id, turnId),
            turnId,
            updatedAt: now,
          });
        }
      }

      if (event.type === "session.exited") {
        yield* clearTurnStateForSession(thread.id);
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage = runtimeErrorMessageFromEvent(event) ?? "Provider runtime error";

        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null ||
            eventTurnId === undefined ||
            sameId(activeTurnId, eventTurnId);

        if (shouldApplyRuntimeError) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: eventTurnId ?? null,
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "thread.metadata.updated" && event.payload.name) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: providerCommandId(event, "thread-meta-update"),
          threadId: thread.id,
          title: event.payload.name,
        });
      }

      if (event.type === "turn.diff.updated") {
        const turnId = toTurnId(event.turnId);
        if (turnId && (yield* isGitRepoForThread(thread.id))) {
          const assistantMessageId = MessageId.makeUnsafe(
            `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
          );
          yield* orchestrationEngine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: providerCommandId(event, "thread-turn-diff-complete"),
            threadId: thread.id,
            turnId,
            completedAt: now,
            checkpointRef: CheckpointRef.makeUnsafe(`provider-diff:${event.eventId}`),
            status: "missing",
            files: [],
            assistantMessageId,
            checkpointTurnCount: thread.checkpoints.length + 1,
            createdAt: now,
          });
        }
      }

      const activities = runtimeEventToActivities(event);
      yield* Effect.forEach(activities, (activity) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: providerCommandId(event, "thread-activity-append"),
          threadId: thread.id,
          activity,
          createdAt: activity.createdAt,
        }),
      ).pipe(Effect.asVoid);
    });

  const processDomainEvent = (event: TurnStartRequestedDomainEvent) =>
    Ref.set(
      assistantDeliveryModeRef,
      event.payload.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
    );

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime" ? processRuntimeEvent(input.event) : processDomainEvent(input.event);

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          eventId: input.event.eventId,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const start: ProviderRuntimeIngestionShape["start"] = Effect.gen(function* () {
    const inputQueue = yield* Queue.unbounded<RuntimeIngestionInput>();
    yield* Effect.addFinalizer(() => Queue.shutdown(inputQueue).pipe(Effect.asVoid));

    yield* Effect.forkScoped(
      Effect.forever(Queue.take(inputQueue).pipe(Effect.flatMap(processInputSafely))),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        Queue.offer(inputQueue, { source: "runtime", event }).pipe(Effect.asVoid),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.turn-start-requested") {
          return Effect.void;
        }
        return Queue.offer(inputQueue, { source: "domain", event }).pipe(Effect.asVoid);
      }),
    );
  });

  return {
    start,
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(ProviderRuntimeIngestionService, make);
