import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";

// #region show
export default AWS.Lambda.Function(
  "Archive",
  { main: import.meta.url },
  Effect.gen(function* () {
    const source = yield* AWS.DynamoDB.Table("Messages", {
      partitionKey: "room",
      attributes: { room: "S" },
    });

    yield* AWS.DynamoDB.consumeTableChanges(
      source,
      { streamViewType: "NEW_IMAGE" },
      Effect.fn(function* (event) {
        yield* Effect.log(event.Records);
      }),
    );

    return {};
  }).pipe(Effect.provide(AWS.Lambda.TableEventSource)),
);
// #endregion show
