import type * as neptune from "@distilled.cloud/aws/neptune";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DeleteDBClusterSnapshot` operation (IAM action
 * `rds:DeleteDBClusterSnapshot`).
 *
 * Deletes a manual Neptune cluster snapshot — the pruning half of a
 * snapshot-rotation function. Provide the implementation with
 * `Effect.provide(AWS.Neptune.DeleteDBClusterSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Prune an Old Snapshot
 * ```typescript
 * const deleteDBClusterSnapshot = yield* AWS.Neptune.DeleteDBClusterSnapshot();
 *
 * yield* deleteDBClusterSnapshot({
 *   DBClusterSnapshotIdentifier: oldSnapshotId,
 * });
 * ```
 */
export interface DeleteDBClusterSnapshot extends Binding.Service<
  DeleteDBClusterSnapshot,
  "AWS.Neptune.DeleteDBClusterSnapshot",
  () => Effect.Effect<
    (
      request?: neptune.DeleteDBClusterSnapshotMessage,
    ) => Effect.Effect<
      neptune.DeleteDBClusterSnapshotResult,
      neptune.DeleteDBClusterSnapshotError
    >
  >
> {}
export const DeleteDBClusterSnapshot = Binding.Service<DeleteDBClusterSnapshot>(
  "AWS.Neptune.DeleteDBClusterSnapshot",
);
