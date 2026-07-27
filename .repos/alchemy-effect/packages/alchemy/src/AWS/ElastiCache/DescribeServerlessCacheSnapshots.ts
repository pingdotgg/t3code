import type * as elasticache from "@distilled.cloud/aws/elasticache";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeServerlessCacheSnapshots` operation (IAM
 * action `elasticache:DescribeServerlessCacheSnapshots`).
 *
 * Lists serverless cache snapshots — all of them, one by name, or those of a
 * particular cache. Available for valkey, redis, and serverless memcached.
 * Provide the implementation with
 * `Effect.provide(AWS.ElastiCache.DescribeServerlessCacheSnapshotsHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example List a Cache's Snapshots
 * ```typescript
 * const describeSnapshots = yield* ElastiCache.DescribeServerlessCacheSnapshots();
 *
 * const result = yield* describeSnapshots({ ServerlessCacheName: name });
 * for (const snapshot of result.ServerlessCacheSnapshots ?? []) {
 *   yield* Effect.logInfo(`${snapshot.ServerlessCacheSnapshotName}: ${snapshot.Status}`);
 * }
 * ```
 */
export interface DescribeServerlessCacheSnapshots extends Binding.Service<
  DescribeServerlessCacheSnapshots,
  "AWS.ElastiCache.DescribeServerlessCacheSnapshots",
  () => Effect.Effect<
    (
      request?: elasticache.DescribeServerlessCacheSnapshotsRequest,
    ) => Effect.Effect<
      elasticache.DescribeServerlessCacheSnapshotsResponse,
      elasticache.DescribeServerlessCacheSnapshotsError
    >
  >
> {}
export const DescribeServerlessCacheSnapshots =
  Binding.Service<DescribeServerlessCacheSnapshots>(
    "AWS.ElastiCache.DescribeServerlessCacheSnapshots",
  );
