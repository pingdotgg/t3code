import type * as rds from "@distilled.cloud/aws/rds";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `CopyDBClusterSnapshot` operation (IAM actions
 * `rds:CopyDBClusterSnapshot` +
 * `rds:AddTagsToResource`).
 *
 * Copies an Aurora cluster snapshot (e.g. to archive it under a new
 * identifier or re-encrypt with a different KMS key). Provide the implementation with
 * `Effect.provide(AWS.RDS.CopyDBClusterSnapshotHttp)`.
 * @binding
 * @section Managing Cluster Snapshots
 * @example Archive a Cluster Snapshot
 * ```typescript
 * const copyDBClusterSnapshot = yield* AWS.RDS.CopyDBClusterSnapshot();
 *
 * yield* copyDBClusterSnapshot({
 *   SourceDBClusterSnapshotIdentifier: snapshotId,
 *   TargetDBClusterSnapshotIdentifier: `archive-${snapshotId}`,
 * });
 * ```
 */
export interface CopyDBClusterSnapshot extends Binding.Service<
  CopyDBClusterSnapshot,
  "AWS.RDS.CopyDBClusterSnapshot",
  () => Effect.Effect<
    (
      request: rds.CopyDBClusterSnapshotMessage,
    ) => Effect.Effect<
      rds.CopyDBClusterSnapshotResult,
      rds.CopyDBClusterSnapshotError
    >
  >
> {}
export const CopyDBClusterSnapshot = Binding.Service<CopyDBClusterSnapshot>(
  "AWS.RDS.CopyDBClusterSnapshot",
);
