import { CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { IdAllocatorV2 } from "./IdAllocator.ts";
import {
  type ProviderContinuationRequest,
  ProviderContinuationRequests,
} from "./ProviderContinuationRequests.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

const CONTINUATION_MESSAGE_TEXT = "Background task completed.";

/**
 * Drains ProviderContinuationRequests and dispatches an internal
 * message.dispatch per request so the wake turn buffered by the adapter is
 * ingested as a normal run. Dispatches queue_after_active, so a continuation
 * racing a user run simply queues behind it and drains the wake buffer once
 * that run finishes.
 */
export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const ids = yield* IdAllocatorV2;
    const requests = yield* ProviderContinuationRequests;
    const threads = yield* ThreadManagementService;

    const dispatchContinuation = Effect.fn("ProviderContinuationService.dispatchContinuation")(
      function* (request: ProviderContinuationRequest) {
        const projection = yield* threads.getThreadProjection(request.threadId);
        if (projection.thread.archivedAt !== null) {
          yield* Effect.logInfo("orchestration-v2.provider-continuation.thread-archived", {
            threadId: request.threadId,
            providerThreadId: request.providerThreadId,
          });
          return;
        }
        const messageId = yield* ids.allocate.message({
          threadId: request.threadId,
          ordinal: projection.messages.length + 1,
        });
        const commandId = CommandId.make(`provider-continuation:${messageId}`);
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId: request.threadId,
          messageId,
          text: request.detail ?? CONTINUATION_MESSAGE_TEXT,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "provider",
        });
      },
    );

    yield* requests.take.pipe(
      Effect.flatMap((request) =>
        dispatchContinuation(request).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.provider-continuation.dispatch-failed", {
              threadId: request.threadId,
              providerThreadId: request.providerThreadId,
              cause,
            }),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
