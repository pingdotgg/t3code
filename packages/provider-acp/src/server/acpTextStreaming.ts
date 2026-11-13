// ACP session behaviour extracted from server/adapter.ts (textStreaming).

import {
  type ActiveAcpTurn,
  type ActiveTextStream,
  type ActiveTextSegment,
} from "./acpTurnModel.ts";
import { ACP_TEXT_FLUSH_INTERVAL } from "./acpAdapterConfig.ts";
import { type OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type { AcpSessionCtx3 } from "./acpSessionContext.ts";

export const createAcpTextStreaming = Effect.fn("acpSession.textStreaming")(function* (ctx: AcpSessionCtx3) {
  const rememberSnapshotMessage = (message: OrchestrationV2ConversationMessage) =>
    Ref.update(ctx.snapshot, (current) => {
      const key = String(message.id);
      const exists = current.messages.has(key);
      const messages = new Map(current.messages);
      messages.set(key, message);
      return {
        ...current,
        order: exists ? current.order : [...current.order, key],
        messages,
      };
    });
  const textStreamFor = (
    context: ActiveAcpTurn,
    kind: "user" | "assistant" | "reasoning",
  ): ActiveTextStream =>
    kind === "user"
      ? context.user
      : kind === "assistant"
        ? context.assistant
        : context.reasoning;
  const textEmissionPermit = yield* Semaphore.make(1);
  const emitTextSegment = Effect.fnUntraced(function* (
    context: ActiveAcpTurn,
    kind: "user" | "assistant" | "reasoning",
    completed: boolean,
    flushOf?: ActiveTextSegment,
  ) {
    const stream = textStreamFor(context, kind);
    const segment = stream.current;
    if (segment === null) return;
    if (flushOf !== undefined && (segment !== flushOf || !segment.dirty)) return;
    // The node carries no text, so it changes only when the segment
    // opens and when it completes.
    const emitsNode = completed || !segment.emitted;
    segment.emitted = true;
    segment.dirty = false;
    // Read the text in the same step that clears `dirty`. Chunks keep
    // appending while this emission yields; each one marks the segment
    // dirty again and reaches the next flush or the close.
    const text = segment.text;
    const now = yield* DateTime.now;
    const ordinal = yield* ctx.resolveItemOrdinal(context, segment.nativeItemId);
    const nodeId = ctx.providerNodeId(segment.nativeItemId);
    const turnItemId = ctx.providerTurnItemId(segment.nativeItemId);
    const nativeItemRef = {
      driver: ctx.driver,
      nativeId: segment.nativeItemId,
      strength: "weak" as const,
    };
    if (kind !== "user" && emitsNode) {
      yield* ctx.emitProviderEvent({
        type: "node.updated",
        driver: ctx.driver,
        node: {
          id: nodeId,
          threadId: context.input.threadId,
          runId: context.input.runId,
          parentNodeId: context.input.rootNodeId,
          rootNodeId: context.input.rootNodeId,
          kind: kind === "assistant" ? "assistant_message" : "reasoning",
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
    }
    if (kind !== "reasoning") {
      const messageId = ctx.providerMessageId(segment.nativeItemId);
      const messageNodeId = kind === "user" ? context.input.rootNodeId : nodeId;
      const message: OrchestrationV2ConversationMessage = {
        createdBy: kind === "user" ? "user" : "agent",
        creationSource: "provider",
        id: messageId,
        threadId: context.input.threadId,
        runId: context.input.runId,
        nodeId: messageNodeId,
        role: kind,
        text,
        attachments: [],
        streaming: !completed,
        createdAt: segment.startedAt,
        updatedAt: now,
      };
      yield* ctx.emitProviderEvent({ type: "message.updated", driver: ctx.driver, message });
      yield* ctx.emitProviderEvent(
        kind === "user"
          ? {
              type: "turn_item.updated",
              driver: ctx.driver,
              turnItem: {
                createdBy: "user",
                creationSource: "provider",
                id: turnItemId,
                threadId: context.input.threadId,
                runId: context.input.runId,
                nodeId: messageNodeId,
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
                type: "user_message",
                messageId,
                inputIntent: "turn_start",
                text,
                attachments: [],
              },
            }
          : {
              type: "turn_item.updated",
              driver: ctx.driver,
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
                text,
                streaming: !completed,
              },
            },
      );
      if (completed) yield* rememberSnapshotMessage(message);
      return;
    }
    yield* ctx.emitProviderEvent({
      type: "turn_item.updated",
      driver: ctx.driver,
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
        text,
        streaming: !completed,
      },
    });
  }, textEmissionPermit.withPermit);
  const publishTextSegment = Effect.fnUntraced(function* (
    context: ActiveAcpTurn,
    kind: "user" | "assistant" | "reasoning",
  ) {
    const segment = textStreamFor(context, kind).current;
    if (segment === null) return;
    if (!segment.emitted) return yield* emitTextSegment(context, kind, false);
    if (segment.dirty) return;
    segment.dirty = true;
    yield* emitTextSegment(context, kind, false, segment).pipe(
      Effect.delay(ACP_TEXT_FLUSH_INTERVAL),
      Effect.forkIn(ctx.sessionScope),
    );
  });
  const closeTextStream = Effect.fnUntraced(function* (
    context: ActiveAcpTurn,
    kind: "user" | "assistant" | "reasoning",
  ) {
    const stream = textStreamFor(context, kind);
    if (stream.current === null) return;
    yield* emitTextSegment(context, kind, true);
    stream.current = null;
  });
  const closeTextStreams = Effect.fnUntraced(function* (context: ActiveAcpTurn) {
    yield* closeTextStream(context, "user");
    yield* closeTextStream(context, "reasoning");
    yield* closeTextStream(context, "assistant");
  });
  return {
    rememberSnapshotMessage,
    textStreamFor,
    textEmissionPermit,
    emitTextSegment,
    publishTextSegment,
    closeTextStream,
    closeTextStreams,
  };
});
