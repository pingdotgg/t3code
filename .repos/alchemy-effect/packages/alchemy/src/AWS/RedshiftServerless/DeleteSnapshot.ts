import type * as serverless from "@distilled.cloud/aws/redshift-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DeleteSnapshot` operation (IAM actions
 * `redshift-serverless:DeleteSnapshot`).
 *
 * Deletes a manual snapshot — the cleanup half of a snapshot-rotation
 * job. Provide the implementation with
 * `Effect.provide(AWS.RedshiftServerless.DeleteSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Delete an Expired Snapshot
 * ```typescript
 * // init — resolve the runtime client
 * const deleteSnapshot = yield* AWS.RedshiftServerless.DeleteSnapshot();
 *
 * yield* deleteSnapshot({ snapshotName: "pre-migration-1" });
 * ```
 */
export interface DeleteSnapshot extends Binding.Service<
  DeleteSnapshot,
  "AWS.RedshiftServerless.DeleteSnapshot",
  () => Effect.Effect<
    (
      request: serverless.DeleteSnapshotRequest,
    ) => Effect.Effect<
      serverless.DeleteSnapshotResponse,
      serverless.DeleteSnapshotError
    >
  >
> {}
export const DeleteSnapshot = Binding.Service<DeleteSnapshot>(
  "AWS.RedshiftServerless.DeleteSnapshot",
);
