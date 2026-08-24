import type * as memorydb from "@distilled.cloud/aws/memorydb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DeleteSnapshot` operation (IAM action
 * `memorydb:DeleteSnapshot` on the snapshot ARN wildcard — snapshot names
 * are runtime data).
 *
 * Deletes a snapshot by name — e.g. pruning old on-demand backups from a
 * scheduled cleanup Lambda. Provide the implementation with
 * `Effect.provide(AWS.MemoryDB.DeleteSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Delete an Old Snapshot
 * ```typescript
 * const deleteSnapshot = yield* MemoryDB.DeleteSnapshot();
 *
 * yield* deleteSnapshot({ SnapshotName: "pre-migration" }).pipe(
 *   Effect.catchTag("SnapshotNotFoundFault", () => Effect.void),
 * );
 * ```
 */
export interface DeleteSnapshot extends Binding.Service<
  DeleteSnapshot,
  "AWS.MemoryDB.DeleteSnapshot",
  () => Effect.Effect<
    (
      request: memorydb.DeleteSnapshotRequest,
    ) => Effect.Effect<
      memorydb.DeleteSnapshotResponse,
      memorydb.DeleteSnapshotError
    >
  >
> {}
export const DeleteSnapshot = Binding.Service<DeleteSnapshot>(
  "AWS.MemoryDB.DeleteSnapshot",
);
