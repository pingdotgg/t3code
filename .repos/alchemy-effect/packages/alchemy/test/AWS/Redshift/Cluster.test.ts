import * as AWS from "@/AWS";
import type { SubnetId } from "@/AWS/EC2/Subnet.ts";
import { Cluster, ClusterSubnetGroup } from "@/AWS/Redshift";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as redshift from "@distilled.cloud/aws/redshift";
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
        redshift.describeClusters({
          ClusterIdentifier: "alchemy-nonexistent-redshift-probe",
        }),
      );
      expect(error._tag).toBe("ClusterNotFoundFault");
    }),
);

// Resolve two default-for-AZ subnets in the default VPC.
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
    .sort()
    .slice(0, 2);
  if (subnetIds.length < 2) {
    return yield* Effect.die(
      new Error("default VPC has fewer than 2 default-for-az subnets"),
    );
  }
  return subnetIds as SubnetId[];
});

// Deletion is verified as INITIATED (status `deleting`, irreversible) or
// fully gone. Full disappearance takes several more minutes server-side;
// waiting for it would push the test into its timeout.
const assertClusterDeleting = (identifier: string) =>
  Effect.gen(function* () {
    const status = yield* redshift
      .describeClusters({ ClusterIdentifier: identifier })
      .pipe(
        Effect.map((r) => r.Clusters?.[0]?.ClusterStatus ?? "gone"),
        Effect.catchTag("ClusterNotFoundFault", () =>
          Effect.succeed("gone" as const),
        ),
      );
    if (status !== "gone" && status !== "deleting") {
      return yield* Effect.fail(
        new Error(`cluster '${identifier}' still exists (status: ${status})`),
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

// Provisioned Redshift clusters take ~5-10 minutes to reach `available` and
// bill hourly per node while they exist. The full lifecycle is gated behind
// AWS_TEST_SLOW=1 and always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create single-node Redshift cluster, verify, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const subnetIds = yield* defaultSubnets;

      const { cluster } = yield* stack.deploy(
        Effect.gen(function* () {
          const subnetGroup = yield* ClusterSubnetGroup("WarehouseSubnets", {
            description: "alchemy redshift cluster subnets",
            subnetIds,
          });
          const cluster = yield* Cluster("Warehouse", {
            nodeType: "ra3.large",
            numberOfNodes: 1,
            masterUsername: "alchemyadmin",
            masterUserPassword: Redacted.make("AlchemyRedshiftTest1"),
            dbName: "analytics",
            clusterSubnetGroupName: subnetGroup.clusterSubnetGroupName,
            publiclyAccessible: false,
            encrypted: true,
            tags: { fixture: "redshift-cluster" },
          });
          return { cluster };
        }),
      );

      expect(cluster.clusterIdentifier).toBeDefined();
      expect(cluster.clusterArn).toContain(":cluster:");
      expect(cluster.clusterStatus).toBe("available");
      expect(cluster.nodeType).toBe("ra3.large");
      expect(cluster.numberOfNodes).toBe(1);
      expect(cluster.dbName).toBe("analytics");
      expect(cluster.masterUsername).toBe("alchemyadmin");
      expect(cluster.endpointAddress).toContain("redshift");
      expect(cluster.endpointPort).toBe(5439);
      expect(cluster.publiclyAccessible).toBe(false);
      expect(cluster.encrypted).toBe(true);

      // Out-of-band verification via distilled, tags included.
      const described = yield* redshift.describeClusters({
        ClusterIdentifier: cluster.clusterIdentifier,
      });
      const observed = described.Clusters?.[0];
      expect(observed?.ClusterStatus).toBe("available");
      expect(observed?.NodeType).toBe("ra3.large");
      expect(observed?.Encrypted).toBe(true);
      expect(
        observed?.Tags?.some(
          (t) => t.Key === "fixture" && t.Value === "redshift-cluster",
        ),
      ).toBe(true);

      // Destroy immediately — clusters bill while they exist — and verify
      // deletion was initiated out-of-band.
      yield* stack.destroy();
      yield* assertClusterDeleting(cluster.clusterIdentifier);
    }),
  // create (~5-10 min) + delete initiation, one test.
  { timeout: 1_500_000 },
);
