import * as Effect from "effect/Effect";

import * as FcmDeliveries from "./FcmDeliveries.ts";

// Throwing from the handler asks the host to retry the message; success acknowledges it.
export const processMessage = Effect.fn("relay.fcm_delivery_queue.process_message")(function* (
  body: unknown,
) {
  const deliveries = yield* FcmDeliveries.FcmDeliveries;
  yield* deliveries.process(body);
});
