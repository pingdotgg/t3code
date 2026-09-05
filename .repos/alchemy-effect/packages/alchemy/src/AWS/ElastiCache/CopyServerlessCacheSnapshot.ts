import type * as elasticache from "@distilled.cloud/aws/elasticache";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `CopyServerlessCacheSnapshot` operation (IAM
 * actions `elasticache:CopyServerlessCacheSnapshot` +
 * `elasticache:AddTagsToResource`).
 *
 * Copies an existing serverless cache snapshot, optionally re-encrypting it
 * under a different KMS key — e.g. duplicating a nightly backup before a
 * risky migration. Available for valkey, redis, and serverless memcached.
 * Provide the implementation with
 * `Effect.provide(AWS.ElastiCache.CopyServerlessCacheSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Copy a Snapshot
 * ```typescript
 * const copySnapshot = yield* ElastiCache.CopyServerlessCacheSnapshot();
 *
 * const result = yield* copySnapshot({
 *   SourceServerlessCacheSnapshotName: "nightly",
 *   TargetServerlessCacheSnapshotName: "pre-migration",
 * });
 * ```
 */
export interface CopyServerlessCacheSnapshot extends Binding.Service<
  CopyServerlessCacheSnapshot,
  "AWS.ElastiCache.CopyServerlessCacheSnapshot",
  () => Effect.Effect<
    (
      request: elasticache.CopyServerlessCacheSnapshotRequest,
    ) => Effect.Effect<
      elasticache.CopyServerlessCacheSnapshotResponse,
      elasticache.CopyServerlessCacheSnapshotError
    >
  >
> {}
export const CopyServerlessCacheSnapshot =
  Binding.Service<CopyServerlessCacheSnapshot>(
    "AWS.ElastiCache.CopyServerlessCacheSnapshot",
  );
