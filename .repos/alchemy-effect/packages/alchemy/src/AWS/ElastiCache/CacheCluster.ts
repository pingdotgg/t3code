import * as elasticache from "@distilled.cloud/aws/elasticache";
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

export interface CacheClusterProps {
  /** Cache cluster identifier. Generated deterministically when omitted. */
  cacheClusterId?: string;
  /** Memcached is the supported topology for this resource. */
  engine?: "memcached";
  engineVersion?: string;
  /** ElastiCache node type. Must start with `cache.`, for example `cache.t4g.micro`. @default cache.t4g.micro */
  nodeType?: `cache.${string}`;
  /** Number of Memcached nodes. */
  numCacheNodes?: number;
  subnetGroupName?: string;
  securityGroupIds?: string[];
  parameterGroupName?: string;
  preferredAvailabilityZones?: string[];
  maintenanceWindow?: string;
  notificationTopicArn?: string;
  autoMinorVersionUpgrade?: boolean;
  port?: number;
  networkType?: elasticache.NetworkType;
  ipDiscovery?: elasticache.IpDiscovery;
  tags?: Record<string, string>;
}

export interface CacheNodeEndpoint {
  address: string;
  port: number;
}

export interface CacheCluster extends Resource<
  "AWS.ElastiCache.CacheCluster",
  CacheClusterProps,
  {
    cacheClusterId: string;
    cacheClusterArn: string;
    status: string;
    engine: string;
    engineVersion: string | undefined;
    nodeType: string | undefined;
    endpoints: CacheNodeEndpoint[];
    transitEncryptionEnabled: boolean;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A provisioned Memcached cluster. Use {@link ReplicationGroup} for Valkey or Redis.
 *
 * ### Creating a Memcached Cluster
 * **Example:** Two-node cluster in a VPC
 * ```typescript
 * const cache = yield* CacheCluster("Cache", {
 *   subnetGroupName: subnets.subnetGroupName,
 *   securityGroupIds: [cacheSecurityGroup.groupId],
 *   numCacheNodes: 2,
 * });
 * ```
 *
 * @resource
 */
export const CacheCluster = Resource<CacheCluster>(
  "AWS.ElastiCache.CacheCluster",
);

export const CacheClusterProvider = () =>
  Provider.effect(
    CacheCluster,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<CacheClusterProps>) =>
        props.cacheClusterId
          ? Effect.succeed(props.cacheClusterId)
          : createPhysicalName({ id, maxLength: 50, lowercase: true });
      const readCluster = Effect.fn(function* (name: string) {
        const response = yield* elasticache
          .describeCacheClusters({
            CacheClusterId: name,
            ShowCacheNodeInfo: true,
          })
          .pipe(
            Effect.catchTag("CacheClusterNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.CacheClusters?.[0];
      });
      const waitForAvailable = Effect.fn(function* (name: string) {
        return yield* readCluster(name).pipe(
          Effect.flatMap((cluster) =>
            cluster?.CacheClusterStatus === "available"
              ? Effect.succeed(cluster)
              : Effect.fail(
                  new Error(`Cache cluster '${name}' is not available`),
                ),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.fixed("15 seconds"),
              Schedule.recurs(60),
            ]),
          }),
        );
      });
      const waitForDeleted = Effect.fn(function* (name: string) {
        return yield* readCluster(name).pipe(
          Effect.flatMap((cluster) =>
            cluster === undefined
              ? Effect.void
              : Effect.fail(
                  new Error(`Cache cluster '${name}' is still deleting`),
                ),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.fixed("15 seconds"),
              Schedule.recurs(60),
            ]),
          }),
        );
      });
      const attrs = Effect.fn(function* (cluster: elasticache.CacheCluster) {
        if (!cluster.CacheClusterId || !cluster.ARN) {
          return yield* Effect.fail(
            new Error("ElastiCache cache cluster is missing its id or ARN"),
          );
        }
        return {
          cacheClusterId: cluster.CacheClusterId,
          cacheClusterArn: cluster.ARN,
          status: cluster.CacheClusterStatus ?? "available",
          engine: cluster.Engine ?? "memcached",
          engineVersion: cluster.EngineVersion,
          nodeType: cluster.CacheNodeType,
          endpoints: (cluster.CacheNodes ?? []).flatMap((node) =>
            node.Endpoint?.Address !== undefined &&
            node.Endpoint.Port !== undefined
              ? [{ address: node.Endpoint.Address, port: node.Endpoint.Port }]
              : [],
          ),
          transitEncryptionEnabled: cluster.TransitEncryptionEnabled ?? false,
          tags: yield* readElastiCacheTags(cluster.ARN),
        };
      });
      const replaces = (
        olds: Partial<CacheClusterProps>,
        news: Partial<CacheClusterProps>,
      ) =>
        olds.subnetGroupName !== news.subnetGroupName ||
        olds.port !== news.port ||
        olds.networkType !== news.networkType ||
        olds.engine !== news.engine;

      return {
        stables: ["cacheClusterId", "cacheClusterArn"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          if (replaces(olds ?? {}, news ?? {}))
            return { action: "replace" } as const;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const cluster = yield* readCluster(
            output?.cacheClusterId ?? (yield* toName(id, olds ?? {})),
          );
          if (!cluster?.ARN) return undefined;
          const result = yield* attrs(cluster);
          return (yield* hasAlchemyTags(id, result.tags))
            ? result
            : Unowned(result);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news ?? {};
          const name = output?.cacheClusterId ?? (yield* toName(id, props));
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...props.tags,
          };
          let cluster = yield* readCluster(name);
          if (!cluster) {
            yield* elasticache
              .createCacheCluster({
                CacheClusterId: name,
                Engine: "memcached",
                EngineVersion: props.engineVersion,
                CacheNodeType: props.nodeType ?? "cache.t4g.micro",
                NumCacheNodes: props.numCacheNodes ?? 1,
                CacheSubnetGroupName: props.subnetGroupName,
                SecurityGroupIds: props.securityGroupIds,
                CacheParameterGroupName: props.parameterGroupName,
                PreferredAvailabilityZones: props.preferredAvailabilityZones,
                PreferredMaintenanceWindow: props.maintenanceWindow,
                NotificationTopicArn: props.notificationTopicArn,
                AutoMinorVersionUpgrade: props.autoMinorVersionUpgrade,
                Port: props.port,
                NetworkType: props.networkType,
                IpDiscovery: props.ipDiscovery,
                Tags: tagsToWire(desiredTags),
              })
              .pipe(
                Effect.catchTag(
                  "CacheClusterAlreadyExistsFault",
                  () => Effect.void,
                ),
              );
          }
          cluster = yield* waitForAvailable(name);
          const update: elasticache.ModifyCacheClusterMessage = {
            CacheClusterId: name,
            ApplyImmediately: true,
          };
          let changed = false;
          const set = <K extends keyof elasticache.ModifyCacheClusterMessage>(
            key: K,
            desired: elasticache.ModifyCacheClusterMessage[K],
            observed: unknown,
          ) => {
            if (desired !== undefined && desired !== observed) {
              update[key] = desired;
              changed = true;
            }
          };
          set("NumCacheNodes", props.numCacheNodes, cluster.NumCacheNodes);
          set("CacheNodeType", props.nodeType, cluster.CacheNodeType);
          set("EngineVersion", props.engineVersion, cluster.EngineVersion);
          set(
            "CacheParameterGroupName",
            props.parameterGroupName,
            cluster.CacheParameterGroup?.CacheParameterGroupName,
          );
          set(
            "PreferredMaintenanceWindow",
            props.maintenanceWindow,
            cluster.PreferredMaintenanceWindow,
          );
          set(
            "AutoMinorVersionUpgrade",
            props.autoMinorVersionUpgrade,
            cluster.AutoMinorVersionUpgrade,
          );
          set("IpDiscovery", props.ipDiscovery, cluster.IpDiscovery);
          if (props.securityGroupIds !== undefined) {
            const observed = (cluster.SecurityGroups ?? [])
              .map((group) => group.SecurityGroupId)
              .filter((id): id is string => id !== undefined);
            if (!sameStringSet(props.securityGroupIds, observed)) {
              update.SecurityGroupIds = props.securityGroupIds;
              changed = true;
            }
          }
          if (changed) {
            yield* elasticache.modifyCacheCluster(update);
            cluster = yield* waitForAvailable(name);
          }
          if (cluster.ARN) {
            const { removed, upsert } = diffTags(
              yield* readElastiCacheTags(cluster.ARN),
              desiredTags,
            );
            if (upsert.length)
              yield* elasticache.addTagsToResource({
                ResourceName: cluster.ARN,
                Tags: upsert,
              });
            if (removed.length)
              yield* elasticache.removeTagsFromResource({
                ResourceName: cluster.ARN,
                TagKeys: removed,
              });
          }
          yield* session.note(name);
          return yield* attrs(cluster);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* elasticache
            .deleteCacheCluster({ CacheClusterId: output.cacheClusterId })
            .pipe(
              Effect.catchTag("CacheClusterNotFoundFault", () => Effect.void),
              Effect.retry({
                while: (error) =>
                  error._tag === "InvalidCacheClusterStateFault",
                schedule: Schedule.max([
                  Schedule.fixed("15 seconds"),
                  Schedule.recurs(12),
                ]),
              }),
            );
          yield* waitForDeleted(output.cacheClusterId);
        }),
        list: () =>
          elasticache.describeCacheClusters
            .pages({ ShowCacheNodeInfo: true })
            .pipe(
              Stream.runCollect,
              Effect.map((pages) =>
                Array.from(pages).flatMap((page) => page.CacheClusters ?? []),
              ),
              Effect.flatMap((clusters) =>
                Effect.forEach(
                  clusters.filter((cluster) => cluster.ARN),
                  attrs,
                ),
              ),
            ),
      };
    }),
  );
