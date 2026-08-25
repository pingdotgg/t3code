import * as AWS from "@/AWS";
import { ResourceCollection } from "@/AWS/DevOpsGuru/ResourceCollection.ts";
import * as Test from "@/Test/Alchemy";
import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Observe the account's tag-based coverage out-of-band. An account that has
// never configured a collection fails with the typed ResourceNotFoundException
// ("No CustomerResourceFilter present") — treated as empty. A key whose last
// value was removed lingers with an empty TagValues list — also empty.
const observedTags = devopsguru
  .getResourceCollection({ ResourceCollectionType: "AWS_TAGS" })
  .pipe(
    Effect.map((r) =>
      (r.ResourceCollection?.Tags ?? []).filter((t) => t.TagValues.length > 0),
    ),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed([] as devopsguru.TagCollectionFilter[]),
    ),
  );

// Ungated typed-error probe: getResourceCollection either returns the
// configured collection or fails with the typed not-found tag — never an
// untyped catch-all.
test.provider("getResourceCollection returns typed results", () =>
  Effect.gen(function* () {
    const tags = yield* observedTags;
    expect(Array.isArray(tags)).toBe(true);
  }),
);

// The resource collection is an account/region singleton. This test only
// runs when the account has no tag-based coverage it doesn't own — it must
// never clobber coverage the user already operates.
test.provider(
  "lifecycle: configure tag coverage, converge values, remove",
  (stack) =>
    Effect.gen(function* () {
      const preexisting = yield* observedTags;
      const foreign = preexisting.filter(
        (t) => t.AppBoundaryKey.toLowerCase() !== "devops-guru-alchemy",
      );
      if (foreign.length > 0) {
        yield* Effect.logInfo(
          `DevOps Guru tag coverage already configured (${foreign
            .map((t) => t.AppBoundaryKey)
            .join(", ")}) — skipping destructive lifecycle test`,
        );
        return;
      }

      yield* stack.destroy();

      // Create — tag-based coverage.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ResourceCollection("Coverage", {
            tags: [
              {
                appBoundaryKey: "devops-guru-alchemy",
                tagValues: ["devopsguru-test-a", "devopsguru-test-b"],
              },
            ],
          });
        }),
      );
      expect(created.cloudFormationStackNames).toEqual([]);
      expect(created.tags).toHaveLength(1);
      expect(created.tags[0]!.tagValues.sort()).toEqual([
        "devopsguru-test-a",
        "devopsguru-test-b",
      ]);

      // Out-of-band verification via distilled.
      const observed = yield* observedTags;
      expect(observed).toHaveLength(1);
      expect([...(observed[0]?.TagValues ?? [])].sort()).toEqual([
        "devopsguru-test-a",
        "devopsguru-test-b",
      ]);

      // Update — add one value, remove another; the provider applies only
      // the delta (REMOVE b, ADD c).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ResourceCollection("Coverage", {
            tags: [
              {
                appBoundaryKey: "devops-guru-alchemy",
                tagValues: ["devopsguru-test-a", "devopsguru-test-c"],
              },
            ],
          });
        }),
      );
      expect(updated.tags[0]!.tagValues.sort()).toEqual([
        "devopsguru-test-a",
        "devopsguru-test-c",
      ]);
      const observedUpdated = yield* observedTags;
      expect([...(observedUpdated[0]?.TagValues ?? [])].sort()).toEqual([
        "devopsguru-test-a",
        "devopsguru-test-c",
      ]);

      // Destroy — the collection is emptied and the account is clean again.
      yield* stack.destroy();
      const after = yield* observedTags;
      expect(after).toEqual([]);
    }),
  { timeout: 180_000 },
);
