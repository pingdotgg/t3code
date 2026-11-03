import {
  CommandId,
  IDLE_COMPACTION_TEXT,
  MessageId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { CONTEXT_COMPACTION_REQUIRED_CODE } from "@t3tools/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";

const COMPACTION_MESSAGE_PREFIX = "context-compact:";

/**
 * When a turn cannot start because its native session is full, compacts that
 * session as a visible turn, then continues. The failed request reaches the
 * provider as missed-request history on the continuation.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;

  const react = Effect.fn("ContextCompactionService.react")(
    function* (event: OrchestrationV2DomainEvent) {
      if (
        event.type === "turn-item.updated" &&
        event.payload.type === "error" &&
        event.payload.failure.code === CONTEXT_COMPACTION_REQUIRED_CODE &&
        event.payload.runId !== null
      ) {
        const failedRunId = event.payload.runId;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:context-compact:${failedRunId}`),
          messageId: MessageId.make(`${COMPACTION_MESSAGE_PREFIX}${failedRunId}`),
          threadId: event.threadId,
          text: IDLE_COMPACTION_TEXT,
          attachments: [],
          createdBy: "agent",
          creationSource: "server",
          idleCompaction: "onReturn",
          dispatchMode: { type: "start_immediately" },
        });
        return;
      }
      if (
        event.type === "run.updated" &&
        event.payload.status === "completed" &&
        event.payload.userMessageId.startsWith(COMPACTION_MESSAGE_PREFIX)
      ) {
        // Dispatched after the compaction so it runs even while the failure holds the queue.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:context-compact-continue:${event.payload.id}`),
          messageId: MessageId.make(`context-compact-continue:${event.payload.id}`),
          threadId: event.threadId,
          text: "Continue where you left off.",
          attachments: [],
          createdBy: "user",
          creationSource: "server",
          dispatchMode: { type: "start_immediately" },
        });
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("context compaction skipped", { threadId: event.threadId, cause }),
        ),
      ),
  );

  const start = Effect.fn("ContextCompactionService.start")(function* () {
    yield* forkParked(Stream.runForEach(orchestrator.streamDomainEvents, react));
  });
  return { start };
});
