import type * as elasticache from "@distilled.cloud/aws/elasticache";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ServerlessCache } from "./ServerlessCache.ts";

/**
 * Runtime binding for the `CreateServerlessCacheSnapshot` operation (IAM
 * actions `elasticache:CreateServerlessCacheSnapshot` +
 * `elasticache:AddTagsToResource`), scoped to one {@link ServerlessCache}.
 *
 * Takes an on-demand snapshot of the bound serverless cache — e.g. a
 * pre-migration backup from an operational Lambda. Available for valkey,
 * redis, and serverless memcached. Provide the implementation with
 * `Effect.provide(AWS.ElastiCache.CreateServerlessCacheSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Take an On-Demand Snapshot
 * ```typescript
 * const createSnapshot = yield* ElastiCache.CreateServerlessCacheSnapshot(cache);
 *
 * const result = yield* createSnapshot({
 *   ServerlessCacheSnapshotName: "pre-migration",
 * });
 * // result.ServerlessCacheSnapshot.Status → "creating"
 * ```
 */
export interface CreateServerlessCacheSnapshot extends Binding.Service<
  CreateServerlessCacheSnapshot,
  "AWS.ElastiCache.CreateServerlessCacheSnapshot",
  (
    cache: ServerlessCache,
  ) => Effect.Effect<
    (
      request: Omit<
        elasticache.CreateServerlessCacheSnapshotRequest,
        "ServerlessCacheName"
      >,
    ) => Effect.Effect<
      elasticache.CreateServerlessCacheSnapshotResponse,
      elasticache.CreateServerlessCacheSnapshotError
    >
  >
> {}
export const CreateServerlessCacheSnapshot =
  Binding.Service<CreateServerlessCacheSnapshot>(
    "AWS.ElastiCache.CreateServerlessCacheSnapshot",
  );
