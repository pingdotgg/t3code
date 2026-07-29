import type * as rds from "@distilled.cloud/aws/rds";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DeleteDBSnapshot` operation (IAM action
 * `rds:DeleteDBSnapshot`).
 *
 * Deletes a manual DB instance snapshot — the pruning half of a
 * snapshot-rotation function. Provide the implementation with
 * `Effect.provide(AWS.RDS.DeleteDBSnapshotHttp)`.
 * @binding
 * @section Managing Instance Snapshots
 * @example Prune an Old Instance Snapshot
 * ```typescript
 * const deleteDBSnapshot = yield* AWS.RDS.DeleteDBSnapshot();
 *
 * yield* deleteDBSnapshot({ DBSnapshotIdentifier: oldSnapshotId });
 * ```
 */
export interface DeleteDBSnapshot extends Binding.Service<
  DeleteDBSnapshot,
  "AWS.RDS.DeleteDBSnapshot",
  () => Effect.Effect<
    (
      request: rds.DeleteDBSnapshotMessage,
    ) => Effect.Effect<rds.DeleteDBSnapshotResult, rds.DeleteDBSnapshotError>
  >
> {}
export const DeleteDBSnapshot = Binding.Service<DeleteDBSnapshot>(
  "AWS.RDS.DeleteDBSnapshot",
);
