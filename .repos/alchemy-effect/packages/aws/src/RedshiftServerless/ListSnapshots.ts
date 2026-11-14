import type * as serverless from "@distilled.cloud/aws/redshift-serverless";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for the `ListSnapshots` operation (IAM actions
 * `redshift-serverless:ListSnapshots`).
 *
 * Lists snapshots in the account, optionally filtered by namespace or
 * time window — the discovery half of snapshot-rotation and DR tooling. Provide the implementation with
 * `Effect.provide(AWS.RedshiftServerless.ListSnapshotsHttp)`.
 * ### Managing Snapshots
 * **Example:** List Snapshots for a Namespace
 * ```typescript
 * // init — resolve the runtime client
 * const listSnapshots = yield* AWS.RedshiftServerless.ListSnapshots();
 *
 * const { snapshots } = yield* listSnapshots({ namespaceName });
 * ```
 *
 * @binding
 */
export interface ListSnapshots extends Binding.Service<
  ListSnapshots,
  "AWS.RedshiftServerless.ListSnapshots",
  () => Effect.Effect<
    (
      request?: serverless.ListSnapshotsRequest,
    ) => Effect.Effect<serverless.ListSnapshotsResponse, serverless.ListSnapshotsError>
  >
> {}
export const ListSnapshots = Binding.Service<ListSnapshots>("AWS.RedshiftServerless.ListSnapshots");
