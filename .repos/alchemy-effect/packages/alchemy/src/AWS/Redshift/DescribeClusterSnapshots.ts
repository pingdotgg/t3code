import type * as redshift from "@distilled.cloud/aws/redshift";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeClusterSnapshots` operation (IAM action
 * `redshift:DescribeClusterSnapshots`).
 *
 * Lists the account's cluster snapshots (manual and automated) — e.g. a
 * snapshot-rotation job that finds manual snapshots older than the retention
 * window before deleting them. Provide the implementation with
 * `Effect.provide(AWS.Redshift.DescribeClusterSnapshotsHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example List a Cluster's Manual Snapshots
 * ```typescript
 * const describeClusterSnapshots =
 *   yield* AWS.Redshift.DescribeClusterSnapshots();
 *
 * const page = yield* describeClusterSnapshots({
 *   ClusterIdentifier: clusterId,
 *   SnapshotType: "manual",
 * });
 * const identifiers = page.Snapshots?.map((s) => s.SnapshotIdentifier);
 * ```
 */
export interface DescribeClusterSnapshots extends Binding.Service<
  DescribeClusterSnapshots,
  "AWS.Redshift.DescribeClusterSnapshots",
  () => Effect.Effect<
    (
      request?: redshift.DescribeClusterSnapshotsMessage,
    ) => Effect.Effect<
      redshift.SnapshotMessage,
      redshift.DescribeClusterSnapshotsError
    >
  >
> {}
export const DescribeClusterSnapshots =
  Binding.Service<DescribeClusterSnapshots>(
    "AWS.Redshift.DescribeClusterSnapshots",
  );
