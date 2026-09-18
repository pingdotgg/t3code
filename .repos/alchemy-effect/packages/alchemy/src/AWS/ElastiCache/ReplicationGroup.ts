import * as elasticache from "@distilled.cloud/aws/elasticache";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readElastiCacheTags, sameStringSet, tagsToWire } from "./internal.ts";

export interface ReplicationGroupProps {
  /** Replication group identifier. Generated deterministically when omitted. */
  replicationGroupId?: string;
  /** Required human-readable description. */
  description: string;
  /** Cache engine. */
  engine: "valkey" | "redis";
  engineVersion?: string;
  /** ElastiCache node type. Must start with `cache.`, for example `cache.t4g.micro`. @default cache.t4g.micro */
  nodeType?: `cache.${string}`;
  subnetGroupName?: string;
  securityGroupIds?: string[];
  /** Shard count. Changes use online resharding. */
  numNodeGroups?: number;
  /** Read replicas per shard, from 0 through 5. */
  replicasPerNodeGroup?: number;
  automaticFailoverEnabled?: boolean;
  multiAzEnabled?: boolean;
  parameterGroupName?: string;
  port?: number;
  maintenanceWindow?: string;
  snapshotRetentionLimit?: number;
  snapshotWindow?: string;
  autoMinorVersionUpgrade?: boolean;
  /** Enables TLS for client connections. @default true */
  transitEncryptionEnabled?: boolean;
  transitEncryptionMode?: elasticache.TransitEncryptionMode;
  atRestEncryptionEnabled?: boolean;
  kmsKeyId?: string;
  networkType?: elasticache.NetworkType;
  ipDiscovery?: elasticache.IpDiscovery;
  /** User group IDs for Valkey/Redis RBAC. */
  userGroupIds?: string[];
  /** Snapshot used only while creating a new group. */
  snapshotName?: string;
  snapshotArns?: string[];
  /** Optional final snapshot created before destroy. */
  finalSnapshotName?: string;
  tags?: Record<string, string>;
}

