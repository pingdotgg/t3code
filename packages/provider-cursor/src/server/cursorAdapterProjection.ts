// @effect-diagnostics nodeBuiltinImport:off
import type { InteractionUpdate, ToolCall } from "@cursor/sdk";
import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CursorTransportFailure } from "./transportFailure.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import type { ActiveCursorTurn, CursorProjectionTarget } from "./adapter.ts";
import type { ActiveCursorToolCall } from "./adapter.ts";
import type { ActiveCursorSubagent } from "./adapter.ts";

import { makeCursorProjectionText } from "./cursorAdapterProjectionText.ts";
import { makeCursorProjectionTools } from "./cursorAdapterProjectionTools.ts";
import {
  cursorToolFailed,
  assistantTextsFromConversationSteps,
  toolCallsFromConversationSteps,
  MAX_CURSOR_STREAMED_OUTPUT_CHARS,
} from "./cursorAdapterProjectionSupport.ts";

export * from "./cursorAdapterProjectionSupport.ts";

export interface MakeCursorAdapterProjectionDeps {
  readonly idAllocator: Parameters<typeof IdAllocator.IdAllocatorV2.of>[0];
  readonly createdAt: DateTime.Utc;
  readonly emitProviderEvent: (
    event: ProviderAdapter.ProviderAdapterV2Event,
  ) => Effect.Effect<void>;
  readonly parentTarget: (context: ActiveCursorTurn) => CursorProjectionTarget;
  readonly resolvePlanId: (
    context: ActiveCursorTurn,
    nativeItemId: string,
  ) => Effect.Effect<OrchestrationV2PlanArtifact["id"], IdAllocator.IdAllocatorV2AllocationError>;
  readonly resolveItemOrdinal: (
    context: ActiveCursorTurn,
    nativeItemId: string,
  ) => Effect.Effect<number>;
  readonly path: import("effect/Path").Path;
}

export const makeCursorAdapterProjection = (deps: MakeCursorAdapterProjectionDeps) => {
  const { emitProviderEvent, resolveItemOrdinal } = deps;
  const { idAllocator } = deps;
  const { emitAssistant, emitReasoning, appendTextSegment, completeAssistant, completeReasoning } =
    makeCursorProjectionText(deps);
  const { emitToolArtifacts, ensureToolStarted, emitPlanArtifacts, emitTodoArtifacts } =
    makeCursorProjectionTools(deps);
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
      (input.completed ? (cursorToolFailed(input.toolCall) ? "failed" : "completed") : "running");
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
  return {
    emitAssistant,
    emitReasoning,
    appendTextSegment,
    completeAssistant,
    completeReasoning,
    emitToolArtifacts,
    ensureToolStarted,
    emitPlanArtifacts,
    emitTodoArtifacts,
    emitSubagent,
    handleToolUpdate,
    shellOutputText,
    handleInteractionUpdate,
  };
};
