import * as AWS from "@/AWS";
import { ReplicationInstance, ReplicationSubnetGroup } from "@/AWS/DMS";
import { Subnet, Vpc } from "@/AWS/EC2";
import { AWSEnvironment } from "@/AWS/Environment";
import * as Test from "@/Test/Alchemy";
import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { reapDmsOrphans } from "./reap.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "deleteReplicationInstance on a nonexistent instance fails with ResourceNotFoundFault",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      const error = yield* Effect.flip(
        dms.deleteReplicationInstance({
          ReplicationInstanceArn: `arn:aws:dms:${region}:${accountId}:rep:AAAAAAAAAAAAAAAAAAAAAAAAAA`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundFault");
    }),
);

const findInstance = (identifier: string) =>
  dms
    .describeReplicationInstances({
      Filters: [{ Name: "replication-instance-id", Values: [identifier] }],
    })
    .pipe(
      Effect.map((r) => r.ReplicationInstances?.[0]),
      Effect.catchTag("ResourceNotFoundFault", () => Effect.succeed(undefined)),
    );

// A replication instance takes ~6-10 minutes to provision, a similar time to
// delete, and is billed hourly while it exists. The full lifecycle is gated
// behind AWS_TEST_SLOW=1 and always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create replication instance in a subnet group, destroy, verify gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // A previous hard-killed run (in-memory scratch state) may have
      // orphaned the VPC fixture — reap it out-of-band before deploying.
      yield* reapDmsOrphans;

      const azResult = yield* ec2.describeAvailabilityZones({});
      const azs = (azResult.AvailabilityZones ?? [])
        .filter((az) => az.State === "available")
        .map((az) => az.ZoneName!);
      const [az1, az2] = azs;

      const { instance } = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("DmsInstVpc", { cidrBlock: "10.92.0.0/16" });
          const subnetA = yield* Subnet("DmsInstSubnetA", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.92.1.0/24",
            availabilityZone: az1,
          });
          const subnetB = yield* Subnet("DmsInstSubnetB", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.92.2.0/24",
            availabilityZone: az2,
          });
          const subnetGroup = yield* ReplicationSubnetGroup("InstGroup", {
            description: "alchemy dms instance test",
            subnetIds: [subnetA.subnetId, subnetB.subnetId],
          });
          const instance = yield* ReplicationInstance("Instance", {
            replicationInstanceClass: "dms.t3.micro",
            allocatedStorage: 20,
            replicationSubnetGroupIdentifier:
              subnetGroup.replicationSubnetGroupIdentifier,
            publiclyAccessible: false,
            multiAZ: false,
          });
          return { instance };
        }),
      );

      expect(instance.replicationInstanceArn).toContain(":rep:");
      expect(instance.replicationInstanceClass).toBe("dms.t3.micro");
      expect(instance.status).toBe("available");

      const observed = yield* findInstance(
        instance.replicationInstanceIdentifier,
      );
      expect(observed?.ReplicationInstanceArn).toBe(
        instance.replicationInstanceArn,
      );

      // Destroy immediately — the instance bills hourly — and verify deletion
      // has at least initiated (full disappearance takes several more minutes).
      yield* stack.destroy();
      const status = yield* findInstance(
        instance.replicationInstanceIdentifier,
      ).pipe(
        Effect.map((i) => i?.ReplicationInstanceStatus ?? "gone"),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("10 seconds"),
            Schedule.recurs(12),
          ]),
        }),
      );
      expect(["gone", "deleting"]).toContain(status);
    }).pipe(
      // Converge to zero leftovers even when the body (or the engine's own
      // scratch destroy) fails: the reaper waits out the instance deletion
      // and tears the VPC fixture down out-of-band with idempotent typed
      // calls. `orDie` — a finalizer must not swallow its own failure.
      Effect.ensuring(reapDmsOrphans.pipe(Effect.orDie)),
    ),
  { timeout: 1_500_000 },
);
