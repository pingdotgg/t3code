import type * as serverless from "@distilled.cloud/aws/redshift-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `UpdateSnapshot` operation (IAM actions
 * `redshift-serverless:UpdateSnapshot`).
 *
 * Changes a snapshot's retention period — e.g. extending retention on a
 * snapshot that an audit flagged for preservation. Provide the implementation with
 * `Effect.provide(AWS.RedshiftServerless.UpdateSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Extend a Snapshot's Retention
 * ```typescript
 * // init — resolve the runtime client
 * const updateSnapshot = yield* AWS.RedshiftServerless.UpdateSnapshot();
 *
 * yield* updateSnapshot({ snapshotName: "pre-migration-1", retentionPeriod: 30 });
 * ```
 */
export interface UpdateSnapshot extends Binding.Service<
  UpdateSnapshot,
  "AWS.RedshiftServerless.UpdateSnapshot",
  () => Effect.Effect<
    (
      request: serverless.UpdateSnapshotRequest,
    ) => Effect.Effect<
      serverless.UpdateSnapshotResponse,
      serverless.UpdateSnapshotError
    >
  >
> {}
export const UpdateSnapshot = Binding.Service<UpdateSnapshot>(
  "AWS.RedshiftServerless.UpdateSnapshot",
);
