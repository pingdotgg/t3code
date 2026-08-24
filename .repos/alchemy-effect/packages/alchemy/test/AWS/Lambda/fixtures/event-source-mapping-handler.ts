import * as Lambda from "@/AWS/Lambda";
import * as SQS from "@/AWS/SQS";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Minimal host Function for the EventSourceMapping `list()` test: it owns an
// SQS Queue and subscribes to it via `consumeQueueMessages(queue, ...)`, which
// (through the Lambda `QueueEventSource` layer + registered
// `QueueEventSourcePolicy`) creates the `AWS.Lambda.EventSourceMapping`
// resource and grants the role the SQS read permissions the mapping needs.
export class EventSourceMappingFunction extends Lambda.Function<EventSourceMappingFunction>()(
  "EventSourceMappingFunction",
) {}

export default EventSourceMappingFunction.make(
  {
    main: import.meta.url,
    url: false,
  },
  Effect.gen(function* () {
    const queue = yield* SQS.Queue("EventSourceMappingQueue");

    yield* SQS.consumeQueueMessages(queue, (stream) =>
      stream.pipe(Stream.runDrain),
    );

    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("ok");
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Lambda.QueueEventSource))),
);
