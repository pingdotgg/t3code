import type * as fsx from "@distilled.cloud/aws/fsx";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DeleteSnapshot` operation (IAM action
 * `fsx:DeleteSnapshot` on `*` — runtime-created snapshots have ARNs
 * unknowable at deploy time).
 *
 * Deletes an FSx for OpenZFS snapshot by id — the teardown half of a
 * runtime snapshot rotation built with {@link CreateSnapshot}. Deleting an
 * already-deleted snapshot surfaces the typed `SnapshotNotFound`. Provide
 * the implementation with `Effect.provide(AWS.FSx.DeleteSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots at Runtime
 * @example Rotate out an old snapshot
 * ```typescript
 * const deleteSnapshot = yield* AWS.FSx.DeleteSnapshot();
 *
 * yield* deleteSnapshot({ SnapshotId: old.SnapshotId! }).pipe(
 *   Effect.catchTag("SnapshotNotFound", () => Effect.void),
 * );
 * ```
 */
export interface DeleteSnapshot extends Binding.Service<
  DeleteSnapshot,
  "AWS.FSx.DeleteSnapshot",
  () => Effect.Effect<
    (
      request: fsx.DeleteSnapshotRequest,
    ) => Effect.Effect<fsx.DeleteSnapshotResponse, fsx.DeleteSnapshotError>
  >
> {}
export const DeleteSnapshot = Binding.Service<DeleteSnapshot>(
  "AWS.FSx.DeleteSnapshot",
);
