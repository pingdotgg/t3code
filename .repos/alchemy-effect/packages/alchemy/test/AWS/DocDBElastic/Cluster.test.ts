import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/DocDBElastic";
import { AWSEnvironment } from "@/AWS/Environment";
import * as Test from "@/Test/Alchemy";
import * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on. Runs in every
// CI pass at near-zero cost, unlike the gated lifecycle below.
test.provider(
  "getCluster on a nonexistent cluster ARN fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      const error = yield* Effect.flip(
        docdbelastic.getCluster({
          clusterArn: `arn:aws:docdb-elastic:${region}:${accountId}:cluster/00000000-0000-0000-0000-000000000000`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
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
  // DocumentDB elastic clusters are not offered in every AZ (e.g.
  // us-west-2d) — pick subnets from the region's first three AZs (suffix
  // a/b/c) only.
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

// Deletion is verified as INITIATED (status DELETING, irreversible) or fully
// gone. Full disappearance takes several more minutes server-side.
const assertClusterDeleting = (arn: string) =>
  Effect.gen(function* () {
    const status = yield* docdbelastic.getCluster({ clusterArn: arn }).pipe(
      Effect.map((r) => r.cluster.status),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("GONE" as const),
      ),
    );
    if (status !== "GONE" && status !== "DELETING") {
      return yield* Effect.fail(
        new Error(`cluster '${arn}' still exists (status: ${status})`),
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

// A DocumentDB elastic cluster takes ~8-10 minutes to provision and bills
// per shard-vCPU-hour while it exists. The full lifecycle is gated behind
// AWS_TEST_SLOW=1 and always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create elastic cluster (1 shard, capacity 2), verify, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const network = yield* defaultNetwork;

      const { cluster } = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* Cluster("Documents", {
            adminUserName: "alchemyadmin",
            adminUserPassword: Redacted.make("AlchemyTestPassw0rd"),
            shardCapacity: 2,
            shardCount: 1,
            subnetIds: network.subnetIds,
            vpcSecurityGroupIds: network.securityGroupIds,
            backupRetentionPeriod: "1 day",
            tags: { fixture: "docdb-elastic-cluster" },
          });
          return { cluster };
        }),
      );

      expect(cluster.clusterName).toBeDefined();
      expect(cluster.clusterArn).toContain(":cluster/");
      expect(cluster.status).toBe("ACTIVE");
      expect(cluster.clusterEndpoint).toContain("docdb-elastic");
      expect(cluster.adminUserName).toBe("alchemyadmin");
      expect(cluster.authType).toBe("PLAIN_TEXT");
      expect(cluster.shardCapacity).toBe(2);
      expect(cluster.shardCount).toBe(1);
      expect(new Set(cluster.subnetIds)).toEqual(new Set(network.subnetIds));

      // Out-of-band verification via distilled.
      const described = yield* docdbelastic.getCluster({
        clusterArn: cluster.clusterArn,
      });
      expect(described.cluster.status).toBe("ACTIVE");
      expect(described.cluster.shardCount).toBe(1);

      // Destroy immediately — clusters bill while they exist — and verify
      // deletion was initiated out-of-band.
      yield* stack.destroy();
      yield* assertClusterDeleting(cluster.clusterArn);
    }),
  // cluster create (~10 min) + delete initiation, one test.
  { timeout: 1_500_000 },
);
