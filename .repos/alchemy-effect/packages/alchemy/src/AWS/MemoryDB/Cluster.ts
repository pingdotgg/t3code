import * as memorydb from "@distilled.cloud/aws/memorydb";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireDays } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import { readMemoryDbTags, sameStringSet } from "./internal.ts";

export interface ClusterProps {
  /**
   * Name of the cluster. Must be 1-40 alphanumeric characters. If omitted, a
   * deterministic physical name is generated. Changing the name replaces the
   * cluster.
   */
  clusterName?: string;
  /**
   * Compute and memory capacity of the nodes, e.g. `"db.t4g.small"` (the
   * cheapest supported node type) or `"db.r7g.large"`.
   * @default "db.t4g.small"
   */
  nodeType?: string;
  /**
   * Name of the {@link ACL} that authenticates connections to the cluster.
   * Required by MemoryDB. The ACL must include a user named `default`.
   */
  aclName: string;
  /**
   * Name of the {@link SubnetGroup} the cluster's nodes are placed into.
   * Changing the subnet group replaces the cluster.
   * @default the default subnet group
   */
  subnetGroupName?: string;
  /**
   * VPC security groups that control network access to the cluster endpoint.
   * @default the VPC's default security group
   */
  securityGroupIds?: string[];
  /**
   * Number of shards (partitions) in the cluster.
   * @default 1
   */
  numShards?: number;
  /**
   * Number of read replicas per shard (0-5).
   * @default 1
   */
  numReplicasPerShard?: number;
  /**
   * Name of the parameter group applied to the cluster.
   * @default the engine's default parameter group
   */
  parameterGroupName?: string;
  /**
   * Human-readable description of the cluster.
   */
  description?: string;
  /**
   * Engine — `"redis"` or `"valkey"`.
   * @default "valkey"
   */
  engine?: string;
  /**
   * Engine version, e.g. `"7.1"` (redis) or `"7.2"` (valkey).
   * @default latest for the engine
   */
  engineVersion?: string;
  /**
   * Port the cluster accepts connections on. Changing the port replaces the
   * cluster.
   * @default 6379
   */
  port?: number;
  /**
   * Whether in-transit encryption (TLS) is enabled. Changing this replaces the
   * cluster.
   * @default true
   */
  tlsEnabled?: boolean;
  /**
   * Customer-managed KMS key for encryption at rest. Changing the key replaces
   * the cluster.
   * @default AWS-owned key
   */
  kmsKeyId?: string;
  /**
   * Weekly maintenance window, e.g. `"sun:23:00-mon:01:30"` (UTC).
   */
  maintenanceWindow?: string;
  /**
   * How long automatic snapshots are retained (e.g. `"7 days"` or
   * `Duration.days(7)`). Sent to the API in whole days; `Duration.zero`
   * disables automatic snapshots.
   */
  snapshotRetentionLimit?: Duration.Input;
  /**
   * Daily window (UTC, `HH:MM-HH:MM`) when automatic snapshots are taken.
   */
  snapshotWindow?: string;
  /**
   * SNS topic ARN to publish cluster events to.
   */
  snsTopicArn?: string;
  /**
   * Whether minor engine version upgrades are applied automatically.
   * @default true
   */
  autoMinorVersionUpgrade?: boolean;
  /**
   * Whether data tiering (SSD) is enabled. Only supported on r6gd node types.
   * Changing this replaces the cluster.
   */
  dataTiering?: boolean;
  /**
   * IP address type. Changing this replaces the cluster.
   * @default "ipv4"
   */
  networkType?: memorydb.NetworkType;
  /**
   * IP discovery protocol.
   */
  ipDiscovery?: memorydb.IpDiscovery;
  /**
   * User-defined tags for the cluster.
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "AWS.MemoryDB.Cluster",
  ClusterProps,
  {
    /** Name of the cluster. */
    clusterName: string;
    /** ARN of the cluster. */
    clusterArn: string;
    /** Current lifecycle status (e.g. `creating`, `available`). */
    status: string;
    /** Node instance type (e.g. `db.t4g.small`). */
    nodeType: string;
    /** Engine (`redis` or `valkey`). */
    engine: string;
    /** Running engine version. */
    engineVersion: string | undefined;
    /** DNS address of the cluster endpoint. */
    endpointAddress: string | undefined;
    /** Port of the cluster endpoint. */
    endpointPort: number | undefined;
    /** Name of the ACL attached to the cluster. */
    aclName: string | undefined;
    /** Name of the parameter group in use. */
    parameterGroupName: string | undefined;
    /** Name of the subnet group the cluster's nodes are placed in. */
    subnetGroupName: string | undefined;
    /** Whether in-transit encryption (TLS) is enabled. */
    tlsEnabled: boolean | undefined;
    /** Number of shards in the cluster. */
    numberOfShards: number | undefined;
    /** Tags on the cluster (user + internal Alchemy tags). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon MemoryDB cluster — a durable, Redis/Valkey-compatible in-memory
 * database.
 *
 * Clusters take roughly 10-15 minutes to provision and are billed per node
 * while they exist. They are reachable only from inside a VPC and require an
 * {@link ACL}; place them in a {@link SubnetGroup} spanning multiple AZs for
 * high availability. Destroy clusters you are not using.
 * @resource
 * @section Creating a Cluster
 * @example Single-Shard Cluster
 * ```typescript
 * const user = yield* User("CacheUser", {
 *   authenticationMode: { type: "password", passwords: [cachePassword] },
 *   accessString: "on ~* +@all",
 * });
 * const acl = yield* ACL("CacheAcl", { userNames: [user.userName] });
 * const subnetGroup = yield* SubnetGroup("CacheSubnets", {
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 * });
 * const cluster = yield* Cluster("Cache", {
 *   nodeType: "db.t4g.small",
 *   aclName: acl.aclName,
 *   subnetGroupName: subnetGroup.subnetGroupName,
 *   numShards: 1,
 *   numReplicasPerShard: 1,
 * });
 * ```
 */
export const Cluster = Resource<Cluster>("AWS.MemoryDB.Cluster");

const DEFAULT_NODE_TYPE = "db.t4g.small";

export const ClusterProvider = () =>
  Provider.effect(
    Cluster,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<ClusterProps>) =>
        props.clusterName
          ? Effect.succeed(props.clusterName)
          : createPhysicalName({ id, maxLength: 40, lowercase: true });

