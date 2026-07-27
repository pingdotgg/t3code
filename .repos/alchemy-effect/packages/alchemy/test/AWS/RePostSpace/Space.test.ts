import * as AWS from "@/AWS";
import { Space } from "@/AWS/RePostSpace";
import * as Test from "@/Test/Alchemy";
import * as repostspace from "@distilled.cloud/aws/repostspace";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/reconcile/delete paths depend on. Runs
// in every CI pass at near-zero cost, unlike the gated lifecycle below.
test.provider(
  "getSpace on a nonexistent space fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        repostspace.getSpace({
          spaceId: "SPalchemynonexistentprobe0",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// Deletion is verified as INITIATED (a DELETE* status, irreversible) or
// fully gone. Full disappearance takes several more minutes server-side.
const assertSpaceDeleting = (spaceId: string) =>
  Effect.gen(function* () {
    const status = yield* repostspace.getSpace({ spaceId }).pipe(
      Effect.map((space) => space.status),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("gone" as const),
      ),
    );
    if (status !== "gone" && !status.startsWith("DELETE")) {
      return yield* Effect.fail(
        new Error(`space '${spaceId}' still exists (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(18),
      ]),
    }),
  );

// re:Post Private is a paid tier (Basic/Standard) that requires IAM Identity
// Center and provisions asynchronously (~30 minutes). The full lifecycle is
// gated behind AWS_TEST_REPOSTSPACE=1 and always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_REPOSTSPACE)(
  "create re:Post Private space (BASIC), update description, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const make = (description: string) =>
        Effect.gen(function* () {
          const space = yield* Space("Space", {
            // subdomain must be globally unique across re:Post Private —
            // deterministic, alchemy-branded constant.
            subdomain: "alchemy-e2e-repost-space",
            tier: "BASIC",
            description,
            tags: { fixture: "repostspace-space" },
          });
          return { space };
        });

      const { space } = yield* stack.deploy(make("alchemy repostspace test"));

      expect(space.spaceId).toBeDefined();
      expect(space.spaceArn).toContain(":space/");
      expect(space.status).toBe("CREATE_COMPLETED");
      expect(space.tier).toBe("BASIC");
      expect(space.randomDomain).toBeDefined();
      expect(space.description).toBe("alchemy repostspace test");

      // Out-of-band verification via distilled.
      const observed = yield* repostspace.getSpace({
        spaceId: space.spaceId,
      });
      expect(observed.status).toBe("CREATE_COMPLETED");
      expect(observed.tier).toBe("BASIC");

      // In-place update (no replacement): description changes, id is stable.
      const { space: updated } = yield* stack.deploy(
        make("alchemy repostspace test (updated)"),
      );
      expect(updated.spaceId).toBe(space.spaceId);
      expect(updated.description).toBe("alchemy repostspace test (updated)");

      // Destroy immediately — spaces bill while they exist — and verify
      // deletion was initiated out-of-band.
      yield* stack.destroy();
      yield* assertSpaceDeleting(space.spaceId);
    }),
  // async provisioning (~30 min) + update + delete initiation, one test.
  { timeout: 3_600_000 },
);
