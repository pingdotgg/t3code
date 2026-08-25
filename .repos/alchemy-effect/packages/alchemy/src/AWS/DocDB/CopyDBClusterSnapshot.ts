import type * as docdb from "@distilled.cloud/aws/docdb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `CopyDBClusterSnapshot` operation (IAM action
 * `rds:CopyDBClusterSnapshot` — DocumentDB shares the RDS control plane).
 *
 * Copies a DocumentDB cluster snapshot — to a new name, another KMS key, or
 * (with a pre-signed URL) another region — the core of snapshot fan-out and
 * DR automation. Source and target identifiers are runtime data, so the
 * grant spans the account's `cluster-snapshot` ARNs. Provide the
 * implementation with `Effect.provide(AWS.DocDB.CopyDBClusterSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Copy a Snapshot to an Archive Name
 * ```typescript
 * const copySnapshot = yield* DocDB.CopyDBClusterSnapshot();
 *
 * yield* copySnapshot({
 *   SourceDBClusterSnapshotIdentifier: "nightly-2026-07-15",
 *   TargetDBClusterSnapshotIdentifier: "archive-2026-07-15",
 * });
 * ```
 */
export interface CopyDBClusterSnapshot extends Binding.Service<
  CopyDBClusterSnapshot,
  "AWS.DocDB.CopyDBClusterSnapshot",
  () => Effect.Effect<
    (
      request: docdb.CopyDBClusterSnapshotMessage,
    ) => Effect.Effect<
      docdb.CopyDBClusterSnapshotResult,
      docdb.CopyDBClusterSnapshotError
    >
  >
> {}
export const CopyDBClusterSnapshot = Binding.Service<CopyDBClusterSnapshot>(
  "AWS.DocDB.CopyDBClusterSnapshot",
);
