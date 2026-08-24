import type * as elasticache from "@distilled.cloud/aws/elasticache";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DeleteServerlessCacheSnapshot` operation (IAM
 * action `elasticache:DeleteServerlessCacheSnapshot`).
 *
 * Deletes a serverless cache snapshot by name — e.g. rotating out old manual
 * backups from a maintenance Lambda. Available for valkey, redis, and
 * serverless memcached. Provide the implementation with
 * `Effect.provide(AWS.ElastiCache.DeleteServerlessCacheSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Delete an Old Snapshot
 * ```typescript
 * const deleteSnapshot = yield* ElastiCache.DeleteServerlessCacheSnapshot();
 *
 * yield* deleteSnapshot({ ServerlessCacheSnapshotName: "pre-migration" }).pipe(
 *   Effect.catchTag("ServerlessCacheSnapshotNotFoundFault", () => Effect.void),
 * );
 * ```
 */
export interface DeleteServerlessCacheSnapshot extends Binding.Service<
  DeleteServerlessCacheSnapshot,
  "AWS.ElastiCache.DeleteServerlessCacheSnapshot",
  () => Effect.Effect<
    (
      request: elasticache.DeleteServerlessCacheSnapshotRequest,
    ) => Effect.Effect<
      elasticache.DeleteServerlessCacheSnapshotResponse,
      elasticache.DeleteServerlessCacheSnapshotError
    >
  >
> {}
export const DeleteServerlessCacheSnapshot =
  Binding.Service<DeleteServerlessCacheSnapshot>(
    "AWS.ElastiCache.DeleteServerlessCacheSnapshot",
  );
