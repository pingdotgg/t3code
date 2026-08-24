import * as AWS from "@/AWS";
import { AttributeGroup } from "@/AWS/AppRegistry";
import * as Test from "@/Test/Alchemy";
import * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { makeAppRegistryTestLease } from "./TestLease.ts";

const { test, beforeAll, afterAll } = Test.make({ providers: AWS.providers() });
const serviceLease = makeAppRegistryTestLease();

beforeAll(serviceLease.acquire, { timeout: 3_600_000 });
afterAll(serviceLease.release);

class AttributeGroupStillExists extends Data.TaggedError(
  "AttributeGroupStillExists",
)<{ specifier: string }> {}

const assertAttributeGroupGone = (specifier: string) =>
  appregistry.getAttributeGroup({ attributeGroup: specifier }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new AttributeGroupStillExists({ specifier })),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "AttributeGroupStillExists",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "creates, updates, and deletes an attribute group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* AttributeGroup("TestAttributes", {
            description: "attribute group lifecycle test",
            attributes: { owner: "platform-team", costCenter: "1234" },
            tags: { purpose: "lifecycle" },
          });
          return {
            attributeGroupId: group.attributeGroupId,
            attributeGroupArn: group.attributeGroupArn,
            attributeGroupName: group.attributeGroupName,
          };
        }),
      );
      expect(created.attributeGroupArn).toContain(":servicecatalog:");

      // out-of-band verify via distilled
      const found = yield* appregistry.getAttributeGroup({
        attributeGroup: created.attributeGroupId,
      });
      expect(found.name).toBe(created.attributeGroupName);
      expect(found.description).toBe("attribute group lifecycle test");
      expect(JSON.parse(found.attributes ?? "{}")).toEqual({
        owner: "platform-team",
        costCenter: "1234",
      });
      expect(found.tags?.purpose).toBe("lifecycle");
      expect(found.tags?.["alchemy::id"]).toBe("TestAttributes");

      // in-place update of attributes, description, and tags
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* AttributeGroup("TestAttributes", {
            description: "updated description",
            attributes: {
              owner: "commerce-team",
              costCenter: "5678",
              tier: 1,
            },
            tags: { purpose: "lifecycle-updated" },
          });
        }),
      );
      const updated = yield* appregistry.getAttributeGroup({
        attributeGroup: created.attributeGroupId,
      });
      expect(updated.id).toBe(created.attributeGroupId);
      expect(updated.description).toBe("updated description");
      expect(JSON.parse(updated.attributes ?? "{}")).toEqual({
        owner: "commerce-team",
        costCenter: "5678",
        tier: 1,
      });
      expect(updated.tags?.purpose).toBe("lifecycle-updated");

      yield* stack.destroy();
      yield* assertAttributeGroupGone(created.attributeGroupId);
    }),
  { timeout: 180_000 },
);
