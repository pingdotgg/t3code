// @effect-diagnostics nodeBuiltinImport:off
import type {
  AgentMessage,
  AgentOptions,
  InteractionUpdate,
  McpServerConfig,
  RunResult,
  SDKUserMessage,
  SettingSource,
  ToolCall,
} from "@cursor/sdk";
import { formatReadToolLabel, formatSearchToolLabel } from "@t3tools/shared/toolActivity";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  isOrchestrationV2WorkActive,
  defaultInstanceIdForDriver,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ServerProviderModel,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { CursorTransportFailure } from "./transportFailure.ts";
import { cursorContextWindowTokens, cursorSdkModelSelection } from "./sdkModel.ts";
import {
  discoverCursorSkills,
  hasCursorSkillMention,
  rewriteCursorSkillMentions,
} from "./skills.ts";
import { t3OrchestrationPrompt } from "@t3tools/provider-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import { isCursorSdkError } from "./sdk.ts";
import type { ActiveCursorTurn, CursorProjectionTarget } from "./adapter.ts";
import type { ActiveCursorTextStream, ActiveCursorToolCall } from "./adapter.ts";
import type { ActiveCursorSubagent } from "./adapter.ts";


export function cursorToolFileName(toolCall: ToolCall): string {
  switch (toolCall.type) {
    case "write":
    case "delete":
    case "read":
    case "edit":
    case "ls":
      return toolCall.args.path;
    case "generateImage":
      return toolCall.args.filePath ?? "generated-image";
    default:
      return cursorToolName(toolCall);
  }
}

export function cursorToolOutputText(toolCall: ToolCall): string {
  if (toolCall.type === "shell" && toolCall.result?.status === "success") {
    return [toolCall.result.value.stdout, toolCall.result.value.stderr]
      .filter((part) => part.length > 0)
      .join("\n");
  }
  if (toolCall.type === "mcp" && toolCall.result?.status === "success") {
    return toolCall.result.value.content
      .flatMap((part) => (part.text === undefined ? [] : [part.text.text]))
      .join("\n");
  }
  const output = cursorToolOutput(toolCall);
  if (output === undefined) {
    return "";
  }
  return typeof output === "string" ? output : stableJson(output);
}

export function cursorToolFailed(toolCall: ToolCall): boolean {
  if (toolCall.result?.status === "error") {
    return true;
  }
  return toolCall.type === "mcp" && toolCall.result?.status === "success"
    ? toolCall.result.value.isError
    : false;
}

export interface MakeCursorAdapterProjectionDeps {
  readonly idAllocator: Parameters<typeof IdAllocator.IdAllocatorV2.of>[0];
  readonly createdAt: DateTime.Utc;
  readonly emitProviderEvent: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>;
  readonly parentTarget: (context: ActiveCursorTurn) => CursorProjectionTarget;
  readonly resolvePlanId: (
    context: ActiveCursorTurn,
    nativeItemId: string,
  ) => Effect.Effect<OrchestrationV2PlanArtifact["id"], IdAllocator.IdAllocatorV2AllocationError>;
  readonly resolveItemOrdinal: (context: ActiveCursorTurn, nativeItemId: string) => Effect.Effect<number>;
  readonly path: import("effect/Path").Path;
}

