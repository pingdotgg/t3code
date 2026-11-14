import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";

// #region show
export default AWS.Lambda.Function(
  "Archive",
  { main: import.meta.url },
  Effect.gen(function* () {
    const source = yield* AWS.SQS.Queue("Messages");

    yield* AWS.SQS.consumeQueueMessages(
      source,
      Effect.fn(function* (event) {
        yield* Effect.log(event.Records);
      }),
    );

    return {};
  }).pipe(Effect.provide(AWS.Lambda.QueueEventSource)),
);
// #endregion show
