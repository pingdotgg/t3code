import type * as serverless from "@distilled.cloud/aws/redshift-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetSnapshot` operation (IAM actions
 * `redshift-serverless:GetSnapshot`).
 *
 * Reads one snapshot by name or ARN — e.g. polling a snapshot taken with
 * {@link CreateSnapshot} until its `status` reaches `AVAILABLE`. Provide the implementation with
 * `Effect.provide(AWS.RedshiftServerless.GetSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Poll a Snapshot Until Available
 * ```typescript
 * // init — resolve the runtime client
 * const getSnapshot = yield* AWS.RedshiftServerless.GetSnapshot();
 *
 * const { snapshot } = yield* getSnapshot({ snapshotName: "pre-migration-1" });
 * // snapshot?.status -> "CREATING" | "AVAILABLE" | ...
 * ```
 */
export interface GetSnapshot extends Binding.Service<
  GetSnapshot,
  "AWS.RedshiftServerless.GetSnapshot",
  () => Effect.Effect<
    (
      request: serverless.GetSnapshotRequest,
    ) => Effect.Effect<
      serverless.GetSnapshotResponse,
      serverless.GetSnapshotError
    >
  >
> {}
export const GetSnapshot = Binding.Service<GetSnapshot>(
  "AWS.RedshiftServerless.GetSnapshot",
);
