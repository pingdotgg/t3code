// @effect-diagnostics nodeBuiltinImport:off
import type { ToolCall } from "@cursor/sdk";
import { formatReadToolLabel, formatSearchToolLabel } from "@t3tools/shared/toolActivity";
import {
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import type { ActiveCursorTurn, CursorProjectionTarget } from "./adapter.ts";
import type { ActiveCursorToolCall } from "./adapter.ts";

import type { MakeCursorAdapterProjectionDeps } from "./cursorAdapterProjection.ts";
import {
  cursorToolFileName,
  cursorToolOutputText,
  cursorToolFailed,
  cursorToolOutput,
  cursorToolName,
  cursorToolSearchPattern,
  cursorToolSearchResults,
  cursorTodoSteps,
} from "./cursorAdapterProjectionSupport.ts";

/** Tool, plan and todo artifact projection for one Cursor turn. */
export const makeCursorProjectionTools = (deps: MakeCursorAdapterProjectionDeps) => {
  const { emitProviderEvent, parentTarget, resolvePlanId, resolveItemOrdinal, path, idAllocator } =
    deps;
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

  return {
    emitToolArtifacts,
    ensureToolStarted,
    emitPlanArtifacts,
    emitTodoArtifacts,
  };
};
