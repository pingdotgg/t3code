import type * as fsx from "@distilled.cloud/aws/fsx";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `UpdateSnapshot` operation (IAM action
 * `fsx:UpdateSnapshot` on `*` — runtime-created snapshots have ARNs
 * unknowable at deploy time).
 *
 * Renames an OpenZFS volume snapshot — the management half of a runtime
 * snapshot rotation built with {@link CreateSnapshot}. A missing snapshot
 * surfaces the typed `UpdateSnapshotNotFound` (FSx reports it as a wire
 * `BadRequest`; the distilled patch carves out the typed tag by message).
 * Provide the implementation with
 * `Effect.provide(AWS.FSx.UpdateSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots at Runtime
 * @example Rename a snapshot after promotion
 * ```typescript
 * const updateSnapshot = yield* AWS.FSx.UpdateSnapshot();
 *
 * yield* updateSnapshot({
 *   SnapshotId: snapshot.SnapshotId!,
 *   Name: "nightly-promoted",
 * });
 * ```
 */
export interface UpdateSnapshot extends Binding.Service<
  UpdateSnapshot,
  "AWS.FSx.UpdateSnapshot",
  () => Effect.Effect<
    (
      request: fsx.UpdateSnapshotRequest,
    ) => Effect.Effect<fsx.UpdateSnapshotResponse, fsx.UpdateSnapshotError>
  >
> {}
export const UpdateSnapshot = Binding.Service<UpdateSnapshot>(
  "AWS.FSx.UpdateSnapshot",
);
