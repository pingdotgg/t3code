import type * as fsx from "@distilled.cloud/aws/fsx";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `CopySnapshotAndUpdateVolume` operation (IAM
 * action `fsx:CopySnapshotAndUpdateVolume` on `*`).
 *
 * Updates an existing FSx for OpenZFS volume from a snapshot on another FSx
 * for OpenZFS file system (on-demand data replication) — the cross-file-system
 * counterpart of {@link RestoreVolumeFromSnapshot}. Provide the
 * implementation with `Effect.provide(AWS.FSx.CopySnapshotAndUpdateVolumeHttp)`.
 * ### Managing Snapshots at Runtime
 * **Example:** Replicate a snapshot from another file system into a volume
 * ```typescript
 * const copySnapshotAndUpdateVolume =
 *   yield* AWS.FSx.CopySnapshotAndUpdateVolume();
 *
 * const response = yield* copySnapshotAndUpdateVolume({
 *   VolumeId: volumeId,
 *   SourceSnapshotARN: sourceSnapshot.ResourceARN!,
 *   CopyStrategy: "INCREMENTAL_COPY",
 * });
 * yield* Effect.log(`volume ${response.VolumeId} updating`);
 * ```
 *
 * @binding
 */
export interface CopySnapshotAndUpdateVolume extends Binding.Service<
  CopySnapshotAndUpdateVolume,
  "AWS.FSx.CopySnapshotAndUpdateVolume",
  () => Effect.Effect<
    (
      request: fsx.CopySnapshotAndUpdateVolumeRequest,
    ) => Effect.Effect<
      fsx.CopySnapshotAndUpdateVolumeResponse,
      fsx.CopySnapshotAndUpdateVolumeError
    >
  >
> {}
export const CopySnapshotAndUpdateVolume =
  Binding.Service<CopySnapshotAndUpdateVolume>(
    "AWS.FSx.CopySnapshotAndUpdateVolume",
  );
