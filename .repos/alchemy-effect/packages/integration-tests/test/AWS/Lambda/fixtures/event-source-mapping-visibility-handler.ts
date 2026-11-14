import * as Lambda from "@alchemy.run/aws/Lambda";
import * as SQS from "@alchemy.run/aws/SQS";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

// A 30-second Function reading a queue left at SQS's 30-second default
// visibility timeout. Lambda runs it for 31 seconds (`timeoutMargin`), which
// AWS refuses for an SQS event source.
export class EventSourceMappingVisibilityFunction extends Lambda.Function<EventSourceMappingVisibilityFunction>()(
  "EventSourceMappingVisibilityFunction",
) {}

export default EventSourceMappingVisibilityFunction.make(
  {
    main: import.meta.url,
    functionUrl: false,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const queue = yield* SQS.Queue("EventSourceMappingVisibilityQueue");

    yield* SQS.consumeQueueMessages(queue, () => Effect.void);

    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("ok");
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Lambda.QueueEventSource))),
);
