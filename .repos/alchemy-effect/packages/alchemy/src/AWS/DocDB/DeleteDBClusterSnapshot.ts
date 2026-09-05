import type * as docdb from "@distilled.cloud/aws/docdb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DeleteDBClusterSnapshot` operation (IAM action
 * `rds:DeleteDBClusterSnapshot` — DocumentDB shares the RDS control plane).
 *
 * Deletes a DocumentDB cluster snapshot by identifier — the retention half
 * of snapshot-rotation automation (create nightly, prune the oldest).
 * Snapshot identifiers are runtime data, so the grant spans the account's
 * `cluster-snapshot` ARNs. Provide the implementation with
 * `Effect.provide(AWS.DocDB.DeleteDBClusterSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Prune an Expired Snapshot
 * ```typescript
 * const deleteSnapshot = yield* DocDB.DeleteDBClusterSnapshot();
 *
 * yield* deleteSnapshot({
 *   DBClusterSnapshotIdentifier: "nightly-2026-06-01",
 * }).pipe(
 *   // already gone — rotation is idempotent
 *   Effect.catchTag("DBClusterSnapshotNotFoundFault", () => Effect.void),
 * );
 * ```
 */
export interface DeleteDBClusterSnapshot extends Binding.Service<
  DeleteDBClusterSnapshot,
  "AWS.DocDB.DeleteDBClusterSnapshot",
  () => Effect.Effect<
    (
      request: docdb.DeleteDBClusterSnapshotMessage,
    ) => Effect.Effect<
      docdb.DeleteDBClusterSnapshotResult,
      docdb.DeleteDBClusterSnapshotError
    >
  >
> {}
export const DeleteDBClusterSnapshot = Binding.Service<DeleteDBClusterSnapshot>(
  "AWS.DocDB.DeleteDBClusterSnapshot",
);
