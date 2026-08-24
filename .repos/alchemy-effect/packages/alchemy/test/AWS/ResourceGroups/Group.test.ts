import * as AWS from "@/AWS";
import { Group } from "@/AWS/ResourceGroups";
import * as Test from "@/Test/Alchemy";
import * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

const assertGroupGone = (groupName: string) =>
  resourcegroups.getGroup({ Group: groupName }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`group ${groupName} still exists`)),
    ),
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

const tagQuery = (tagKey: string, tagValue: string) =>
  JSON.stringify({
    ResourceTypeFilters: ["AWS::AllSupported"],
    TagFilters: [{ Key: tagKey, Values: [tagValue] }],
  });

describe("AWS.ResourceGroups.Group", () => {
  test.provider(
    "creates, updates, and deletes a tag-based group",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const group = yield* Group("TagGroup", {
              description: "Alchemy resource-groups test",
              resourceQuery: {
                type: "TAG_FILTERS_1_0",
                query: tagQuery("alchemy-rg-test", "v1"),
              },
              tags: { purpose: "alchemy-test" },
            });
            return {
              groupName: group.groupName,
              groupArn: group.groupArn,
            };
          }),
        );

        // Verify out-of-band via distilled.
        const observed = yield* resourcegroups.getGroup({
          Group: created.groupName,
        });
        expect(observed.Group.GroupArn).toEqual(created.groupArn);
        expect(observed.Group.Description).toEqual(
          "Alchemy resource-groups test",
        );

        const query = yield* resourcegroups.getGroupQuery({
          Group: created.groupName,
        });
        expect(query.GroupQuery?.ResourceQuery).toEqual({
          Type: "TAG_FILTERS_1_0",
          Query: tagQuery("alchemy-rg-test", "v1"),
        });

        const tags = yield* resourcegroups.getTags({
          Arn: created.groupArn,
        });
        expect(tags.Tags?.purpose).toEqual("alchemy-test");
        expect(tags.Tags?.["alchemy::id"]).toEqual("TagGroup");

        // The query group is functional: enumerating members succeeds
        // (nothing carries the probe tag, so it's simply empty).
        const members = yield* resourcegroups.listGroupResources
          .pages({ Group: created.groupName })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.Resources ?? []),
            ),
          );
        expect(members).toEqual([]);

        // Update description, query, and tags in place — the ARN must
        // survive (no replacement).
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const group = yield* Group("TagGroup", {
              description: "Alchemy resource-groups test updated",
              resourceQuery: {
                type: "TAG_FILTERS_1_0",
                query: tagQuery("alchemy-rg-test", "v2"),
              },
              tags: { purpose: "alchemy-test-updated" },
            });
            return {
              groupName: group.groupName,
              groupArn: group.groupArn,
            };
          }),
        );
        expect(updated.groupArn).toEqual(created.groupArn);

        const afterUpdate = yield* resourcegroups.getGroup({
          Group: created.groupName,
        });
        expect(afterUpdate.Group.Description).toEqual(
          "Alchemy resource-groups test updated",
        );
        const queryAfterUpdate = yield* resourcegroups.getGroupQuery({
          Group: created.groupName,
        });
        expect(queryAfterUpdate.GroupQuery?.ResourceQuery.Query).toEqual(
          tagQuery("alchemy-rg-test", "v2"),
        );
        const tagsAfterUpdate = yield* resourcegroups.getTags({
          Arn: created.groupArn,
        });
        expect(tagsAfterUpdate.Tags?.purpose).toEqual("alchemy-test-updated");

        yield* stack.destroy();
        yield* assertGroupGone(created.groupName);
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "replaces the group when the name changes",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const groupProps = {
          resourceQuery: {
            type: "TAG_FILTERS_1_0",
            query: tagQuery("alchemy-rg-replace", "true"),
          },
        } as const;

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const group = yield* Group("RenamedGroup", {
              ...groupProps,
              groupName: "alchemy-test-rg-original",
            });
            return { groupName: group.groupName };
          }),
        );
        expect(created.groupName).toEqual("alchemy-test-rg-original");

        const renamed = yield* stack.deploy(
          Effect.gen(function* () {
            const group = yield* Group("RenamedGroup", {
              ...groupProps,
              groupName: "alchemy-test-rg-renamed",
            });
            return { groupName: group.groupName };
          }),
        );
        expect(renamed.groupName).toEqual("alchemy-test-rg-renamed");

        // The old group is deleted by the replacement.
        yield* assertGroupGone("alchemy-test-rg-original");

        const observed = yield* resourcegroups.getGroup({
          Group: "alchemy-test-rg-renamed",
        });
        expect(observed.Group.Name).toEqual("alchemy-test-rg-renamed");

        yield* stack.destroy();
        yield* assertGroupGone("alchemy-test-rg-renamed");
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "creates a configuration-based group",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const group = yield* Group("ConfigGroup", {
              configuration: [
                {
                  type: "AWS::ResourceGroups::Generic",
                  parameters: [
                    {
                      name: "allowed-resource-types",
                      values: ["AWS::EC2::CapacityReservation"],
                    },
                  ],
                },
                { type: "AWS::EC2::CapacityReservationPool" },
              ],
            });
            return {
              groupName: group.groupName,
              groupArn: group.groupArn,
            };
          }),
        );

        const observed = yield* resourcegroups.getGroupConfiguration({
          Group: created.groupName,
        });
        const types = (observed.GroupConfiguration?.Configuration ?? []).map(
          (item) => item.Type,
        );
        expect(types).toContain("AWS::EC2::CapacityReservationPool");
        expect(types).toContain("AWS::ResourceGroups::Generic");

        // Re-deploying the identical configuration is a no-op (the
        // order-insensitive fingerprint must not trigger a rejected
        // putGroupConfiguration).
        const second = yield* stack.deploy(
          Effect.gen(function* () {
            const group = yield* Group("ConfigGroup", {
              configuration: [
                {
                  type: "AWS::ResourceGroups::Generic",
                  parameters: [
                    {
                      name: "allowed-resource-types",
                      values: ["AWS::EC2::CapacityReservation"],
                    },
                  ],
                },
                { type: "AWS::EC2::CapacityReservationPool" },
              ],
            });
            return { groupArn: group.groupArn };
          }),
        );
        expect(second.groupArn).toEqual(created.groupArn);

        yield* stack.destroy();
        yield* assertGroupGone(created.groupName);
      }),
    { timeout: 120_000 },
  );
});
