import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as ElastiCache from "@distilled.cloud/aws/elasticache";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  assertReplicationGroupGone,
  getProvisionedNetwork,
  shareProvisionedNetwork,
} from "./ProvisionedFixture.ts";
const { test, beforeAll, afterAll } = Test.make({
  providers: AWS.providers(),
});
shareProvisionedNetwork({ beforeAll, afterAll });
const snapshotName = "alchemy-elasticache-provisioned-restore";

const deleteSnapshot = () =>
  ElastiCache.deleteSnapshot({ SnapshotName: snapshotName }).pipe(
    Effect.catchTag("SnapshotNotFoundFault", () => Effect.void),
    Effect.retry({
      while: (error) => error._tag === "InvalidSnapshotStateFault",
      schedule: Schedule.max([
        Schedule.fixed("15 seconds"),
        Schedule.recurs(12),
      ]),
    }),
  );

const waitForSnapshot = () =>
  ElastiCache.describeSnapshots({ SnapshotName: snapshotName }).pipe(
    Effect.flatMap((response) =>
      response.Snapshots?.[0]?.SnapshotStatus === "available"
        ? Effect.void
        : Effect.fail(new Error(`snapshot '${snapshotName}' is not available`)),
    ),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("30 seconds"),
        Schedule.recurs(30),
      ]),
    }),
  );

test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "restores a new Valkey replication group from a final snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* deleteSnapshot();
      const deploy = (
        snapshotNameToRestore?: string,
        finalSnapshotName?: string,
      ) =>
        stack.deploy(
          Effect.gen(function* () {
            const net = yield* getProvisionedNetwork;
            const cache = yield* AWS.ElastiCache.ReplicationGroup("Cache", {
              description: "alchemy snapshot restore cache",
              engine: "valkey",
              nodeType: "cache.t4g.micro",
              subnetGroupName: net.subnetGroupName,
              securityGroupIds: [net.securityGroupId],
              replicasPerNodeGroup: 0,
              transitEncryptionEnabled: true,
              snapshotName: snapshotNameToRestore,
              finalSnapshotName,
            });
            return { cache };
          }),
        );

      const source = yield* deploy(undefined, snapshotName);
      yield* stack.destroy();
      yield* assertReplicationGroupGone(source.cache.replicationGroupId);
      yield* waitForSnapshot();

      const restored = yield* deploy(snapshotName);
      const observed = yield* ElastiCache.describeReplicationGroups({
        ReplicationGroupId: restored.cache.replicationGroupId,
      });
      expect(observed.ReplicationGroups?.[0]?.Status).toBe("available");
      expect(observed.ReplicationGroups?.[0]?.Engine).toBe("valkey");

      yield* stack.destroy();
      yield* assertReplicationGroupGone(restored.cache.replicationGroupId);
      yield* deleteSnapshot();
    }).pipe(Effect.ensuring(deleteSnapshot().pipe(Effect.ignore))),
  { timeout: 2_700_000 },
);
