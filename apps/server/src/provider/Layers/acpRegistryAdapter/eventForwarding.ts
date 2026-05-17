import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpToolCallEvent,
} from "../../acp/AcpCoreRuntimeEvents.ts";
import type { AcpMultiSessionShape } from "../../acp/AcpMultiSession.ts";

import type { AcpRegistryHandlerContext, AcpRegistrySessionContext } from "./types.ts";

export function forkAcpEventForwarder(input: {
  readonly acp: AcpMultiSessionShape;
  readonly getSessionContext: () => AcpRegistrySessionContext;
  readonly context: AcpRegistryHandlerContext;
}) {
  return Stream.runDrain(
    Stream.mapEffect(input.acp.getEvents(), (event) =>
      Effect.gen(function* () {
        const ctx = input.getSessionContext();
        switch (event._tag) {
          case "AssistantItemStarted":
          case "AssistantItemCompleted":
            yield* input.context.offerRuntimeEvent(
              makeAcpAssistantItemEvent({
                stamp: yield* input.context.makeEventStamp(),
                provider: input.context.provider,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                itemId: event.itemId,
                lifecycle:
                  event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
              }),
            );
            return;
          case "ContentDelta":
            yield* input.context.offerRuntimeEvent(
              makeAcpContentDeltaEvent({
                stamp: yield* input.context.makeEventStamp(),
                provider: input.context.provider,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                ...(event.itemId ? { itemId: event.itemId } : {}),
                text: event.text,
                rawPayload: event.rawPayload,
              }),
            );
            return;
          case "ToolCallUpdated":
            yield* input.context.offerRuntimeEvent(
              makeAcpToolCallEvent({
                stamp: yield* input.context.makeEventStamp(),
                provider: input.context.provider,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                toolCall: event.toolCall,
                rawPayload: event.rawPayload,
              }),
            );
            return;
          case "PlanUpdated":
            yield* input.context.offerRuntimeEvent(
              makeAcpPlanUpdatedEvent({
                stamp: yield* input.context.makeEventStamp(),
                provider: input.context.provider,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                payload: event.payload,
                source: "acp.jsonrpc",
                method: "session/update",
                rawPayload: event.rawPayload,
              }),
            );
            return;
          case "ModeChanged":
            return;
        }
      }),
    ),
  ).pipe(Effect.forkChild);
}
