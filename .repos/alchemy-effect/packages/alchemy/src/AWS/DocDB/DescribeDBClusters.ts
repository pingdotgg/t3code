import type * as docdb from "@distilled.cloud/aws/docdb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDBClusters` operation (IAM action
 * `rds:DescribeDBClusters`).
 *
 * Lists the account's DocumentDB clusters (or one cluster by identifier) —
 * status, endpoints, members, engine versions — for health checks and
 * cluster discovery. Provide the implementation with
 * `Effect.provide(AWS.DocDB.DescribeDBClustersHttp)`.
 * @binding
 * @section Monitoring Clusters
 * @example Check a Cluster's Status
 * ```typescript
 * const describeDBClusters = yield* AWS.DocDB.DescribeDBClusters();
 *
 * const page = yield* describeDBClusters({
 *   DBClusterIdentifier: clusterId,
 * });
 * const status = page.DBClusters?.[0]?.Status;
 * ```
 */
export interface DescribeDBClusters extends Binding.Service<
  DescribeDBClusters,
  "AWS.DocDB.DescribeDBClusters",
  () => Effect.Effect<
    (
      request?: docdb.DescribeDBClustersMessage,
    ) => Effect.Effect<docdb.DBClusterMessage, docdb.DescribeDBClustersError>
  >
> {}
export const DescribeDBClusters = Binding.Service<DescribeDBClusters>(
  "AWS.DocDB.DescribeDBClusters",
);
