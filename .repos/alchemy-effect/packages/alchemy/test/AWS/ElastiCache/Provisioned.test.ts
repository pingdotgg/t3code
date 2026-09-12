import {
  CacheCluster,
  cacheClusterConnectEnvPrefix,
  ConnectCacheCluster,
  ConnectCacheClusterHttp,
  ConnectReplicationGroup,
  ConnectReplicationGroupHttp,
  ReplicationGroup,
  replicationGroupConnectEnvPrefix,
  validateReplicationGroupProps,
} from "@/AWS/ElastiCache";
import * as AWS from "@/AWS";
import { sameStringSet } from "@/AWS/ElastiCache/internal.ts";
import * as Test from "@/Test/Alchemy";
import * as ElastiCache from "@distilled.cloud/aws/elasticache";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Output from "@/Output.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import * as Schedule from "effect/Schedule";
import {
  assertCacheClusterGone,
  assertReplicationGroupGone,
  getProvisionedNetwork,
  shareProvisionedNetwork,
} from "./ProvisionedFixture.ts";

const { test, beforeAll, afterAll } = Test.make({
  providers: AWS.providers(),
});
shareProvisionedNetwork({ beforeAll, afterAll });
test(
  "connection names and unordered subnet IDs are stable",
  Effect.sync(() => {
    expect(replicationGroupConnectEnvPrefix("SessionCache")).toBe(
      "ELASTICACHE_SESSIONCACHE",
    );
    expect(cacheClusterConnectEnvPrefix("SessionCache")).toBe(
      "ELASTICACHE_SESSIONCACHE",
    );
    expect(
      sameStringSet(["subnet-a", "subnet-b"], ["subnet-b", "subnet-a"]),
    ).toBe(true);
    expect(sameStringSet(["subnet-a"], ["subnet-b"])).toBe(false);
  }),
  { timeout: 2_700_000 },
);

test(
  "invalid replication-group configuration fails before an AWS create request",
  Effect.sync(() => {
    const invalid = [
      { automaticFailoverEnabled: true, replicasPerNodeGroup: 0 },
      {
        multiAzEnabled: true,
        automaticFailoverEnabled: false,
        replicasPerNodeGroup: 1,
      },
      { replicasPerNodeGroup: 6 },
      { numNodeGroups: 0 },
      { port: 0 },
      {
        transitEncryptionEnabled: false,
        transitEncryptionMode: "preferred" as const,
      },
    ];
    for (const props of invalid) {
      const error = validateReplicationGroupProps({
        description: "invalid cache",
        engine: "valkey",
        ...props,
      });
      expect(error?._tag).toBe("InvalidReplicationGroupConfiguration");
    }
  }),
  { timeout: 2_700_000 },
);

const withEnv = <A, E = never, R = never>(
  values: Record<string, string>,
  effect: Effect.Effect<A, E, R>,
) => {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  return Effect.gen(function* () {
    yield* Effect.sync(() => Object.assign(process.env, values));
    return yield* effect;
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }),
    ),
  );
};

test(
  "provisioned cache bindings read the endpoints published to a Function",
  Effect.gen(function* () {
    const replicationGroup = {
      LogicalId: "ProvisionedBinding",
      configurationEndpointAddress: Output.asOutput(undefined),
      configurationEndpointPort: Output.asOutput(undefined),
      primaryEndpointAddress: Output.asOutput("primary.example"),
      primaryEndpointPort: Output.asOutput(6379),
      readerEndpointAddress: Output.asOutput("reader.example"),
      readerEndpointPort: Output.asOutput(6379),
      transitEncryptionEnabled: Output.asOutput(true),
    } as unknown as ReplicationGroup;
    const memcached = {
      LogicalId: "MemcachedBinding",
      endpoints: Output.asOutput([{ address: "node.example", port: 11211 }]),
      transitEncryptionEnabled: Output.asOutput(false),
    } as unknown as CacheCluster;
    const replicationPrefix = replicationGroupConnectEnvPrefix(
      replicationGroup.LogicalId,
    );
    const memcachedPrefix = cacheClusterConnectEnvPrefix(memcached.LogicalId);
    const replicationConnect = yield* ConnectReplicationGroup(
      replicationGroup,
    ).pipe(Effect.provide(ConnectReplicationGroupHttp));
    const memcachedConnect = yield* ConnectCacheCluster(memcached).pipe(
      Effect.provide(ConnectCacheClusterHttp),
    );
    const [replication, cluster] = yield* withEnv(
      {
        [`${replicationPrefix}_HOST`]: "primary.example",
        [`${replicationPrefix}_PORT`]: "6379",
        [`${replicationPrefix}_TLS`]: "true",
        [`${replicationPrefix}_READER_HOST`]: "reader.example",
        [`${replicationPrefix}_READER_PORT`]: "6379",
        [`${memcachedPrefix}_ENDPOINTS`]: JSON.stringify([
          { address: "node.example", port: 11211 },
        ]),
        [`${memcachedPrefix}_TLS`]: "false",
      },
      Effect.all([replicationConnect, memcachedConnect]).pipe(
        Effect.provide(RuntimeContext.phantom),
      ),
    );

    expect(replication).toEqual({
      host: "primary.example",
      port: 6379,
      readerHost: "reader.example",
      readerPort: 6379,
      tls: true,
    });
    expect(cluster).toEqual({
      endpoints: [{ address: "node.example", port: 11211 }],
      tls: false,
    });
  }),
  { timeout: 2_700_000 },
);

