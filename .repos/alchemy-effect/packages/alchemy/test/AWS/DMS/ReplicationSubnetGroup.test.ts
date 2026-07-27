import * as AWS from "@/AWS";
import { ReplicationSubnetGroup } from "@/AWS/DMS";
import { Subnet, Vpc } from "@/AWS/EC2";
import * as Test from "@/Test/Alchemy";
import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { reapDmsOrphans } from "./reap.ts";

const { test } = Test.make({ providers: AWS.providers() });

const findGroup = (identifier: string) =>
  dms
    .describeReplicationSubnetGroups({
      Filters: [{ Name: "replication-subnet-group-id", Values: [identifier] }],
    })
    .pipe(
      Effect.map((r) => r.ReplicationSubnetGroups?.[0]),
      Effect.catchTag("ResourceNotFoundFault", () => Effect.succeed(undefined)),
    );

const assertGone = (identifier: string) =>
  findGroup(identifier).pipe(
    Effect.flatMap((group) =>
      group === undefined
        ? Effect.void
        : Effect.fail(new Error(`subnet group '${identifier}' still exists`)),
    ),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(15),
      ]),
    }),
  );

test.provider(
  "create, update, delete a DMS replication subnet group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // A previous hard-killed run (in-memory scratch state) may have
      // orphaned the VPC fixture — reap it out-of-band before deploying.
      yield* reapDmsOrphans;

      // Resolve three AZs so the update can swap the subnet set.
      const azResult = yield* ec2.describeAvailabilityZones({});
      const azs = (azResult.AvailabilityZones ?? [])
        .filter((az) => az.State === "available")
        .map((az) => az.ZoneName!);
      const [az1, az2, az3] = azs;

      const { group, subnetCId } = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("DmsVpc", { cidrBlock: "10.91.0.0/16" });
          const subnetA = yield* Subnet("DmsSubnetA", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.91.1.0/24",
            availabilityZone: az1,
          });
          const subnetB = yield* Subnet("DmsSubnetB", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.91.2.0/24",
            availabilityZone: az2,
          });
          const subnetC = yield* Subnet("DmsSubnetC", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.91.3.0/24",
            availabilityZone: az3,
          });
          const group = yield* ReplicationSubnetGroup("Group", {
            description: "alchemy dms test subnets",
            subnetIds: [subnetA.subnetId, subnetB.subnetId],
            tags: { env: "test" },
          });
          return {
            group,
            subnetCId: subnetC.subnetId.as<string>(),
          };
        }),
      );

      expect(group.replicationSubnetGroupArn).toContain(":subgrp:");
      expect(group.subnetIds.length).toBe(2);
      expect(group.tags.env).toBe("test");

      // Out-of-band verification via distilled.
      const observed = yield* findGroup(group.replicationSubnetGroupIdentifier);
      expect(observed?.SubnetGroupStatus).toBe("Complete");
      expect(observed?.Subnets?.length).toBe(2);

      // Update: swap one subnet + change the description.
      const { group: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("DmsVpc", { cidrBlock: "10.91.0.0/16" });
          const subnetA = yield* Subnet("DmsSubnetA", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.91.1.0/24",
            availabilityZone: az1,
          });
          yield* Subnet("DmsSubnetB", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.91.2.0/24",
            availabilityZone: az2,
          });
          const subnetC = yield* Subnet("DmsSubnetC", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.91.3.0/24",
            availabilityZone: az3,
          });
          const group = yield* ReplicationSubnetGroup("Group", {
            description: "alchemy dms test subnets (updated)",
            subnetIds: [subnetA.subnetId, subnetC.subnetId],
            tags: { env: "test" },
          });
          return { group };
        }),
      );

      // Same subnet group (in-place modify).
      expect(updated.replicationSubnetGroupIdentifier).toBe(
        group.replicationSubnetGroupIdentifier,
      );
      const observed2 = yield* findGroup(
        group.replicationSubnetGroupIdentifier,
      );
      const observedSubnetIds = (observed2?.Subnets ?? [])
        .map((s) => s.SubnetIdentifier)
        .filter((s): s is string => typeof s === "string");
      expect(observedSubnetIds).toContain(subnetCId);
      expect(observed2?.ReplicationSubnetGroupDescription).toBe(
        "alchemy dms test subnets (updated)",
      );

      yield* stack.destroy();
      yield* assertGone(group.replicationSubnetGroupIdentifier);
    }).pipe(
      // Converge to zero leftovers even when the body (or the engine's own
      // scratch destroy) fails: the reaper deletes the VPC fixture out-of-band
      // with idempotent typed calls. `orDie` — a finalizer must not swallow
      // its own failure silently.
      Effect.ensuring(reapDmsOrphans.pipe(Effect.orDie)),
    ),
  { timeout: 300_000 },
);
