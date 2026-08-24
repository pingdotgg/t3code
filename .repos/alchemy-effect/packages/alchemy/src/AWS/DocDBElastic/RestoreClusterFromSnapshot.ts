import type * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `RestoreClusterFromSnapshot` operation (IAM
 * actions `docdb-elastic:RestoreClusterFromSnapshot` +
 * `docdb-elastic:TagResource`, plus the EC2 VPC-endpoint permissions elastic
 * clusters need to attach to a VPC).
 *
 * Restores a new elastic cluster from a snapshot — e.g. a disaster-recovery
 * Lambda that rebuilds a cluster from the latest nightly backup. Provide the
 * implementation with
 * `Effect.provide(AWS.DocDBElastic.RestoreClusterFromSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Restore a Cluster from a Snapshot
 * ```typescript
 * const restoreCluster = yield* DocDBElastic.RestoreClusterFromSnapshot();
 *
 * const result = yield* restoreCluster({
 *   snapshotArn,
 *   clusterName: "documents-restored",
 * });
 * // result.cluster.status → "CREATING"
 * ```
 */
export interface RestoreClusterFromSnapshot extends Binding.Service<
  RestoreClusterFromSnapshot,
  "AWS.DocDBElastic.RestoreClusterFromSnapshot",
  () => Effect.Effect<
    (
      request: docdbelastic.RestoreClusterFromSnapshotInput,
    ) => Effect.Effect<
      docdbelastic.RestoreClusterFromSnapshotOutput,
      docdbelastic.RestoreClusterFromSnapshotError
    >
  >
> {}
export const RestoreClusterFromSnapshot =
  Binding.Service<RestoreClusterFromSnapshot>(
    "AWS.DocDBElastic.RestoreClusterFromSnapshot",
  );
