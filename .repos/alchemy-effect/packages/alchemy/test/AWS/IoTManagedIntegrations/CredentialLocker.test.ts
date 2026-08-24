import * as AWS from "@/AWS";
import { CredentialLocker } from "@/AWS/IoTManagedIntegrations";
import { Region } from "@/AWS/Region.ts";
import * as Test from "@/Test/Alchemy";
import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
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
// not-found tag this provider's read/delete paths depend on. Runs in every
// CI pass at near-zero cost, unlike the gated lifecycle below.
test.provider(
  "getCredentialLocker on a nonexistent locker fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        pin(
          mi.getCredentialLocker({
            Identifier: "alchemynonexistentlockerprobe",
          }),
        ),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

class LockerStillExists extends Data.TaggedError("LockerStillExists")<{
  readonly credentialLockerId: string;
}> {}

const assertLockerGone = (credentialLockerId: string) =>
  mi.getCredentialLocker({ Identifier: credentialLockerId }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new LockerStillExists({ credentialLockerId })),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "LockerStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

// Full lifecycle is gated: the service only exists in a few regions. Run with
// AWS_TEST_IOT_MI=1 and an AWS profile configured in a supported region.
test.provider.skipIf(!process.env.AWS_TEST_IOT_MI)(
  "create credential locker, verify, update tags, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { locker } = yield* stack.deploy(
        Effect.gen(function* () {
          const locker = yield* CredentialLocker("Locker", {
            tags: { fixture: "iot-mi-credential-locker" },
          });
          return { locker };
        }),
      );

      expect(locker.credentialLockerId).toBeDefined();
      expect(locker.credentialLockerArn).toContain(":credential-locker/");
      expect(locker.credentialLockerName).toBeDefined();
      expect(locker.tags.fixture).toBe("iot-mi-credential-locker");

      // Out-of-band verification via distilled.
      const observed = yield* mi.getCredentialLocker({
        Identifier: locker.credentialLockerId,
      });
      expect(observed.Arn).toBe(locker.credentialLockerArn);
      expect(observed.Tags?.fixture).toBe("iot-mi-credential-locker");

      // Update tags in place (no replacement — same name).
      const { locker: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const locker = yield* CredentialLocker("Locker", {
            tags: { fixture: "iot-mi-credential-locker", phase: "two" },
          });
          return { locker };
        }),
      );
      expect(updated.credentialLockerId).toBe(locker.credentialLockerId);
      const retagged = yield* mi.getCredentialLocker({
        Identifier: locker.credentialLockerId,
      });
      expect(retagged.Tags?.phase).toBe("two");

      // Replacement: an explicit name change replaces the locker.
      const { locker: replaced } = yield* stack.deploy(
        Effect.gen(function* () {
          const locker = yield* CredentialLocker("Locker", {
            name: "alchemy-iot-mi-locker-replacement",
            tags: { fixture: "iot-mi-credential-locker" },
          });
          return { locker };
        }),
      );
      expect(replaced.credentialLockerId).not.toBe(locker.credentialLockerId);
      expect(replaced.credentialLockerName).toBe(
        "alchemy-iot-mi-locker-replacement",
      );
      yield* assertLockerGone(locker.credentialLockerId);

      yield* stack.destroy();
      yield* assertLockerGone(replaced.credentialLockerId);
    }),
  { timeout: 120_000 },
);
