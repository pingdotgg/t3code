import { expect, it } from "@effect/vitest";
import { ApplicationProjectDeletedEvent, type ApplicationStoredEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ExtensionEvents from "./ExtensionEvents.ts";

const decodeEvent = Schema.decodeUnknownSync(ApplicationProjectDeletedEvent);
const event = (sequence: number) =>
  decodeEvent({
    sequence,
    eventId: `event:${sequence}`,
    aggregateKind: "project",
    aggregateId: "project:test",
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.deleted",
    payload: { projectId: "project:test", deletedAt: "2026-01-01T00:00:00.000Z" },
  });

it.effect(
  "starts from live state and resumes delivery after the event subscription fails without replaying history",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const latest = yield* Ref.make(1);
        const history = yield* Ref.make<readonly ApplicationStoredEvent[]>([event(1)]);
        const first = yield* Queue.unbounded<ApplicationStoredEvent, PersistenceSqlError>();
        const second = yield* Queue.unbounded<ApplicationStoredEvent, PersistenceSqlError>();
        const subscribed = yield* Deferred.make<void>();
        const reconnected = yield* Deferred.make<void>();
        const delivered = yield* Queue.unbounded<number>();
        let subscriptions = 0;
        const dependency = Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
          latestApplicationSequence: Ref.get(latest),
          streamApplicationEvents: (input) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const live = subscriptions++ === 0 ? first : second;
                yield* Deferred.succeed(subscriptions === 1 ? subscribed : reconnected, undefined);
                const retained = yield* Ref.get(history);
                return Stream.concat(
                  Stream.fromIterable(
                    retained.filter((entry) => entry.sequence > (input?.afterSequence ?? 0)),
                  ),
                  Stream.fromQueue(live),
                );
              }),
            ),
        });
        yield* ExtensionEvents.run(({ data }) => {
          Queue.offerUnsafe(delivered, (data as ApplicationStoredEvent).sequence);
        }).pipe(Effect.provide(dependency), Effect.forkScoped);
        yield* Deferred.await(subscribed);
        yield* Queue.offer(first, event(2));
        expect(yield* Queue.take(delivered)).toBe(2);
        yield* Ref.set(latest, 2);
        yield* Ref.set(history, [event(1), event(2)]);
        yield* Queue.fail(first, new PersistenceSqlError({ operation: "fixture" }));
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(reconnected);
        yield* Queue.offer(second, event(3));
        expect(yield* Queue.take(delivered)).toBe(3);
      }),
    ),
);
