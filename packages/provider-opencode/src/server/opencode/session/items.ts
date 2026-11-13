/**
 * OpenCode turn item projection: session/thread updates, text, reasoning and todo items.
 */
import type {
  Event as OpenCodeEvent,
  Message as OpenCodeMessage,
  Part as OpenCodePart,
  PermissionRequest,
  PermissionRuleset,
  QuestionRequest,
  Session as OpenCodeSession,
  Todo as OpenCodeTodo,
  ToolPart,
} from "@opencode-ai/sdk/v2";
import {
  defaultInstanceIdForDriver,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type PlanId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRequestKind,
  type ProviderSessionId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  providerRef,
} from "../projection.ts";
import {
  dateTimeFromEpoch,
} from "../protocol.ts";
import {
  OPENCODE_PROVIDER,
} from "../provider.ts";
import type {
  ActiveOpenCodeTurn,
  OpenCodeThreadState,
} from "../types.ts";
import type { State } from "./base.ts";

export const makeItems = (deps: State) => {
  const {
    idAllocator,
    now,
    emitProviderEvent,
  } = deps;
  const m = deps.mutable;
  const updateProviderSession =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (
      status: OrchestrationV2ProviderSession["status"],
      lastError: string | null = m.sessionEntity.lastError,
    ) {
      const updatedAt = yield* DateTime.now;
      m.sessionEntity = { ...m.sessionEntity, status, lastError, updatedAt };
      yield* emitProviderEvent({
        type: "provider_session.updated",
        driver: OPENCODE_PROVIDER,
        providerSession: m.sessionEntity,
      });
    });

  const updateProviderThread =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (
      state: OpenCodeThreadState,
      patch: Partial<OrchestrationV2ProviderThread>,
    ) {
      const updatedAt = yield* DateTime.now;
      state.providerThread = { ...state.providerThread, ...patch, updatedAt };
      yield* emitProviderEvent({
        type: "provider_thread.updated",
        driver: OPENCODE_PROVIDER,
        providerThread: state.providerThread,
      });
    });

  const itemOrdinal = (turn: ActiveOpenCodeTurn, nativeItemId: string): number => {
    const existing = turn.itemOrdinals.get(nativeItemId);
    if (existing !== undefined) return existing;
    const ordinal = turn.nextItemOrdinal++;
    turn.itemOrdinals.set(nativeItemId, ordinal);
    return ordinal;
  };

  const emitProviderTurn = (
    state: OpenCodeThreadState,
    turn: ActiveOpenCodeTurn,
    status: OrchestrationV2ProviderTurn["status"],
    completedAt: DateTime.Utc | null,
  ) => {
    const providerTurn: OrchestrationV2ProviderTurn = {
      ...turn.providerTurn,
      nativeTurnRef:
        turn.nativeUserMessageId === null
          ? turn.providerTurn.nativeTurnRef
          : providerRef(turn.nativeUserMessageId, "weak"),
      status,
      completedAt,
      ...(completedAt === null
        ? {}
        : {
            turnTokenUsage:
              turn.usage.partIds.size === 0
                ? {
                    usageScope: "main_agent" as const,
                    usageStatus: "unavailable" as const,
                    hasSubagents: turn.usage.hasSubagents,
                  }
                : {
                    usageScope: "main_agent" as const,
                    usageStatus:
                      status === "completed" &&
                      turn.usage.complete &&
                      turn.usage.unresolvedStepsByMessageId.size === 0
                        ? ("complete" as const)
                        : ("partial" as const),
                    inputTokens: turn.usage.inputTokens,
                    cachedInputTokens: turn.usage.cachedInputTokens,
                    cacheCreationTokens: turn.usage.cacheCreationTokens,
                    outputTokens: turn.usage.outputTokens,
                    reasoningTokens: turn.usage.reasoningTokens,
                    hasSubagents: turn.usage.hasSubagents,
                  },
          }),
    };
    Object.assign(turn.providerTurn, providerTurn);
    state.providerTurns.set(String(providerTurn.id), providerTurn);
    return emitProviderEvent({
      type: "provider_turn.updated",
      driver: OPENCODE_PROVIDER,
      threadId: turn.threadId,
      providerTurn,
    });
  };

  const emitTextPart = Effect.fnUntraced(function* (
    state: OpenCodeThreadState,
    turn: ActiveOpenCodeTurn,
    part: Extract<OpenCodePart, { type: "text" | "reasoning" }>,
    forceCompleted = false,
  ) {
    if (part.type === "text" && (part.ignored === true || part.synthetic === true)) return;
    if (part.text.length === 0) return;
    const emittedAt = yield* DateTime.now;
    const isCompleted = forceCompleted || part.time?.end !== undefined;
    const startedAt = dateTimeFromEpoch(part.time?.start, emittedAt);
    const completedAt = isCompleted ? dateTimeFromEpoch(part.time?.end, emittedAt) : null;
    const nativeItemRef = providerRef(part.id);
    const nodeId = idAllocator.derive.nodeFromProviderItem({
      driver: OPENCODE_PROVIDER,
      nativeItemId: part.id,
    });
    const turnItemId = idAllocator.derive.turnItemFromProviderItem({
      driver: OPENCODE_PROVIDER,
      nativeItemId: part.id,
    });
    const ordinal = itemOrdinal(turn, part.id);
    yield* emitProviderEvent({
      type: "node.updated",
      driver: OPENCODE_PROVIDER,
      node: {
        id: nodeId,
        threadId: turn.threadId,
        runId: turn.runId,
        parentNodeId: turn.rootNodeId,
        rootNodeId: turn.rootNodeId,
        kind: part.type === "text" ? "assistant_message" : "reasoning",
        status: isCompleted ? "completed" : "running",
        countsForRun: false,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurnId,
        nativeItemRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt,
        completedAt,
      },
    });
    if (part.type === "text") {
      const messageId = idAllocator.derive.messageFromProviderItem({
        driver: OPENCODE_PROVIDER,
        nativeItemId: part.id,
      });
      const message: OrchestrationV2ConversationMessage = {
        createdBy: "agent",
        creationSource: "provider",
        id: messageId,
        threadId: turn.threadId,
        runId: turn.runId,
        nodeId,
        role: "assistant",
        text: part.text,
        attachments: [],
        streaming: !isCompleted,
        createdAt: startedAt,
        updatedAt: emittedAt,
      };
      yield* emitProviderEvent({
        type: "message.updated",
        driver: OPENCODE_PROVIDER,
        message,
      });
      yield* emitProviderEvent({
        type: "turn_item.updated",
        driver: OPENCODE_PROVIDER,
        turnItem: {
          id: turnItemId,
          threadId: turn.threadId,
          runId: turn.runId,
          nodeId,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurnId,
          nativeItemRef,
          parentItemId: null,
          ordinal,
          status: isCompleted ? "completed" : "running",
          title: null,
          startedAt,
          completedAt,
          updatedAt: emittedAt,
          type: "assistant_message",
          messageId,
          text: part.text,
          streaming: !isCompleted,
        },
      });
      return;
    }
    yield* emitProviderEvent({
      type: "turn_item.updated",
      driver: OPENCODE_PROVIDER,
      turnItem: {
        id: turnItemId,
        threadId: turn.threadId,
        runId: turn.runId,
        nodeId,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurnId,
        nativeItemRef,
        parentItemId: null,
        ordinal,
        status: isCompleted ? "completed" : "running",
        title: null,
        startedAt,
        completedAt,
        updatedAt: emittedAt,
        type: "reasoning",
        text: part.text,
        streaming: !isCompleted,
      },
    });
  });

  const emitTodo = Effect.fnUntraced(function* (
    state: OpenCodeThreadState,
    turn: ActiveOpenCodeTurn,
    todos: ReadonlyArray<OpenCodeTodo>,
  ) {
    const now = yield* DateTime.now;
    if (turn.planId === null) {
      turn.planId = yield* idAllocator.allocate.plan({
        threadId: turn.threadId,
        ...(turn.runId === null ? {} : { runId: turn.runId }),
        driver: OPENCODE_PROVIDER,
      });
    }
    const planId = turn.planId;
    const nativeItemId = `${state.nativeSessionId}:todo:${turn.providerTurnId}`;
    const nodeId = idAllocator.derive.nodeFromProviderItem({
      driver: OPENCODE_PROVIDER,
      nativeItemId,
    });
    const turnItemId = idAllocator.derive.turnItemFromProviderItem({
      driver: OPENCODE_PROVIDER,
      nativeItemId,
    });
    // A cancelled todo is not outstanding work, and plan steps have no
    // cancelled status, so drop it rather than show it as pending.
    const steps: Array<OrchestrationV2PlanStep> = todos.flatMap((todo, index) =>
      todo.status === "cancelled"
        ? []
        : [
            {
              id: `${nativeItemId}:${index + 1}`,
              text: todo.content.trim() || `Todo ${index + 1}`,
              status:
                todo.status === "completed"
                  ? "completed"
                  : todo.status === "in_progress"
                    ? "running"
                    : "pending",
            },
          ],
    );
    const completed = todos.length > 0 && steps.every((step) => step.status === "completed");
    yield* emitProviderEvent({
      type: "node.updated",
      driver: OPENCODE_PROVIDER,
      node: {
        id: nodeId,
        threadId: turn.threadId,
        runId: turn.runId,
        parentNodeId: turn.rootNodeId,
        rootNodeId: turn.rootNodeId,
        kind: "todo_list",
        status: completed ? "completed" : "running",
        countsForRun: false,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurnId,
        nativeItemRef: providerRef(nativeItemId, "weak"),
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: turn.startedAt,
        completedAt: completed ? now : null,
      },
    });
    yield* emitProviderEvent({
      type: "plan.updated",
      driver: OPENCODE_PROVIDER,
      plan: {
        id: planId,
        threadId: turn.threadId,
        runId: turn.runId,
        nodeId,
        status: completed ? "completed" : "active",
        kind: "todo_list",
        steps,
      },
    });
    yield* emitProviderEvent({
      type: "turn_item.updated",
      driver: OPENCODE_PROVIDER,
      turnItem: {
        id: turnItemId,
        threadId: turn.threadId,
        runId: turn.runId,
        nodeId,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurnId,
        nativeItemRef: providerRef(nativeItemId, "weak"),
        parentItemId: null,
        ordinal: itemOrdinal(turn, nativeItemId),
        status: completed ? "completed" : "running",
        title: "Todo list",
        startedAt: turn.startedAt,
        completedAt: completed ? now : null,
        updatedAt: now,
        type: "todo_list",
        planId,
        steps,
      },
    });
  });

  return { updateProviderSession, updateProviderThread, itemOrdinal, emitProviderTurn, emitTextPart, emitTodo };
};

export type Items = ReturnType<typeof makeItems>;
