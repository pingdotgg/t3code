import type * as rds from "@distilled.cloud/aws/rds";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DeleteDBClusterSnapshot` operation (IAM action
 * `rds:DeleteDBClusterSnapshot`).
 *
 * Deletes a manual Aurora cluster snapshot — the pruning half of a
 * snapshot-rotation function. Provide the implementation with
 * `Effect.provide(AWS.RDS.DeleteDBClusterSnapshotHttp)`.
 * @binding
 * @section Managing Cluster Snapshots
 * @example Prune an Old Cluster Snapshot
 * ```typescript
 * const deleteDBClusterSnapshot = yield* AWS.RDS.DeleteDBClusterSnapshot();
 *
 * yield* deleteDBClusterSnapshot({
 *   DBClusterSnapshotIdentifier: oldSnapshotId,
 * });
 * ```
 */
export interface DeleteDBClusterSnapshot extends Binding.Service<
  DeleteDBClusterSnapshot,
  "AWS.RDS.DeleteDBClusterSnapshot",
  () => Effect.Effect<
    (
      request: rds.DeleteDBClusterSnapshotMessage,
    ) => Effect.Effect<
      rds.DeleteDBClusterSnapshotResult,
      rds.DeleteDBClusterSnapshotError
    >
  >
> {}
export const DeleteDBClusterSnapshot = Binding.Service<DeleteDBClusterSnapshot>(
  "AWS.RDS.DeleteDBClusterSnapshot",
);
