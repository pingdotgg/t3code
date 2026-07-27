import type * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `CopyClusterSnapshot` operation (IAM actions
 * `docdb-elastic:CopyClusterSnapshot` + `docdb-elastic:TagResource`).
 *
 * Copies an elastic-cluster snapshot — e.g. re-encrypting under a different
 * KMS key or fanning a nightly backup out under a retention-tagged name.
 * Provide the implementation with
 * `Effect.provide(AWS.DocDBElastic.CopyClusterSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Copy a Snapshot Under a New Name
 * ```typescript
 * const copySnapshot = yield* DocDBElastic.CopyClusterSnapshot();
 *
 * const result = yield* copySnapshot({
 *   snapshotArn,
 *   targetSnapshotName: "weekly-archive",
 *   copyTags: true,
 * });
 * // result.snapshot.snapshotName → "weekly-archive"
 * ```
 */
export interface CopyClusterSnapshot extends Binding.Service<
  CopyClusterSnapshot,
  "AWS.DocDBElastic.CopyClusterSnapshot",
  () => Effect.Effect<
    (
      request: docdbelastic.CopyClusterSnapshotInput,
    ) => Effect.Effect<
      docdbelastic.CopyClusterSnapshotOutput,
      docdbelastic.CopyClusterSnapshotError
    >
  >
> {}
export const CopyClusterSnapshot = Binding.Service<CopyClusterSnapshot>(
  "AWS.DocDBElastic.CopyClusterSnapshot",
);
