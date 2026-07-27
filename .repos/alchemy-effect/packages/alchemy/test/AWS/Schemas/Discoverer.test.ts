import * as AWS from "@/AWS";
import { EventBus } from "@/AWS/EventBridge";
import { Discoverer } from "@/AWS/Schemas";
import * as Test from "@/Test/Alchemy";
import * as schemas from "@distilled.cloud/aws/schemas";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const assertDiscovererGone = (discovererId: string) =>
  schemas.describeDiscoverer({ DiscovererId: discovererId }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`discoverer ${discovererId} still exists`)),
    ),
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

describe("AWS.Schemas.Discoverer", () => {
  test.provider(
    "creates a discoverer on an event bus, stops it, and deletes it",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // CREATE — discoverer on a dedicated event bus, started by default.
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const bus = yield* EventBus("DiscovererBus", {});
            const discoverer = yield* Discoverer("BusDiscoverer", {
              sourceArn: bus.eventBusArn,
              description: "alchemy schemas discoverer test",
              tags: { purpose: "alchemy-test" },
            });
            return {
              eventBusArn: bus.eventBusArn,
              discovererId: discoverer.discovererId,
              discovererArn: discoverer.discovererArn,
              state: discoverer.state,
            };
          }),
        );
        expect(created.state).toEqual("STARTED");

        // Verify out-of-band via distilled.
        const observed = yield* schemas.describeDiscoverer({
          DiscovererId: created.discovererId,
        });
        expect(observed.DiscovererArn).toEqual(created.discovererArn);
        expect(observed.SourceArn).toEqual(created.eventBusArn);
        expect(observed.State).toEqual("STARTED");
        expect(observed.Description).toEqual("alchemy schemas discoverer test");
        expect(observed.Tags?.purpose).toEqual("alchemy-test");
        expect(observed.Tags?.["alchemy::id"]).toEqual("BusDiscoverer");

        // UPDATE — stop the discoverer and change the description in place.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const bus = yield* EventBus("DiscovererBus", {});
            const discoverer = yield* Discoverer("BusDiscoverer", {
              sourceArn: bus.eventBusArn,
              description: "paused discoverer",
              state: "STOPPED",
              tags: { purpose: "alchemy-test" },
            });
            return {
              discovererId: discoverer.discovererId,
              state: discoverer.state,
            };
          }),
        );
        expect(updated.discovererId).toEqual(created.discovererId);
        expect(updated.state).toEqual("STOPPED");

        const afterUpdate = yield* schemas.describeDiscoverer({
          DiscovererId: created.discovererId,
        });
        expect(afterUpdate.State).toEqual("STOPPED");
        expect(afterUpdate.Description).toEqual("paused discoverer");

        // DELETE
        yield* stack.destroy();
        yield* assertDiscovererGone(created.discovererId);
      }),
    { timeout: 120_000 },
  );
});
