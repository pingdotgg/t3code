import type * as rds from "@distilled.cloud/aws/rds";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `CopyDBSnapshot` operation (IAM actions
 * `rds:CopyDBSnapshot` +
 * `rds:AddTagsToResource`).
 *
 * Copies a DB instance snapshot (e.g. to archive it under a new
 * identifier or re-encrypt with a different KMS key). Provide the implementation with
 * `Effect.provide(AWS.RDS.CopyDBSnapshotHttp)`.
 * @binding
 * @section Managing Instance Snapshots
 * @example Archive an Instance Snapshot
 * ```typescript
 * const copyDBSnapshot = yield* AWS.RDS.CopyDBSnapshot();
 *
 * yield* copyDBSnapshot({
 *   SourceDBSnapshotIdentifier: snapshotId,
 *   TargetDBSnapshotIdentifier: `archive-${snapshotId}`,
 * });
 * ```
 */
export interface CopyDBSnapshot extends Binding.Service<
  CopyDBSnapshot,
  "AWS.RDS.CopyDBSnapshot",
  () => Effect.Effect<
    (
      request: rds.CopyDBSnapshotMessage,
    ) => Effect.Effect<rds.CopyDBSnapshotResult, rds.CopyDBSnapshotError>
  >
> {}
export const CopyDBSnapshot = Binding.Service<CopyDBSnapshot>(
  "AWS.RDS.CopyDBSnapshot",
);
