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

/**
 * Cache engine for a serverless cache.
 */
export type ServerlessCacheEngine = "valkey" | "redis" | "memcached";

/**
 * Usage limits that cap how much a serverless cache can consume. Setting
 * low maximums is the primary cost-control lever — serverless caches bill
 * for data stored (GB-hours) and compute (ECPUs) with a monthly floor.
 */
export interface ServerlessCacheUsageLimits {
  /**
   * Cached data storage limits in GB.
   * The service-minimum for `maximum` is 1 GB.
   */
  dataStorage?: {
    /** Maximum data storage in GB. */
    maximum?: number;
    /** Minimum (pre-provisioned) data storage in GB. */
    minimum?: number;
  };
  /**
   * ElastiCache Processing Unit (ECPU) rate limits.
   * The service-minimum for `maximum` is 1000 ECPUs/second.
   */
  ecpuPerSecond?: {
    /** Maximum ECPUs per second. */
    maximum?: number;
    /** Minimum (pre-provisioned) ECPUs per second. */
    minimum?: number;
  };
}

export interface ServerlessCacheProps {
  /**
   * Name of the serverless cache. Must be 1-40 alphanumeric characters or
   * hyphens. If omitted, a deterministic physical name is generated.
   * Changing the name replaces the cache.
   */
  serverlessCacheName?: string;
  /**
   * Cache engine.
   * @default "valkey"
   */
  engine?: ServerlessCacheEngine;
  /**
   * Major engine version, e.g. `"8"` for valkey or `"7"` for redis.
   * @default latest for the engine
   */
  majorEngineVersion?: string;
  /**
   * Human-readable description of the cache.
   */
  description?: string;
  /**
   * Usage limits capping storage (GB) and compute (ECPUs/second).
   * Strongly recommended for cost control.
   */
  cacheUsageLimits?: ServerlessCacheUsageLimits;
  /**
   * Customer-managed KMS key for encryption at rest. Changing the key
   * replaces the cache.
   * @default AWS-owned key
   */
  kmsKeyId?: string;
  /**
   * VPC security groups that control network access to the cache endpoint.
   * @default the VPC's default security group
   */
  securityGroupIds?: string[];
  /**
   * VPC subnets the cache is reachable from. Changing subnets replaces the
   * cache.
   * @default subnets of the account's default VPC
   */
  subnetIds?: string[];
  /**
   * User group for RBAC authentication (valkey/redis only).
   */
  userGroupId?: string;
  /**
   * Days to retain automatic daily snapshots. 0 disables automatic
   * snapshots.
   * @default 0
   */
  snapshotRetentionLimit?: number;
  /**
   * Daily time window (UTC, `HH:MM`) when automatic snapshots are taken.
   */
  dailySnapshotTime?: string;
  /**
   * IP discovery network type. Changing this replaces the cache.
   * @default "ipv4"
   */
  networkType?: elasticache.NetworkType;
  /**
   * ARNs of snapshots to seed the cache from at creation (create-only).
   */
  snapshotArnsToRestore?: string[];
  /**
   * User-defined tags for the cache.
   */
  tags?: Record<string, string>;
}

