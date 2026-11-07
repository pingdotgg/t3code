import * as AWS from "@alchemy.run/aws";
import type { SubnetId } from "@alchemy.run/aws/EC2/Subnet";
import * as Core from "@alchemy.run/test/Core";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as ElastiCache from "@distilled.cloud/aws/elasticache";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";
import { networkState, type ProvisionedNetwork } from "./ProvisionedNetwork.ts";

export { getProvisionedNetwork, type ProvisionedNetwork } from "./ProvisionedNetwork.ts";

const testOptions = { providers: AWS.providers() };
const networkStack = Core.scratchStack(
  testOptions,
  "Network",
  "test/AWS/ElastiCache/ProvisionedFixture.ts",
);

let holders = 0;
let deployed = false;

// The account's default VPC costs no VPC quota, so cache suites never queue
// behind EC2 suites for VPC capacity. Lambdas reach the caches over private
// addresses, so public default subnets need no NAT.
const findDefaultSubnets = Effect.gen(function* () {
  const vpc = yield* getDefaultVpc;
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "default-for-az", Values: ["true"] },
      { Name: "state", Values: ["available"] },
    ],
  });
  // Not every AZ offers every cache node type; stay within the first three.
  const subnetIds = (subnets.Subnets ?? [])
    .filter((subnet) => /[abc]$/.test(subnet.AvailabilityZone ?? ""))
    .sort((l, r) => (l.AvailabilityZone ?? "").localeCompare(r.AvailabilityZone ?? ""))
    .flatMap((subnet) => (subnet.SubnetId ? [subnet.SubnetId] : []))
    .slice(0, 2) as SubnetId[];
  if (subnetIds.length < 2) {
    return yield* Effect.fail(
      new Error("ElastiCache tests require two default subnets in AZs a-c"),
    );
  }
  return { vpcId: vpc.vpcId, subnetIds };
});

const deployNetwork = Effect.gen(function* () {
  const { vpcId, subnetIds } = yield* Core.withProviders(
    findDefaultSubnets,
    testOptions,
    "Network",
  );
  yield* networkStack.destroy();
  return yield* networkStack.deploy(
    Effect.gen(function* () {
      const securityGroup = yield* AWS.EC2.SecurityGroup("CacheSecurityGroup", {
        vpcId,
        description: "ElastiCache shared cache access",
        tags: { fixture: "elasticache-provisioned" },
      });
      const subnetGroup = yield* AWS.ElastiCache.SubnetGroup("Subnets", {
        description: "alchemy provisioned cache subnets",
        subnetIds,
        tags: { fixture: "elasticache-provisioned" },
      });
      return {
        vpcId,
        subnetIds,
        securityGroupId: securityGroup.groupId,
        subnetGroupName: subnetGroup.subnetGroupName,
      } as unknown as ProvisionedNetwork;
    }),
  );
});

/** First caller deploys the shared VPC; everyone else waits for it. */
export const acquireProvisionedNetwork = Effect.gen(function* () {
  holders += 1;
  if (networkState.started) {
    return yield* Deferred.await(networkState.ready);
  }
  networkState.started = true;
  const attrs = yield* deployNetwork.pipe(
    Effect.tapError((error) =>
      Effect.gen(function* () {
        networkState.started = false;
        yield* Deferred.fail(networkState.ready, error);
        networkState.ready = Deferred.makeUnsafe();
      }),
    ),
  );
  deployed = true;
  yield* Deferred.succeed(networkState.ready, attrs);
  return attrs;
});

export const releaseProvisionedNetwork = Effect.suspend(() => {
  holders = Math.max(0, holders - 1);
  if (holders > 0 || !deployed) return Effect.void;
  deployed = false;
  networkState.started = false;
  networkState.ready = Deferred.makeUnsafe();
  return networkStack.destroy();
});

export const shareProvisionedNetwork = (hooks: {
  beforeAll: (eff: Effect.Effect<unknown, any, any>, options?: { timeout?: number }) => unknown;
  afterAll: (eff: Effect.Effect<unknown, any, any>, options?: { timeout?: number }) => void;
}) => {
  hooks.beforeAll(acquireProvisionedNetwork, { timeout: 180_000 });
  hooks.afterAll(releaseProvisionedNetwork, { timeout: 180_000 });
};

export const assertReplicationGroupGone = (name: string) =>
  ElastiCache.describeReplicationGroups({ ReplicationGroupId: name }).pipe(
    Effect.flatMap(() => Effect.fail(new Error(`replication group '${name}' still exists`))),
    Effect.catchTag("ReplicationGroupNotFoundFault", () => Effect.void),
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("10 seconds"), Schedule.recurs(18)]),
    }),
  );

export const assertCacheClusterGone = (name: string) =>
  ElastiCache.describeCacheClusters({ CacheClusterId: name }).pipe(
    Effect.flatMap(() => Effect.fail(new Error(`cache cluster '${name}' still exists`))),
    Effect.catchTag("CacheClusterNotFoundFault", () => Effect.void),
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("10 seconds"), Schedule.recurs(18)]),
    }),
  );
