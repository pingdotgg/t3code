import * as DynamoDB from "@alchemy.run/aws/DynamoDB";
import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

// One Function consuming a DynamoDB stream. Each deploy varies the Table or the
// stream subscription to drive a different EventSourceMapping transition.
export class EventSourceMappingTableFunction extends Lambda.Function<EventSourceMappingTableFunction>()(
  "EventSourceMappingTableFunction",
) {}

export interface TableFunctionOptions {
  tags?: Record<string, string>;
  partitionKey?: string;
  streamViewType?: "NEW_AND_OLD_IMAGES" | "KEYS_ONLY";
  startingPosition?: "LATEST" | "TRIM_HORIZON";
}

export const makeTableFunction = ({
  tags = {},
  partitionKey = "pk",
  streamViewType = "NEW_AND_OLD_IMAGES",
  startingPosition = "LATEST",
}: TableFunctionOptions = {}) =>
  EventSourceMappingTableFunction.make(
    {
      main: import.meta.url,
      functionUrl: false,
    },
    Effect.gen(function* () {
      const table = yield* DynamoDB.Table("EventSourceMappingTable", {
        partitionKey,
        attributes: { [partitionKey]: "S" },
        tags,
      });

      yield* DynamoDB.consumeTableChanges(
        table,
        { streamViewType, startingPosition },
        () => Effect.void,
      );

      return {
        fetch: Effect.gen(function* () {
          return HttpServerResponse.text("ok");
        }).pipe(Effect.orDie),
      };
    }).pipe(Effect.provide(Layer.mergeAll(Lambda.TableEventSource))),
  );

export default makeTableFunction();
