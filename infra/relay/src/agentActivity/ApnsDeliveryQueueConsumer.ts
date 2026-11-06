import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ApnsDeliveries from "./ApnsDeliveries.ts";
import { SignedApnsDeliveryJob } from "./apnsDeliveryJobs.ts";

const decodeJob = Schema.decodeUnknownOption(SignedApnsDeliveryJob);

export const processBatch = Effect.fn("relay.apn_delivery_queue.process_batch")(function* (
  stream: Stream.Stream<{ readonly body: unknown }>,
) {
  const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
  const messages = yield* Stream.runCollect(stream);
  const groups = Array.groupBy(messages, (message) => {
    const job = decodeJob(message.body);
    return Option.isSome(job)
      ? JSON.stringify([job.value.payload.target.userId, job.value.payload.target.deviceId])
      : "";
  });
  // Finish other devices before surfacing failures so their in-flight sends aren't cancelled.
  yield* Effect.validate(
    Object.values(groups),
    (group) =>
      Effect.forEach(
        group,
        (message) =>
          deliveries
            .processSignedJob(message.body)
            .pipe(Effect.withSpan("relay.apn_delivery_queue.process_message")),
        { discard: true },
      ),
    { concurrency: 10, discard: true },
  );
});
