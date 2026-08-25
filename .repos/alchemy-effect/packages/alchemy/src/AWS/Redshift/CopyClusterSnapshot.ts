import type * as redshift from "@distilled.cloud/aws/redshift";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `CopyClusterSnapshot` operation (IAM action
 * `redshift:CopyClusterSnapshot`).
 *
 * Copies an automated cluster snapshot to a manual one so it survives the
 * automated retention window — e.g. an archival job that preserves the
 * nightly snapshot before a risky migration. Provide the implementation with
 * `Effect.provide(AWS.Redshift.CopyClusterSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Preserve an Automated Snapshot
 * ```typescript
 * const copyClusterSnapshot = yield* AWS.Redshift.CopyClusterSnapshot();
 *
 * yield* copyClusterSnapshot({
 *   SourceSnapshotIdentifier: nightly.SnapshotIdentifier!,
 *   TargetSnapshotIdentifier: `archive-${runId}`,
 * });
 * ```
 */
export interface CopyClusterSnapshot extends Binding.Service<
  CopyClusterSnapshot,
  "AWS.Redshift.CopyClusterSnapshot",
  () => Effect.Effect<
    (
      request: redshift.CopyClusterSnapshotMessage,
    ) => Effect.Effect<
      redshift.CopyClusterSnapshotResult,
      redshift.CopyClusterSnapshotError
    >
  >
> {}
export const CopyClusterSnapshot = Binding.Service<CopyClusterSnapshot>(
  "AWS.Redshift.CopyClusterSnapshot",
);
