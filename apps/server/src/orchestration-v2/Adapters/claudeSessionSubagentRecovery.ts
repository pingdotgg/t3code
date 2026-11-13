// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { text } from "../unknownField.ts";

import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2UserInputQuestion,
  OrchestrationV2TurnItem,
  ProviderApprovalOption,
  ProviderRequestKind,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import * as Ref from "effect/Ref";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { Deps as PrevDeps } from "./claudeSessionSubagentNode.ts";
import { installSubagentNode } from "./claudeSessionSubagentNode.ts";
import { CLAUDE_GOAL_DEFERRING_TASK_TYPES } from "./ClaudeToolClassification.ts";
import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { NO_CLAUDE_NATIVE_TOOL_OUTPUT } from "./ClaudeToolClassification.ts";
import { claudeApprovalPresentation } from "./ClaudeApprovals.ts";
import type { ActiveClaudeSubagent } from "./ClaudeAssistantArtifacts.ts";
import type { ActiveClaudeToolCall } from "./ClaudeAssistantArtifacts.ts";
import type { ActiveClaudeTurnContext } from "./ClaudeAssistantArtifacts.ts";
import type { ClaudeLiveQueryContext } from "./ClaudeAssistantArtifacts.ts";
import type { ClaudeNativeToolInput } from "./ClaudeToolClassification.ts";
import type { ClaudeSubagentProjectionTarget } from "./ClaudeAssistantArtifacts.ts";
import type { ClaudeToolPresentation } from "./ClaudeToolClassification.ts";

export type Deps = PrevDeps & ReturnType<typeof installSubagentNode>;

