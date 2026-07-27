import type * as ds from "@distilled.cloud/aws/directory-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Directory } from "./Directory.ts";

/**
 * Runtime binding for the `DescribeSnapshots` operation (IAM action
 * `ds:DescribeSnapshots`), scoped to one {@link Directory}.
 *
 * Lists the bound directory's snapshots — id, type (`Auto`/`Manual`),
 * status, and start time. The directory id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DirectoryService.DescribeSnapshotsHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example List the Directory's Snapshots
 * ```typescript
 * // init — bind the operation to the directory
 * const describeSnapshots = yield* AWS.DirectoryService.DescribeSnapshots(directory);
 *
 * // runtime
 * const { Snapshots } = yield* describeSnapshots();
 * for (const snapshot of Snapshots ?? []) {
 *   console.log(snapshot.SnapshotId, snapshot.Status);
 * }
 * ```
 */
export interface DescribeSnapshots extends Binding.Service<
  DescribeSnapshots,
  "AWS.DirectoryService.DescribeSnapshots",
  (
    directory: Directory,
  ) => Effect.Effect<
    (
      request?: Omit<ds.DescribeSnapshotsRequest, "DirectoryId">,
    ) => Effect.Effect<ds.DescribeSnapshotsResult, ds.DescribeSnapshotsError>
  >
> {}
export const DescribeSnapshots = Binding.Service<DescribeSnapshots>(
  "AWS.DirectoryService.DescribeSnapshots",
);
