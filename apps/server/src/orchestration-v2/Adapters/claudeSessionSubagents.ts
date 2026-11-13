// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { field, text } from "../unknownField.ts";

import type { SDKAssistantMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderTurn,
  ThreadId,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import * as Option from "effect/Option";

import * as Ref from "effect/Ref";

import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { makeSubagentConversationArtifacts } from "@t3tools/provider-core/server/subagentProjection";
import type { Deps as PrevDeps } from "./claudeSessionTurnItems.ts";
import { installTurnItems } from "./claudeSessionTurnItems.ts";
import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { EMPTY_CLAUDE_NATIVE_TOOL_INPUT } from "./ClaudeToolClassification.ts";
import { NO_CLAUDE_NATIVE_TOOL_OUTPUT } from "./ClaudeToolClassification.ts";
import { classifyClaudeNativeTool } from "./ClaudeToolClassification.ts";
import { claudeNativeToolInputFromUnknown } from "./ClaudeToolClassification.ts";
import { claudeToolNonExecutionKind } from "./ClaudeToolClassification.ts";
import { claudeToolPresentationsFromAssistantMessage } from "./ClaudeToolClassification.ts";
import { claudeToolResultEntriesFromMessage } from "./ClaudeToolClassification.ts";
import { claudeToolUseBlocksFromAssistantMessage } from "./ClaudeToolClassification.ts";
import { isClaudeToolResultError } from "./ClaudeToolClassification.ts";
import { isClaudeTranscriptConversationLine } from "./ClaudeSessionTypes.ts";
import { textFromClaudeContent } from "./ClaudeProviderMessages.ts";
import { toolNameFromClaudeToolResult } from "./ClaudeToolClassification.ts";
import type { ActiveClaudeSubagent } from "./ClaudeAssistantArtifacts.ts";
import type { ActiveClaudeToolCall } from "./ClaudeAssistantArtifacts.ts";
import type { ActiveClaudeTurnContext } from "./ClaudeAssistantArtifacts.ts";
import type { ClaudeNativeToolInput } from "./ClaudeToolClassification.ts";
import type { ClaudeNativeToolOutput } from "./ClaudeToolClassification.ts";
import type { ClaudeSubagentProjectionTarget } from "./ClaudeAssistantArtifacts.ts";
import type { ClaudeToolPresentation } from "./ClaudeToolClassification.ts";
import type { ClaudeToolResultContentBlock } from "./ClaudeRuntimePolicy.ts";

export type Deps = PrevDeps & ReturnType<typeof installTurnItems>;

export const installSubagents = (s: Deps) => {
  const { idAllocator, queryRunner, input } = s.env;
  const {
    now,
    stopTaskOutputTail,
    sessionSubagentsByTaskId,
    sessionSubagentTaskIdsByToolUseId,
    emitProviderEvent,
    claudeSubagentIds,
    resolveItemOrdinal,
    buildToolCallArtifacts,
    emitToolCallArtifacts,
    findToolCall,
  } = s;
  // Resume frames reference the launch call, but task_started names SendMessage; recover the mapping from CLI storage.
  const recoverResumedClaudeSubagent = Effect.fnUntraced(function* (resume: {
    readonly context: ActiveClaudeTurnContext;
    readonly nativeThreadId: string;
    readonly taskId: string;
    readonly toolUseId: string | undefined;
    readonly title: string;
  }) {
    if (
      resume.toolUseId === undefined ||
      findToolCall(resume.context, resume.toolUseId) === undefined ||
      resume.context.subagentsByTaskId.has(resume.taskId) ||
      (yield* Ref.get(sessionSubagentsByTaskId)).has(resume.taskId)
    ) {
      return;
    }
    const launchToolUseId = yield* queryRunner
      .subagentLaunchToolUseId({
        sessionId: resume.nativeThreadId,
        agentId: resume.taskId,
        dir: resume.context.input.runtimePolicy.cwd,
        threadId: resume.context.input.threadId,
        providerSessionId: input.providerSessionId,
      })
      .pipe(
        Effect.catch(() =>
          Effect.logWarning("orchestration-v2.claude-subagent-launch-lookup-failed", {
            taskId: resume.taskId,
          }).pipe(Effect.as(null)),
        ),
      );
    if (launchToolUseId === null || launchToolUseId === resume.toolUseId) {
      return;
    }
    const ids = claudeSubagentIds(resume.context, resume.taskId);
    const now = yield* DateTime.now;
    const subagent: ActiveClaudeSubagent = {
      nativeTaskType: undefined,
      confirmedOutcome: undefined,
      childThread: null,
      task: {
        id: ids.nodeId,
        threadId: resume.context.input.threadId,
        runId: resume.context.input.runId,
        parentNodeId: resume.context.input.rootNodeId,
        origin: "provider_native",
        createdBy: "agent",
        driver: CLAUDE_PROVIDER,
        providerInstanceId: resume.context.input.modelSelection.instanceId,
        providerThreadId: null,
        childThreadId: ids.childThreadId,
        nativeTaskRef: {
          driver: CLAUDE_PROVIDER,
          nativeId: resume.taskId,
          strength: "strong",
        },
        prompt: "",
        title: resume.title,
        model: null,
        result: null,
        status: "completed",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      },
      rootNodeId: resume.context.input.rootNodeId,
      childThreadId: ids.childThreadId,
      childRootNodeId: ids.childRootNodeId,
      turnItemId: ids.turnItemId,
      turnItemOrdinal: yield* resolveItemOrdinal(resume.context, `task:${resume.taskId}:subagent`),
      runToolUseId: launchToolUseId,
      effort: undefined,
      nextChildItemOrdinal: 100,
      resultItemOrdinal: null,
      lastAssistantText: null,
      lastAssistantMessageId: null,
    };
    yield* Ref.update(sessionSubagentsByTaskId, (current) =>
      new Map(current).set(resume.taskId, subagent),
    );
    yield* Ref.update(sessionSubagentTaskIdsByToolUseId, (current) =>
      new Map(current).set(launchToolUseId, resume.taskId),
    );
  });

  const emitSubagentConversationMessage = Effect.fnUntraced(function* (input: {
    readonly nativeItemId: string;
    readonly threadId: ThreadId;
    readonly senderThreadId?: ThreadId;
    readonly rootNodeId: OrchestrationV2ExecutionNode["id"];
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly workflowScript?: boolean;
    readonly ordinal: number;
    readonly now: DateTime.Utc;
  }) {
    const artifacts = makeSubagentConversationArtifacts({
      messageId: idAllocator.derive.messageFromProviderItem({
        driver: CLAUDE_PROVIDER,
        nativeItemId: input.nativeItemId,
      }),
      turnItemId: idAllocator.derive.turnItemFromProviderItem({
        driver: CLAUDE_PROVIDER,
        nativeItemId: input.nativeItemId,
      }),
      threadId: input.threadId,
      ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
      rootNodeId: input.rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: {
        driver: CLAUDE_PROVIDER,
        nativeId: input.nativeItemId,
        strength: "strong",
      },
      role: input.role,
      text: input.text,
      ...(input.workflowScript === undefined ? {} : { workflowScript: input.workflowScript }),
      ordinal: input.ordinal,
      now: input.now,
    });
    yield* emitProviderEvent({
      type: "message.updated",
      driver: CLAUDE_PROVIDER,
      message: artifacts.message,
    });
    yield* emitProviderEvent({
      type: "turn_item.updated",
      driver: CLAUDE_PROVIDER,
      turnItem: artifacts.turnItem,
    });
  });

  const endToolCalls = Effect.fnUntraced(function* (input: {
    readonly context: ActiveClaudeTurnContext | null;
    readonly toolCalls: ReadonlyArray<ActiveClaudeToolCall>;
    readonly status: Extract<
      OrchestrationV2ProviderTurn["status"],
      "interrupted" | "failed" | "cancelled"
    >;
    readonly completedAt: DateTime.Utc;
  }) {
    for (const toolCall of input.toolCalls) {
      yield* stopTaskOutputTail(toolCall.nativeItemId);
      yield* emitToolCallArtifacts(
        buildToolCallArtifacts({
          context: input.context,
          nativeItemId: toolCall.nativeItemId,
          toolName: toolCall.toolName,
          classification: toolCall.classification,
          toolInput: toolCall.input,
          threadId: toolCall.threadId,
          runId: toolCall.runId,
          rootNodeId: toolCall.rootNodeId,
          parentNodeId: toolCall.parentNodeId,
          ordinal: toolCall.ordinal,
          output: NO_CLAUDE_NATIVE_TOOL_OUTPUT,
          status: input.status,
          startedAt: toolCall.startedAt,
          updatedAt: input.completedAt,
          presentation: toolCall.presentation,
        }),
      );
    }
  });
  const emitSubagentThinking = Effect.fnUntraced(function* (
    target: ClaudeSubagentProjectionTarget,
    message: SDKAssistantMessage,
    at: DateTime.Utc,
  ) {
    const thinking = message.message.content.flatMap((block) =>
      block.type === "thinking" && block.thinking.trim().length > 0 ? [block.thinking] : [],
    );
    for (const [index, text] of thinking.entries()) {
      const nativeItemId = `${message.uuid}:thinking:${index}`;
      yield* emitProviderEvent({
        type: "turn_item.updated",
        driver: CLAUDE_PROVIDER,
        turnItem: {
          id: idAllocator.derive.turnItemFromProviderItem({
            driver: CLAUDE_PROVIDER,
            nativeItemId,
          }),
          threadId: target.childThreadId,
          runId: null,
          nodeId: target.childRootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: {
            driver: CLAUDE_PROVIDER,
            nativeId: nativeItemId,
            strength: "strong",
          },
          parentItemId: null,
          ordinal: target.nextOrdinal(),
          type: "reasoning",
          title: "Thinking",
          text,
          streaming: false,
          status: "completed",
          startedAt: at,
          completedAt: at,
          updatedAt: at,
        },
      });
    }
  });

  const settleToolCall = Effect.fnUntraced(function* (input: {
    readonly context: ActiveClaudeTurnContext | null;
    readonly toolCall: ActiveClaudeToolCall;
    readonly registry: Map<string, ActiveClaudeToolCall>;
    readonly message: SDKMessage;
    readonly toolResult: ClaudeToolResultContentBlock;
    readonly output: ClaudeNativeToolOutput;
    readonly completedAt: DateTime.Utc;
  }) {
    const { toolCall } = input;
    const toolNonExecutionKind = claudeToolNonExecutionKind(
      input.message,
      input.toolResult.tool_use_id,
    );
    yield* stopTaskOutputTail(toolCall.nativeItemId);
    yield* emitToolCallArtifacts(
      buildToolCallArtifacts({
        context: input.context,
        nativeItemId: toolCall.nativeItemId,
        toolName: toolCall.toolName,
        classification: toolCall.classification,
        toolInput: toolCall.input,
        threadId: toolCall.threadId,
        runId: toolCall.runId,
        rootNodeId: toolCall.rootNodeId,
        parentNodeId: toolCall.parentNodeId,
        ordinal: toolCall.ordinal,
        output: input.output,
        status:
          toolNonExecutionKind === "cancelled"
            ? "cancelled"
            : isClaudeToolResultError(input.toolResult)
              ? "failed"
              : "completed",
        ...(toolNonExecutionKind === undefined ? {} : { toolNonExecutionKind }),
        startedAt: toolCall.startedAt,
        updatedAt: input.completedAt,
        presentation: toolCall.presentation,
      }),
    );
    input.registry.delete(toolCall.nativeItemId);
  });

  const startToolCall = Effect.fnUntraced(function* (input: {
    readonly context: ActiveClaudeTurnContext | null;
    readonly nativeItemId: string;
    readonly toolName: string;
    readonly toolInput: ClaudeNativeToolInput;
    readonly presentation: ClaudeToolPresentation | undefined;
    readonly threadId: ThreadId;
    readonly runId: ProviderAdapter.ProviderAdapterV2TurnInput["runId"] | null;
    readonly rootNodeId: OrchestrationV2ExecutionNode["id"];
    readonly ordinal: number;
    readonly startedAt: DateTime.Utc;
    readonly registry: Map<string, ActiveClaudeToolCall>;
  }) {
    const toolCall: ActiveClaudeToolCall = {
      nativeItemId: input.nativeItemId,
      toolName: input.toolName,
      classification: classifyClaudeNativeTool(input.toolName),
      input: input.toolInput,
      threadId: input.threadId,
      runId: input.runId,
      rootNodeId: input.rootNodeId,
      parentNodeId: input.rootNodeId,
      ordinal: input.ordinal,
      startedAt: input.startedAt,
      ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
    };
    input.registry.set(input.nativeItemId, toolCall);
    yield* emitToolCallArtifacts(
      buildToolCallArtifacts({
        context: input.context,
        nativeItemId: toolCall.nativeItemId,
        toolName: toolCall.toolName,
        classification: toolCall.classification,
        toolInput: toolCall.input,
        threadId: toolCall.threadId,
        runId: toolCall.runId,
        rootNodeId: toolCall.rootNodeId,
        parentNodeId: toolCall.parentNodeId,
        ordinal: toolCall.ordinal,
        output: NO_CLAUDE_NATIVE_TOOL_OUTPUT,
        status: "running",
        startedAt: toolCall.startedAt,
        updatedAt: toolCall.startedAt,
        presentation: input.presentation,
      }),
    );
    return toolCall;
  });

  const startSubagentToolCall = (
    target: ClaudeSubagentProjectionTarget,
    call: {
      readonly nativeItemId: string;
      readonly toolName: string;
      readonly toolInput: ClaudeNativeToolInput;
      readonly presentation: ClaudeToolPresentation | undefined;
      readonly startedAt: DateTime.Utc;
    },
  ) =>
    startToolCall({
      ...call,
      context: null,
      threadId: target.childThreadId,
      runId: null,
      rootNodeId: target.childRootNodeId,
      ordinal: target.nextOrdinal(),
      registry: target.toolCalls,
    });

  const projectSubagentTranscriptLine = Effect.fnUntraced(function* (
    target: ClaudeSubagentProjectionTarget,
    line: unknown,
  ) {
    if (!isClaudeTranscriptConversationLine(line)) return false;
    const at =
      Option.getOrUndefined(DateTime.make(text(field(line, "timestamp")) ?? "")) ??
      (yield* DateTime.now);
    const presentations = claudeToolPresentationsFromAssistantMessage(line);
    for (const toolUse of claudeToolUseBlocksFromAssistantMessage(line)) {
      if (target.toolCalls.has(toolUse.id)) continue;
      yield* startSubagentToolCall(target, {
        nativeItemId: toolUse.id,
        toolName: toolUse.name,
        toolInput: claudeNativeToolInputFromUnknown(toolUse.input),
        presentation:
          presentations.get(toolUse.id) ??
          mcpToolPresentation({
            toolName: toolUse.name.replace(/^mcp__claude_ai_/u, "mcp__"),
          }),
        startedAt: at,
      });
    }
    for (const { toolResult, output } of claudeToolResultEntriesFromMessage(line)) {
      const toolCall =
        target.toolCalls.get(toolResult.tool_use_id) ??
        (yield* startSubagentToolCall(target, {
          nativeItemId: toolResult.tool_use_id,
          toolName: toolNameFromClaudeToolResult(toolResult),
          toolInput: EMPTY_CLAUDE_NATIVE_TOOL_INPUT,
          presentation: undefined,
          startedAt: at,
        }));
      yield* settleToolCall({
        context: null,
        toolCall,
        registry: target.toolCalls,
        message: line,
        toolResult,
        output,
        completedAt: at,
      });
    }
    if (line.type !== "assistant") return false;
    yield* emitSubagentThinking(target, line, at);
    const assistantText = textFromClaudeContent(line.message.content);
    if (assistantText.length === 0) return false;
    yield* emitSubagentConversationMessage({
      nativeItemId: line.uuid,
      threadId: target.childThreadId,
      rootNodeId: target.childRootNodeId,
      role: "assistant",
      text: assistantText,
      ordinal: target.nextOrdinal(),
      now: at,
    });
    return true;
  });

  return {
    recoverResumedClaudeSubagent,
    emitSubagentConversationMessage,
    endToolCalls,
    emitSubagentThinking,
    settleToolCall,
    startToolCall,
    startSubagentToolCall,
    projectSubagentTranscriptLine,
  };
};