export interface ReplicationGroup extends Resource<
  "AWS.ElastiCache.ReplicationGroup",
  ReplicationGroupProps,
  {
    replicationGroupId: string;
    replicationGroupArn: string;
    status: string;
    engine: string;
    engineVersion: string | undefined;
    nodeType: string | undefined;
    configurationEndpointAddress: string | undefined;
    configurationEndpointPort: number | undefined;
    primaryEndpointAddress: string | undefined;
    primaryEndpointPort: number | undefined;
    readerEndpointAddress: string | undefined;
    readerEndpointPort: number | undefined;
    transitEncryptionEnabled: boolean;
    nodeGroupIds: string[];
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/** Invalid desired topology rejected before AWS can start a partial create. */
export class InvalidReplicationGroupConfiguration extends Data.TaggedError(
  "InvalidReplicationGroupConfiguration",
)<{ message: string }> {}

export const validateReplicationGroupProps = (
  props: ReplicationGroupProps,
): InvalidReplicationGroupConfiguration | undefined => {
  const invalid = (message: string) =>
    new InvalidReplicationGroupConfiguration({ message });
  if (
    props.port !== undefined &&
    (!Number.isInteger(props.port) || props.port < 1 || props.port > 65_535)
  ) {
    return invalid("port must be an integer from 1 through 65535");
  }
  if (
    props.numNodeGroups !== undefined &&
    (!Number.isInteger(props.numNodeGroups) || props.numNodeGroups < 1)
  ) {
    return invalid("numNodeGroups must be an integer of at least 1");
  }
  if (
    props.replicasPerNodeGroup !== undefined &&
    (!Number.isInteger(props.replicasPerNodeGroup) ||
      props.replicasPerNodeGroup < 0 ||
      props.replicasPerNodeGroup > 5)
  ) {
    return invalid("replicasPerNodeGroup must be an integer from 0 through 5");
  }
  if (
    props.automaticFailoverEnabled === true &&
    (props.replicasPerNodeGroup ?? 0) < 1
  ) {
    return invalid(
      "automaticFailoverEnabled requires replicasPerNodeGroup to be at least 1",
    );
  }
  if (props.multiAzEnabled === true && (props.replicasPerNodeGroup ?? 0) < 1) {
    return invalid(
      "multiAzEnabled requires replicasPerNodeGroup to be at least 1",
    );
  }
  if (
    props.multiAzEnabled === true &&
    props.automaticFailoverEnabled !== true
  ) {
    return invalid(
      "multiAzEnabled requires automaticFailoverEnabled to be true",
    );
  }
  if (
    props.transitEncryptionMode !== undefined &&
    props.transitEncryptionEnabled === false
  ) {
    return invalid("transitEncryptionMode requires transitEncryptionEnabled");
  }
  return undefined;
};

/**
 * A provisioned Valkey or Redis OSS replication group.
 *
 * ### Creating a Highly Available Cache
 * **Example:** Valkey with a replica in a VPC
 * ```typescript
 * const cache = yield* ReplicationGroup("Cache", {
 *   description: "application cache",
 *   engine: "valkey",
 *   subnetGroupName: subnets.subnetGroupName,
 *   securityGroupIds: [cacheSecurityGroup.groupId],
 *   replicasPerNodeGroup: 1,
 *   automaticFailoverEnabled: true,
 *   multiAzEnabled: true,
 *   transitEncryptionEnabled: true,
 * });
 * ```
 *
 * @resource
 */
export const ReplicationGroup = Resource<ReplicationGroup>(
  "AWS.ElastiCache.ReplicationGroup",
);

const DEFAULT_NODE_TYPE = "cache.t4g.micro";

export const ReplicationGroupProvider = () =>
  Provider.effect(
    ReplicationGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<ReplicationGroupProps>) =>
        props.replicationGroupId
          ? Effect.succeed(props.replicationGroupId)
          : createPhysicalName({ id, maxLength: 40, lowercase: true });
      const readGroup = Effect.fn(function* (name: string) {
        const response = yield* elasticache
          .describeReplicationGroups({ ReplicationGroupId: name })
          .pipe(
            Effect.catchTag("ReplicationGroupNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.ReplicationGroups?.[0];
      });
      const waitForAvailable = Effect.fn(function* (name: string) {
        return yield* readGroup(name).pipe(
          Effect.flatMap((group) =>
            group?.Status === "available"
              ? Effect.succeed(group)
              : Effect.fail(
                  new Error(`Replication group '${name}' is not available`),
                ),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.fixed("15 seconds"),
              // Engine upgrades can remain in "modifying" for more than
              // fifteen minutes before ElastiCache reports "available".
              Schedule.recurs(100),
            ]),
          }),
        );
      });
      const waitForDeleted = Effect.fn(function* (name: string) {
        return yield* readGroup(name).pipe(
          Effect.flatMap((group) =>
            group === undefined
              ? Effect.void
              : Effect.fail(
                  new Error(`Replication group '${name}' is still deleting`),
                ),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.fixed("15 seconds"),
              // Multi-AZ failover deletes can remain visible longer than the
              // normal fifteen-minute lifecycle window.
              Schedule.recurs(100),
            ]),
          }),
        );
      });
      const retryWhileCacheTransitioning = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ) =>
        effect.pipe(
          Effect.retry({
            while: (error) =>
              (error as { _tag?: string })._tag ===
                "InvalidReplicationGroupStateFault" ||
              (error as { _tag?: string })._tag ===
                "InvalidCacheClusterStateFault",
            schedule: Schedule.max([
              Schedule.fixed("15 seconds"),
              // AWS can report the group as available before its member
              // clusters accept tag changes after an in-place update.
              Schedule.recurs(100),
            ]),
          }),
        );
      const attrs = Effect.fn(function* (group: elasticache.ReplicationGroup) {
        if (
          !group.ReplicationGroupId ||
          !group.ARN ||
          !group.Status ||
          !group.Engine
        ) {
          return yield* Effect.fail(
            new Error(
              "ElastiCache replication group is missing its id, ARN, status, or engine",
            ),
          );
        }
        const engineVersion = group.MemberClusters?.[0]
          ? (yield* elasticache.describeCacheClusters({
              CacheClusterId: group.MemberClusters[0],
            })).CacheClusters?.[0]?.EngineVersion
          : undefined;
        const primary = group.NodeGroups?.[0]?.PrimaryEndpoint;
        const reader = group.NodeGroups?.[0]?.ReaderEndpoint;
        return {
          replicationGroupId: group.ReplicationGroupId,
          replicationGroupArn: group.ARN,
          status: group.Status,
          engine: group.Engine,
          engineVersion,
          nodeType: group.CacheNodeType,
          configurationEndpointAddress: group.ConfigurationEndpoint?.Address,
          configurationEndpointPort: group.ConfigurationEndpoint?.Port,
          primaryEndpointAddress: primary?.Address,
          primaryEndpointPort: primary?.Port,
          readerEndpointAddress: reader?.Address,
          readerEndpointPort: reader?.Port,
          transitEncryptionEnabled: group.TransitEncryptionEnabled ?? false,
          nodeGroupIds: (group.NodeGroups ?? [])
            .map((nodeGroup) => nodeGroup.NodeGroupId)
            .filter((id): id is string => id !== undefined),
          tags: yield* readElastiCacheTags(group.ARN),
        };
      });
      const replacement = (
        olds: Partial<ReplicationGroupProps>,
        news: Partial<ReplicationGroupProps>,
      ) =>
        olds.subnetGroupName !== news.subnetGroupName ||
        olds.port !== news.port ||
        olds.kmsKeyId !== news.kmsKeyId ||
        olds.atRestEncryptionEnabled !== news.atRestEncryptionEnabled ||
        olds.networkType !== news.networkType ||
        olds.snapshotName !== news.snapshotName ||
        // AWS cannot enable cluster mode on an existing non-cluster-mode
        // replication group, so scaling from one shard must replace it.
        ((olds.numNodeGroups ?? 1) <= 1 && (news.numNodeGroups ?? 1) > 1) ||
        !sameStringSet(olds.snapshotArns, news.snapshotArns);

      return {
        stables: ["replicationGroupId", "replicationGroupArn"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          if (replacement(olds ?? {}, news ?? {}))
            return { action: "replace" } as const;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const group = yield* readGroup(
            output?.replicationGroupId ?? (yield* toName(id, olds ?? {})),
          );
          if (!group?.ARN) return undefined;
          const result = yield* attrs(group);
          return (yield* hasAlchemyTags(id, result.tags))
            ? result
            : Unowned(result);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news!;
          const invalid = validateReplicationGroupProps(props);
          if (invalid) return yield* Effect.fail(invalid);
          const name = output?.replicationGroupId ?? (yield* toName(id, props));
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...props.tags,
          };
          let group = yield* readGroup(name);
          if (!group) {
            yield* elasticache
              .createReplicationGroup({
                ReplicationGroupId: name,
                ReplicationGroupDescription: props.description,
                Engine: props.engine,
                EngineVersion: props.engineVersion,
                CacheNodeType: props.nodeType ?? DEFAULT_NODE_TYPE,
                CacheSubnetGroupName: props.subnetGroupName,
                SecurityGroupIds: props.securityGroupIds,
                NumNodeGroups: props.numNodeGroups,
                ReplicasPerNodeGroup: props.replicasPerNodeGroup,
                AutomaticFailoverEnabled: props.automaticFailoverEnabled,
                MultiAZEnabled: props.multiAzEnabled,
                CacheParameterGroupName: props.parameterGroupName,
                Port: props.port,
                PreferredMaintenanceWindow: props.maintenanceWindow,
                SnapshotRetentionLimit: props.snapshotRetentionLimit,
                SnapshotWindow: props.snapshotWindow,
                AutoMinorVersionUpgrade: props.autoMinorVersionUpgrade,
                TransitEncryptionEnabled:
                  props.transitEncryptionEnabled ?? true,
                TransitEncryptionMode: props.transitEncryptionMode,
                AtRestEncryptionEnabled: props.atRestEncryptionEnabled,
                KmsKeyId: props.kmsKeyId,
                NetworkType: props.networkType,
                IpDiscovery: props.ipDiscovery,
                UserGroupIds: props.userGroupIds,
                SnapshotName: props.snapshotName,
                SnapshotArns: props.snapshotArns,
                Tags: tagsToWire(desiredTags),
              })
              .pipe(
                Effect.catchTag(
                  "ReplicationGroupAlreadyExistsFault",
                  () => Effect.void,
                ),
              );
          }
          group = yield* waitForAvailable(name);
          const update: elasticache.ModifyReplicationGroupMessage = {
            ReplicationGroupId: name,
            ApplyImmediately: true,
          };
          let changed = false;
          const set = <
            K extends keyof elasticache.ModifyReplicationGroupMessage,
          >(
            key: K,
            desired: elasticache.ModifyReplicationGroupMessage[K],
            observed: unknown,
          ) => {
            if (desired !== undefined && desired !== observed) {
              update[key] = desired;
              changed = true;
            }
          };
          set(
            "ReplicationGroupDescription",
            props.description,
            group.Description,
          );
          set("CacheNodeType", props.nodeType, group.CacheNodeType);
          set("Engine", props.engine, group.Engine);
          set(
            "AutoMinorVersionUpgrade",
            props.autoMinorVersionUpgrade,
            group.AutoMinorVersionUpgrade,
          );
          set("PreferredMaintenanceWindow", props.maintenanceWindow, undefined);
          set(
            "SnapshotRetentionLimit",
            props.snapshotRetentionLimit,
            group.SnapshotRetentionLimit,
          );
          set("SnapshotWindow", props.snapshotWindow, group.SnapshotWindow);
          set("CacheParameterGroupName", props.parameterGroupName, undefined);
          set("IpDiscovery", props.ipDiscovery, group.IpDiscovery);
          set(
            "TransitEncryptionMode",
            props.transitEncryptionMode,
            group.TransitEncryptionMode,
          );
          // ElastiCache reports VPC security groups and engine version on a
          // member cluster, not on the replication-group response.
          const member = group.MemberClusters?.[0]
            ? (yield* elasticache.describeCacheClusters({
                CacheClusterId: group.MemberClusters[0],
              })).CacheClusters?.[0]
            : undefined;
          const existingSecurityGroups = (member?.SecurityGroups ?? [])
            .map((membership) => membership.SecurityGroupId)
            .filter((id): id is string => id !== undefined);
          set("EngineVersion", props.engineVersion, member?.EngineVersion);
          if (
            props.securityGroupIds &&
            !sameStringSet(props.securityGroupIds, existingSecurityGroups)
          ) {
            update.SecurityGroupIds = props.securityGroupIds;
            changed = true;
          }
          const existingUsers = group.UserGroupIds ?? [];
          if (
            props.userGroupIds &&
            !sameStringSet(props.userGroupIds, existingUsers)
          ) {
            update.UserGroupIdsToAdd = props.userGroupIds.filter(
              (id) => !existingUsers.includes(id),
            );
            update.UserGroupIdsToRemove = existingUsers.filter(
              (id) => !props.userGroupIds!.includes(id),
            );
            changed = true;
          }
          if (changed) {
            yield* elasticache.modifyReplicationGroup(update);
            group = yield* waitForAvailable(name);
          }
          const currentNodeGroups = group.NodeGroups?.length ?? 1;
          if (
            props.numNodeGroups !== undefined &&
            props.numNodeGroups !== currentNodeGroups
          ) {
            yield* elasticache.modifyReplicationGroupShardConfiguration({
              ReplicationGroupId: name,
              NodeGroupCount: props.numNodeGroups,
              ApplyImmediately: true,
              ...(props.numNodeGroups < currentNodeGroups
                ? {
                    NodeGroupsToRemove: (group.NodeGroups ?? [])
                      .slice(props.numNodeGroups)
                      .map((node) => node.NodeGroupId)
                      .filter((id): id is string => id !== undefined),
                  }
                : {}),
            });
            group = yield* waitForAvailable(name);
          }
          const setAutomaticFailover = Effect.fn(function* (enabled: boolean) {
            const current = group;
            if (!current) {
              return yield* Effect.die(
                `Replication group '${name}' disappeared while updating automatic failover`,
              );
            }
            if ((current.AutomaticFailover === "enabled") === enabled) return;
            yield* retryWhileCacheTransitioning(
              elasticache.modifyReplicationGroup({
                ReplicationGroupId: name,
                AutomaticFailoverEnabled: enabled,
                ApplyImmediately: true,
              }),
            );
            group = yield* waitForAvailable(name);
          });
          const setMultiAz = Effect.fn(function* (enabled: boolean) {
            const current = group;
            if (!current) {
              return yield* Effect.die(
                `Replication group '${name}' disappeared while updating Multi-AZ`,
              );
            }
            if ((current.MultiAZ === "enabled") === enabled) return;
            yield* retryWhileCacheTransitioning(
              elasticache.modifyReplicationGroup({
                ReplicationGroupId: name,
                MultiAZEnabled: enabled,
                ApplyImmediately: true,
              }),
            );
            group = yield* waitForAvailable(name);
          });
          if (props.replicasPerNodeGroup !== undefined) {
            const replicaCount = Math.max(
              ...(group.NodeGroups ?? []).map((node) =>
                Math.max(0, (node.NodeGroupMembers?.length ?? 1) - 1),
              ),
              0,
            );
            // AWS rejects HA before the first replica exists, and rejects
            // removing the final replica while either HA setting is on.
            if (props.replicasPerNodeGroup === 0 && replicaCount > 0) {
              yield* setMultiAz(false);
              yield* setAutomaticFailover(false);
            }
            if (props.replicasPerNodeGroup > replicaCount) {
              yield* elasticache.increaseReplicaCount({
                ReplicationGroupId: name,
                NewReplicaCount: props.replicasPerNodeGroup,
                ApplyImmediately: true,
              });
              group = yield* waitForAvailable(name);
            } else if (props.replicasPerNodeGroup < replicaCount) {
              yield* elasticache.decreaseReplicaCount({
                ReplicationGroupId: name,
                NewReplicaCount: props.replicasPerNodeGroup,
                ApplyImmediately: true,
              });
              group = yield* waitForAvailable(name);
            }
          }
          if (props.automaticFailoverEnabled !== undefined) {
            yield* setAutomaticFailover(props.automaticFailoverEnabled);
          }
          if (props.multiAzEnabled !== undefined) {
            yield* setMultiAz(props.multiAzEnabled);
          }
          if (group.ARN) {
            const { removed, upsert } = diffTags(
              yield* retryWhileCacheTransitioning(
                readElastiCacheTags(group.ARN),
              ),
              desiredTags,
            );
            if (upsert.length)
              yield* retryWhileCacheTransitioning(
                elasticache.addTagsToResource({
                  ResourceName: group.ARN,
                  Tags: upsert,
                }),
              );
            if (removed.length)
              yield* retryWhileCacheTransitioning(
                elasticache.removeTagsFromResource({
                  ResourceName: group.ARN,
                  TagKeys: removed,
                }),
              );
            // AWS can accept a tag update before ListTagsForResource is
            // available again. Do not report the resource as reconciled
            // until callers can observe the finished tag state.
            yield* retryWhileCacheTransitioning(readElastiCacheTags(group.ARN));
          }
          yield* session.note(name);
          return yield* attrs(group);
        }),
        delete: Effect.fn(function* ({ olds, output }) {
          yield* retryWhileCacheTransitioning(
            elasticache
              .deleteReplicationGroup({
                ReplicationGroupId: output.replicationGroupId,
                FinalSnapshotIdentifier: olds.finalSnapshotName,
              })
              .pipe(
                Effect.catchTag(
                  "ReplicationGroupNotFoundFault",
                  () => Effect.void,
                ),
              ),
          );
          yield* waitForDeleted(output.replicationGroupId);
        }),
        list: () =>
          elasticache.describeReplicationGroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((pages) =>
              Array.from(pages).flatMap((page) => page.ReplicationGroups ?? []),
            ),
            Effect.flatMap((groups) =>
              Effect.forEach(
                groups.filter((group) => group.ARN),
                attrs,
              ),
            ),
          ),
      };
    }),
  );
