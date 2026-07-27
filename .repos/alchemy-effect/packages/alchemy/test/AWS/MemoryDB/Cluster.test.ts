import * as AWS from "@/AWS";
import { ACL, Cluster, SubnetGroup, User } from "@/AWS/MemoryDB";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as memorydb from "@distilled.cloud/aws/memorydb";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "describeClusters on a nonexistent cluster fails with ClusterNotFoundFault",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        memorydb.describeClusters({
          ClusterName: "alchemy-nonexistent-memorydb-probe",
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
  const subnetIds = (subnets.Subnets ?? [])
    .map((s) => s.SubnetId)
    .filter((id): id is string => id !== undefined)
    .sort()
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

// Deletion is verified as INITIATED (status `deleting`, irreversible) or fully
// gone. Full disappearance takes several more minutes server-side; waiting for
// it would push the test into its timeout.
const assertClusterDeleting = (name: string) =>
  Effect.gen(function* () {
    const status = yield* memorydb.describeClusters({ ClusterName: name }).pipe(
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

// MemoryDB clusters take ~10-15 minutes to provision and are billed per node
// while they exist. The full lifecycle is gated behind AWS_TEST_SLOW=1 and
// always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create single-node MemoryDB cluster, verify, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const network = yield* defaultNetwork;

      const { cluster } = yield* stack.deploy(
        Effect.gen(function* () {
          const user = yield* User("ClusterUser", {
            authenticationMode: {
              type: "password",
              passwords: [Redacted.make("AlchemyMemoryDbTestPass01")],
            },
            accessString: "on ~* +@all",
          });
          const acl = yield* ACL("ClusterAcl", {
            userNames: [user.userName],
          });
          const subnetGroup = yield* SubnetGroup("ClusterSubnets", {
            description: "alchemy memorydb cluster subnets",
            subnetIds: network.subnetIds,
          });
          const cluster = yield* Cluster("Cache", {
            nodeType: "db.t4g.small",
            engine: "valkey",
            aclName: acl.aclName,
            subnetGroupName: subnetGroup.subnetGroupName,
            securityGroupIds: network.securityGroupIds,
            numShards: 1,
            numReplicasPerShard: 0,
            description: "alchemy memorydb fixture",
            tags: { fixture: "memorydb-cluster" },
          });
          return { cluster };
        }),
      );

      expect(cluster.clusterName).toBeDefined();
      expect(cluster.clusterArn).toContain(":cluster/");
      expect(cluster.status).toBe("available");
      expect(cluster.nodeType).toBe("db.t4g.small");
      expect(cluster.numberOfShards).toBe(1);
      expect(cluster.endpointAddress).toContain("memorydb");

      // Out-of-band verification via distilled.
      const described = yield* memorydb.describeClusters({
        ClusterName: cluster.clusterName,
      });
      const observed = described.Clusters?.[0];
      expect(observed?.Status).toBe("available");
      expect(observed?.TLSEnabled).toBe(true);
      expect(observed?.ACLName).toBeDefined();

      // Destroy immediately — clusters bill while they exist — and verify
      // deletion was initiated out-of-band.
      yield* stack.destroy();
      yield* assertClusterDeleting(cluster.clusterName);
    }),
  // create (~10-15 min) + delete initiation, one test.
  { timeout: 1_500_000 },
);
