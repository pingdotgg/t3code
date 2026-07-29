import type * as fsx from "@distilled.cloud/aws/fsx";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `RestoreVolumeFromSnapshot` operation (IAM action
 * `fsx:RestoreVolumeFromSnapshot` on `*`).
 *
 * Rolls an FSx for OpenZFS volume back to the state saved by a snapshot —
 * the undo half of the runtime snapshot pattern built with
 * {@link CreateSnapshot}. Pass `Options: ["DELETE_INTERMEDIATE_SNAPSHOTS"]`
 * to roll back past newer snapshots. Provide the implementation with
 * `Effect.provide(AWS.FSx.RestoreVolumeFromSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots at Runtime
 * @example Roll back a failed batch of writes
 * ```typescript
 * const restoreVolumeFromSnapshot =
 *   yield* AWS.FSx.RestoreVolumeFromSnapshot();
 *
 * const response = yield* restoreVolumeFromSnapshot({
 *   VolumeId: volumeId,
 *   SnapshotId: snapshot.SnapshotId!,
 * });
 * yield* Effect.log(`volume ${response.VolumeId} restoring`);
 * ```
 */
export interface RestoreVolumeFromSnapshot extends Binding.Service<
  RestoreVolumeFromSnapshot,
  "AWS.FSx.RestoreVolumeFromSnapshot",
  () => Effect.Effect<
    (
      request: fsx.RestoreVolumeFromSnapshotRequest,
    ) => Effect.Effect<
      fsx.RestoreVolumeFromSnapshotResponse,
      fsx.RestoreVolumeFromSnapshotError
    >
  >
> {}
export const RestoreVolumeFromSnapshot =
  Binding.Service<RestoreVolumeFromSnapshot>(
    "AWS.FSx.RestoreVolumeFromSnapshot",
  );