export const installSubagentRecovery = (s: Deps) => {
  const { idAllocator, input } = s.env;
  const {
    now,
    pendingBackgroundTasksByNativeThread,
    sessionSubagentsByTaskId,
    sessionSubagentTaskIdsByToolUseId,
    subagentToolCalls,
    settledTurnByNativeThread,
    wakeBuffers,
    emitProviderEvent,
    rosterForNativeThread,
    resolveItemOrdinal,
    buildToolCallArtifacts,
    emitToolCallArtifacts,
    findToolCall,
    startToolCall,
    startSubagentToolCall,
    endToolCalls,
  } = s;
  const resolveSubagentByToolUseId = Effect.fnUntraced(function* (
    context: ActiveClaudeTurnContext,
    toolUseId: string,
  ) {
    const taskId = (yield* Ref.get(sessionSubagentTaskIdsByToolUseId)).get(toolUseId);
    const registered =
      taskId === undefined ? undefined : (yield* Ref.get(sessionSubagentsByTaskId)).get(taskId);
    return registered ?? context.subagentsByToolUseId.get(toolUseId);
  });

  const toolCallsFor = (context: ActiveClaudeTurnContext, toolCall: ActiveClaudeToolCall) =>
    toolCall.runId === null ? subagentToolCalls : context.toolCalls;

  const subagentProjectionTarget = (
    subagent: ActiveClaudeSubagent,
  ): ClaudeSubagentProjectionTarget => ({
    childThreadId: subagent.childThreadId,
    childRootNodeId: subagent.childRootNodeId,
    nextOrdinal: () => ++subagent.nextChildItemOrdinal,
    toolCalls: subagentToolCalls,
  });

  const ensureToolCallStarted = Effect.fnUntraced(function* (input: {
    readonly context: ActiveClaudeTurnContext;
    readonly nativeItemId: string;
    readonly toolName: string;
    readonly toolInput: ClaudeNativeToolInput;
    readonly parentToolUseId: string | null;
    readonly presentation?: ClaudeToolPresentation | undefined;
  }) {
    const existing = findToolCall(input.context, input.nativeItemId);
    if (existing !== undefined) {
      // Permission callbacks can start calls before assistant frames provide their display name and icon.
      if (input.presentation === undefined || existing.presentation !== undefined) {
        return existing;
      }
      const presented = { ...existing, presentation: input.presentation };
      toolCallsFor(input.context, presented).set(input.nativeItemId, presented);
      const updatedAt = yield* DateTime.now;
      yield* emitToolCallArtifacts(
        buildToolCallArtifacts({
          context: input.context,
          nativeItemId: presented.nativeItemId,
          toolName: presented.toolName,
          classification: presented.classification,
          toolInput: presented.input,
          threadId: presented.threadId,
          runId: presented.runId,
          rootNodeId: presented.rootNodeId,
          parentNodeId: presented.parentNodeId,
          ordinal: presented.ordinal,
          output: NO_CLAUDE_NATIVE_TOOL_OUTPUT,
          status: "running",
          startedAt: presented.startedAt,
          updatedAt,
          presentation: input.presentation,
        }),
      );
      return presented;
    }
    const subagent =
      input.parentToolUseId === null
        ? undefined
        : yield* resolveSubagentByToolUseId(input.context, input.parentToolUseId);
    const call = {
      nativeItemId: input.nativeItemId,
      toolName: input.toolName,
      toolInput: input.toolInput,
      presentation: input.presentation,
      startedAt: yield* DateTime.now,
    };
    if (subagent !== undefined) {
      return yield* startSubagentToolCall(subagentProjectionTarget(subagent), call);
    }
    return yield* startToolCall({
      ...call,
      context: input.context,
      threadId: input.context.input.threadId,
      runId: input.context.input.runId,
      rootNodeId: input.context.input.rootNodeId,
      ordinal: yield* resolveItemOrdinal(input.context, input.nativeItemId),
      registry: input.context.toolCalls,
    });
  });

  const buildApprovalRequestArtifacts = Effect.fnUntraced(function* (input: {
    readonly context: ActiveClaudeTurnContext;
    readonly nativeItemId: string;
    readonly nativeRequestId: string;
    readonly parentNodeId?: OrchestrationV2ExecutionNode["id"];
    readonly requestKind: OrchestrationV2RuntimeRequest["kind"];
    readonly prompt?: string;
    readonly appName?: string;
    readonly options?: ReadonlyArray<ProviderApprovalOption>;
    readonly presentation?: ReturnType<typeof claudeApprovalPresentation>;

    readonly questions?: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  }) {
    const createdAt = yield* DateTime.now;
    const requestId = yield* idAllocator.allocate.runtimeRequest({
      driver: CLAUDE_PROVIDER,
      providerTurnId: input.context.providerTurnId,
      nativeRequestId: input.nativeRequestId,
    });
    const nodeId = idAllocator.derive.approvalNode({ requestId });
    const providerSessionId = input.context.input.providerThread.providerSessionId;
    if (providerSessionId === null) {
      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
        driver: CLAUDE_PROVIDER,
        detail: `Provider thread ${input.context.input.providerThread.id} is missing a provider session id.`,
      });
    }
    const ordinal = yield* resolveItemOrdinal(
      input.context,
      `${input.nativeItemId}:approval:${input.nativeRequestId}`,
    );
    const nativeItemRef = {
      driver: CLAUDE_PROVIDER,
      nativeId: input.nativeRequestId,
      strength: "strong" as const,
    };
    const node: OrchestrationV2ExecutionNode = {
      id: nodeId,
      threadId: input.context.input.threadId,
      runId: input.context.input.runId,
      parentNodeId:
        input.parentNodeId ??
        idAllocator.derive.nodeFromProviderItem({
          driver: CLAUDE_PROVIDER,
          nativeItemId: input.nativeItemId,
        }),
      rootNodeId: input.context.input.rootNodeId,
      kind: input.questions === undefined ? "approval_request" : "user_input_request",
      status: "waiting",
      countsForRun: false,
      providerThreadId: input.context.input.providerThread.id,
      providerTurnId: input.context.providerTurnId,
      nativeItemRef,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: createdAt,
      completedAt: null,
    };
    const request: OrchestrationV2RuntimeRequest = {
      id: requestId,
      nodeId,
      providerTurnId: input.context.providerTurnId,
      nativeRequestRef: {
        driver: CLAUDE_PROVIDER,
        nativeId: input.nativeRequestId,
        strength: "strong",
      },
      kind: input.requestKind,
      status: "pending",
      responseCapability: {
        type: "live",
        providerSessionId,
        ...(input.questions === undefined && input.requestKind !== "mcp-elicitation"
          ? { supportsFeedback: true }
          : {}),
      },
      createdAt,
      resolvedAt: null,
    };
    const turnItem: OrchestrationV2TurnItem = {
      id: idAllocator.derive.approvalTurnItem({ requestId }),
      threadId: input.context.input.threadId,
      runId: input.context.input.runId,
      nodeId,
      providerThreadId: input.context.input.providerThread.id,
      providerTurnId: input.context.providerTurnId,
      nativeItemRef,
      parentItemId: null,
      ordinal,
      status: "waiting",
      title: null,
      startedAt: createdAt,
      completedAt: null,
      updatedAt: createdAt,
      ...(input.questions === undefined
        ? {
            type: "approval_request" as const,
            requestId,
            requestKind: input.requestKind as ProviderRequestKind,
            ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
            ...(input.appName === undefined ? {} : { appName: input.appName }),
            ...(input.options === undefined ? {} : { options: input.options }),
            ...input.presentation,
          }
        : {
            type: "user_input_request" as const,
            requestId,
            questions: [...input.questions],
          }),
    };
    return { node, request, turnItem };
  });

  // Claude withdraws a permission request it no longer needs, for example
  // when a PermissionRequest hook answered it. Close the request and its
  // card, which would otherwise wait for an answer nothing reads.
  const cancelWithdrawnRequest = Effect.fnUntraced(function* (
    artifacts: Effect.Success<ReturnType<typeof buildApprovalRequestArtifacts>>,
  ) {
    const now = yield* DateTime.now;
    yield* Effect.all(
      [
        emitProviderEvent({
          type: "runtime_request.updated",
          driver: CLAUDE_PROVIDER,
          runtimeRequest: { ...artifacts.request, status: "cancelled", resolvedAt: now },
        }),
        emitProviderEvent({
          type: "node.updated",
          driver: CLAUDE_PROVIDER,
          node: { ...artifacts.node, status: "cancelled", completedAt: now },
        }),
        emitProviderEvent({
          type: "turn_item.updated",
          driver: CLAUDE_PROVIDER,
          turnItem: {
            ...artifacts.turnItem,
            status: "cancelled",
            completedAt: now,
            updatedAt: now,
          },
        }),
      ],
      { concurrency: 1 },
    );
  });

  const ensureReasoningBlock = Effect.fnUntraced(function* (
    context: ActiveClaudeTurnContext,
    itemId: string,
  ) {
    if (!context.reasoning.blocks.has(itemId)) {
      context.reasoning.blocks.set(itemId, {
        startedAt: yield* DateTime.now,
        ordinal: yield* resolveItemOrdinal(context, itemId),
        text: "",
      });
    }
  });
  const endSubagentCallsOfClosedQuery = Effect.fnUntraced(function* (
    nativeThreadId: string,
    status: "interrupted" | "failed",
  ) {
    const settled = settledTurnByNativeThread.get(nativeThreadId);
    if (settled === undefined || subagentToolCalls.size === 0) {
      return;
    }
    yield* endToolCalls({
      context: settled,
      toolCalls: [...subagentToolCalls.values()],
      status,
      completedAt: yield* DateTime.now,
    });
    subagentToolCalls.clear();
  });

  const liveProcessRunsBackgroundWork = Effect.fnUntraced(function* (
    live: ClaudeLiveQueryContext,
    options?: { readonly forGoalCheck?: boolean },
  ) {
    if (
      rosterForNativeThread(
        yield* Ref.get(pendingBackgroundTasksByNativeThread),
        live.nativeThreadId,
      ).size > 0
    ) {
      return true;
    }
    const buffered = (yield* Ref.get(wakeBuffers)).get(live.nativeThreadId)?.messages ?? [];
    for (const [taskId, subagent] of yield* Ref.get(sessionSubagentsByTaskId)) {
      if (
        subagent.task.status === "running" &&
        !live.subagentsFromEarlierProcesses.has(subagent) &&
        (options?.forGoalCheck !== true ||
          subagent.nativeTaskType === undefined ||
          CLAUDE_GOAL_DEFERRING_TASK_TYPES.has(subagent.nativeTaskType)) &&
        !buffered.some(
          (message) =>
            message.type === "system" &&
            message.subtype === "task_notification" &&
            message.task_id === taskId,
        )
      ) {
        return true;
      }
    }
    return false;
  });

  return {
    resolveSubagentByToolUseId,
    toolCallsFor,
    subagentProjectionTarget,
    ensureToolCallStarted,
    buildApprovalRequestArtifacts,
    cancelWithdrawnRequest,
    ensureReasoningBlock,
    endSubagentCallsOfClosedQuery,
    liveProcessRunsBackgroundWork,
  };
};
