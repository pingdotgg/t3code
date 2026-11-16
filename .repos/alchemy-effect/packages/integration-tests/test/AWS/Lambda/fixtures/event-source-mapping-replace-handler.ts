import * as Lambda from "@alchemy.run/aws/Lambda";
import * as SQS from "@alchemy.run/aws/SQS";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

// One Function whose queue switches between standard and FIFO across deploys.
// Switching `fifo` replaces the queue, so the second deploy must move the
// EventSourceMapping onto the new queue.
export class EventSourceMappingReplaceFunction extends Lambda.Function<EventSourceMappingReplaceFunction>()(
  "EventSourceMappingReplaceFunction",
) {}

const make = (fifo: boolean) =>
  EventSourceMappingReplaceFunction.make(
    {
      main: import.meta.url,
      functionUrl: false,
    },
    Effect.gen(function* () {
      const queue = yield* SQS.Queue("EventSourceMappingReplaceQueue", fifo ? { fifo: true } : {});

      yield* SQS.consumeQueueMessages(queue, () => Effect.void);

      return {
        fetch: Effect.gen(function* () {
          return HttpServerResponse.text("ok");
        }).pipe(Effect.orDie),
      };
    }).pipe(Effect.provide(Layer.mergeAll(Lambda.QueueEventSource))),
  );

export const StandardQueueLive = make(false);
export const FifoQueueLive = make(true);

export default StandardQueueLive;