      const readCluster = Effect.fn(function* (name: string) {
        const response = yield* memorydb
          .describeClusters({ ClusterName: name })
          .pipe(
            Effect.catchTag("ClusterNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.Clusters?.[0];
      });

      // Bounded readiness wait. MemoryDB cluster provisioning/modification
      // typically completes in 10-15 minutes; budget ~20 min (80 * 15s).
      const waitForAvailable = Effect.fn(function* (name: string) {
        const policy = Schedule.max([
          Schedule.fixed("15 seconds"),
          Schedule.recurs(80),
        ]);
        return yield* readCluster(name).pipe(
          Effect.flatMap((cluster) => {
            if (!cluster?.ARN) {
              return Effect.fail(new Error(`Cluster '${name}' not found`));
            }
            if (cluster.Status !== "available") {
              return Effect.fail(
                new Error(
                  `Cluster '${name}' not available (status: ${cluster.Status})`,
                ),
              );
            }
            return Effect.succeed(cluster);
          }),
          Effect.retry({ schedule: policy }),
        );
      });

      // Wait for a cluster to leave a transitional state before delete. Ends
      // when the cluster is available, deleting, or gone.
      const waitUntilSettled = Effect.fn(function* (name: string) {
        const policy = Schedule.max([
          Schedule.fixed("15 seconds"),
          Schedule.recurs(80),
        ]);
        return yield* readCluster(name).pipe(
          Effect.flatMap((cluster) => {
            if (
              cluster !== undefined &&
              cluster.Status !== "available" &&
              cluster.Status !== "deleting"
            ) {
              return Effect.fail(
                new Error(
                  `Cluster '${name}' still settling (status: ${cluster.Status})`,
                ),
              );
            }
            return Effect.succeed(cluster);
          }),
          Effect.retry({ schedule: policy }),
        );
      });

      const toAttrs = Effect.fn(function* (cluster: memorydb.Cluster) {
        if (!cluster.Name || !cluster.ARN) {
          return yield* Effect.fail(
            new Error(`Cluster '${cluster.Name}' is missing its ARN`),
          );
        }
        return {
          clusterName: cluster.Name,
          clusterArn: cluster.ARN,
          status: cluster.Status ?? "available",
          nodeType: cluster.NodeType ?? DEFAULT_NODE_TYPE,
          engine: cluster.Engine ?? "valkey",
          engineVersion: cluster.EngineVersion,
          endpointAddress: cluster.ClusterEndpoint?.Address,
          endpointPort: cluster.ClusterEndpoint?.Port,
          aclName: cluster.ACLName,
          parameterGroupName: cluster.ParameterGroupName,
          subnetGroupName: cluster.SubnetGroupName,
          tlsEnabled: cluster.TLSEnabled,
          numberOfShards: cluster.NumberOfShards,
          tags: yield* readMemoryDbTags(cluster.ARN),
        };
      });

      return {
        stables: ["clusterName", "clusterArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const n = news ?? { aclName: "" };
          const o = olds ?? { aclName: "" };
          if ((yield* toName(id, o)) !== (yield* toName(id, n))) {
            return { action: "replace" } as const;
          }
          // Create-only properties force a replacement.
          if (
            n.subnetGroupName !== undefined &&
            o.subnetGroupName !== undefined &&
            n.subnetGroupName !== o.subnetGroupName
          ) {
            return { action: "replace" } as const;
          }
          if ((n.port ?? undefined) !== (o.port ?? undefined)) {
            return { action: "replace" } as const;
          }
          if ((n.tlsEnabled ?? undefined) !== (o.tlsEnabled ?? undefined)) {
            return { action: "replace" } as const;
          }
          if ((n.kmsKeyId ?? undefined) !== (o.kmsKeyId ?? undefined)) {
            return { action: "replace" } as const;
          }
          if ((n.networkType ?? undefined) !== (o.networkType ?? undefined)) {
            return { action: "replace" } as const;
          }
          if ((n.dataTiering ?? undefined) !== (o.dataTiering ?? undefined)) {
            return { action: "replace" } as const;
          }
          if ((n.engine ?? undefined) !== (o.engine ?? undefined)) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.clusterName ?? (yield* toName(id, olds ?? { aclName: "" }));
          const cluster = yield* readCluster(name);
          if (!cluster?.ARN) return undefined;
          const attrs = yield* toAttrs(cluster);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news!;
          const name = output?.clusterName ?? (yield* toName(id, props));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...props.tags };
          // The wire field is whole days.
          const snapshotRetentionDays = toWireDays(
            props.snapshotRetentionLimit,
          );

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readCluster(name);

          // 2. Ensure — create if missing; tolerate AlreadyExists as a race.
          if (observed === undefined) {
            yield* memorydb
              .createCluster({
                ClusterName: name,
                NodeType: props.nodeType ?? DEFAULT_NODE_TYPE,
                ACLName: props.aclName,
                SubnetGroupName: props.subnetGroupName,
                SecurityGroupIds: props.securityGroupIds,
                NumShards: props.numShards,
                NumReplicasPerShard: props.numReplicasPerShard,
                ParameterGroupName: props.parameterGroupName,
                Description: props.description,
                Engine: props.engine,
                EngineVersion: props.engineVersion,
                Port: props.port,
                TLSEnabled: props.tlsEnabled,
                KmsKeyId: props.kmsKeyId,
                MaintenanceWindow: props.maintenanceWindow,
                SnapshotRetentionLimit: snapshotRetentionDays,
                SnapshotWindow: props.snapshotWindow,
                SnsTopicArn: props.snsTopicArn,
                AutoMinorVersionUpgrade: props.autoMinorVersionUpgrade,
                DataTiering: props.dataTiering,
                NetworkType: props.networkType,
                IpDiscovery: props.ipDiscovery,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag("ClusterAlreadyExistsFault", () => Effect.void),
              );
          }

          // Provisioning and in-flight modifications both surface as a
          // non-available status; wait for availability (bounded) so modify
          // calls do not hit InvalidClusterStateFault.
          observed = yield* waitForAvailable(name);

          // 3. Sync — compute the update delta from OBSERVED state.
          const update: memorydb.UpdateClusterRequest = { ClusterName: name };
          let mutated = false;
          if (
            props.description !== undefined &&
            props.description !== observed.Description
          ) {
            update.Description = props.description;
            mutated = true;
          }
          const observedSg = (observed.SecurityGroups ?? [])
            .map((g) => g.SecurityGroupId)
            .filter((g): g is string => g !== undefined);
          if (
            props.securityGroupIds !== undefined &&
            !sameStringSet(props.securityGroupIds, observedSg)
          ) {
            update.SecurityGroupIds = props.securityGroupIds;
            mutated = true;
          }
          if (
            props.maintenanceWindow !== undefined &&
            props.maintenanceWindow !== observed.MaintenanceWindow
          ) {
            update.MaintenanceWindow = props.maintenanceWindow;
            mutated = true;
          }
          if (
            snapshotRetentionDays !== undefined &&
            snapshotRetentionDays !== (observed.SnapshotRetentionLimit ?? 0)
          ) {
            update.SnapshotRetentionLimit = snapshotRetentionDays;
            mutated = true;
          }
          if (
            props.snapshotWindow !== undefined &&
            props.snapshotWindow !== observed.SnapshotWindow
          ) {
            update.SnapshotWindow = props.snapshotWindow;
            mutated = true;
          }
          if (
            props.nodeType !== undefined &&
            props.nodeType !== observed.NodeType
          ) {
            update.NodeType = props.nodeType;
            mutated = true;
          }
          if (
            props.engineVersion !== undefined &&
            props.engineVersion !== observed.EngineVersion
          ) {
            update.EngineVersion = props.engineVersion;
            mutated = true;
          }
          if (
            props.parameterGroupName !== undefined &&
            props.parameterGroupName !== observed.ParameterGroupName
          ) {
            update.ParameterGroupName = props.parameterGroupName;
            mutated = true;
          }
          if (
            props.aclName !== undefined &&
            props.aclName !== observed.ACLName
          ) {
            update.ACLName = props.aclName;
            mutated = true;
          }
          if (
            props.ipDiscovery !== undefined &&
            props.ipDiscovery !== observed.IpDiscovery
          ) {
            update.IpDiscovery = props.ipDiscovery;
            mutated = true;
          }
          if (
            props.numShards !== undefined &&
            props.numShards !== observed.NumberOfShards
          ) {
            update.ShardConfiguration = { ShardCount: props.numShards };
            mutated = true;
          }

          if (mutated) {
            yield* memorydb.updateCluster(update);
            observed = yield* waitForAvailable(name);
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const arn = observed.ARN;
          if (arn) {
            const observedTags = yield* readMemoryDbTags(arn);
            const { removed, upsert } = diffTags(observedTags, desiredTags);
            if (upsert.length > 0) {
              yield* memorydb.tagResource({ ResourceArn: arn, Tags: upsert });
            }
            if (removed.length > 0) {
              yield* memorydb.untagResource({
                ResourceArn: arn,
                TagKeys: removed,
              });
            }
          }

          yield* session.note(name);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          const name = output.clusterName;
          // A cluster mid-create/modify rejects deletion with
          // InvalidClusterStateFault — wait (bounded) for it to settle first.
          // A cluster already deleting (or gone) is success.
          yield* waitUntilSettled(name).pipe(Effect.catch(() => Effect.void));
          yield* memorydb.deleteCluster({ ClusterName: name }).pipe(
            Effect.catchTag("ClusterNotFoundFault", () => Effect.void),
            Effect.retry({
              while: (e) => e._tag === "InvalidClusterStateFault",
              schedule: Schedule.max([
                Schedule.fixed("15 seconds"),
                Schedule.recurs(20),
              ]),
            }),
            Effect.catchTag("InvalidClusterStateFault", () => Effect.void),
          );
        }),

        list: () =>
          memorydb.describeClusters.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.Clusters ?? []).filter(
                  (cluster) =>
                    cluster.Name !== undefined && cluster.ARN !== undefined,
                ),
              ),
            ),
            Effect.flatMap(
              Effect.forEach((cluster) => toAttrs(cluster), { concurrency: 4 }),
            ),
          ),
      };
    }),
  );
