import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationEvent } from "@t3tools/contracts";
import { ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeEventsCapability } from "./EventsCapability.ts";

const silentLogger = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
};

/** A domain event with only the fields this capability reads. */
const event = (type: string, sequence: number): OrchestrationEvent =>
  ({
    type,
    sequence,
    eventId: `event-${sequence}`,
    aggregateKind: "project",
    aggregateId: ProjectId.make("project-1"),
    occurredAt: "2026-07-15T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {},
  }) as unknown as OrchestrationEvent;

// The SDK types a plugin's event handler as failing with `Error`, so these extend it
// rather than being bare tagged structs.
class HandlerExploded extends Error {
  readonly _tag = "HandlerExploded";
}
class NotAllPublished extends Error {
  readonly _tag = "NotAllPublished";
}

const capabilityFor = (events: Stream.Stream<OrchestrationEvent>) =>
  makeEventsCapability({ pluginId: "events-fixture", logger: silentLogger, events });

describe("EventsCapability", () => {
  it.effect("delivers only the types the plugin declared", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<Array<string>>([]);
      const events = capabilityFor(
        Stream.fromIterable([
          event("thread.created", 1),
          event("project.deleted", 2),
          event("thread.deleted", 3),
        ]),
      );

      yield* events.subscribe({
        types: ["thread.created", "thread.deleted"],
        handler: (received) => Ref.update(seen, (all) => [...all, received.type]),
      });

      // Holding the capability grants the stream; it must not grant every type on it.
      assert.deepStrictEqual(yield* Ref.get(seen), ["thread.created", "thread.deleted"]);
    }),
  );

  it.effect("keeps delivering after a handler fails", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<Array<number>>([]);
      const events = capabilityFor(
        Stream.fromIterable([event("thread.created", 1), event("thread.created", 2)]),
      );

      yield* events.subscribe({
        types: ["thread.created"],
        handler: (received) =>
          // A plugin handler is the one piece of code here the host does not own, so
          // it must not be able to end delivery. Per-stream recovery would drop
          // everything after the first failure for the process lifetime.
          received.sequence === 1
            ? Effect.fail(new HandlerExploded())
            : Ref.update(seen, (all) => [...all, received.sequence]),
      });

      assert.deepStrictEqual(
        yield* Ref.get(seen),
        [2],
        "the event after a failing handler must still arrive",
      );
    }),
  );

  it.effect("abandons a handler that hangs rather than stalling delivery", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<Array<number>>([]);
      const events = capabilityFor(
        Stream.fromIterable([event("thread.created", 1), event("thread.created", 2)]),
      );

      const fiber = yield* Effect.forkChild(
        events.subscribe({
          types: ["thread.created"],
          handler: (received) =>
            // A hang looks exactly like "the event never fired" and is undebuggable.
            received.sequence === 1
              ? Effect.never
              : Ref.update(seen, (all) => [...all, received.sequence]),
        }),
      );

      yield* TestClock.adjust("31 seconds");
      yield* Fiber.join(fiber);

      assert.deepStrictEqual(
        yield* Ref.get(seen),
        [2],
        "delivery must resume once the hung handler times out",
      );
    }),
  );

  it.effect("ends the subscription when the host's stream ends", () =>
    Effect.gen(function* () {
      const events = capabilityFor(Stream.fromIterable([event("thread.created", 1)]));
      // If the subscription outlived the host stream, this would hang forever and the
      // plugin's service could only be stopped by interrupting it.
      yield* events.subscribe({ types: ["thread.created"], handler: () => Effect.void });
    }),
  );

  it.effect("drops the oldest events rather than blocking the host's stream", () =>
    Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      const handled = yield* Ref.make<Array<number>>([]);
      const published = yield* Ref.make(0);
      // 600 events against a 256-slot buffer, with the consumer held on the first.
      const total = 600;
      const source = Stream.fromIterable(Array.from({ length: total }, (_, index) => index)).pipe(
        Stream.mapEffect((index) =>
          Ref.update(published, (count) => count + 1).pipe(
            Effect.as(event("thread.created", index)),
          ),
        ),
      );

      const fiber = yield* Effect.forkChild(
        capabilityFor(source).subscribe({
          types: ["thread.created"],
          handler: (received) =>
            received.sequence === 0
              ? Deferred.await(released)
              : Ref.update(handled, (all) => [...all, received.sequence]),
        }),
      );

      // The host's stream must run to completion even though the plugin is stuck on
      // the very first event. A blocking queue would stall here at ~257 and
      // orchestration would wait on a third-party plugin.
      yield* Ref.get(published).pipe(
        Effect.flatMap((count) =>
          count === total ? Effect.void : Effect.fail(new NotAllPublished(`published ${count}`)),
        ),
        Effect.retry({ schedule: Schedule.recurs(5000) }),
        Effect.orDie,
      );

      yield* Deferred.succeed(released, undefined);
      yield* Fiber.join(fiber);

      const delivered = yield* Ref.get(handled);
      assert.isBelow(
        delivered.length,
        total - 1,
        "a subscriber that cannot keep up must lose events, not stall the host",
      );
      assert.deepStrictEqual(
        delivered.at(-1),
        total - 1,
        "the NEWEST events must survive: dropping the newest would make the plugin permanently stale",
      );
    }),
  );
});