const assertSubnetGroupGone = (name: string) =>
  ElastiCache.describeCacheSubnetGroups({ CacheSubnetGroupName: name }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`subnet group '${name}' still exists`)),
    ),
    Effect.catchTag("CacheSubnetGroupNotFoundFault", () => Effect.void),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

const finalSnapshotName = "alchemy-elasticache-final-snapshot";

const deleteFinalSnapshot = () =>
  ElastiCache.deleteSnapshot({ SnapshotName: finalSnapshotName }).pipe(
    Effect.catchTag("SnapshotNotFoundFault", () => Effect.void),
    Effect.retry({
      while: (error) => error._tag === "InvalidSnapshotStateFault",
      schedule: Schedule.max([
        Schedule.fixed("15 seconds"),
        Schedule.recurs(12),
      ]),
    }),
  );

const assertFinalSnapshotAvailable = () =>
  ElastiCache.describeSnapshots({ SnapshotName: finalSnapshotName }).pipe(
    Effect.flatMap((result) =>
      result.Snapshots?.[0]?.SnapshotStatus === "available"
        ? Effect.void
        : Effect.fail(
            new Error(`snapshot '${finalSnapshotName}' is not ready`),
          ),
    ),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("30 seconds"),
        Schedule.recurs(30),
      ]),
    }),
  );

test.provider(
  "create, update, verify, and destroy an ElastiCache subnet group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const net = yield* getProvisionedNetwork;
      const deploy = (description: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const group = yield* AWS.ElastiCache.SubnetGroup("Subnets", {
              description,
              subnetIds: net.privateSubnetIds,
              tags: { fixture: "elasticache-provisioned" },
            });
            return { group, subnetIds: net.privateSubnetIds };
          }),
        );

      const { group, subnetIds } = yield* deploy("alchemy cache subnets");
      expect(group.subnetGroupArn).toContain(":subnetgroup:");
      expect(new Set(group.subnetIds)).toEqual(new Set(subnetIds));

      const described = yield* ElastiCache.describeCacheSubnetGroups({
        CacheSubnetGroupName: group.subnetGroupName,
      });
      expect(
        described.CacheSubnetGroups?.[0]?.CacheSubnetGroupDescription,
      ).toBe("alchemy cache subnets");

      const { group: updated } = yield* deploy("alchemy cache subnets v2");
      expect(updated.subnetGroupName).toBe(group.subnetGroupName);
      expect(updated.description).toBe("alchemy cache subnets v2");

      yield* stack.destroy();
      yield* assertSubnetGroupGone(group.subnetGroupName);
    }),
  { timeout: 2_700_000 },
);

test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create, update, verify, and destroy a provisioned Valkey replication group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const net = yield* getProvisionedNetwork;
      const deploy = (description: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const cache = yield* ReplicationGroup("Cache", {
              description,
              engine: "valkey",
              nodeType: "cache.t4g.micro",
              subnetGroupName: net.subnetGroupName,
              securityGroupIds: [net.securityGroupId],
              replicasPerNodeGroup: 0,
              transitEncryptionEnabled: true,
              tags: { fixture: "elasticache-provisioned" },
            });
            return { cache };
          }),
        );
      const { cache } = yield* deploy("alchemy provisioned cache");
      expect(cache.status).toBe("available");
      expect(cache.replicationGroupArn).toContain(":replicationgroup:");
      expect(cache.primaryEndpointAddress).toBeDefined();
      const observed = yield* ElastiCache.describeReplicationGroups({
        ReplicationGroupId: cache.replicationGroupId,
      });
      expect(observed.ReplicationGroups?.[0]?.Status).toBe("available");

      const { cache: updated } = yield* deploy("alchemy provisioned cache v2");
      expect(updated.replicationGroupId).toBe(cache.replicationGroupId);
      expect(updated.status).toBe("available");

      yield* stack.destroy();
      yield* assertReplicationGroupGone(cache.replicationGroupId);
    }),
  { timeout: 2_700_000 },
);

