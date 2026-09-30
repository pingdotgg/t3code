import type * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import * as FcmDeliveries from "./FcmDeliveries.ts";

export const processMessage = Effect.fn("relay.fcm_delivery_queue.process_message")(function* (
  message: Cloudflare.Queues.Message<unknown>,
) {
  const deliveries = yield* FcmDeliveries.FcmDeliveries;
  yield* deliveries.process(message.body).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.gen(function* () {
          // Decide this message's outcome before Alchemy acknowledges the batch.
          // Cloudflare keeps the first ack/retry decision for each message.
          message.retry();
          yield* Effect.logWarning("FCM queue delivery failed; retrying message", {
            messageId: message.id,
            errorTag: error._tag,
          });
        }),
      onSuccess: () => Effect.sync(() => message.ack()),
    }),
  );
});
