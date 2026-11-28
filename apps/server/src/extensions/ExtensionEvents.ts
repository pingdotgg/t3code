import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";

export const run = Effect.fn("ExtensionEvents.run")(function* (
  publish: (event: { type: string; data: unknown }) => void,
) {
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  yield* Stream.unwrap(
    Effect.map(events.latestApplicationSequence, (afterSequence) =>
      events.streamApplicationEvents({ afterSequence }),
    ),
  ).pipe(
    Stream.runForEach((event) =>
      Effect.sync(() =>
        publish({ type: "type" in event ? event.type : event.event.type, data: event }),
      ),
    ),
    Effect.tapError((cause) =>
      Effect.logWarning(
        "Extension event subscription failed; reconnecting from current state",
        cause,
      ),
    ),
    Effect.retry(Schedule.exponential("1 second")),
  );
});
