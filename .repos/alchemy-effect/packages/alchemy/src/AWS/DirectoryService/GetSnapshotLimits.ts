import type * as ds from "@distilled.cloud/aws/directory-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Directory } from "./Directory.ts";

/**
 * Runtime binding for the `GetSnapshotLimits` operation (IAM action
 * `ds:GetSnapshotLimits`), scoped to one {@link Directory}.
 *
 * Reads the bound directory's manual snapshot limits — how many manual
 * snapshots exist versus the allowed maximum — so a backup function can
 * prune before taking a new snapshot. The directory id is injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.DirectoryService.GetSnapshotLimitsHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Check the Manual Snapshot Quota
 * ```typescript
 * // init — bind the operation to the directory
 * const getSnapshotLimits = yield* AWS.DirectoryService.GetSnapshotLimits(directory);
 *
 * // runtime
 * const { SnapshotLimits } = yield* getSnapshotLimits();
 * if (SnapshotLimits?.ManualSnapshotsLimitReached) {
 *   yield* Effect.logWarning("manual snapshot limit reached");
 * }
 * ```
 */
export interface GetSnapshotLimits extends Binding.Service<
  GetSnapshotLimits,
  "AWS.DirectoryService.GetSnapshotLimits",
  (
    directory: Directory,
  ) => Effect.Effect<
    () => Effect.Effect<ds.GetSnapshotLimitsResult, ds.GetSnapshotLimitsError>
  >
> {}
export const GetSnapshotLimits = Binding.Service<GetSnapshotLimits>(
  "AWS.DirectoryService.GetSnapshotLimits",
);
