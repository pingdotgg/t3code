import * as AWS from "@/AWS";
import { SubnetGroup } from "@/AWS/MemoryDB";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as memorydb from "@distilled.cloud/aws/memorydb";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Resolve two default-for-AZ subnets from the account's default VPC.
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
    .filter((id): id is string => id !== undefined)
    .sort();
  if (ids.length < 2) {
    return yield* Effect.die(
      new Error("default VPC has fewer than 2 default-for-AZ subnets"),
    );
  }
  return ids;
});

const assertGone = (name: string) =>
  memorydb.describeSubnetGroups({ SubnetGroupName: name }).pipe(
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
  "create, update description, delete a MemoryDB subnet group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const subnetIds = yield* defaultSubnetIds;

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* SubnetGroup("Subnets", {
            description: "alchemy memorydb subnet group",
            subnetIds: subnetIds.slice(0, 2),
            tags: { fixture: "memorydb-subnet-group" },
          });
          return { group };
        }),
      );

      expect(group.subnetGroupName).toBeDefined();
      expect(group.subnetGroupArn).toContain(":subnetgroup/");
      expect(new Set(group.subnetIds)).toEqual(new Set(subnetIds.slice(0, 2)));

      // Out-of-band verification.
      const described = yield* memorydb.describeSubnetGroups({
        SubnetGroupName: group.subnetGroupName,
      });
      const observed = described.SubnetGroups?.[0];
      expect(observed?.Description).toBe("alchemy memorydb subnet group");
      expect(observed?.VpcId).toBeDefined();

      // Update the description in place (name unchanged).
      const { group: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* SubnetGroup("Subnets", {
            description: "alchemy memorydb subnet group v2",
            subnetIds: subnetIds.slice(0, 2),
            tags: { fixture: "memorydb-subnet-group", env: "test" },
          });
          return { group };
        }),
      );
      expect(updated.subnetGroupName).toBe(group.subnetGroupName);
      expect(updated.description).toBe("alchemy memorydb subnet group v2");

      const redescribed = yield* memorydb.describeSubnetGroups({
        SubnetGroupName: group.subnetGroupName,
      });
      expect(redescribed.SubnetGroups?.[0]?.Description).toBe(
        "alchemy memorydb subnet group v2",
      );

      yield* stack.destroy();
      yield* assertGone(group.subnetGroupName);
    }),
  { timeout: 240_000 },
);
