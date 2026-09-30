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
const listTagsWhenAvailable = (resourceName: string) =>
  ElastiCache.listTagsForResource({ ResourceName: resourceName }).pipe(
    Effect.retry({
      while: (error) =>
        (error as { _tag?: string })._tag ===
        "InvalidReplicationGroupStateFault",
      schedule: Schedule.max([
        Schedule.fixed("15 seconds"),
        Schedule.recurs(100),
      ]),
    }),
  );

test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "updates replication-group tags and VPC security groups in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (phase: "one" | "two") =>
        stack.deploy(
          Effect.gen(function* () {
            const net = yield* getProvisionedNetwork;
            const replacementSecurityGroup = yield* AWS.EC2.SecurityGroup(
              "ReplacementSecurityGroup",
              {
                vpcId: net.vpcId,
                description: "ElastiCache replacement integration-test access",
                tags: { fixture: "elasticache-provisioned" },
              },
            );
            const cache = yield* AWS.ElastiCache.ReplicationGroup("Cache", {
              description: "alchemy configuration cache",
              engine: "valkey",
              nodeType: "cache.t4g.micro",
              subnetGroupName: net.subnetGroupName,
              securityGroupIds: [
                phase === "one"
                  ? net.securityGroupId
                  : replacementSecurityGroup.groupId,
              ],
              replicasPerNodeGroup: 0,
              transitEncryptionEnabled: true,
              tags:
                phase === "one"
                  ? {
                      fixture: "elasticache-provisioned",
                      phase: "one",
                      remove: "me",
                    }
                  : { fixture: "elasticache-provisioned", phase: "two" },
            });
            return {
              cache,
              activeSecurityGroupId:
                phase === "one"
                  ? net.securityGroupId
                  : replacementSecurityGroup.groupId,
            };
          }),
        );

      const created = yield* deploy("one");
      const createdTags = yield* listTagsWhenAvailable(
        created.cache.replicationGroupArn,
      );
      expect(createdTags.TagList).toContainEqual({
        Key: "phase",
        Value: "one",
      });
      expect(createdTags.TagList).toContainEqual({
        Key: "remove",
        Value: "me",
      });

      const updated = yield* deploy("two");
      expect(updated.cache.replicationGroupId).toBe(
        created.cache.replicationGroupId,
      );
      const updatedTags = yield* listTagsWhenAvailable(
        updated.cache.replicationGroupArn,
      );
      expect(updatedTags.TagList).toContainEqual({
        Key: "phase",
        Value: "two",
      });
      expect(updatedTags.TagList).not.toContainEqual({
        Key: "remove",
        Value: "me",
      });

      const group = yield* ElastiCache.describeReplicationGroups({
        ReplicationGroupId: updated.cache.replicationGroupId,
      });
      const memberId = group.ReplicationGroups?.[0]?.MemberClusters?.[0];
      if (!memberId)
        return yield* Effect.fail(
          new Error("replication group has no member cluster"),
        );
      const member = yield* ElastiCache.describeCacheClusters({
        CacheClusterId: memberId,
      });
      expect(
        member.CacheClusters?.[0]?.SecurityGroups?.map(
          (sg) => sg.SecurityGroupId,
        ),
      ).toEqual([updated.activeSecurityGroupId]);

      yield* stack.destroy();
      yield* assertReplicationGroupGone(updated.cache.replicationGroupId);
    }),
  { timeout: 2_700_000 },
);
