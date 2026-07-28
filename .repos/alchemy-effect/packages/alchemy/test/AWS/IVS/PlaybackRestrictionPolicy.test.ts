import * as AWS from "@/AWS";
import { PlaybackRestrictionPolicy } from "@/AWS/IVS";
import * as Test from "@/Test/Alchemy";
import * as ivs from "@distilled.cloud/aws/ivs";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getPlaybackRestrictionPolicy on a nonexistent ARN fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const region = yield* yield* AWS.Region;
      const { Account } = yield* sts.getCallerIdentity({});
      const error = yield* Effect.flip(
        ivs.getPlaybackRestrictionPolicy({
          arn: `arn:aws:ivs:${region}:${Account}:playback-restriction-policy/AbCdEfGh1234`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 60_000 },
);

const assertPolicyGone = (arn: string) =>
  Effect.gen(function* () {
    const policy = yield* ivs.getPlaybackRestrictionPolicy({ arn }).pipe(
      Effect.map((r) => r.playbackRestrictionPolicy),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
    if (policy !== undefined) {
      return yield* Effect.fail(new Error(`policy '${arn}' still exists`));
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
    }),
  );

// Playback restriction policies are free and provision synchronously — the
// full lifecycle (create, no-op, update-in-place, destroy) runs ungated.
test.provider(
  "create, update, and destroy an IVS playback restriction policy",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const props = {
        playbackRestrictionPolicyName: "alchemy-test-ivs-prp",
        allowedCountries: ["US", "CA"],
        allowedOrigins: ["https://example.com"],
        tags: { fixture: "ivs-prp" },
      };

      // Create.
      const created = yield* stack.deploy(
        PlaybackRestrictionPolicy("GeoFence", props),
      );
      expect(created.playbackRestrictionPolicyArn).toContain(
        ":playback-restriction-policy/",
      );
      expect(created.playbackRestrictionPolicyName).toBe(
        "alchemy-test-ivs-prp",
      );
      expect([...created.allowedCountries].sort()).toEqual(["CA", "US"]);
      expect(created.allowedOrigins).toEqual(["https://example.com"]);

      // Out-of-band verification via distilled.
      const observed = yield* ivs.getPlaybackRestrictionPolicy({
        arn: created.playbackRestrictionPolicyArn,
      });
      expect(observed.playbackRestrictionPolicy?.name).toBe(
        "alchemy-test-ivs-prp",
      );
      expect(observed.playbackRestrictionPolicy?.tags?.fixture).toBe("ivs-prp");
      expect(observed.playbackRestrictionPolicy?.tags?.["alchemy::id"]).toBe(
        "GeoFence",
      );

      // No-op redeploy keeps the same policy.
      const noop = yield* stack.deploy(
        PlaybackRestrictionPolicy("GeoFence", props),
      );
      expect(noop.playbackRestrictionPolicyArn).toBe(
        created.playbackRestrictionPolicyArn,
      );

      // Update in place — countries, origins, and strict enforcement are
      // all mutable; the ARN must not change.
      const updated = yield* stack.deploy(
        PlaybackRestrictionPolicy("GeoFence", {
          ...props,
          allowedCountries: ["US"],
          allowedOrigins: ["https://example.com", "https://example.org"],
          enableStrictOriginEnforcement: true,
        }),
      );
      expect(updated.playbackRestrictionPolicyArn).toBe(
        created.playbackRestrictionPolicyArn,
      );
      expect(updated.allowedCountries).toEqual(["US"]);
      expect([...updated.allowedOrigins].sort()).toEqual([
        "https://example.com",
        "https://example.org",
      ]);
      expect(updated.enableStrictOriginEnforcement).toBe(true);

      const reobserved = yield* ivs.getPlaybackRestrictionPolicy({
        arn: created.playbackRestrictionPolicyArn,
      });
      expect(
        reobserved.playbackRestrictionPolicy?.enableStrictOriginEnforcement,
      ).toBe(true);
      expect(reobserved.playbackRestrictionPolicy?.allowedCountries).toEqual([
        "US",
      ]);

      // Destroy and verify out-of-band with a typed wait-until-gone.
      yield* stack.destroy();
      yield* assertPolicyGone(created.playbackRestrictionPolicyArn);
    }),
  { timeout: 240_000 },
);
