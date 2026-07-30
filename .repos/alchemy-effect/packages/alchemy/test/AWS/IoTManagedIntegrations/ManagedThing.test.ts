import * as AWS from "@/AWS";
import { CredentialLocker, ManagedThing } from "@/AWS/IoTManagedIntegrations";
import { Region } from "@/AWS/Region.ts";
import * as Test from "@/Test/Alchemy";
import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// IoT Managed Integrations is only deployed in a few regions (eu-west-1,
// ca-central-1, ...). The testing profile's default region (us-west-2) has no
// endpoint, so the ungated probe pins a supported region explicitly. The gated
// lifecycle below requires an AWS profile whose region IS a supported one
// (SSO profiles resolve region from ~/.aws/config; the AWS_REGION env var is
// not consulted), e.g. a profile with region = eu-west-1.
const MI_REGION = "eu-west-1";
const pin = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Region, Effect.succeed(MI_REGION)));

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getManagedThing on a nonexistent thing fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        pin(mi.getManagedThing({ Identifier: "alchemynonexistentthingprobe" })),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

class ThingStillExists extends Data.TaggedError("ThingStillExists")<{
  readonly managedThingId: string;
}> {}

const assertThingGone = (managedThingId: string) =>
  mi.getManagedThing({ Identifier: managedThingId }).pipe(
    Effect.flatMap((thing) =>
      thing.ProvisioningStatus === "DELETED" ||
      thing.ProvisioningStatus === "DELETE_IN_PROGRESS"
        ? Effect.void
        : Effect.fail(new ThingStillExists({ managedThingId })),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "ThingStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

// A synthetic Zigbee install-code QR payload. CreateManagedThing validates the
// payload shape, not that the device exists, so a well-formed constant is
// accepted for a DEVICE role. Checked in as a constant (never generated at
// test time).
const ZIGBEE_QR_PAYLOAD = "Z:24FD5B0000015C63$I:83FED3407A939738";

// Full lifecycle is gated: the service only exists in a few regions and a
// managed thing represents onboarded device state. Run with
// AWS_TEST_IOT_MI=1 and an AWS profile configured in a supported region.
test.provider.skipIf(!process.env.AWS_TEST_IOT_MI)(
  "create managed thing, verify, update, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const makeStack = (brand: string) =>
        Effect.gen(function* () {
          const locker = yield* CredentialLocker("Locker", {});
          const thing = yield* ManagedThing("Device", {
            role: "DEVICE",
            authenticationMaterial: Redacted.make(ZIGBEE_QR_PAYLOAD),
            authenticationMaterialType: "ZIGBEE_QR_BAR_CODE",
            credentialLockerId: locker.credentialLockerId,
            brand,
            serialNumber: "SN-ALCHEMY-0001",
            tags: { fixture: "iot-mi-managed-thing" },
          });
          return { thing };
        });

      const { thing } = yield* stack.deploy(makeStack("alchemy"));

      expect(thing.managedThingId).toBeDefined();
      expect(thing.managedThingArn).toContain(":managed-thing/");
      expect(thing.role).toBe("DEVICE");
      expect(thing.tags.fixture).toBe("iot-mi-managed-thing");

      // Out-of-band verification via distilled.
      const observed = yield* mi.getManagedThing({
        Identifier: thing.managedThingId,
      });
      expect(observed.Arn).toBe(thing.managedThingArn);

      // Update a mutable field in place.
      const { thing: updated } = yield* stack.deploy(makeStack("alchemy-two"));
      expect(updated.managedThingId).toBe(thing.managedThingId);

      yield* stack.destroy();
      yield* assertThingGone(thing.managedThingId);
    }),
  { timeout: 240_000 },
);
