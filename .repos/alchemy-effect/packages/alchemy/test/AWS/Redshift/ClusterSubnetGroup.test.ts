import * as AWS from "@/AWS";
import type { SubnetId } from "@/AWS/EC2/Subnet.ts";
import { ClusterSubnetGroup } from "@/AWS/Redshift";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as redshift from "@distilled.cloud/aws/redshift";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "describeClusterSubnetGroups on a nonexistent group fails with ClusterSubnetGroupNotFoundFault",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        redshift.describeClusterSubnetGroups({
          ClusterSubnetGroupName: "alchemy-nonexistent-redshift-sng-probe",
        }),
      );
      expect(error._tag).toBe("ClusterSubnetGroupNotFoundFault");
    }),
);

// Resolve default-for-AZ subnets in the default VPC (sorted for determinism).
const defaultSubnets = Effect.gen(function* () {
  const vpc = yield* getDefaultVpc;
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  });
  const subnetIds = (subnets.Subnets ?? [])
    .map((s) => s.SubnetId)
    .filter((id): id is string => id !== undefined)
    .sort();
  if (subnetIds.length < 2) {
    return yield* Effect.die(
      new Error("default VPC has fewer than 2 default-for-az subnets"),
    );
  }
  return subnetIds as SubnetId[];
});

test.provider(
  "create, update subnets and tags, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const subnetIds = yield* defaultSubnets;

      // Create with a single subnet.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ClusterSubnetGroup("Subnets", {
            description: "alchemy redshift subnet group",
            subnetIds: subnetIds.slice(0, 1),
            tags: { fixture: "redshift-subnet-group" },
          });
        }),
      );

      expect(created.clusterSubnetGroupName).toBeDefined();
      expect(created.clusterSubnetGroupArn).toContain(":subnetgroup:");
      expect(created.subnetIds).toEqual(subnetIds.slice(0, 1));
      expect(created.vpcId).toBeDefined();
      expect(created.tags.fixture).toBe("redshift-subnet-group");

      // Out-of-band verification via distilled, tags included.
      const observed = yield* redshift.describeClusterSubnetGroups({
        ClusterSubnetGroupName: created.clusterSubnetGroupName,
      });
      const group = observed.ClusterSubnetGroups?.[0];
      expect(group?.SubnetGroupStatus).toBe("Complete");
      expect(
        group?.Tags?.some(
          (t) => t.Key === "fixture" && t.Value === "redshift-subnet-group",
        ),
      ).toBe(true);

      // Update — expand to two subnets, change description, swap tags.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ClusterSubnetGroup("Subnets", {
            description: "alchemy redshift subnet group (updated)",
            subnetIds: subnetIds.slice(0, 2),
            tags: { stage: "updated" },
          });
        }),
      );

      expect(updated.clusterSubnetGroupName).toBe(
        created.clusterSubnetGroupName,
      );
      expect(updated.description).toBe(
        "alchemy redshift subnet group (updated)",
      );
      expect([...updated.subnetIds].sort()).toEqual(subnetIds.slice(0, 2));
      expect(updated.tags.stage).toBe("updated");
      expect(updated.tags.fixture).toBeUndefined();

      const reobserved = yield* redshift.describeClusterSubnetGroups({
        ClusterSubnetGroupName: created.clusterSubnetGroupName,
      });
      const regroup = reobserved.ClusterSubnetGroups?.[0];
      expect(regroup?.Subnets?.length).toBe(2);
      expect(regroup?.Tags?.some((t) => t.Key === "fixture")).toBe(false);

      // Destroy and verify gone with the typed not-found tag.
      yield* stack.destroy();
      const error = yield* Effect.flip(
        redshift.describeClusterSubnetGroups({
          ClusterSubnetGroupName: created.clusterSubnetGroupName,
        }),
      );
      expect(error._tag).toBe("ClusterSubnetGroupNotFoundFault");
    }),
  { timeout: 120_000 },
);