test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create, scale, verify, and destroy a provisioned Memcached cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const net = yield* getProvisionedNetwork;
      const deploy = (numCacheNodes: number) =>
        stack.deploy(
          Effect.gen(function* () {
            const cache = yield* CacheCluster("Cache", {
              subnetGroupName: net.subnetGroupName,
              securityGroupIds: [net.securityGroupId],
              numCacheNodes,
              tags: { fixture: "elasticache-memcached" },
            });
            return { cache };
          }),
        );

      const { cache } = yield* deploy(1);
      expect(cache.status).toBe("available");
      expect(cache.endpoints).toHaveLength(1);

      const { cache: scaled } = yield* deploy(2);
      expect(scaled.cacheClusterId).toBe(cache.cacheClusterId);
      expect(scaled.endpoints).toHaveLength(2);

      const observed = yield* ElastiCache.describeCacheClusters({
        CacheClusterId: scaled.cacheClusterId,
        ShowCacheNodeInfo: true,
      });
      expect(observed.CacheClusters?.[0]?.NumCacheNodes).toBe(2);

      yield* stack.destroy();
      yield* assertCacheClusterGone(cache.cacheClusterId);
    }),
  { timeout: 2_700_000 },
);

test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "replace a replication group when its port changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const net = yield* getProvisionedNetwork;
      const deploy = (port: number) =>
        stack.deploy(
          Effect.gen(function* () {
            const cache = yield* ReplicationGroup("Cache", {
              description: "alchemy replacement cache",
              engine: "valkey",
              nodeType: "cache.t4g.micro",
              subnetGroupName: net.subnetGroupName,
              securityGroupIds: [net.securityGroupId],
              replicasPerNodeGroup: 0,
              transitEncryptionEnabled: true,
              port,
            });
            return { cache };
          }),
        );

      const { cache } = yield* deploy(6379);
      const { cache: replaced } = yield* deploy(6380);
      expect(replaced.replicationGroupId).not.toBe(cache.replicationGroupId);
      expect(replaced.primaryEndpointPort).toBe(6380);
      yield* assertReplicationGroupGone(cache.replicationGroupId);

      yield* stack.destroy();
      yield* assertReplicationGroupGone(replaced.replicationGroupId);
    }),
  { timeout: 2_700_000 },
);

test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "add and remove a Valkey replica",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const net = yield* getProvisionedNetwork;
      const deploy = (replicasPerNodeGroup: number) =>
        stack.deploy(
          Effect.gen(function* () {
            const cache = yield* ReplicationGroup("Cache", {
              description: "alchemy scaling cache",
              engine: "valkey",
              nodeType: "cache.t4g.micro",
              subnetGroupName: net.subnetGroupName,
              securityGroupIds: [net.securityGroupId],
              replicasPerNodeGroup,
              automaticFailoverEnabled: replicasPerNodeGroup > 0,
              transitEncryptionEnabled: true,
            });
            return { cache };
          }),
        );

      const { cache } = yield* deploy(0);
      const { cache: scaled } = yield* deploy(1);
      expect(scaled.replicationGroupId).toBe(cache.replicationGroupId);

      const withReplica = yield* ElastiCache.describeReplicationGroups({
        ReplicationGroupId: scaled.replicationGroupId,
      });
      expect(
        withReplica.ReplicationGroups?.[0]?.NodeGroups?.[0]?.NodeGroupMembers,
      ).toHaveLength(2);

      const { cache: reduced } = yield* deploy(0);
      const withoutReplica = yield* ElastiCache.describeReplicationGroups({
        ReplicationGroupId: reduced.replicationGroupId,
      });
      expect(
        withoutReplica.ReplicationGroups?.[0]?.NodeGroups?.[0]
          ?.NodeGroupMembers,
      ).toHaveLength(1);

      yield* stack.destroy();
      yield* assertReplicationGroupGone(reduced.replicationGroupId);
    }),
  { timeout: 2_700_000 },
);

test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create and clean up the requested final snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* deleteFinalSnapshot();
      const net = yield* getProvisionedNetwork;
      const { cache } = yield* stack.deploy(
        Effect.gen(function* () {
          const cache = yield* ReplicationGroup("Cache", {
            description: "alchemy final snapshot cache",
            engine: "valkey",
            nodeType: "cache.t4g.micro",
            subnetGroupName: net.subnetGroupName,
            securityGroupIds: [net.securityGroupId],
            replicasPerNodeGroup: 0,
            transitEncryptionEnabled: true,
            finalSnapshotName,
          });
          return { cache };
        }),
      );

      yield* stack.destroy();
      yield* assertReplicationGroupGone(cache.replicationGroupId);
      yield* assertFinalSnapshotAvailable();
      yield* deleteFinalSnapshot();
    }).pipe(Effect.ensuring(deleteFinalSnapshot().pipe(Effect.ignore))),
  { timeout: 2_700_000 },
);