export const makeCursorAdapterProjection = Effect.fn("makeCursorAdapterProjection")(function* (
  deps: MakeCursorAdapterProjectionDeps,
) {
  const { createdAt, emitProviderEvent, parentTarget, resolvePlanId, resolveItemOrdinal } = deps;
  const { path } = deps;
  const { idAllocator } = deps;
        const emitAssistant = Effect.fnUntraced(function* (
          context: ActiveCursorTurn,
          completed: boolean,
        ) {
          const segment = context.assistant.current;
          if (segment === null || segment.text.length === 0) {
            return;
          }
          const now = yield* DateTime.now;
          const ordinal = yield* resolveItemOrdinal(context, segment.nativeItemId);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId: segment.nativeItemId,
          });
          const messageId = idAllocator.derive.messageFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId: segment.nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId: segment.nativeItemId,
          });
          const nativeItemRef = {
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeId: segment.nativeItemId,
            strength: "weak" as const,
          };
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            node: {
              id: nodeId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              parentNodeId: context.input.rootNodeId,
              rootNodeId: context.input.rootNodeId,
              kind: "assistant_message",
              status: completed ? "completed" : "running",
              countsForRun: false,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: segment.startedAt,
              completedAt: completed ? now : null,
            },
          });
          yield* emitProviderEvent({
            type: "message.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            message: {
              createdBy: "agent",
              creationSource: "provider",
              id: messageId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId,
              role: "assistant",
              text: segment.text,
              attachments: [],
              streaming: !completed,
              createdAt: segment.startedAt,
              updatedAt: now,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            turnItem: {
              id: turnItemId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal,
              status: completed ? "completed" : "running",
              title: null,
              startedAt: segment.startedAt,
              completedAt: completed ? now : null,
              updatedAt: now,
              type: "assistant_message",
              messageId,
              text: segment.text,
              streaming: !completed,
            },
          });
        });

        const emitReasoning = Effect.fnUntraced(function* (
          context: ActiveCursorTurn,
          completed: boolean,
        ) {
          const segment = context.reasoning.current;
          if (segment === null || segment.text.length === 0) {
            return;
          }
          const now = yield* DateTime.now;
          const ordinal = yield* resolveItemOrdinal(context, segment.nativeItemId);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId: segment.nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId: segment.nativeItemId,
          });
          const nativeItemRef = {
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeId: segment.nativeItemId,
            strength: "weak" as const,
          };
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            node: {
              id: nodeId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              parentNodeId: context.input.rootNodeId,
              rootNodeId: context.input.rootNodeId,
              kind: "reasoning",
              status: completed ? "completed" : "running",
              countsForRun: false,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: segment.startedAt,
              completedAt: completed ? now : null,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            turnItem: {
              id: turnItemId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal,
              status: completed ? "completed" : "running",
              title: null,
              startedAt: segment.startedAt,
              completedAt: completed ? now : null,
              updatedAt: now,
              type: "reasoning",
              text: segment.text,
              streaming: !completed,
            },
          });
        });

        const appendTextSegment = Effect.fnUntraced(function* (input: {
          readonly context: ActiveCursorTurn;
          readonly stream: ActiveCursorTextStream;
          readonly kind: "assistant" | "reasoning";
          readonly text: string;
        }) {
          if (input.stream.current === null) {
            input.stream.nextSegment += 1;
            input.stream.current = {
              nativeItemId: `${input.kind}:${input.context.run.runId}:${input.stream.nextSegment}`,
              startedAt: yield* DateTime.now,
              text: "",
            };
          }
          input.stream.current.text += input.text;
        });

        const completeAssistant = Effect.fnUntraced(function* (context: ActiveCursorTurn) {
          if (context.assistant.current === null) {
            return;
          }
          yield* emitAssistant(context, true);
          context.assistant.current = null;
        });

        const completeReasoning = Effect.fnUntraced(function* (context: ActiveCursorTurn) {
          if (context.reasoning.current === null) {
            return;
          }
          yield* emitReasoning(context, true);
          context.reasoning.current = null;
        });

        const emitToolArtifacts = Effect.fnUntraced(function* (input: {
          readonly active: ActiveCursorToolCall;
          readonly completed: boolean;
          readonly unfinishedStatus?: "interrupted" | "failed" | "cancelled";
        }) {
          const { active } = input;
          const toolCall = active.toolCall;
          const now = yield* DateTime.now;
          const failed = input.completed && cursorToolFailed(toolCall);
          const status = !input.completed
            ? "running"
            : (input.unfinishedStatus ?? (failed ? "failed" : "completed"));
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId: active.callId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId: active.callId,
          });
          const nativeItemRef = {
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeId: active.callId,
            strength: "strong" as const,
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId: active.target.threadId,
            runId: active.target.runId,
            parentNodeId: active.target.parentNodeId,
            rootNodeId: active.target.rootNodeId,
            kind: "tool_call",
            status,
            countsForRun: false,
            providerThreadId: active.target.providerThreadId,
            providerTurnId: active.target.providerTurnId,
            nativeItemRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: active.startedAt,
            completedAt: input.completed ? now : null,
          };
          const base = {
            id: turnItemId,
            threadId: active.target.threadId,
            runId: active.target.runId,
            nodeId,
            providerThreadId: active.target.providerThreadId,
            providerTurnId: active.target.providerTurnId,
            nativeItemRef,
            parentItemId: null,
            ordinal: active.ordinal,
            status,
            title: null,
            startedAt: active.startedAt,
            completedAt: input.completed ? now : null,
            updatedAt: now,
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
          const outputText = cursorToolOutputText(toolCall) || active.streamedOutput;
          let turnItem: OrchestrationV2TurnItem;
          switch (toolCall.type) {
            case "shell":
              turnItem = {
                ...base,
                type: "command_execution",
                input: toolCall.args.command,
                ...(outputText.length === 0 ? {} : { output: outputText }),
                ...(toolCall.result?.status === "success"
                  ? { exitCode: toolCall.result.value.exitCode }
                  : {}),
              };
              break;
            case "write":
            case "delete":
            case "edit":
            case "generateImage":
              turnItem = {
                ...base,
                type: "file_change",
                fileName: cursorToolFileName(toolCall),
                ...(toolCall.type === "edit" &&
                toolCall.result?.status === "success" &&
                toolCall.result.value.linesAdded !== undefined
                  ? { additions: toolCall.result.value.linesAdded }
                  : {}),
                ...(toolCall.type === "edit" &&
                toolCall.result?.status === "success" &&
                toolCall.result.value.linesRemoved !== undefined
                  ? { deletions: toolCall.result.value.linesRemoved }
                  : {}),
                ...(toolCall.type === "edit" &&
                toolCall.result?.status === "success" &&
                toolCall.result.value.diffString !== undefined
                  ? { diffStr: toolCall.result.value.diffString }
                  : toolCall.result?.status === "error" && outputText.trim().length > 0
                    ? { diffStr: outputText }
                    : {}),
                ...(toolCall.type === "write" ? { newStr: toolCall.args.fileText } : {}),
              };
              break;
            case "read":
              turnItem = {
                ...base,
                title: formatReadToolLabel(toolCall.args.path),
                type: "dynamic_tool",
                toolName: "Read",
                input: toolCall.args,
                ...(cursorToolOutput(toolCall) === undefined
                  ? {}
                  : { output: cursorToolOutput(toolCall) }),
              };
              break;
            case "glob":
            case "grep":
            case "ls":
            case "readLints":
            case "semSearch": {
              const pattern = cursorToolSearchPattern(toolCall);
              const searchPath =
                toolCall.type === "grep"
                  ? toolCall.args.path
                  : toolCall.type === "glob"
                    ? toolCall.args.targetDirectory
                    : toolCall.type === "semSearch"
                      ? toolCall.args.targetDirectories?.join(", ")
                      : pattern;
              const results =
                toolCall.result?.status === "error" && outputText.trim().length > 0
                  ? [{ fileName: searchPath?.trim() || ".", preview: outputText }]
                  : cursorToolSearchResults(toolCall, path);
              turnItem = {
                ...base,
                title:
                  formatSearchToolLabel({
                    input: toolCall.args,
                    ...(pattern === undefined ? {} : { pattern }),
                  }) ?? null,
                type: "file_search",
                ...(pattern === undefined ? {} : { pattern }),
                ...(results.length === 0 ? {} : { results: [...results] }),
              };
              break;
            }
            default:
              turnItem = {
                ...base,
                type: "dynamic_tool",
                ...(toolCall.type === "mcp"
                  ? mcpToolPresentation({
                      serverName: toolCall.args.providerIdentifier,
                      toolName: toolCall.args.toolName,
                    })
                  : {}),
                toolName: cursorToolName(toolCall),
                input: toolCall.type === "mcp" ? (toolCall.args.args ?? {}) : toolCall.args,
                ...(cursorToolOutput(toolCall) === undefined
                  ? {}
                  : { output: cursorToolOutput(toolCall) }),
              };
          }
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            node,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            turnItem,
          });
        });

        const ensureToolStarted = Effect.fnUntraced(function* (
          context: ActiveCursorTurn,
          callId: string,
          toolCall: ToolCall,
        ) {
          const existing = context.tools.get(callId);
          if (existing !== undefined) {
            existing.toolCall = toolCall;
            return existing;
          }
          const startedAt = yield* DateTime.now;
          const active: ActiveCursorToolCall = {
            callId,
            toolCall,
            target: parentTarget(context),
            ordinal: yield* resolveItemOrdinal(context, callId),
            startedAt,
            streamedOutput: "",
          };
          context.tools.set(callId, active);
          yield* emitToolArtifacts({ active, completed: false });
          return active;
        });

        const emitPlanArtifacts = Effect.fnUntraced(function* (input: {
          readonly context: ActiveCursorTurn;
          readonly callId: string;
          readonly markdown: string;
          readonly completed: boolean;
          readonly failed: boolean;
        }) {
          const nativeItemId = `plan:${input.callId}`;
          const now = yield* DateTime.now;
          const planId = yield* resolvePlanId(input.context, nativeItemId);
          const ordinal = yield* resolveItemOrdinal(input.context, nativeItemId);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId,
          });
          const status = input.failed ? "failed" : input.completed ? "completed" : "running";
          const nativeItemRef = {
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeId: input.callId,
            strength: "strong" as const,
          };
          const plan: OrchestrationV2PlanArtifact = {
            id: planId,
            threadId: input.context.input.threadId,
            runId: input.context.input.runId,
            nodeId,
            kind: "proposed_plan",
            status: input.completed ? "active" : "draft",
            markdown: input.markdown,
          };
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            node: {
              id: nodeId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              parentNodeId: input.context.input.rootNodeId,
              rootNodeId: input.context.input.rootNodeId,
              kind: "plan",
              status,
              countsForRun: false,
              providerThreadId: input.context.input.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: input.context.startedAt,
              completedAt: input.completed ? now : null,
            },
          });
          yield* emitProviderEvent({
            type: "plan.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            plan,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            turnItem: {
              id: turnItemId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              nodeId,
              providerThreadId: input.context.input.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal,
              status,
              title: null,
              startedAt: input.context.startedAt,
              completedAt: input.completed ? now : null,
              updatedAt: now,
              type: "proposed_plan",
              planId,
              markdown: input.markdown,
              streaming: !input.completed,
            },
          });
        });

        const emitTodoArtifacts = Effect.fnUntraced(function* (input: {
          readonly context: ActiveCursorTurn;
          readonly callId: string;
          readonly toolCall: Extract<ToolCall, { readonly type: "updateTodos" }>;
          readonly completed: boolean;
          readonly failed: boolean;
        }) {
          const nativeItemId = `todos:${input.callId}`;
          const now = yield* DateTime.now;
          const planId = yield* resolvePlanId(input.context, nativeItemId);
          const ordinal = yield* resolveItemOrdinal(input.context, nativeItemId);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeItemId,
          });
          const status = input.failed ? "failed" : input.completed ? "completed" : "running";
          const steps = cursorTodoSteps(input.toolCall);
          const nativeItemRef = {
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            nativeId: input.callId,
            strength: "strong" as const,
          };
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            node: {
              id: nodeId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              parentNodeId: input.context.input.rootNodeId,
              rootNodeId: input.context.input.rootNodeId,
              kind: "todo_list",
              status,
              countsForRun: false,
              providerThreadId: input.context.input.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: input.context.startedAt,
              completedAt: input.completed ? now : null,
            },
          });
          yield* emitProviderEvent({
            type: "plan.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            plan: {
              id: planId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              nodeId,
              kind: "todo_list",
              status: input.completed ? "active" : "draft",
              steps: [...steps],
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            turnItem: {
              id: turnItemId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              nodeId,
              providerThreadId: input.context.input.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal,
              status,
              title: null,
              startedAt: input.context.startedAt,
              completedAt: input.completed ? now : null,
              updatedAt: now,
              type: "todo_list",
              planId,
              steps: [...steps],
            },
          });
        });

        const emitSubagent = Effect.fnUntraced(function* (input: {
          readonly context: ActiveCursorTurn;
          readonly callId: string;
          readonly toolCall: Extract<ToolCall, { readonly type: "task" }>;
          readonly completed: boolean;
          readonly status?: OrchestrationV2Subagent["status"];
        }) {
          const args = input.toolCall.args;
          const result =
            input.toolCall.result?.status === "success" ? input.toolCall.result.value : undefined;
          const existing = input.context.subagents.get(input.callId);
          if (
            existing !== undefined &&
            !isOrchestrationV2WorkActive(existing.task.status) &&
            !input.completed
          )
            return;
          const now = yield* DateTime.now;
          const status: OrchestrationV2Subagent["status"] =
            input.status ??
            (input.completed
              ? cursorToolFailed(input.toolCall)
                ? "failed"
                : "completed"
              : "running");
          const resultText = [
            ...assistantTextsFromConversationSteps(result?.conversationSteps ?? []),
            ...(result?.resultSuffix === undefined ? [] : [result.resultSuffix]),
          ]
            .filter((part) => part.trim().length > 0)
            .join("\n");
          const nativeItemId = input.callId;
          const nodeId =
            existing?.task.id ??
            idAllocator.derive.nodeFromProviderItem({
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              nativeItemId,
            });
          const childRootNodeId =
            existing?.childRootNodeId ??
            idAllocator.derive.nodeFromProviderItem({
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              nativeItemId: `${nativeItemId}:child-root`,
            });
          const childThreadId =
            existing?.childThreadId ??
            idAllocator.derive.threadFromProviderThread({
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              nativeThreadId: `${input.context.run.runId}:task:${input.callId}`,
            });
          const task: OrchestrationV2Subagent = {
            ...(existing?.task ?? {
              id: nodeId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              parentNodeId: input.context.input.rootNodeId,
              origin: "provider_native" as const,
              createdBy: "agent" as const,
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              providerInstanceId: input.context.input.modelSelection.instanceId,
              providerThreadId: null,
              childThreadId,
              nativeTaskRef: {
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                nativeId: input.callId,
                strength: "strong" as const,
              },
              prompt: args.prompt,
              title: args.description,
              result: null,
              startedAt: now,
            }),
            model: args.model?.trim() || existing?.task.model || null,
            nativeTaskRef: {
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              nativeId: input.callId,
              strength: "strong" as const,
            },
            status,
            result: resultText.length === 0 ? (existing?.task.result ?? null) : resultText,
            completedAt: input.completed ? (existing?.task.completedAt ?? now) : null,
            updatedAt: now,
          };
          const subagent: ActiveCursorSubagent = {
            task,
            toolCall: input.toolCall,
            callId: input.callId,
            childThreadId,
            childRootNodeId,
            turnItemId:
              existing?.turnItemId ??
              idAllocator.derive.turnItemFromProviderItem({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                nativeItemId,
              }),
            turnItemOrdinal:
              existing?.turnItemOrdinal ?? (yield* resolveItemOrdinal(input.context, nativeItemId)),
            nextChildOrdinal: existing?.nextChildOrdinal ?? 100,
            resultProjected: existing?.resultProjected ?? false,
          };
          input.context.subagents.set(input.callId, subagent);

          if (existing === undefined) {
            yield* emitProviderEvent({
              type: "app_thread.created",
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              appThread: makeSubagentChildThread({
                parentThread: input.context.input.appThread,
                childThreadId,
                parentNodeId: nodeId,
                activeProviderThreadId: null,
                providerInstanceId: input.context.input.modelSelection.instanceId,
                modelSelection: input.context.input.modelSelection,
                title: subagentThreadTitle({
                  parentTitle: input.context.input.appThread.title,
                  title: args.description,
                  prompt: args.prompt,
                  ordinal: input.context.subagents.size,
                }),
                now,
                createdBy: "agent",
                creationSource: "provider",
              }),
            });
            const promptNativeId = `${nativeItemId}:prompt`;
            const promptArtifacts = makeSubagentConversationArtifacts({
              senderThreadId: input.context.input.threadId,
              messageId: idAllocator.derive.messageFromProviderItem({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                nativeItemId: promptNativeId,
              }),
              turnItemId: idAllocator.derive.turnItemFromProviderItem({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                nativeItemId: promptNativeId,
              }),
              threadId: childThreadId,
              rootNodeId: childRootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: {
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                nativeId: promptNativeId,
                strength: "weak",
              },
              role: "user",
              text: args.prompt,
              ordinal: 100,
              now,
            });
            yield* emitProviderEvent({
              type: "message.updated",
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              message: promptArtifacts.message,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              turnItem: promptArtifacts.turnItem,
            });
          }

          yield* emitProviderEvent({
            type: "node.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            node: {
              id: nodeId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              parentNodeId: input.context.input.rootNodeId,
              rootNodeId: input.context.input.rootNodeId,
              kind: "subagent",
              status,
              countsForRun: false,
              providerThreadId: input.context.input.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: task.nativeTaskRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: task.startedAt,
              completedAt: task.completedAt,
            },
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            node: {
              id: childRootNodeId,
              threadId: childThreadId,
              runId: null,
              parentNodeId: null,
              rootNodeId: childRootNodeId,
              kind: "root_turn",
              status,
              countsForRun: false,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: task.nativeTaskRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: task.startedAt,
              completedAt: task.completedAt,
            },
          });
          yield* emitProviderEvent({
            type: "subagent.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            subagent: task,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            turnItem: {
              id: subagent.turnItemId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              nodeId,
              providerThreadId: input.context.input.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: task.nativeTaskRef,
              parentItemId: null,
              ordinal: subagent.turnItemOrdinal,
              status,
              title: task.title,
              startedAt: task.startedAt,
              completedAt: task.completedAt,
              updatedAt: now,
              type: "subagent",
              subagentId: task.id,
              origin: task.origin,
              driver: task.driver,
              providerInstanceId: task.providerInstanceId,
              childThreadId,
              prompt: task.prompt,
              result: task.result,
            },
          });

          if (input.completed && !subagent.resultProjected) {
            for (const [index, nestedTool] of toolCallsFromConversationSteps(
              result?.conversationSteps ?? [],
            ).entries()) {
              const callId = `${nativeItemId}:child-tool:${nestedTool.callId || index + 1}`;
              const startedAt = task.startedAt ?? now;
              const active: ActiveCursorToolCall = {
                callId,
                toolCall: nestedTool.toolCall,
                target: {
                  threadId: childThreadId,
                  runId: null,
                  rootNodeId: childRootNodeId,
                  parentNodeId: childRootNodeId,
                  providerThreadId: null,
                  providerTurnId: null,
                },
                ordinal: ++subagent.nextChildOrdinal,
                startedAt,
                streamedOutput: "",
              };
              yield* emitToolArtifacts({ active, completed: true });
            }
            if (task.result !== null && task.result.length > 0) {
              const resultNativeId = `${nativeItemId}:result`;
              const resultArtifacts = makeSubagentConversationArtifacts({
                messageId: idAllocator.derive.messageFromProviderItem({
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
                  nativeItemId: resultNativeId,
                }),
                turnItemId: idAllocator.derive.turnItemFromProviderItem({
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
                  nativeItemId: resultNativeId,
                }),
                threadId: childThreadId,
                rootNodeId: childRootNodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: {
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
                  nativeId: resultNativeId,
                  strength: "weak",
                },
                role: "assistant",
                text: task.result,
                ordinal: ++subagent.nextChildOrdinal,
                now,
              });
              yield* emitProviderEvent({
                type: "message.updated",
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                message: resultArtifacts.message,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                turnItem: resultArtifacts.turnItem,
              });
            }
            subagent.resultProjected = true;
          }
        });

        const handleToolUpdate = Effect.fnUntraced(function* (
          context: ActiveCursorTurn,
          update: Extract<
            InteractionUpdate,
            {
              readonly type: "tool-call-started" | "partial-tool-call" | "tool-call-completed";
            }
          >,
        ) {
          const completed = update.type === "tool-call-completed";
          const toolCall = update.toolCall;
          switch (toolCall.type) {
            case "createPlan":
              yield* emitPlanArtifacts({
                context,
                callId: update.callId,
                markdown: toolCall.args.plan,
                completed,
                failed: completed && cursorToolFailed(toolCall),
              });
              return;
            case "updateTodos":
              yield* emitTodoArtifacts({
                context,
                callId: update.callId,
                toolCall,
                completed,
                failed: completed && cursorToolFailed(toolCall),
              });
              return;
            case "task":
              if (update.type === "partial-tool-call") {
                return;
              }
              yield* emitSubagent({
                context,
                callId: update.callId,
                toolCall,
                completed,
              });
              return;
            default: {
              const active = yield* ensureToolStarted(context, update.callId, toolCall);
              active.toolCall = toolCall;
              if (update.type !== "tool-call-started") {
                yield* emitToolArtifacts({ active, completed });
              }
              if (completed) {
                context.tools.delete(update.callId);
              }
            }
          }
        });

        const shellOutputText = (event: Record<string, unknown>): string => {
          const candidates = [
            event.text,
            event.output,
            event.data,
            event.stdout,
            event.stderr,
            event.chunk,
          ];
          return candidates.filter((value): value is string => typeof value === "string").join("");
        };

        const handleInteractionUpdate = Effect.fnUntraced(function* (
          context: ActiveCursorTurn,
          update: InteractionUpdate,
        ) {
          if (context.finalized) {
            return;
          }
          if (update.type === "turn-ended") {
            context.turnEnded = true;
          } else if (
            update.type === "step-started" ||
            update.type === "user-message-appended" ||
            update.type === "text-delta" ||
            update.type === "thinking-delta" ||
            update.type === "partial-tool-call" ||
            update.type === "tool-call-started"
          ) {
            context.turnEnded = false;
          }
          switch (update.type) {
            case "text-delta":
              // Classify each assistant message on its own, so earlier
              // commentary does not hide a later standalone transport dump.
              if (context.assistant.current === null) {
                context.assistantReply = new CursorTransportFailure();
              }
              context.assistantReply.push(update.text);
              yield* completeReasoning(context);
              yield* appendTextSegment({
                context,
                stream: context.assistant,
                kind: "assistant",
                text: update.text,
              });
              yield* emitAssistant(context, false);
              return;
            case "thinking-delta":
              yield* completeAssistant(context);
              yield* appendTextSegment({
                context,
                stream: context.reasoning,
                kind: "reasoning",
                text: update.text,
              });
              yield* emitReasoning(context, false);
              return;
            case "thinking-completed":
              yield* completeReasoning(context);
              return;
            case "tool-call-started":
            case "partial-tool-call":
            case "tool-call-completed":
              yield* completeAssistant(context);
              yield* completeReasoning(context);
              yield* handleToolUpdate(context, update);
              return;
            case "step-completed":
            case "turn-ended":
              yield* completeAssistant(context);
              yield* completeReasoning(context);
              return;
            case "shell-output-delta": {
              const shell = Array.from(context.tools.values())
                .toReversed()
                .find((candidate) => candidate.toolCall.type === "shell");
              if (shell === undefined) {
                return;
              }
              const chunk = shellOutputText(update.event);
              if (chunk.length === 0) return;
              // Persist output once; live hub deltas avoid quadratic event-store growth.
              shell.streamedOutput = (shell.streamedOutput + chunk).slice(
                -MAX_CURSOR_STREAMED_OUTPUT_CHARS,
              );
              yield* emitProviderEvent({
                type: "command_output.delta",
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                threadId: shell.target.threadId,
                itemId: idAllocator.derive.turnItemFromProviderItem({
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
                  nativeItemId: shell.callId,
                }),
                chunk,
              });
              return;
            }
            default:
              return;
          }
        });
  return { emitAssistant, emitReasoning, appendTextSegment, completeAssistant, completeReasoning, emitToolArtifacts, ensureToolStarted, emitPlanArtifacts, emitTodoArtifacts, emitSubagent, handleToolUpdate, shellOutputText, handleInteractionUpdate };
});

