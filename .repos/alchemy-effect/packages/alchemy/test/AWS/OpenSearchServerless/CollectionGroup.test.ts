import * as AWS from "@/AWS";
import { CollectionGroup } from "@/AWS/OpenSearchServerless";
import * as Test from "@/Test/Alchemy";
import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const GROUP_NAME = "alchemy-test-aoss-group";

const observe = (name: string) =>
  aoss
    .batchGetCollectionGroup({ names: [name] })
    .pipe(Effect.map((r) => r.collectionGroupDetails?.[0]));

const assertGone = (name: string) =>
  observe(name).pipe(
    Effect.flatMap((detail) =>
      detail === undefined
        ? Effect.void
        : Effect.fail(new Error(`collection group ${name} still exists`)),
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(5)]),
    }),
  );

// An empty collection group is free (capacity limits only — no OCUs are
// provisioned until collections are placed in it), so the full lifecycle
// runs ungated: create, no-op, update description, destroy, verify gone.
test.provider(
  "collection group lifecycle: create, no-op, update, destroy, verify gone",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const deployGroup = (description?: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const group = yield* CollectionGroup("Group", {
              groupName: GROUP_NAME,
              standbyReplicas: "DISABLED",
              description,
              tags: { purpose: "alchemy-test" },
            });
            return { group };
          }),
        );

      // Create.
      const created = yield* deployGroup("alchemy test group");
      expect(created.group.collectionGroupName).toBe(GROUP_NAME);
      expect(created.group.collectionGroupArn).toContain(":aoss:");
      expect(created.group.collectionGroupId).toBeDefined();
      expect(created.group.standbyReplicas).toBe("DISABLED");

      // Out-of-band verification via distilled (including internal tags —
      // batchGetCollectionGroup does not return tags, so read them via
      // listTagsForResource).
      const observed = yield* observe(GROUP_NAME);
      expect(observed?.name).toBe(GROUP_NAME);
      const observedTags = yield* aoss
        .listTagsForResource({
          resourceArn: created.group.collectionGroupArn,
        })
        .pipe(Effect.map((r) => (r.tags ?? []).map((t) => t.key)));
      expect(observedTags).toContain("purpose");
      expect(observedTags.some((k) => k.startsWith("alchemy::"))).toBe(true);

      // No-op redeploy.
      const noop = yield* deployGroup("alchemy test group");
      expect(noop.group.collectionGroupId).toBe(
        created.group.collectionGroupId,
      );

      // Update the description.
      yield* deployGroup("alchemy test group v2");
      const observedUpdated = yield* observe(GROUP_NAME);
      expect(observedUpdated?.description).toBe("alchemy test group v2");

      // Destroy and verify deletion out-of-band.
      yield* stack.destroy();
      yield* assertGone(GROUP_NAME);
    }),
  { timeout: 180_000 },
);
