import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

import * as ApnsDeliveries from "./ApnsDeliveries.ts";

export const processMessage = Effect.fn("relay.apn_delivery_queue.process_message")(function* (
  message: Cloudflare.Queues.Message<unknown>,
) {
  const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
  yield* deliveries.processSignedJob(message.body).pipe(
    Effect.matchEffect({
      // The enclosing process_message span covers this handler.
      onFailure: Effect.fnUntraced(function* (error) {
        // Cloudflare keeps the first ack/retry decision, before Alchemy acknowledges the batch.
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