const CURSOR_RESUME_NO_PROGRESS_MESSAGE =
  "Agent turn stopped after repeated resume attempts made no progress";

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function cursorToolOutput(toolCall: ToolCall): unknown {
  const result = toolCall.result;
  if (result === undefined) {
    return undefined;
  }
  return result.status === "success" ? result.value : result.error;
}

function cursorToolName(toolCall: ToolCall): string {
  if (toolCall.type !== "mcp") {
    return toolCall.type;
  }
  const provider = toolCall.args.providerIdentifier ?? "mcp";
  const tool = toolCall.args.toolName ?? "unknown";
  return `mcp__${provider}__${tool}`;
}

function cursorToolSearchPattern(toolCall: ToolCall): string | undefined {
  switch (toolCall.type) {
    case "glob":
      return toolCall.args.globPattern;
    case "grep":
      return toolCall.args.pattern;
    case "semSearch":
      return toolCall.args.query;
    case "ls":
      return toolCall.args.path;
    case "readLints":
      return toolCall.args.paths.join(", ");
    default:
      return undefined;
  }
}

function cursorToolSearchResults(
  toolCall: ToolCall,
  path: Path.Path,
): ReadonlyArray<{
  readonly fileName: string;
  readonly line?: number;
  readonly column?: number;
  readonly preview?: string;
}> {
  if (toolCall.result?.status !== "success") {
    return [];
  }
  switch (toolCall.type) {
    case "glob":
      return toolCall.result.value.files.map((fileName) => ({ fileName }));
    case "grep":
      return Object.values(toolCall.result.value.workspaceResults ?? {}).flatMap((result) => {
        if (result.type === "files") {
          return result.output.files.map((fileName) => ({ fileName }));
        }
        if (result.type === "count") {
          return result.output.counts.map((entry) => ({
            fileName: entry.file,
            preview: `${entry.count} ${entry.count === 1 ? "match" : "matches"}`,
          }));
        }
        return result.output.matches.map((entry) => ({
          fileName: entry.file,
          ...(entry.lineNumber === undefined ? {} : { line: entry.lineNumber }),
          preview: entry.line,
        }));
      });
    case "ls":
      return cursorLsSearchResults(toolCall.result.value.directoryTreeRoot, path);
    case "readLints":
      return toolCall.result.value.fileDiagnostics.flatMap((file) =>
        file.diagnostics.map((diagnostic) => {
          const line = diagnostic.range?.start?.line;
          const character = diagnostic.range?.start?.character;
          const hasLine = typeof line === "number" && Number.isInteger(line) && line >= 0;
          return {
            fileName: file.path,
            ...(hasLine ? { line: line + 1 } : {}),
            ...(hasLine &&
            typeof character === "number" &&
            Number.isInteger(character) &&
            character >= 0
              ? { column: character + 1 }
              : {}),
            preview: diagnostic.message,
          };
        }),
      );
    case "semSearch":
      return [
        {
          fileName: "semantic-search",
          preview: toolCall.result.value.results,
        },
      ];
    default:
      return [];
  }
}

