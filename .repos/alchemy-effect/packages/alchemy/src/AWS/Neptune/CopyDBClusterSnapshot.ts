import type * as neptune from "@distilled.cloud/aws/neptune";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `CopyDBClusterSnapshot` operation (IAM action
 * `rds:CopyDBClusterSnapshot`).
 *
 * Copies a Neptune cluster snapshot — e.g. archive a nightly snapshot under
 * a retention prefix, or copy it for cross-region disaster recovery. Provide
 * the implementation with
 * `Effect.provide(AWS.Neptune.CopyDBClusterSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Archive a Snapshot
 * ```typescript
 * const copyDBClusterSnapshot = yield* AWS.Neptune.CopyDBClusterSnapshot();
 *
 * yield* copyDBClusterSnapshot({
 *   SourceDBClusterSnapshotIdentifier: snapshotId,
 *   TargetDBClusterSnapshotIdentifier: `${snapshotId}-archive`,
 * });
 * ```
 */
export interface CopyDBClusterSnapshot extends Binding.Service<
  CopyDBClusterSnapshot,
  "AWS.Neptune.CopyDBClusterSnapshot",
  () => Effect.Effect<
    (
      request?: neptune.CopyDBClusterSnapshotMessage,
    ) => Effect.Effect<
      neptune.CopyDBClusterSnapshotResult,
      neptune.CopyDBClusterSnapshotError
    >
  >
> {}
export const CopyDBClusterSnapshot = Binding.Service<CopyDBClusterSnapshot>(
  "AWS.Neptune.CopyDBClusterSnapshot",
);
