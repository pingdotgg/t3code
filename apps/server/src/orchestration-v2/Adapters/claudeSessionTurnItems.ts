// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import {
  dynamicToolTitle,
  formatReadToolLabel,
  formatSearchToolLabel,
} from "@t3tools/shared/toolActivity";

import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";

import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderTurn,
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { Deps as PrevDeps } from "./claudeSessionRoster.ts";
import { installRoster } from "./claudeSessionRoster.ts";
import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { WEB_FETCH_SNIPPET_MAX_CHARS } from "./ClaudeToolClassification.ts";
import { claudeCommandOutputText } from "./ClaudeToolClassification.ts";
import { claudeFileChangeText } from "./ClaudeToolClassification.ts";
import { claudeNativeToolInputValue } from "./ClaudeToolClassification.ts";
import { claudeNativeToolOutputText } from "./ClaudeToolClassification.ts";
import { claudeNativeToolOutputValue } from "./ClaudeToolClassification.ts";
import { commandInputFromClaudeTool } from "./ClaudeToolClassification.ts";
import { fileNameFromClaudeTool } from "./ClaudeToolClassification.ts";
import { firstStringInputField } from "./ClaudeToolClassification.ts";
import { webSearchPatternsFromClaudeTool } from "./ClaudeToolClassification.ts";
import { webSearchResultsFromClaudeOutput } from "./ClaudeToolClassification.ts";
import type { ActiveClaudeTurnContext } from "./ClaudeAssistantArtifacts.ts";
import type { ClaudeNativeToolInput } from "./ClaudeToolClassification.ts";
import type { ClaudeNativeToolOutput } from "./ClaudeToolClassification.ts";
import type { ClaudeToolClassification } from "./ClaudeToolClassification.ts";
import type { ClaudeToolPresentation } from "./ClaudeToolClassification.ts";

export type Deps = PrevDeps & ReturnType<typeof installRoster>;

