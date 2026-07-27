import * as AWS from "@/AWS";
import { SubnetGroup } from "@/AWS/DAX";
import * as Test from "@/Test/Alchemy";
import * as dax from "@distilled.cloud/aws/dax";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "describeSubnetGroups on a nonexistent group fails with SubnetGroupNotFoundFault",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        dax.describeSubnetGroups({
          SubnetGroupNames: ["alchemy-nonexistent-dax-subnet-probe"],
        }),
      );
      expect(error._tag).toBe("SubnetGroupNotFoundFault");
    }),
);

// Resolve default-for-AZ subnets from the account's default VPC.
const defaultSubnetIds = Effect.gen(function* () {
  const vpc = yield* getDefaultVpc;
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  });
  const ids = (subnets.Subnets ?? [])
    .map((s) => s.SubnetId)
    .filter((id): id is `subnet-${string}` => id !== undefined)
    .sort();
  if (ids.length < 3) {
    return yield* Effect.die(
      new Error("default VPC has fewer than 3 default-for-AZ subnets"),
    );
  }
  return ids;
});

const assertGone = (name: string) =>
  dax.describeSubnetGroups({ SubnetGroupNames: [name] }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`subnet group '${name}' still exists`)),
    ),
    Effect.catchTag("SubnetGroupNotFoundFault", () => Effect.void),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create, update description and subnets, delete a DAX subnet group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const subnetIds = yield* defaultSubnetIds;

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* SubnetGroup("Subnets", {
            description: "alchemy dax subnet group",
            subnetIds: subnetIds.slice(0, 2),
          });
          return { group };
        }),
      );

      expect(group.subnetGroupName).toBeDefined();
      expect(group.vpcId).toBeDefined();
      expect(new Set(group.subnetIds)).toEqual(new Set(subnetIds.slice(0, 2)));

      // Out-of-band verification via distilled.
      const described = yield* dax.describeSubnetGroups({
        SubnetGroupNames: [group.subnetGroupName],
      });
      const observed = described.SubnetGroups?.[0];
      expect(observed?.Description).toBe("alchemy dax subnet group");
      expect(observed?.VpcId).toBeDefined();

      // Update the description and widen the subnet set in place.
      const { group: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* SubnetGroup("Subnets", {
            description: "alchemy dax subnet group v2",
            subnetIds: subnetIds.slice(0, 3),
          });
          return { group };
        }),
      );
      expect(updated.subnetGroupName).toBe(group.subnetGroupName);
      expect(new Set(updated.subnetIds)).toEqual(
        new Set(subnetIds.slice(0, 3)),
      );

      const redescribed = yield* dax.describeSubnetGroups({
        SubnetGroupNames: [group.subnetGroupName],
      });
      expect(redescribed.SubnetGroups?.[0]?.Description).toBe(
        "alchemy dax subnet group v2",
      );

      yield* stack.destroy();
      yield* assertGone(group.subnetGroupName);
    }),
  { timeout: 240_000 },
);
