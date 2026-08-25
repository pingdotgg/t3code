import type * as ec2 from "@distilled.cloud/aws/ec2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Volume } from "./Volume.ts";

/**
 * `CreateSnapshot` request with `VolumeId` injected from the bound
 * {@link Volume}.
 */
export interface CreateSnapshotRequest extends Omit<
  ec2.CreateSnapshotRequest,
  "VolumeId"
> {}

/**
 * Runtime binding for the `CreateSnapshot` operation scoped to the bound
 * {@link Volume} (IAM actions `ec2:CreateSnapshot` + `ec2:CreateTags` on the
 * volume ARN and the region-wide snapshot wildcard — snapshot creation
 * authorizes against both the source volume and the new snapshot).
 *
 * Creates a point-in-time EBS snapshot of the volume — e.g. a Lambda that
 * takes an application-consistent backup before a risky migration. The
 * snapshot is created `pending` and completes asynchronously. Provide the
 * implementation with `Effect.provide(AWS.EC2.CreateSnapshotHttp)`.
 * @binding
 * @section Volume Backups
 * @example Snapshot the bound volume
 * ```typescript
 * // init — bind the operation to the volume
 * const createSnapshot = yield* AWS.EC2.CreateSnapshot(volume);
 *
 * // runtime — take a point-in-time backup
 * const snapshot = yield* createSnapshot({
 *   Description: "pre-migration backup",
 * });
 * console.log(snapshot.SnapshotId, snapshot.State);
 * ```
 */
export interface CreateSnapshot extends Binding.Service<
  CreateSnapshot,
  "AWS.EC2.CreateSnapshot",
  (
    volume: Volume,
  ) => Effect.Effect<
    (
      request?: CreateSnapshotRequest,
    ) => Effect.Effect<ec2.Snapshot, ec2.CreateSnapshotError>
  >
> {}

export const CreateSnapshot = Binding.Service<CreateSnapshot>(
  "AWS.EC2.CreateSnapshot",
);
