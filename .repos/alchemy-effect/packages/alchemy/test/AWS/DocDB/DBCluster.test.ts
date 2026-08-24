import * as AWS from "@/AWS";
import { DBCluster, DBInstance, DBSubnetGroup } from "@/AWS/DocDB";
import * as Test from "@/Test/Alchemy";
import * as docdb from "@distilled.cloud/aws/docdb";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probes: prove the distilled error union carries the
// not-found tags this provider's read/delete paths depend on. These run in
// every CI pass at near-zero cost, unlike the gated lifecycle below.
test.provider(
  "describeDBClusters on a nonexistent cluster fails with DBClusterNotFoundFault",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        docdb.describeDBClusters({
          DBClusterIdentifier: "alchemy-nonexistent-docdb-cluster-probe",
        }),
      );
      expect(error._tag).toBe("DBClusterNotFoundFault");
    }),
);

test.provider(
  "describeDBInstances on a nonexistent instance fails with DBInstanceNotFoundFault",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        docdb.describeDBInstances({
          DBInstanceIdentifier: "alchemy-nonexistent-docdb-instance-probe",
        }),
      );
      expect(error._tag).toBe("DBInstanceNotFoundFault");
    }),
);

test.provider(
  "describeDBSubnetGroups on a nonexistent group fails with DBSubnetGroupNotFoundFault",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        docdb.describeDBSubnetGroups({
          DBSubnetGroupName: "alchemy-nonexistent-docdb-subnet-probe",
        }),
      );
      expect(error._tag).toBe("DBSubnetGroupNotFoundFault");
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
    .filter((id): id is `subnet-${string}` => id !== undefined)
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
const assertClusterDeleting = (identifier: string) =>
  Effect.gen(function* () {
    const status = yield* docdb
      .describeDBClusters({ DBClusterIdentifier: identifier })
      .pipe(
        Effect.map((r) => r.DBClusters?.[0]?.Status ?? "gone"),
        Effect.catchTag("DBClusterNotFoundFault", () =>
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

// A DocumentDB cluster + instance take ~5-10 minutes to provision and bill per
// instance-hour while they exist. The full lifecycle is gated behind
// AWS_TEST_SLOW=1 and always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create DocumentDB cluster + instance, verify, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const network = yield* defaultNetwork;

      const { cluster, instance } = yield* stack.deploy(
        Effect.gen(function* () {
          const subnetGroup = yield* DBSubnetGroup("Subnets", {
            description: "alchemy docdb cluster subnets",
            subnetIds: network.subnetIds,
          });
          const cluster = yield* DBCluster("Cluster", {
            dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
            vpcSecurityGroupIds: network.securityGroupIds,
            masterUsername: "alchemy",
            manageMasterUserPassword: true,
            backupRetentionPeriod: "1 day",
            deletionProtection: false,
            tags: { fixture: "docdb-cluster" },
          });
          const instance = yield* DBInstance("Writer", {
            dbClusterIdentifier: cluster.dbClusterIdentifier,
            dbInstanceClass: "db.t3.medium",
            tags: { fixture: "docdb-instance" },
          });
          return { cluster, instance };
        }),
      );

      expect(cluster.dbClusterIdentifier).toBeDefined();
      expect(cluster.dbClusterArn).toContain(":cluster:");
      expect(cluster.engine).toBe("docdb");
      expect(cluster.status).toBe("available");
      expect(cluster.endpoint).toContain("docdb");
      expect(cluster.masterUserSecretArn).toBeDefined();

      expect(instance.dbInstanceIdentifier).toBeDefined();
      expect(instance.dbClusterIdentifier).toBe(cluster.dbClusterIdentifier);
      expect(instance.dbInstanceClass).toBe("db.t3.medium");
      expect(instance.status).toBe("available");

      // Out-of-band verification via distilled.
      const describedCluster = yield* docdb.describeDBClusters({
        DBClusterIdentifier: cluster.dbClusterIdentifier,
      });
      const observedCluster = describedCluster.DBClusters?.[0];
      expect(observedCluster?.Status).toBe("available");
      expect(observedCluster?.Engine).toBe("docdb");
      expect(observedCluster?.DBClusterMembers?.length).toBe(1);

      const describedInstance = yield* docdb.describeDBInstances({
        DBInstanceIdentifier: instance.dbInstanceIdentifier,
      });
      expect(describedInstance.DBInstances?.[0]?.DBInstanceStatus).toBe(
        "available",
      );

      // Destroy immediately — instances bill while they exist — and verify
      // cluster deletion was initiated out-of-band.
      yield* stack.destroy();
      yield* assertClusterDeleting(cluster.dbClusterIdentifier);
    }),
  // cluster + instance create (~5-10 min) + delete initiation, one test.
  { timeout: 1_500_000 },
);
