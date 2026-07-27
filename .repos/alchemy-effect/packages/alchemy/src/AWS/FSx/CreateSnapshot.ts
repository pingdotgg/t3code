import type * as fsx from "@distilled.cloud/aws/fsx";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `CreateSnapshot` operation (IAM actions
 * `fsx:CreateSnapshot` and `fsx:TagResource` on `*` — snapshots target
 * OpenZFS volumes whose ARNs are typically runtime values).
 *
 * Takes a point-in-time snapshot of an FSx for OpenZFS volume — e.g.
 * before applying a batch of writes so they can be rolled back with
 * {@link RestoreVolumeFromSnapshot}. Pass a `ClientRequestToken` to make
 * the call idempotent. Provide the implementation with
 * `Effect.provide(AWS.FSx.CreateSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots at Runtime
 * @example Snapshot a volume before a risky write
 * ```typescript
 * const createSnapshot = yield* AWS.FSx.CreateSnapshot();
 *
 * const response = yield* createSnapshot({
 *   Name: "pre-batch-42",
 *   VolumeId: volumeId,
 * });
 * yield* Effect.log(`snapshot ${response.Snapshot?.SnapshotId} started`);
 * ```
 */
export interface CreateSnapshot extends Binding.Service<
  CreateSnapshot,
  "AWS.FSx.CreateSnapshot",
  () => Effect.Effect<
    (
      request: fsx.CreateSnapshotRequest,
    ) => Effect.Effect<fsx.CreateSnapshotResponse, fsx.CreateSnapshotError>
  >
> {}
export const CreateSnapshot = Binding.Service<CreateSnapshot>(
  "AWS.FSx.CreateSnapshot",
);
