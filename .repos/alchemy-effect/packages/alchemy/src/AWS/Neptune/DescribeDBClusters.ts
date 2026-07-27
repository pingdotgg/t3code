import type * as neptune from "@distilled.cloud/aws/neptune";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDBClusters` operation (IAM action
 * `rds:DescribeDBClusters`).
 *
 * Lists the account's Neptune clusters (or one cluster by identifier) —
 * status, endpoints, members, engine versions — for health checks and
 * cluster discovery. Provide the implementation with
 * `Effect.provide(AWS.Neptune.DescribeDBClustersHttp)`.
 * @binding
 * @section Monitoring Clusters
 * @example Check a Cluster's Status
 * ```typescript
 * const describeDBClusters = yield* AWS.Neptune.DescribeDBClusters();
 *
 * const page = yield* describeDBClusters({
 *   DBClusterIdentifier: clusterId,
 * });
 * const status = page.DBClusters?.[0]?.Status;
 * ```
 */
export interface DescribeDBClusters extends Binding.Service<
  DescribeDBClusters,
  "AWS.Neptune.DescribeDBClusters",
  () => Effect.Effect<
    (
      request?: neptune.DescribeDBClustersMessage,
    ) => Effect.Effect<
      neptune.DBClusterMessage,
      neptune.DescribeDBClustersError
    >
  >
> {}
export const DescribeDBClusters = Binding.Service<DescribeDBClusters>(
  "AWS.Neptune.DescribeDBClusters",
);
