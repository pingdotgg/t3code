import type * as ds from "@distilled.cloud/aws/directory-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Directory } from "./Directory.ts";

/**
 * Runtime binding for the `CreateSnapshot` operation (IAM action
 * `ds:CreateSnapshot`), scoped to one {@link Directory}.
 *
 * Takes a manual snapshot of the bound Simple AD or Managed Microsoft AD
 * directory — e.g. before a scheduled change — returning the new
 * `SnapshotId`. Manual snapshots are limited per directory (see
 * {@link GetSnapshotLimits}). The directory id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DirectoryService.CreateSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Snapshot the Directory Before a Change
 * ```typescript
 * // init — bind the operation to the directory
 * const createSnapshot = yield* AWS.DirectoryService.CreateSnapshot(directory);
 *
 * // runtime
 * const { SnapshotId } = yield* createSnapshot({ Name: "pre-migration" });
 * ```
 */
export interface CreateSnapshot extends Binding.Service<
  CreateSnapshot,
  "AWS.DirectoryService.CreateSnapshot",
  (
    directory: Directory,
  ) => Effect.Effect<
    (
      request?: Omit<ds.CreateSnapshotRequest, "DirectoryId">,
    ) => Effect.Effect<ds.CreateSnapshotResult, ds.CreateSnapshotError>
  >
> {}
export const CreateSnapshot = Binding.Service<CreateSnapshot>(
  "AWS.DirectoryService.CreateSnapshot",
);
