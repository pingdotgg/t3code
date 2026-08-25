import type * as memorydb from "@distilled.cloud/aws/memorydb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `BatchUpdateCluster` operation (IAM action
 * `memorydb:BatchUpdateCluster`).
 *
 * Applies a service update (security patch, engine upgrade) to a list of
 * clusters — pair with {@link DescribeServiceUpdates} to build patch
 * automation that applies available updates inside a maintenance window.
 * Clusters that cannot take the update are returned in
 * `UnprocessedClusters` (with the reason) rather than failing the call.
 * Provide the implementation with
 * `Effect.provide(AWS.MemoryDB.BatchUpdateClusterHttp)`.
 * @binding
 * @section Applying Service Updates
 * @example Apply a Service Update to Clusters
 * ```typescript
 * const batchUpdateCluster = yield* MemoryDB.BatchUpdateCluster();
 *
 * const result = yield* batchUpdateCluster({
 *   ClusterNames: [clusterName],
 *   ServiceUpdate: { ServiceUpdateNameToApply: updateName },
 * });
 * // result.ProcessedClusters / result.UnprocessedClusters
 * ```
 */
export interface BatchUpdateCluster extends Binding.Service<
  BatchUpdateCluster,
  "AWS.MemoryDB.BatchUpdateCluster",
  () => Effect.Effect<
    (
      request: memorydb.BatchUpdateClusterRequest,
    ) => Effect.Effect<
      memorydb.BatchUpdateClusterResponse,
      memorydb.BatchUpdateClusterError
    >
  >
> {}
export const BatchUpdateCluster = Binding.Service<BatchUpdateCluster>(
  "AWS.MemoryDB.BatchUpdateCluster",
);