export interface ServerlessCache extends Resource<
  "AWS.ElastiCache.ServerlessCache",
  ServerlessCacheProps,
  {
    /** The name of the serverless cache. */
    serverlessCacheName: string;
    /** The ARN of the serverless cache. */
    serverlessCacheArn: string;
    /** The cache status (e.g. `creating`, `available`, `modifying`). */
    status: string;
    /** The cache engine (`valkey`, `redis`, or `memcached`). */
    engine: string;
    /** The major engine version (e.g. `8`). */
    majorEngineVersion: string | undefined;
    /** The full engine version the cache is running. */
    fullEngineVersion: string | undefined;
    /** The DNS hostname of the primary endpoint. */
    endpointAddress: string;
    /** The port of the primary endpoint (6379 for valkey/redis, 11211 for memcached). */
    endpointPort: number;
    /** The DNS hostname of the reader endpoint, when the engine exposes one. */
    readerEndpointAddress: string | undefined;
    /** The port of the reader endpoint, when the engine exposes one. */
    readerEndpointPort: number | undefined;
    /** The IDs of the security groups associated with the cache. */
    securityGroupIds: string[];
    /** The IDs of the subnets the cache is deployed in. */
    subnetIds: string[];
    /** The tags applied to the cache. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon ElastiCache serverless cache (valkey, redis, or memcached).
 *
 * Serverless caches scale storage and compute automatically and are only
 * reachable from inside a VPC. They are metered while they exist (with a
 * monthly minimum), so set `cacheUsageLimits` and destroy caches you are
 * not using.
 * @resource
 * @section Creating a Serverless Cache
 * @example Valkey Cache with Cost-Control Limits
 * ```typescript
 * const cache = yield* ServerlessCache("SessionCache", {
 *   engine: "valkey",
 *   cacheUsageLimits: {
 *     dataStorage: { maximum: 1 },
 *     ecpuPerSecond: { maximum: 1000 },
 *   },
 * });
 * ```
 *
 * @example Redis Cache in Specific Subnets
 * ```typescript
 * const cache = yield* ServerlessCache("Cache", {
 *   engine: "redis",
 *   majorEngineVersion: "7",
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 *   securityGroupIds: [cacheSecurityGroup.securityGroupId],
 * });
 * ```
 *
 * @section Connecting from a Lambda Function
 * @example Bind Connection Info into a Function
 * ```typescript
 * const connect = yield* ElastiCache.Connect(cache);
 * // inside a handler:
 * const { host, port, tls } = yield* connect;
 * ```
 */
export const ServerlessCache = Resource<ServerlessCache>(
  "AWS.ElastiCache.ServerlessCache",
);

const toTagRecord = (
  tags: Array<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const sameStringSet = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean => {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

/**
 * Convert user-facing camelCase usage limits into the wire shape. Serverless
 * data storage is always expressed in GB.
 */
const toWireUsageLimits = (
  limits: ServerlessCacheUsageLimits | undefined,
): elasticache.CacheUsageLimits | undefined =>
  limits === undefined
    ? undefined
    : {
        ...(limits.dataStorage
          ? {
              DataStorage: {
                Maximum: limits.dataStorage.maximum,
                Minimum: limits.dataStorage.minimum,
                Unit: "GB",
              },
            }
          : {}),
        ...(limits.ecpuPerSecond
          ? {
              ECPUPerSecond: {
                Maximum: limits.ecpuPerSecond.maximum,
                Minimum: limits.ecpuPerSecond.minimum,
              },
            }
          : {}),
      };

/**
 * True when the desired usage limits differ from the observed ones for any
 * field the user actually specified.
 */
const usageLimitsDiffer = (
  desired: elasticache.CacheUsageLimits | undefined,
  observed: elasticache.CacheUsageLimits | undefined,
): boolean => {
  if (desired === undefined) return false;
  // Only compare fields the user actually specified — the service fills in
  // defaults (units, minimums) that must not trigger spurious modify calls.
  if (desired.DataStorage) {
    if (
      (desired.DataStorage.Maximum !== undefined &&
        desired.DataStorage.Maximum !== observed?.DataStorage?.Maximum) ||
      (desired.DataStorage.Minimum !== undefined &&
        desired.DataStorage.Minimum !== observed?.DataStorage?.Minimum)
    ) {
      return true;
    }
  }
  if (desired.ECPUPerSecond) {
    if (
      (desired.ECPUPerSecond.Maximum !== undefined &&
        desired.ECPUPerSecond.Maximum !== observed?.ECPUPerSecond?.Maximum) ||
      (desired.ECPUPerSecond.Minimum !== undefined &&
        desired.ECPUPerSecond.Minimum !== observed?.ECPUPerSecond?.Minimum)
    ) {
      return true;
    }
  }
  return false;
};

export const ServerlessCacheProvider = () =>
  Provider.effect(
    ServerlessCache,
    Effect.gen(function* () {
      const toName = (id: string, props: ServerlessCacheProps) =>
        props.serverlessCacheName
          ? Effect.succeed(props.serverlessCacheName)
          : createPhysicalName({ id, maxLength: 40, lowercase: true });

      const readCache = Effect.fn(function* (name: string) {
        const response = yield* elasticache
          .describeServerlessCaches({ ServerlessCacheName: name })
          .pipe(
            Effect.catchTag("ServerlessCacheNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.ServerlessCaches?.[0];
      });

      const readTags = Effect.fn(function* (arn: string) {
        const response = yield* elasticache
          .listTagsForResource({ ResourceName: arn })
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        return toTagRecord(response?.TagList);
      });

      // Bounded readiness wait. Serverless cache provisioning/modification
      // typically completes in 1-3 minutes; budget ~10 min (60 * 10s) like
      // the RDS cluster wait so slow regions still converge.
      const waitForCache = Effect.fn(function* (name: string) {
        const readinessPolicy = Schedule.max([
          Schedule.fixed("10 seconds"),
          Schedule.recurs(60),
        ]);
        return yield* readCache(name).pipe(
          Effect.flatMap((cache) => {
            if (!cache?.ARN) {
              return Effect.fail(
                new Error(`Serverless cache '${name}' not found`),
              );
            }
            if (cache.Status !== "available") {
              return Effect.fail(
                new Error(
                  `Serverless cache '${name}' not available (status: ${cache.Status})`,
                ),
              );
            }
            return Effect.succeed(cache);
          }),
          Effect.retry({ schedule: readinessPolicy }),
        );
      });

      // Wait for a cache to leave a transitional state before delete. Ends
      // when the cache is available, deleting, or gone.
      const waitUntilSettled = Effect.fn(function* (name: string) {
        const settlePolicy = Schedule.max([
          Schedule.fixed("10 seconds"),
          Schedule.recurs(60),
        ]);
        return yield* readCache(name).pipe(
          Effect.flatMap((cache) => {
            if (
              cache !== undefined &&
              cache.Status !== "available" &&
              cache.Status !== "deleting"
            ) {
              return Effect.fail(
                new Error(
                  `Serverless cache '${name}' still settling (status: ${cache.Status})`,
                ),
              );
            }
            return Effect.succeed(cache);
          }),
          Effect.retry({ schedule: settlePolicy }),
        );
      });

      const toAttrs = Effect.fn(function* (cache: elasticache.ServerlessCache) {
        if (
          !cache.ServerlessCacheName ||
          !cache.ARN ||
          !cache.Endpoint?.Address ||
          cache.Endpoint.Port === undefined
        ) {
          return yield* Effect.fail(
            new Error(
              `Serverless cache '${cache.ServerlessCacheName}' is missing its ARN or endpoint (status: ${cache.Status})`,
            ),
          );
        }
        return {
          serverlessCacheName: cache.ServerlessCacheName,
          serverlessCacheArn: cache.ARN,
          status: cache.Status ?? "available",
          engine: cache.Engine ?? "valkey",
          majorEngineVersion: cache.MajorEngineVersion,
          fullEngineVersion: cache.FullEngineVersion,
          endpointAddress: cache.Endpoint.Address,
          endpointPort: cache.Endpoint.Port,
          readerEndpointAddress: cache.ReaderEndpoint?.Address,
          readerEndpointPort: cache.ReaderEndpoint?.Port,
          securityGroupIds: [...(cache.SecurityGroupIds ?? [])],
          subnetIds: [...(cache.SubnetIds ?? [])],
          tags: yield* readTags(cache.ARN),
        };
      });

      return {
        stables: ["serverlessCacheName", "serverlessCacheArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          // Create-only properties force a replacement.
          if (
            news?.subnetIds !== undefined &&
            olds?.subnetIds !== undefined &&
            !sameStringSet(news.subnetIds, olds.subnetIds)
          ) {
            return { action: "replace" } as const;
          }
          if ((news?.kmsKeyId ?? undefined) !== (olds?.kmsKeyId ?? undefined)) {
            return { action: "replace" } as const;
          }
          if (
            (news?.networkType ?? undefined) !==
            (olds?.networkType ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.serverlessCacheName ?? (yield* toName(id, olds ?? {}));
          const cache = yield* readCache(name);
          // A cache that is still provisioning has no endpoint yet; report
          // it as missing so reconcile (which tolerates the AlreadyExists
          // race and waits for availability) converges it.
          if (
            !cache?.ARN ||
            !cache.Endpoint?.Address ||
            cache.Endpoint.Port === undefined
          ) {
            return undefined;
          }
          const attrs = yield* toAttrs(cache);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const name = output?.serverlessCacheName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredLimits = toWireUsageLimits(news.cacheUsageLimits);

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readCache(name);

          // 2. Ensure — create if missing; tolerate AlreadyExists as a race.
          if (observed === undefined) {
            yield* elasticache
              .createServerlessCache({
                ServerlessCacheName: name,
                Engine: news.engine ?? "valkey",
                MajorEngineVersion: news.majorEngineVersion,
                Description: news.description,
                CacheUsageLimits: desiredLimits,
                KmsKeyId: news.kmsKeyId,
                SecurityGroupIds: news.securityGroupIds,
                SubnetIds: news.subnetIds,
                UserGroupId: news.userGroupId,
                SnapshotRetentionLimit: news.snapshotRetentionLimit,
                DailySnapshotTime: news.dailySnapshotTime,
                NetworkType: news.networkType,
                SnapshotArnsToRestore: news.snapshotArnsToRestore,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag(
                  "ServerlessCacheAlreadyExistsFault",
                  () => Effect.void,
                ),
              );
          }

          // Provisioning and in-flight modifications both surface as a
          // non-available status; wait for the cache to become available
          // (bounded) so sync/modify calls do not hit
          // InvalidServerlessCacheStateFault.
          observed = yield* waitForCache(name);

          // 3. Sync — compute the modify delta from OBSERVED state.
          const modify: elasticache.ModifyServerlessCacheRequest = {};
          if (
            news.description !== undefined &&
            news.description !== observed.Description
          ) {
            modify.Description = news.description;
          }
          if (usageLimitsDiffer(desiredLimits, observed.CacheUsageLimits)) {
            modify.CacheUsageLimits = desiredLimits;
          }
          if (
            news.securityGroupIds !== undefined &&
            !sameStringSet(news.securityGroupIds, observed.SecurityGroupIds)
          ) {
            modify.SecurityGroupIds = news.securityGroupIds;
          }
          if (
            news.userGroupId !== undefined &&
            news.userGroupId !== observed.UserGroupId
          ) {
            modify.UserGroupId = news.userGroupId;
          } else if (
            news.userGroupId === undefined &&
            observed.UserGroupId !== undefined
          ) {
            modify.RemoveUserGroup = true;
          }
          if (
            news.snapshotRetentionLimit !== undefined &&
            news.snapshotRetentionLimit !==
              (observed.SnapshotRetentionLimit ?? 0)
          ) {
            modify.SnapshotRetentionLimit = news.snapshotRetentionLimit;
          }
          if (
            news.dailySnapshotTime !== undefined &&
            news.dailySnapshotTime !== observed.DailySnapshotTime
          ) {
            modify.DailySnapshotTime = news.dailySnapshotTime;
          }
          if (news.engine !== undefined && news.engine !== observed.Engine) {
            // valkey <-> redis upgrades are supported in-place by the API.
            modify.Engine = news.engine;
            if (news.majorEngineVersion !== undefined) {
              modify.MajorEngineVersion = news.majorEngineVersion;
            }
          } else if (
            news.majorEngineVersion !== undefined &&
            news.majorEngineVersion !== observed.MajorEngineVersion
          ) {
            modify.MajorEngineVersion = news.majorEngineVersion;
          }

          if (Object.keys(modify).length > 0) {
            yield* elasticache.modifyServerlessCache({
              ServerlessCacheName: name,
              ...modify,
            });
            observed = yield* waitForCache(name);
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const arn = observed.ARN;
          if (arn) {
            const observedTags = yield* readTags(arn);
            const { removed, upsert } = diffTags(observedTags, desiredTags);
            if (upsert.length > 0) {
              yield* elasticache.addTagsToResource({
                ResourceName: arn,
                Tags: upsert,
              });
            }
            if (removed.length > 0) {
              yield* elasticache.removeTagsFromResource({
                ResourceName: arn,
                TagKeys: removed,
              });
            }
          }

          // 4. Return fresh attributes.
          yield* session.note(name);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          const name = output.serverlessCacheName;
          // A cache mid-create/modify rejects deletion with
          // InvalidServerlessCacheStateFault — wait (bounded) for it to
          // settle first. A cache already deleting (or gone) is success.
          yield* waitUntilSettled(name);
          yield* elasticache
            .deleteServerlessCache({ ServerlessCacheName: name })
            .pipe(
              Effect.catchTag(
                "ServerlessCacheNotFoundFault",
                () => Effect.void,
              ),
              Effect.catchTag(
                "InvalidServerlessCacheStateFault",
                () =>
                  // Already deleting — deletion is in progress.
                  Effect.void,
              ),
            );
        }),

        list: () =>
          elasticache.describeServerlessCaches.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.ServerlessCaches ?? []).filter(
                  (cache) =>
                    cache.ServerlessCacheName !== undefined &&
                    cache.ARN !== undefined &&
                    cache.Endpoint?.Address !== undefined &&
                    cache.Endpoint.Port !== undefined,
                ),
              ),
            ),
            Effect.flatMap(
              Effect.forEach((cache) => toAttrs(cache), { concurrency: 4 }),
            ),
          ),
      };
    }),
  );
