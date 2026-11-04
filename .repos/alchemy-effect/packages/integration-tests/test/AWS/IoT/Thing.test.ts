import * as AWS from "@alchemy.run/aws";
import { Thing } from "@alchemy.run/aws/IoT";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as iot from "@distilled.cloud/aws/iot";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const assertThingGone = (thingName: string) =>
  iot.describeThing({ thingName }).pipe(
    Effect.flatMap(() => Effect.fail(new Error(`thing ${thingName} still exists`))),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(10)]),
    }),
  );

describe.sequential("AWS.IoT.Thing", { tags: ["provider:aws", "provider:aws:iot", "live"] }, () => {
  test.provider(
    "creates a thing with attributes, updates attributes, and deletes it",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const thing = yield* Thing("Sensor", {
              attributes: { location: "warehouse-a" },
            });
            return { thingName: thing.thingName };
          }),
        );

        const observed = yield* iot.describeThing({
          thingName: created.thingName,
        });
        expect(observed.attributes?.location).toEqual("warehouse-a");

        // Update attributes in place.
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* Thing("Sensor", {
              attributes: { location: "warehouse-b", model: "t1000" },
            });
          }),
        );
        const updated = yield* iot.describeThing({
          thingName: created.thingName,
        });
        expect(updated.attributes?.location).toEqual("warehouse-b");
        expect(updated.attributes?.model).toEqual("t1000");

        yield* stack.destroy();
        yield* assertThingGone(created.thingName);
      }),
    { timeout: 180_000 },
  );
});