export const installTurnItems = (s: Deps) => {
  const { idAllocator, input } = s.env;
  const { subagentToolCalls, emitProviderEvent } = s;
  const claudeSubagentIds = (context: ActiveClaudeTurnContext, taskId: string) => ({
    nodeId: idAllocator.derive.nodeFromProviderItem({
      driver: CLAUDE_PROVIDER,
      nativeItemId: `task:${taskId}`,
    }),
    childRootNodeId: idAllocator.derive.nodeFromProviderItem({
      driver: CLAUDE_PROVIDER,
      nativeItemId: `task:${taskId}:thread-root`,
    }),
    childThreadId: idAllocator.derive.threadFromProviderThread({
      driver: CLAUDE_PROVIDER,
      nativeThreadId: `${context.input.providerThread.id}:${taskId}`,
    }),
    turnItemId: idAllocator.derive.turnItemFromProviderItem({
      driver: CLAUDE_PROVIDER,
      nativeItemId: `task:${taskId}:subagent`,
    }),
  });

  const resolveItemOrdinal = (context: ActiveClaudeTurnContext, nativeItemId: string) =>
    Effect.sync(() => {
      const existing = context.itemOrdinals.get(nativeItemId);
      if (existing !== undefined) {
        return existing;
      }
      const ordinal = context.input.providerTurnOrdinal * 100 + context.itemOrdinals.size + 1;
      context.itemOrdinals.set(nativeItemId, ordinal);
      return ordinal;
    });

  const providerTurnPayload = (input: {
    readonly context: ActiveClaudeTurnContext;
    readonly status: OrchestrationV2ProviderTurn["status"];
    readonly completedAt: DateTime.Utc | null;
  }): OrchestrationV2ProviderTurn => ({
    id: input.context.providerTurnId,
    providerThreadId: input.context.input.providerThread.id,
    nodeId: input.context.input.rootNodeId,
    runAttemptId: input.context.input.attemptId,
    nativeTurnRef: {
      driver: CLAUDE_PROVIDER,
      nativeId: input.context.nativeMessageCursor ?? input.context.nativeTurnId,
      strength: "weak",
    },
    ordinal: input.context.providerTurnOrdinal,
    status: input.status,
    startedAt: input.context.startedAt,
    completedAt: input.completedAt,
  });

  const buildToolCallArtifacts = (input: {
    readonly context: ActiveClaudeTurnContext | null;
    readonly nativeItemId: string;
    readonly toolName: string;
    readonly classification: ClaudeToolClassification;
    readonly toolInput: ClaudeNativeToolInput;
    readonly threadId: ThreadId;
    readonly runId: ProviderAdapter.ProviderAdapterV2TurnInput["runId"] | null;
    readonly rootNodeId: OrchestrationV2ExecutionNode["id"];
    readonly parentNodeId: OrchestrationV2ExecutionNode["id"];
    readonly ordinal: number;
    readonly output: ClaudeNativeToolOutput;
    readonly status: Extract<
      OrchestrationV2TurnItem["status"],
      "running" | "completed" | "failed" | "interrupted" | "cancelled"
    >;
    readonly startedAt: DateTime.Utc;
    readonly updatedAt: DateTime.Utc;
    readonly presentation: ClaudeToolPresentation | undefined;
    readonly toolNonExecutionKind?: string;
  }) => {
    const completedAt = input.status === "running" ? null : input.updatedAt;
    const nodeId = idAllocator.derive.nodeFromProviderItem({
      driver: CLAUDE_PROVIDER,
      nativeItemId: input.nativeItemId,
    });
    const turnItemId = idAllocator.derive.turnItemFromProviderItem({
      driver: CLAUDE_PROVIDER,
      nativeItemId: input.nativeItemId,
    });
    const nativeItemRef = {
      driver: CLAUDE_PROVIDER,
      nativeId: input.nativeItemId,
      strength: "strong" as const,
    };
    const node: OrchestrationV2ExecutionNode = {
      id: nodeId,
      threadId: input.threadId,
      runId: input.runId,
      parentNodeId: input.parentNodeId,
      rootNodeId: input.rootNodeId,
      kind: "tool_call",
      status: input.status,
      countsForRun: false,
      providerThreadId:
        input.runId === null ? null : (input.context?.input.providerThread.id ?? null),
      providerTurnId: input.runId === null ? null : (input.context?.providerTurnId ?? null),
      nativeItemRef,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: input.startedAt,
      completedAt,
    };
    const readPath = ["read", "read file"].includes(input.classification.normalizedName)
      ? firstStringInputField(input.toolInput, ["file_path", "path"])?.trim()
      : undefined;
    const nativeToolInput = claudeNativeToolInputValue(input.toolInput);
    const searchTitle = ["grep", "glob", "ls"].includes(input.classification.normalizedName)
      ? formatSearchToolLabel({
          input:
            nativeToolInput !== null &&
            typeof nativeToolInput === "object" &&
            !Array.isArray(nativeToolInput)
              ? (nativeToolInput as Record<string, unknown>)
              : undefined,
        })
      : undefined;
    const itemBase = {
      ...(input.toolNonExecutionKind === undefined
        ? {}
        : { toolNonExecutionKind: input.toolNonExecutionKind }),
      id: turnItemId,
      threadId: input.threadId,
      runId: input.runId,
      nodeId,
      providerThreadId:
        input.runId === null ? null : (input.context?.input.providerThread.id ?? null),
      providerTurnId: input.runId === null ? null : (input.context?.providerTurnId ?? null),
      nativeItemRef,
      parentItemId: null,
      ordinal: input.ordinal,
      status: input.status,
      title:
        readPath !== undefined
          ? formatReadToolLabel(readPath)
          : (searchTitle ??
            dynamicToolTitle(input.toolName, nativeToolInput) ??
            input.presentation?.title ??
            null),
      startedAt: input.startedAt,
      completedAt,
      updatedAt: input.updatedAt,
    } satisfies Pick<
      OrchestrationV2TurnItem,
      | "id"
      | "threadId"
      | "runId"
      | "nodeId"
      | "providerThreadId"
      | "providerTurnId"
      | "nativeItemRef"
      | "parentItemId"
      | "ordinal"
      | "status"
      | "title"
      | "startedAt"
      | "completedAt"
      | "updatedAt"
    >;
    const viewedImagePath =
      readPath &&
      readPath.length <= 4096 &&
      !/[\r\n]/.test(readPath) &&
      isWorkspaceImagePreviewPath(readPath)
        ? readPath
        : undefined;
    const itemType = input.classification.itemType;
    const webSearchPatterns = webSearchPatternsFromClaudeTool({
      toolInput: input.toolInput,
      output: input.output,
    });
    const webSearchResults = webSearchResultsFromClaudeOutput(input.output);
    const webFetchUrl = firstStringInputField(input.toolInput, ["url"])?.trim();
    const outputValue = claudeNativeToolOutputValue(input.output);
    const outputText =
      itemType === "command_execution"
        ? claudeCommandOutputText(input.output)
        : itemType === "file_change"
          ? claudeFileChangeText(input.output)
          : claudeNativeToolOutputText(input.output);
    const turnItem: OrchestrationV2TurnItem =
      itemType === "command_execution"
        ? {
            ...itemBase,
            type: "command_execution",
            input: commandInputFromClaudeTool(input.toolName, input.toolInput),
            ...(outputText.length === 0 ? {} : { output: outputText }),
          }
        : itemType === "file_change"
          ? {
              ...itemBase,
              type: "file_change",
              fileName: fileNameFromClaudeTool(input.toolName, input.toolInput),
              ...(outputText.length === 0 ? {} : { diffStr: outputText }),
            }
          : itemType === "web_search"
            ? {
                ...itemBase,
                type: "web_search",
                ...(webSearchPatterns.length === 0 ? {} : { patterns: [...webSearchPatterns] }),
                ...(webSearchResults.length > 0
                  ? { results: [...webSearchResults] }
                  : input.classification.normalizedName === "webfetch" &&
                      outputText.trim().length > 0
                    ? {
                        results: [
                          {
                            ...(webFetchUrl === undefined ? {} : { url: webFetchUrl }),
                            snippet: outputText.slice(0, WEB_FETCH_SNIPPET_MAX_CHARS),
                          },
                        ],
                      }
                    : {}),
              }
            : {
                ...itemBase,
                type: "dynamic_tool",
                ...(input.presentation?.toolIcon === undefined
                  ? {}
                  : { toolIcon: input.presentation.toolIcon }),
                ...(input.presentation?.toolSource === undefined
                  ? {}
                  : { toolSource: input.presentation.toolSource }),
                toolName: input.toolName,
                ...(viewedImagePath === undefined ? {} : { viewedImagePath }),
                input: claudeNativeToolInputValue(input.toolInput),
                ...(outputValue === undefined ? {} : { output: outputValue }),
              };
    return { node, turnItem };
  };

  const emitToolCallArtifacts = Effect.fnUntraced(function* (artifacts: {
    readonly node: OrchestrationV2ExecutionNode;
    readonly turnItem: OrchestrationV2TurnItem;
  }) {
    yield* emitProviderEvent({
      type: "node.updated",
      driver: CLAUDE_PROVIDER,
      node: artifacts.node,
    });
    yield* emitProviderEvent({
      type: "turn_item.updated",
      driver: CLAUDE_PROVIDER,
      turnItem: artifacts.turnItem,
    });
  });

  const findToolCall = (context: ActiveClaudeTurnContext, nativeItemId: string) =>
    context.toolCalls.get(nativeItemId) ?? subagentToolCalls.get(nativeItemId);
  const withWorkflowMemberThreadIds = (
    workflow: OrchestrationV2SubagentWorkflow,
    coordinatorChildThreadId: ThreadId,
  ): OrchestrationV2SubagentWorkflow => ({
    ...workflow,
    agents: workflow.agents.map((member) => ({
      ...member,
      childThreadId: idAllocator.derive.threadFromProviderThread({
        driver: CLAUDE_PROVIDER,
        nativeThreadId: `${coordinatorChildThreadId}:agent:${member.index}`,
      }),
    })),
  });

  return {
    claudeSubagentIds,
    resolveItemOrdinal,
    providerTurnPayload,
    buildToolCallArtifacts,
    emitToolCallArtifacts,
    findToolCall,
    withWorkflowMemberThreadIds,
  };
};
