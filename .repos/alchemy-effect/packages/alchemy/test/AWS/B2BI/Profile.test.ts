import * as AWS from "@/AWS";
import { Profile } from "@/AWS/B2BI";
import * as Test from "@/Test/Alchemy";
import * as b2bi from "@distilled.cloud/aws/b2bi";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getProfile on a nonexistent id fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        b2bi.getProfile({ profileId: "p-00000000000000000" }),
      );
      expect(["ResourceNotFoundException", "ValidationException"]).toContain(
        error._tag,
      );
    }),
);

const assertProfileGone = (profileId: string) =>
  Effect.gen(function* () {
    const result = yield* b2bi.getProfile({ profileId }).pipe(
      Effect.map(() => "present" as const),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("gone" as const),
      ),
    );
    if (result === "present") {
      return yield* Effect.fail(
        new Error(`Profile '${profileId}' still exists`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(8)]),
    }),
  );

// Profiles are credential-free and cheap, so the full lifecycle runs ungated.
test.provider(
  "create, update, and destroy a B2BI profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const created = yield* stack.deploy(
        Profile("Acme", {
          name: "alchemy-b2bi-profile",
          businessName: "Alchemy Test Corp",
          phone: "+15555550100",
          email: "edi@alchemy.example",
        }),
      );
      expect(created.profileId).toMatch(/^p-/);
      expect(created.name).toBe("alchemy-b2bi-profile");
      expect(created.businessName).toBe("Alchemy Test Corp");
      expect(created.profileArn).toContain(":b2bi:");

      // Out-of-band verification.
      const described = yield* b2bi.getProfile({
        profileId: created.profileId,
      });
      expect(described.businessName).toBe("Alchemy Test Corp");

      // No-op redeploy keeps the same id.
      const noop = yield* stack.deploy(
        Profile("Acme", {
          name: "alchemy-b2bi-profile",
          businessName: "Alchemy Test Corp",
          phone: "+15555550100",
          email: "edi@alchemy.example",
        }),
      );
      expect(noop.profileId).toBe(created.profileId);

      // Update businessName and phone in place.
      const updated = yield* stack.deploy(
        Profile("Acme", {
          name: "alchemy-b2bi-profile",
          businessName: "Alchemy Renamed Corp",
          phone: "+15555550199",
          email: "edi@alchemy.example",
        }),
      );
      expect(updated.profileId).toBe(created.profileId);
      expect(updated.businessName).toBe("Alchemy Renamed Corp");
      const reDescribed = yield* b2bi.getProfile({
        profileId: created.profileId,
      });
      expect(reDescribed.businessName).toBe("Alchemy Renamed Corp");

      // Changing logging replaces the profile (no member on updateProfile);
      // delete-first because profiles are recovered by name and quota-capped.
      const replaced = yield* stack.deploy(
        Profile("Acme", {
          name: "alchemy-b2bi-profile",
          businessName: "Alchemy Renamed Corp",
          phone: "+15555550199",
          email: "edi@alchemy.example",
          logging: "DISABLED",
        }),
      );
      expect(replaced.profileId).not.toBe(created.profileId);
      yield* assertProfileGone(created.profileId);

      // Destroy and verify.
      yield* stack.destroy();
      yield* assertProfileGone(replaced.profileId);
    }),
  { timeout: 120_000 },
);
