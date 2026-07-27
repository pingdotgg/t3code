import * as AWS from "@/AWS";
import { Profile } from "@/AWS/Route53Profiles";
import * as Test from "@/Test/Alchemy";
import * as profiles from "@distilled.cloud/aws/route53profiles";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// A deleted Profile lingers in `DELETING` for a short while and is still
// returned by GetProfile — both RNF and DELETING/DELETED count as gone.
const assertProfileGone = (profileId: string) =>
  profiles.getProfile({ ProfileId: profileId }).pipe(
    Effect.flatMap((r) =>
      r.Profile?.Status === "DELETING" || r.Profile?.Status === "DELETED"
        ? Effect.void
        : Effect.fail(new Error(`profile still ${r.Profile?.Status}`)),
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

test.provider(
  "create, update tags, replace on rename, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create with a generated name + user tags.
      const first = yield* stack.deploy(
        Effect.gen(function* () {
          const profile = yield* Profile("DnsProfile", {
            tags: { env: "test" },
          });
          return { profile };
        }),
      );
      expect(first.profile.profileId).toMatch(/^rp-/);
      expect(first.profile.profileArn).toContain(first.profile.profileId);

      // Out-of-band: the profile exists and carries alchemy + user tags.
      const live = yield* profiles.getProfile({
        ProfileId: first.profile.profileId,
      });
      expect(live.Profile?.Name).toBe(first.profile.profileName);
      const tags = yield* profiles.listTagsForResource({
        ResourceArn: first.profile.profileArn,
      });
      expect(tags.Tags.env).toBe("test");
      expect(
        Object.keys(tags.Tags).some((key) => key.startsWith("alchemy:")),
      ).toBe(true);

      // Update tags in place — same profile id.
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const profile = yield* Profile("DnsProfile", {
            tags: { env: "prod", team: "platform" },
          });
          return { profile };
        }),
      );
      expect(second.profile.profileId).toBe(first.profile.profileId);
      const updatedTags = yield* profiles.listTagsForResource({
        ResourceArn: second.profile.profileArn,
      });
      expect(updatedTags.Tags.env).toBe("prod");
      expect(updatedTags.Tags.team).toBe("platform");

      // Renaming replaces (profiles have no update API).
      const third = yield* stack.deploy(
        Effect.gen(function* () {
          const profile = yield* Profile("DnsProfile", {
            name: "alchemy-test-profile-renamed",
          });
          return { profile };
        }),
      );
      expect(third.profile.profileName).toBe("alchemy-test-profile-renamed");
      expect(third.profile.profileId).not.toBe(first.profile.profileId);
      yield* assertProfileGone(first.profile.profileId);

      yield* stack.destroy();
      yield* assertProfileGone(third.profile.profileId);
    }),
  { timeout: 120_000 },
);
