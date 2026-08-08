import * as AWS from "@/AWS";
import { Cluster, SubnetGroup } from "@/AWS/DAX";
import { Role } from "@/AWS/IAM/Role.ts";
import * as Test from "@/Test/Alchemy";
import * as dax from "@distilled.cloud/aws/dax";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on. Runs in every
// CI pass at near-zero cost, unlike the gated lifecycle below.
test.provider(
  "describeClusters on a nonexistent cluster fails with ClusterNotFoundFault",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        dax.describeClusters({
          ClusterNames: ["alchemy-nonexistent-dax-cluster-probe"],
        }),
      );
      expect(error._tag).toBe("ClusterNotFoundFault");
    }),
);

// Resolve two default-for-AZ subnets and the default security group.
const defaultNetwork = Effect.gen(function* () {
  const vpc = yield* getDefaultVpc;
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  });
  // DAX is not offered in every AZ (e.g. us-west-2d) — pick subnets from the
  // region's first three AZs (suffix a/b/c) only.
  const subnetIds = (subnets.Subnets ?? [])
    .filter((s) => /[abc]$/.test(s.AvailabilityZone ?? ""))
    .sort((l, r) =>
      (l.AvailabilityZone ?? "").localeCompare(r.AvailabilityZone ?? ""),
    )
    .map((s) => s.SubnetId)
    .filter((id): id is `subnet-${string}` => id !== undefined)
    .slice(0, 2);
  const groups = yield* EC2.describeSecurityGroups({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "group-name", Values: ["default"] },
    ],
  });
  const securityGroupId = groups.SecurityGroups?.[0]?.GroupId;
  if (subnetIds.length < 2 || securityGroupId === undefined) {
    return yield* Effect.die(
      new Error("default VPC is missing subnets or its default security group"),
    );
  }
  return { subnetIds, securityGroupIds: [securityGroupId] };
});

// Deletion is verified as INITIATED (status `deleting`, irreversible) or
// fully gone. Full disappearance takes several more minutes server-side.
const assertClusterDeleting = (name: string) =>
  Effect.gen(function* () {
    const status = yield* dax.describeClusters({ ClusterNames: [name] }).pipe(
      Effect.map((r) => r.Clusters?.[0]?.Status ?? "gone"),
      Effect.catchTag("ClusterNotFoundFault", () =>
        Effect.succeed("gone" as const),
      ),
    );
    if (status !== "gone" && status !== "deleting") {
      return yield* Effect.fail(
        new Error(`cluster '${name}' still exists (status: ${status})`),
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

// A DAX cluster takes ~5-10 minutes to provision and bills per node-hour
// while it exists. The full lifecycle is gated behind AWS_TEST_SLOW=1 and
// always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create DAX cluster (dax.t3.small), verify, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const network = yield* defaultNetwork;

      const { cluster } = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* Role("DaxRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "dax.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            managedPolicyArns: [
              "arn:aws:iam::aws:policy/AmazonDynamoDBReadOnlyAccess",
            ],
          });
          const subnetGroup = yield* SubnetGroup("Subnets", {
            description: "alchemy dax cluster subnets",
            subnetIds: network.subnetIds,
          });
          const cluster = yield* Cluster("Cache", {
            nodeType: "dax.t3.small",
            replicationFactor: 1,
            iamRoleArn: role.roleArn,
            subnetGroupName: subnetGroup.subnetGroupName,
            securityGroupIds: network.securityGroupIds,
            description: "alchemy dax test cluster",
            tags: { fixture: "dax-cluster" },
          });
          return { cluster };
        }),
      );

      expect(cluster.clusterName).toBeDefined();
      expect(cluster.clusterArn).toContain(":cache/");
      expect(cluster.status).toBe("available");
      expect(cluster.nodeType).toBe("dax.t3.small");
      expect(cluster.totalNodes).toBe(1);
      expect(cluster.discoveryEndpointAddress).toBeDefined();
      expect(cluster.discoveryEndpointPort).toBeDefined();

      // Out-of-band verification via distilled.
      const described = yield* dax.describeClusters({
        ClusterNames: [cluster.clusterName],
      });
      const observed = described.Clusters?.[0];
      expect(observed?.Status).toBe("available");
      expect(observed?.NodeType).toBe("dax.t3.small");
      expect(observed?.TotalNodes).toBe(1);

      // Destroy immediately — clusters bill while they exist — and verify
      // deletion was initiated out-of-band.
      yield* stack.destroy();
      yield* assertClusterDeleting(cluster.clusterName);
    }),
  // cluster create (~10 min) + delete initiation, one test.
  { timeout: 1_500_000 },
);
