import * as AWS from "@/AWS";
import type { SecurityGroupId } from "@/AWS/EC2/SecurityGroup.ts";
import type { SubnetId } from "@/AWS/EC2/Subnet.ts";
import type { VpcId } from "@/AWS/EC2/Vpc.ts";
import * as Core from "@/Test/Core";
import * as ElastiCache from "@distilled.cloud/aws/elasticache";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { makeEc2VpcCapacityLease } from "../EC2/VpcCapacity.ts";

export interface ProvisionedNetwork {
  vpcId: VpcId;
  privateSubnetIds: SubnetId[];
  securityGroupId: SecurityGroupId;
  subnetGroupName: string;
}

const testOptions = { providers: AWS.providers() };
const networkStack = Core.scratchStack(
  testOptions,
  "Network",
  "test/AWS/ElastiCache/ProvisionedFixture.ts",
);
const vpcLease = makeEc2VpcCapacityLease(1);

let ready = Deferred.makeUnsafe<ProvisionedNetwork, unknown>();
let started = false;
let holders = 0;
let deployed = false;

const deployNetwork = Effect.gen(function* () {
  yield* vpcLease.acquire;
  yield* networkStack.destroy();
  return yield* networkStack.deploy(
    Effect.gen(function* () {
      const network = yield* AWS.EC2.Network("Network", {
        cidrBlock: "10.92.0.0/16",
        availabilityZones: 2,
        nat: "none",
        tags: { fixture: "elasticache-provisioned" },
      });
      const securityGroup = yield* AWS.EC2.SecurityGroup("CacheSecurityGroup", {
        vpcId: network.vpcId,
        description: "ElastiCache shared cache access",
        tags: { fixture: "elasticache-provisioned" },
      });
      const subnetGroup = yield* AWS.ElastiCache.SubnetGroup("Subnets", {
        description: "alchemy provisioned cache subnets",
        subnetIds: network.privateSubnetIds,
        tags: { fixture: "elasticache-provisioned" },
      });
      return {
        vpcId: network.vpcId,
        privateSubnetIds: network.privateSubnetIds,
        securityGroupId: securityGroup.groupId,
        subnetGroupName: subnetGroup.subnetGroupName,
      } as unknown as ProvisionedNetwork;
    }),
  );
});

/** First caller deploys the shared VPC; everyone else waits for it. */
export const acquireProvisionedNetwork = Effect.gen(function* () {
  holders += 1;
  if (started) {
    return yield* Deferred.await(ready);
  }
  started = true;
  const attrs = yield* deployNetwork.pipe(
    Effect.tapError((error) =>
      Effect.gen(function* () {
        started = false;
        yield* Deferred.fail(ready, error);
        ready = Deferred.makeUnsafe();
      }),
    ),
  );
  deployed = true;
  yield* Deferred.succeed(ready, attrs);
  return attrs;
});

/** Resolved IDs of the process-wide provisioned-cache VPC. */
export const getProvisionedNetwork = Effect.suspend(() =>
  started
    ? Deferred.await(ready).pipe(Effect.orDie)
    : Effect.die(
        "provisioned network was not acquired; call shareProvisionedNetwork in the test file",
      ),
);

export const releaseProvisionedNetwork = Effect.suspend(() => {
  holders = Math.max(0, holders - 1);
  if (holders > 0 || !deployed) return Effect.void;
  deployed = false;
  started = false;
  ready = Deferred.makeUnsafe();
  return networkStack.destroy().pipe(Effect.ensuring(vpcLease.release));
});

export const shareProvisionedNetwork = (hooks: {
  beforeAll: (
    eff: Effect.Effect<unknown, any, any>,
    options?: { timeout?: number },
  ) => unknown;
  afterAll: (
    eff: Effect.Effect<unknown, any, any>,
    options?: { timeout?: number },
  ) => void;
}) => {
  hooks.beforeAll(acquireProvisionedNetwork, { timeout: 180_000 });
  hooks.afterAll(releaseProvisionedNetwork, { timeout: 180_000 });
};

export const assertReplicationGroupGone = (name: string) =>
  ElastiCache.describeReplicationGroups({ ReplicationGroupId: name }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`replication group '${name}' still exists`)),
    ),
    Effect.catchTag("ReplicationGroupNotFoundFault", () => Effect.void),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(18),
      ]),
    }),
  );

export const assertCacheClusterGone = (name: string) =>
  ElastiCache.describeCacheClusters({ CacheClusterId: name }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`cache cluster '${name}' still exists`)),
    ),
    Effect.catchTag("CacheClusterNotFoundFault", () => Effect.void),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(18),
      ]),
    }),
  );