function cursorTodoSteps(
  toolCall: Extract<ToolCall, { readonly type: "updateTodos" }>,
): ReadonlyArray<OrchestrationV2PlanStep> {
  const todos =
    toolCall.result?.status === "success" ? toolCall.result.value.todos : toolCall.args.todos;
  return todos
    .filter((todo) => todo.status !== "cancelled" && todo.content.trim().length > 0)
    .map((todo, index) => ({
      id: `todo-${index + 1}`,
      text: todo.content,
      status:
        todo.status === "inProgress"
          ? "running"
          : todo.status === "completed"
            ? "completed"
            : "pending",
    }));
}

function assistantTextsFromConversationSteps(steps: ReadonlyArray<unknown>): ReadonlyArray<string> {
  return steps.flatMap((step) => {
    const record = unknownRecord(step);
    if (record?.type === "assistantMessage") {
      const text = nestedString(record, ["message", "text"]);
      return text === undefined || text.length === 0 ? [] : [text];
    }
    const text = nestedString(record, ["assistantMessage", "text"]);
    return text === undefined || text.length === 0 ? [] : [text];
  });
}

function toolCallsFromConversationSteps(
  steps: ReadonlyArray<unknown>,
): ReadonlyArray<{ readonly callId: string; readonly toolCall: ToolCall }> {
  return steps.flatMap((step) => {
    const record = unknownRecord(step);
    if (record?.type === "toolCall") {
      const message = unknownRecord(record.message);
      return typeof message?.type === "string"
        ? [
            {
              callId: typeof record.callId === "string" ? record.callId : `nested-${message.type}`,
              toolCall: message as ToolCall,
            },
          ]
        : [];
    }
    const envelope = unknownRecord(record?.toolCall);
    const nested = envelope === undefined ? undefined : nestedToolCallFromEnvelope(envelope);
    return nested === undefined ? [] : [nested];
  });
}

