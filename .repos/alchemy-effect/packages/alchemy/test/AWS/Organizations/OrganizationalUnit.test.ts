import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as organizations from "@distilled.cloud/aws/organizations";
import * as Stream from "effect/Stream";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Tree-structured enumeration: `list()` walks the org tree (listRoots ->
// recursive listOrganizationalUnitsForParent) and hydrates each OU into the
// exact `read` Attributes shape. This runs read-only — it neither creates nor
// deletes any organizational unit. When the account isn't an organization
// management account, the typed `AWSOrganizationsNotInUseException` /
// `AccessDeniedException` degrade to `[]`.
test.provider("list enumerates the organizational units", (stack) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(
      AWS.Organizations.OrganizationalUnit,
    );
    const all = yield* provider.list();

    // 0 when the account isn't a management account (or has no OUs); otherwise
    // every discovered OU. Never negative.
    expect(all.length).toBeGreaterThanOrEqual(0);

    // Each entry carries the well-typed Attributes shape that `read` produces.
    for (const ou of all) {
      expect(typeof ou.ouId).toBe("string");
      expect(ou.ouId.length).toBeGreaterThan(0);
      expect(typeof ou.ouArn).toBe("string");
      expect(ou.ouArn.startsWith("arn:aws:organizations::")).toBe(true);
      expect(typeof ou.name).toBe("string");
      expect(ou.name.length).toBeGreaterThan(0);
      expect(typeof ou.tags).toBe("object");
    }

    yield* stack.destroy();
  }),
);

test.provider(
  "restores ownership tags removed from AWS",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const roots = yield* organizations.listRoots({});
      const parentId = roots.Roots?.[0]?.Id;
      if (!parentId) {
        return yield* Effect.fail(
          new Error("An AWS Organizations root is required"),
        );
      }

      const makeOU = (phase: string) =>
        AWS.Organizations.OrganizationalUnit("TagDriftOU", {
          parentId,
          tags: { phase },
        });
      const readTags = (resourceId: string) =>
        organizations.listTagsForResource
          .items({ ResourceId: resourceId })
          .pipe(
            Stream.runCollect,
            Effect.map((tags) =>
              Object.fromEntries(tags.map((tag) => [tag.Key!, tag.Value!])),
            ),
          );

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(makeOU("created"));
        const originalTags = yield* readTags(created.ouId);
        const ownershipKeys = [
          "alchemy::stack",
          "alchemy::stage",
          "alchemy::id",
        ];
        for (const key of ownershipKeys) {
          expect(originalTags[key]).toBeDefined();
        }

        yield* organizations.untagResource({
          ResourceId: created.ouId,
          TagKeys: ownershipKeys,
        });
        expect(yield* readTags(created.ouId)).toEqual({ phase: "created" });

        // Changing a user tag forces reconciliation rather than a no-op deploy.
        const repaired = yield* stack.deploy(makeOU("repaired"));
        expect(repaired.ouId).toEqual(created.ouId);
        const expected = { ...originalTags, phase: "repaired" };
        expect(yield* readTags(created.ouId)).toEqual(expected);
        expect(repaired.tags).toEqual(expected);

        // Force a second reconciliation and verify ownership tags stay intact.
        const converged = yield* stack.deploy(makeOU("converged"));
        const finalTags = { ...originalTags, phase: "converged" };
        expect(converged.ouId).toEqual(created.ouId);
        expect(yield* readTags(created.ouId)).toEqual(finalTags);
        expect(converged.tags).toEqual(finalTags);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));
    }),
  { timeout: 120_000 },
);
