import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";

// #region show
export default AWS.Lambda.Function(
  "Archive",
  { main: import.meta.url },
  Effect.gen(function* () {
    const source = yield* AWS.Kinesis.Stream("Messages");

    yield* AWS.Kinesis.consumeStreamRecords(
      source,
      { startingPosition: "LATEST" },
      Effect.fn(function* (event) {
        yield* Effect.log(event.Records);
      }),
    );

    return {};
  }).pipe(Effect.provide(AWS.Lambda.StreamEventSource)),
);
// #endregion show