const MAX_CURSOR_STREAMED_OUTPUT_CHARS = 256 * 1024;
// After a turn ends, a retryable stream error can make Cursor's SDK resume from
// an older checkpoint inside the same run. When those resumes save nothing, it
// ends the run with this error even though the answer was already delivered.

function cursorLsSearchResults(
  node: CursorLsDirectoryNode,
  path: Path.Path,
): ReadonlyArray<{ readonly fileName: string }> {
  return [
    ...node.childrenFiles.map((file) => ({ fileName: path.join(node.absPath, file.name) })),
    ...node.childrenDirs.flatMap((child) => cursorLsSearchResults(child, path)),
  ];
}

function nestedString(value: unknown, keys: ReadonlyArray<string>): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    current = unknownRecord(current)?.[key];
  }
  return typeof current === "string" ? current : undefined;
}

export function nestedToolCallFromEnvelope(
  envelope: Record<string, unknown>,
): { readonly callId: string; readonly toolCall: ToolCall } | undefined {
  const callId = typeof envelope.toolCallId === "string" ? envelope.toolCallId : undefined;
  const wrapperEntry = Object.entries(envelope).find(([key]) => key.endsWith("ToolCall"));
  if (wrapperEntry === undefined) {
    return undefined;
  }
  const [wrapperName, rawCall] = wrapperEntry;
  const call = unknownRecord(rawCall);
  if (call === undefined) {
    return undefined;
  }
  const args = unknownRecord(call.args) ?? {};
  const fallbackCallId = `nested-${wrapperName}`;
  const nestedCallId = callId ?? fallbackCallId;

  switch (wrapperName) {
    case "readToolCall": {
      const success = unknownRecord(unknownRecord(call.result)?.success);
      const path =
        typeof args.path === "string"
          ? args.path
          : typeof success?.path === "string"
            ? success.path
            : "<unknown path>";
      return {
        callId: nestedCallId,
        toolCall: {
          type: "read",
          args: { path },
          result: nestedToolResult(call.result, (value) => ({
            content: typeof value.content === "string" ? value.content : "",
            totalLines: typeof value.totalLines === "number" ? value.totalLines : 0,
            fileSize: typeof value.fileSize === "number" ? value.fileSize : 0,
          })),
        } as unknown as ToolCall,
      };
    }
    case "globToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "glob",
          args: {
            globPattern: typeof args.globPattern === "string" ? args.globPattern : "**/*",
            ...(typeof args.targetDirectory === "string"
              ? { targetDirectory: args.targetDirectory }
              : {}),
          },
          result: nestedToolResult(call.result, (value) => ({
            files: Array.isArray(value.files)
              ? value.files.filter((file): file is string => typeof file === "string")
              : [],
            totalFiles: typeof value.totalFiles === "number" ? value.totalFiles : 0,
            clientTruncated: false,
            ripgrepTruncated: false,
          })),
        } as unknown as ToolCall,
      };
    case "grepToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "grep",
          args: {
            pattern: typeof args.pattern === "string" ? args.pattern : "",
            ...(typeof args.path === "string" ? { path: args.path } : {}),
            ...(typeof args.glob === "string" ? { glob: args.glob } : {}),
            ...(typeof args.outputMode === "string" ? { outputMode: args.outputMode } : {}),
            ...(typeof args.caseInsensitive === "boolean"
              ? { caseInsensitive: args.caseInsensitive }
              : {}),
            ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
            ...(typeof args.multiline === "boolean" ? { multiline: args.multiline } : {}),
          },
          result: nestedToolResult(call.result, (value) => ({
            workspaceResults: nestedGrepWorkspaceResults(value),
          })),
        } as unknown as ToolCall,
      };
    case "shellToolCall": {
      const rawResult = unknownRecord(call.result);
      const permissionDenied = unknownRecord(rawResult?.permissionDenied);
      const command =
        typeof args.command === "string"
          ? args.command
          : typeof permissionDenied?.command === "string"
            ? permissionDenied.command
            : "<unknown command>";
      return {
        callId: nestedCallId,
        toolCall: {
          type: "shell",
          args: { command },
          result: nestedToolResult(call.result, (value) => ({
            stdout: typeof value.stdout === "string" ? value.stdout : "",
            stderr: typeof value.stderr === "string" ? value.stderr : "",
            exitCode: typeof value.exitCode === "number" ? value.exitCode : 0,
            signal: typeof value.signal === "string" ? value.signal : "",
            executionTime: typeof value.executionTime === "number" ? value.executionTime : 0,
          })),
        } as unknown as ToolCall,
      };
    }
    case "lsToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "ls",
          args: { path: typeof args.path === "string" ? args.path : "" },
          result: nestedToolResult(call.result, (value) => ({
            directoryTreeRoot: nestedLsDirectory(value.directoryTreeRoot),
          })),
        } as unknown as ToolCall,
      };
    case "readLintsToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "readLints",
          args: {
            paths: nestedArray(args.paths).filter(
              (path): path is string => typeof path === "string",
            ),
          },
          result: nestedToolResult(call.result, (value) => ({
            fileDiagnostics: nestedArray(value.fileDiagnostics).map((rawFile) => {
              const file = unknownRecord(rawFile);
              return {
                path: typeof file?.path === "string" ? file.path : "",
                diagnostics: nestedArray(file?.diagnostics).flatMap((rawDiagnostic) => {
                  const diagnostic = unknownRecord(rawDiagnostic);
                  return diagnostic === undefined
                    ? []
                    : [
                        {
                          ...diagnostic,
                          message: typeof diagnostic.message === "string" ? diagnostic.message : "",
                        },
                      ];
                }),
              };
            }),
            totalFiles: typeof value.totalFiles === "number" ? value.totalFiles : 0,
            totalDiagnostics:
              typeof value.totalDiagnostics === "number" ? value.totalDiagnostics : 0,
          })),
        } as unknown as ToolCall,
      };
    case "mcpToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "mcp",
          args,
          result: nestedToolResult(call.result, (value) => ({
            content: nestedArray(value.content).flatMap((rawPart) => {
              const part = unknownRecord(rawPart);
              return part === undefined ? [] : [part];
            }),
            isError: value.isError === true,
          })),
        } as unknown as ToolCall,
      };
    default: {
      const type = wrapperName.slice(0, -"ToolCall".length);
      return {
        callId: nestedCallId,
        toolCall: {
          type,
          args,
          result: nestedToolResult(call.result),
        } as unknown as ToolCall,
      };
    }
  }
}

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type CursorLsDirectoryNode = Extract<
  Extract<ToolCall, { readonly type: "ls" }>["result"],
  { readonly status: "success" }
