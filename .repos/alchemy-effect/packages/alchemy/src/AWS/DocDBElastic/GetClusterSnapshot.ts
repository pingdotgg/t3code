import type * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetClusterSnapshot` operation (IAM action
 * `docdb-elastic:GetClusterSnapshot`).
 *
 * Reads one elastic-cluster snapshot by ARN — status, source cluster, and
 * the network/encryption configuration captured at snapshot time. Snapshot
 * ARNs embed server-generated UUIDs and are runtime data, so the grant spans
 * the account's snapshots. Provide the implementation with
 * `Effect.provide(AWS.DocDBElastic.GetClusterSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Poll a Snapshot Until Available
 * ```typescript
 * const getSnapshot = yield* DocDBElastic.GetClusterSnapshot();
 *
 * const result = yield* getSnapshot({ snapshotArn });
 * // result.snapshot.status → "AVAILABLE"
 * ```
 */
export interface GetClusterSnapshot extends Binding.Service<
  GetClusterSnapshot,
  "AWS.DocDBElastic.GetClusterSnapshot",
  () => Effect.Effect<
    (
      request: docdbelastic.GetClusterSnapshotInput,
    ) => Effect.Effect<
      docdbelastic.GetClusterSnapshotOutput,
      docdbelastic.GetClusterSnapshotError
    >
  >
> {}
export const GetClusterSnapshot = Binding.Service<GetClusterSnapshot>(
  "AWS.DocDBElastic.GetClusterSnapshot",
);
