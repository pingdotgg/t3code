import * as AWS from "@/AWS";
import { Thing, ThingType, ThingTypeDeletionTimedOut } from "@/AWS/IoT";
import * as Test from "@/Test/Alchemy";
import * as iot from "@distilled.cloud/aws/iot";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const assertThingGone = (thingName: string) =>
  iot.describeThing({ thingName }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`thing ${thingName} still exists`)),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

// AWS enforces a mandatory 5-minute window between deprecating a thing type
// and deleting it. Keep the explicit name deterministic so an interrupted
// slow-lane run reclaims the same type instead of minting random-suffixed
// residue; the provider's delete waits until DescribeThingType is NotFound.
const testThingTypeName = "alchemy-test-iot-thing-type";

describe.sequential("AWS.IoT.ThingType", () => {
  test.provider("typed not-found probe", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        iot.describeThingType({
          thingTypeName: "alchemy-nonexistent-thing-type-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  );

  // AWS requires a thing type to remain deprecated for at least five minutes
  // before deletion. The provider fully waits for observable absence, so this
  // lifecycle is intentionally outside the default fast sweep; enable it for
  // the slow lane with AWS_TEST_SLOW=1.
  test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
    "creates a thing type, associates a thing, and deletes it",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Pre-clean: delete the previous run's deprecated leftover. Inside
        // the 5-minute window AWS rejects with InvalidRequestException — in
        // that case reconcile un-deprecates and reuses the existing type.
        yield* iot
          .deleteThingType({ thingTypeName: testThingTypeName })
          .pipe(
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidRequestException"],
              () => Effect.void,
            ),
          );

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const thingType = yield* ThingType("SensorType", {
              thingTypeName: testThingTypeName,
              description: "Alchemy IoT test sensors",
              searchableAttributes: ["location"],
              tags: { purpose: "alchemy-test" },
            });
            const thing = yield* Thing("TypedSensor", {
              thingTypeName: thingType.thingTypeName,
              attributes: { location: "warehouse-a" },
            });
            return {
              thingTypeName: thingType.thingTypeName,
              thingTypeArn: thingType.thingTypeArn,
              thingName: thing.thingName,
            };
          }),
        );

        // Verify out-of-band: the type exists, is active (a previous run's
        // destroy leaves it deprecated — reconcile must un-deprecate), and the
        // thing is associated with it.
        const observed = yield* iot.describeThingType({
          thingTypeName: created.thingTypeName,
        });
        expect(observed.thingTypeArn).toEqual(created.thingTypeArn);
        expect(observed.thingTypeProperties?.thingTypeDescription).toEqual(
          "Alchemy IoT test sensors",
        );
        expect(observed.thingTypeProperties?.searchableAttributes).toEqual([
          "location",
        ]);
        expect(observed.thingTypeMetadata?.deprecated ?? false).toBe(false);

        const thing = yield* iot.describeThing({
          thingName: created.thingName,
        });
        expect(thing.thingTypeName).toEqual(created.thingTypeName);

        // First destroy removes the Thing and deprecates its type, then exits
        // on the provider's bounded nonterminal error instead of blocking for
        // AWS's mandatory five-minute window. State remains for re-entry.
        const pending = yield* Effect.flip(stack.destroy());
        expect(pending).toBeInstanceOf(ThingTypeDeletionTimedOut);
        yield* assertThingGone(created.thingName);

        const deprecated = yield* iot.describeThingType({
          thingTypeName: created.thingTypeName,
        });
        expect(deprecated.thingTypeMetadata?.deprecated).toBe(true);

        // The first bounded delete already consumed ~45s. Wait out the rest
        // of AWS's platform clock, then re-enter deletion exactly as a later
        // nuke would after discovering the deterministic leftover.
        yield* Effect.sleep("260 seconds");
        yield* stack.destroy();

        // Successful deletion returns only after observable absence.
        const error = yield* Effect.flip(
          iot.describeThingType({ thingTypeName: created.thingTypeName }),
        );
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
    { timeout: 420_000 },
  );
});
