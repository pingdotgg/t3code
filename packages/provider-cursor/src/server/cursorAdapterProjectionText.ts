// @effect-diagnostics nodeBuiltinImport:off
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import type { ActiveCursorTurn, CursorProjectionTarget } from "./adapter.ts";
import type { ActiveCursorTextStream, ActiveCursorToolCall } from "./adapter.ts";

import type { MakeCursorAdapterProjectionDeps } from "./cursorAdapterProjection.ts";

/** Assistant and reasoning text projection for one Cursor turn. */
export const makeCursorProjectionText = (deps: MakeCursorAdapterProjectionDeps) => {
  const { emitProviderEvent, resolveItemOrdinal, idAllocator } = deps;
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

  return {
    emitAssistant,
    emitReasoning,
    appendTextSegment,
    completeAssistant,
    completeReasoning,
  };
};