>["value"]["directoryTreeRoot"];

function nestedArray(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

function nestedGrepWorkspaceResults(success: Record<string, unknown>): Record<string, unknown> {
  const workspaces = unknownRecord(success.workspaceResults);
  if (workspaces === undefined) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(workspaces).map(([workspace, rawWorkspaceResult]) => {
      const workspaceResult = unknownRecord(rawWorkspaceResult);
      const content = unknownRecord(workspaceResult?.content);
      const rawMatches = Array.isArray(content?.matches) ? content.matches : [];
      const matches = rawMatches.flatMap((rawFileMatch) => {
        const fileMatch = unknownRecord(rawFileMatch);
        const file = typeof fileMatch?.file === "string" ? fileMatch.file : "";
        const lineMatches = Array.isArray(fileMatch?.matches) ? fileMatch.matches : [];
        return lineMatches.flatMap((rawLineMatch) => {
          const lineMatch = unknownRecord(rawLineMatch);
          if (lineMatch === undefined) {
            return [];
          }
          const line = typeof lineMatch.content === "string" ? lineMatch.content : undefined;
          if (file.length === 0 || line === undefined) {
            return [];
          }
          return [
            {
              file,
              line,
              ...(typeof lineMatch.lineNumber === "number"
                ? { lineNumber: lineMatch.lineNumber }
                : {}),
            },
          ];
        });
      });
      return [
        workspace,
        {
          type: "content",
          output: {
            matches,
            totalMatches:
              typeof content?.totalMatchedLines === "number"
                ? content.totalMatchedLines
                : matches.length,
          },
        },
      ];
    }),
  );
}

