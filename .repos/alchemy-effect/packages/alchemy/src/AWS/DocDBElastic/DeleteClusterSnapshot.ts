import type * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DeleteClusterSnapshot` operation (IAM action
 * `docdb-elastic:DeleteClusterSnapshot`).
 *
 * Deletes a manual elastic-cluster snapshot by ARN — e.g. from a Lambda that
 * prunes on-demand backups past a retention horizon. Provide the
 * implementation with
 * `Effect.provide(AWS.DocDBElastic.DeleteClusterSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Prune an Old Snapshot
 * ```typescript
 * const deleteSnapshot = yield* DocDBElastic.DeleteClusterSnapshot();
 *
 * const result = yield* deleteSnapshot({ snapshotArn });
 * // result.snapshot.status → "DELETING"
 * ```
 */
export interface DeleteClusterSnapshot extends Binding.Service<
  DeleteClusterSnapshot,
  "AWS.DocDBElastic.DeleteClusterSnapshot",
  () => Effect.Effect<
    (
      request: docdbelastic.DeleteClusterSnapshotInput,
    ) => Effect.Effect<
      docdbelastic.DeleteClusterSnapshotOutput,
      docdbelastic.DeleteClusterSnapshotError
    >
  >
> {}
export const DeleteClusterSnapshot = Binding.Service<DeleteClusterSnapshot>(
  "AWS.DocDBElastic.DeleteClusterSnapshot",
);
