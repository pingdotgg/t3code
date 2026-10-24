import type * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import * as ApnsDeliveries from "./ApnsDeliveries.ts";

export const processMessage = Effect.fn("relay.apn_delivery_queue.process_message")(function* (
  message: Cloudflare.Queues.Message<unknown>,
) {
  const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
  yield* deliveries.processSignedJob(message.body).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.gen(function* () {
          // Decide this message's outcome before Alchemy acknowledges the batch.
          // Cloudflare keeps the first ack/retry decision for each message.
          message.retry();
          yield* Effect.logWarning("APNs queue delivery failed; retrying message", {
            messageId: message.id,
            errorTag: error._tag,
          });
        }),
      onSuccess: () => Effect.sync(() => message.ack()),
    }),
  );
});
