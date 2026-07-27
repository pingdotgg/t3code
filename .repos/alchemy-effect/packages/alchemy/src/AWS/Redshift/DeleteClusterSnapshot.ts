import type * as redshift from "@distilled.cloud/aws/redshift";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DeleteClusterSnapshot` operation (IAM action
 * `redshift:DeleteClusterSnapshot`).
 *
 * Deletes a manual cluster snapshot by identifier — the cleanup half of a
 * snapshot-rotation job (automated snapshots cannot be deleted; they expire
 * with the retention period). Provide the implementation with
 * `Effect.provide(AWS.Redshift.DeleteClusterSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Delete an Expired Manual Snapshot
 * ```typescript
 * const deleteClusterSnapshot = yield* AWS.Redshift.DeleteClusterSnapshot();
 *
 * yield* deleteClusterSnapshot({
 *   SnapshotIdentifier: expired.SnapshotIdentifier!,
 * });
 * ```
 */
export interface DeleteClusterSnapshot extends Binding.Service<
  DeleteClusterSnapshot,
  "AWS.Redshift.DeleteClusterSnapshot",
  () => Effect.Effect<
    (
      request: redshift.DeleteClusterSnapshotMessage,
    ) => Effect.Effect<
      redshift.DeleteClusterSnapshotResult,
      redshift.DeleteClusterSnapshotError
    >
  >
> {}
export const DeleteClusterSnapshot = Binding.Service<DeleteClusterSnapshot>(
  "AWS.Redshift.DeleteClusterSnapshot",
);
