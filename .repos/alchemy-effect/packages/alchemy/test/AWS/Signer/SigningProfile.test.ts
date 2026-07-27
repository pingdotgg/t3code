import * as AWS from "@/AWS";
import { SigningProfile } from "@/AWS/Signer";
import * as Test from "@/Test/Alchemy";
import * as signer from "@distilled.cloud/aws/signer";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

/**
 * Signing profiles cannot be deleted — destroy cancels them. Wait (bounded)
 * for the profile to observe as Canceled.
 */
const assertProfileCanceled = (profileName: string) =>
  signer.getSigningProfile({ profileName }).pipe(
    Effect.repeat({
      schedule: Schedule.fixed("2 seconds"),
      until: (r) => r.status === "Canceled",
      times: 10,
    }),
    Effect.map((r) => {
      expect(r.status).toBe("Canceled");
    }),
  );

describe("AWS.Signer.SigningProfile", () => {
  test.provider(
    "creates a Lambda code-signing profile, syncs tags, replaces on validity change, cancels on destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // CREATE
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const profile = yield* SigningProfile("ReleaseProfile", {
              platformId: "AWSLambda-SHA384-ECDSA",
              signatureValidityPeriod: { value: 12, type: "MONTHS" },
              tags: { purpose: "alchemy-test" },
            });
            return {
              profileName: profile.profileName,
              arn: profile.arn,
              profileVersion: profile.profileVersion,
              profileVersionArn: profile.profileVersionArn,
              platformId: profile.platformId,
              status: profile.status,
            };
          }),
        );

        expect(created.platformId).toBe("AWSLambda-SHA384-ECDSA");
        expect(created.status).toBe("Active");
        expect(created.profileVersionArn).toContain(created.profileName);

        // Verify out-of-band via distilled
        const observed = yield* signer.getSigningProfile({
          profileName: created.profileName,
        });
        expect(observed.arn).toEqual(created.arn);
        expect(observed.profileVersion).toEqual(created.profileVersion);
        expect(observed.status).toBe("Active");
        expect(observed.platformId).toBe("AWSLambda-SHA384-ECDSA");
        expect(observed.signatureValidityPeriod).toEqual({
          value: 12,
          type: "MONTHS",
        });
        expect(observed.tags?.purpose).toBe("alchemy-test");
        // internal alchemy tags are branded on the profile
        expect(
          Object.keys(observed.tags ?? {}).some((k) =>
            k.startsWith("alchemy::"),
          ),
        ).toBe(true);

        // UPDATE — tags are the only mutable aspect; the profile (name,
        // arn, version) must be untouched
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const profile = yield* SigningProfile("ReleaseProfile", {
              platformId: "AWSLambda-SHA384-ECDSA",
              signatureValidityPeriod: { value: 12, type: "MONTHS" },
              tags: { purpose: "alchemy-test", stage: "two" },
            });
            return {
              profileName: profile.profileName,
              arn: profile.arn,
              profileVersion: profile.profileVersion,
            };
          }),
        );

        expect(updated.profileName).toEqual(created.profileName);
        expect(updated.arn).toEqual(created.arn);
        expect(updated.profileVersion).toEqual(created.profileVersion);

        const afterUpdate = yield* signer.getSigningProfile({
          profileName: created.profileName,
        });
        expect(afterUpdate.tags?.stage).toBe("two");
        expect(afterUpdate.tags?.purpose).toBe("alchemy-test");

        // REPLACE — PutSigningProfile is create-only, so changing the
        // validity period replaces the profile under a new generated name
        const replaced = yield* stack.deploy(
          Effect.gen(function* () {
            const profile = yield* SigningProfile("ReleaseProfile", {
              platformId: "AWSLambda-SHA384-ECDSA",
              signatureValidityPeriod: { value: 24, type: "MONTHS" },
              tags: { purpose: "alchemy-test", stage: "two" },
            });
            return {
              profileName: profile.profileName,
              arn: profile.arn,
              status: profile.status,
            };
          }),
        );

        expect(replaced.profileName).not.toEqual(created.profileName);
        expect(replaced.status).toBe("Active");

        const afterReplace = yield* signer.getSigningProfile({
          profileName: replaced.profileName,
        });
        expect(afterReplace.status).toBe("Active");
        expect(afterReplace.signatureValidityPeriod).toEqual({
          value: 24,
          type: "MONTHS",
        });
        // the replaced (old) profile is canceled by the engine's delete
        yield* assertProfileCanceled(created.profileName);

        // DESTROY — the profile is canceled (Signer has no hard delete)
        yield* stack.destroy();
        yield* assertProfileCanceled(replaced.profileName);
      }),
    { timeout: 120_000 },
  );
});
