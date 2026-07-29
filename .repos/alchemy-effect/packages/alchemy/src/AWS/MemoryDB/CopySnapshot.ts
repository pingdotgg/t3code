import type * as memorydb from "@distilled.cloud/aws/memorydb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `CopySnapshot` operation (IAM actions
 * `memorydb:CopySnapshot` + `memorydb:TagResource` on the snapshot ARN
 * wildcard — snapshot names are runtime data).
 *
 * Makes a copy of an existing snapshot, optionally exporting it to an S3
 * bucket via `TargetBucket`. Provide the implementation with
 * `Effect.provide(AWS.MemoryDB.CopySnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Copy a Snapshot
 * ```typescript
 * const copySnapshot = yield* MemoryDB.CopySnapshot();
 *
 * const result = yield* copySnapshot({
 *   SourceSnapshotName: "pre-migration",
 *   TargetSnapshotName: "pre-migration-archive",
 * });
 * // result.Snapshot.Status → "creating"
 * ```
 */
export interface CopySnapshot extends Binding.Service<
  CopySnapshot,
  "AWS.MemoryDB.CopySnapshot",
  () => Effect.Effect<
    (
      request: memorydb.CopySnapshotRequest,
    ) => Effect.Effect<
      memorydb.CopySnapshotResponse,
      memorydb.CopySnapshotError
    >
  >
> {}
export const CopySnapshot = Binding.Service<CopySnapshot>(
  "AWS.MemoryDB.CopySnapshot",
);
