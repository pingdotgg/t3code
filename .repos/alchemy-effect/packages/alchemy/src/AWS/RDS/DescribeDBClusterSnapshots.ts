import type * as rds from "@distilled.cloud/aws/rds";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDBClusterSnapshots` operation (IAM action
 * `rds:DescribeDBClusterSnapshots`).
 *
 * Lists the account's Aurora cluster snapshots — the discovery half of a
 * snapshot-rotation or verification function. Provide the implementation with
 * `Effect.provide(AWS.RDS.DescribeDBClusterSnapshotsHttp)`.
 * @binding
 * @section Managing Cluster Snapshots
 * @example List a Cluster's Manual Snapshots
 * ```typescript
 * const describeDBClusterSnapshots =
 *   yield* AWS.RDS.DescribeDBClusterSnapshots();
 *
 * const page = yield* describeDBClusterSnapshots({
 *   DBClusterIdentifier: clusterId,
 *   SnapshotType: "manual",
 * });
 * ```
 */
export interface DescribeDBClusterSnapshots extends Binding.Service<
  DescribeDBClusterSnapshots,
  "AWS.RDS.DescribeDBClusterSnapshots",
  () => Effect.Effect<
    (
      request?: rds.DescribeDBClusterSnapshotsMessage,
    ) => Effect.Effect<
      rds.DBClusterSnapshotMessage,
      rds.DescribeDBClusterSnapshotsError
    >
  >
> {}
export const DescribeDBClusterSnapshots =
  Binding.Service<DescribeDBClusterSnapshots>(
    "AWS.RDS.DescribeDBClusterSnapshots",
  );