function nestedLsDirectory(rawNode: unknown): CursorLsDirectoryNode {
  const node = unknownRecord(rawNode);
  return {
    absPath: typeof node?.absPath === "string" ? node.absPath : "",
    childrenDirs: nestedArray(node?.childrenDirs).map(nestedLsDirectory),
    childrenFiles: nestedArray(node?.childrenFiles).flatMap((rawFile) => {
      const name = unknownRecord(rawFile)?.name;
      return typeof name === "string" ? [{ name }] : [];
    }),
    childrenWereProcessed: node?.childrenWereProcessed === true,
    fullSubtreeExtensionCounts: Object.fromEntries(
      Object.entries(unknownRecord(node?.fullSubtreeExtensionCounts) ?? {}).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    ),
    numFiles: typeof node?.numFiles === "number" ? node.numFiles : 0,
  };
}

function nestedToolResult<Value = Record<string, unknown>>(
  rawResult: unknown,
  mapSuccess: (success: Record<string, unknown>) => Value = (success) => success as Value,
):
  | { readonly status: "success"; readonly value: Value }
  | { readonly status: "error"; readonly error: unknown }
  | undefined {
  const result = unknownRecord(rawResult);
  if (result === undefined) {
    return undefined;
  }
  const success = unknownRecord(result.success);
  if (success !== undefined) {
    return {
      status: "success",
      value: mapSuccess(success),
    };
  }
  return {
    status: "error",
    error: result.error ?? result.permissionDenied ?? result,
  };
}
