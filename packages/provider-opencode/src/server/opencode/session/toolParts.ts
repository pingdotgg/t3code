/**
 * OpenCode tool part projection, including subagent tool calls.
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
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import * as OpenCodeRuntime from "../../OpenCodeRuntime.ts";
import { openCodeCommandFailed, openCodeToolTurnItem } from "../../toolItems.ts";
import {
  providerRef,
} from "../projection.ts";
import {
  OPENCODE_PROVIDER,
} from "../provider.ts";
import {
  toolCompletedAt,
  toolInput,
  toolOutput,
  toolStartedAt,
  toolStatus,
  toolTitle,
} from "../tools.ts";
import type {
  ActiveOpenCodeTurn,
  OpenCodeThreadState,
} from "../types.ts";
import type { Items } from "./items.ts";
import type { Subagents } from "./subagents.ts";
import type { State } from "./base.ts";

export const makeToolParts = (deps: State & Items & Subagents) => {
  const {
    input,
    client,
    idAllocator,
    now,
    emitProviderEvent,
  } = deps;
  const m = deps.mutable;
  const emitToolPart = Effect.fnUntraced(function* (
    state: OpenCodeThreadState,
    turn: ActiveOpenCodeTurn,
    part: ToolPart,
  ) {
    const normalizedTool = part.tool.toLowerCase();
    if (normalizedTool === "task") {
      yield* deps.emitSubagent(state, turn, part);
      return;
    }
    if (normalizedTool === "question") return;
    const now = yield* DateTime.now;
    const status = toolStatus(part);
    const startedAt = toolStartedAt(part, now);
    const completedAt = toolCompletedAt(part, now);
    const nativeItemRef = providerRef(part.id);
    const nodeId = idAllocator.derive.nodeFromProviderItem({
      driver: OPENCODE_PROVIDER,
      nativeItemId: part.id,
    });
    const turnItemId = idAllocator.derive.turnItemFromProviderItem({
      driver: OPENCODE_PROVIDER,
      nativeItemId: part.id,
    });
    const base = {
      id: turnItemId,
      threadId: turn.threadId,
      runId: turn.runId,
      nodeId,
      providerThreadId: state.providerThread.id,
      providerTurnId: turn.providerTurnId,
      nativeItemRef,
      parentItemId: null,
      ordinal: deps.itemOrdinal(turn, part.id),
      status: status.item,
      title: toolTitle(part),
      startedAt,
      completedAt,
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
    const input = toolInput(part);
    const output = toolOutput(part);
    const isNativeTool = part.tool === "code_search" || part.tool === "apply_patch";
    if (!isNativeTool && part.tool.includes("_") && turn.mcpServerNames === undefined) {
      const serverNames = yield* OpenCodeRuntime.runOpenCodeSdk("mcp.status", (signal) =>
        client.mcp.status(undefined, { signal, throwOnError: true }),
      ).pipe(
        Effect.timeout("1 second"),
        Effect.map((response) => Object.keys(response.data ?? {})),
        Effect.catch(() => Effect.void),
      );
      if (serverNames !== undefined) turn.mcpServerNames = serverNames;
    }
    const matchingServers = turn.mcpServerNames?.filter(
      (name) =>
        !isNativeTool && part.tool.startsWith(`${name.replace(/[^a-zA-Z0-9_-]/g, "_")}_`),
    );
    const serverName = matchingServers?.length === 1 ? matchingServers[0] : undefined;
    const presentation =
      serverName === undefined
        ? {}
        : mcpToolPresentation({
            serverName,
            toolName: part.tool.slice(serverName.replace(/[^a-zA-Z0-9_-]/g, "_").length + 1),
            title: toolTitle(part) === part.tool ? undefined : toolTitle(part),
          });
    const turnItem: OrchestrationV2TurnItem = matchingServers?.length
      ? {
          ...base,
          type: "dynamic_tool",
          ...presentation,
          toolName: part.tool,
          input,
          ...(output === undefined ? {} : { output }),
        }
      : openCodeToolTurnItem(base, {
          name: part.tool,
          input,
          output,
          completedMetadata:
            part.state.status === "completed" ? part.state.metadata : undefined,
        });
    yield* emitProviderEvent({
      type: "node.updated",
      driver: OPENCODE_PROVIDER,
      node: {
        id: nodeId,
        threadId: turn.threadId,
        runId: turn.runId,
        parentNodeId: turn.rootNodeId,
        rootNodeId: turn.rootNodeId,
        kind: "tool_call",
        status: status.node,
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
    yield* emitProviderEvent({
      type: "turn_item.updated",
      driver: OPENCODE_PROVIDER,
      turnItem,
    });
  });

  return { emitToolPart };
};

export type ToolParts = ReturnType<typeof makeToolParts>;
