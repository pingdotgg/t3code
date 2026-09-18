import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as ElastiCache from "@distilled.cloud/aws/elasticache";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  assertReplicationGroupGone,
  getProvisionedNetwork,
  shareProvisionedNetwork,
} from "./ProvisionedFixture.ts";

const { test, beforeAll, afterAll } = Test.make({
  providers: AWS.providers(),
});
shareProvisionedNetwork({ beforeAll, afterAll });
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create, update, verify, and destroy a provisioned Redis OSS replication group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const net = yield* getProvisionedNetwork;
      const deploy = (description: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const cache = yield* AWS.ElastiCache.ReplicationGroup("Cache", {
              description,
              engine: "redis",
              nodeType: "cache.t4g.micro",
              subnetGroupName: net.subnetGroupName,
              securityGroupIds: [net.securityGroupId],
              replicasPerNodeGroup: 0,
              transitEncryptionEnabled: true,
              tags: { fixture: "elasticache-provisioned-redis" },
            });
            return { cache };
          }),
        );

      const { cache } = yield* deploy("alchemy Redis OSS cache");
      const created = yield* ElastiCache.describeReplicationGroups({
        ReplicationGroupId: cache.replicationGroupId,
      });
      expect(created.ReplicationGroups?.[0]?.Engine).toBe("redis");
      expect(created.ReplicationGroups?.[0]?.Status).toBe("available");

      const { cache: updated } = yield* deploy("alchemy Redis OSS cache v2");
      expect(updated.replicationGroupId).toBe(cache.replicationGroupId);

      yield* stack.destroy();
      yield* assertReplicationGroupGone(cache.replicationGroupId);
    }),
  { timeout: 2_700_000 },
);
