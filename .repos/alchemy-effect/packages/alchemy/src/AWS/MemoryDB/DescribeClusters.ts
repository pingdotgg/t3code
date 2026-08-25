import type * as memorydb from "@distilled.cloud/aws/memorydb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeClusters` operation (IAM action
 * `memorydb:DescribeClusters`).
 *
 * Lists the account's MemoryDB clusters, or describes a single cluster by
 * name — e.g. checking a cluster's status or endpoint from an operational
 * Lambda. Provide the implementation with
 * `Effect.provide(AWS.MemoryDB.DescribeClustersHttp)`.
 * @binding
 * @section Monitoring Clusters
 * @example Check a Cluster's Status
 * ```typescript
 * const describeClusters = yield* MemoryDB.DescribeClusters();
 *
 * const page = yield* describeClusters({ ClusterName: clusterName });
 * // page.Clusters[0].Status → "available"
 * ```
 */
export interface DescribeClusters extends Binding.Service<
  DescribeClusters,
  "AWS.MemoryDB.DescribeClusters",
  () => Effect.Effect<
    (
      request?: memorydb.DescribeClustersRequest,
    ) => Effect.Effect<
      memorydb.DescribeClustersResponse,
      memorydb.DescribeClustersError
    >
  >
> {}
export const DescribeClusters = Binding.Service<DescribeClusters>(
  "AWS.MemoryDB.DescribeClusters",
);
