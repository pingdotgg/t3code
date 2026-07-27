import type * as serverless from "@distilled.cloud/aws/redshift-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListSnapshots` operation (IAM actions
 * `redshift-serverless:ListSnapshots`).
 *
 * Lists snapshots in the account, optionally filtered by namespace or
 * time window — the discovery half of snapshot-rotation and DR tooling. Provide the implementation with
 * `Effect.provide(AWS.RedshiftServerless.ListSnapshotsHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example List Snapshots for a Namespace
 * ```typescript
 * // init — resolve the runtime client
 * const listSnapshots = yield* AWS.RedshiftServerless.ListSnapshots();
 *
 * const { snapshots } = yield* listSnapshots({ namespaceName });
 * ```
 */
export interface ListSnapshots extends Binding.Service<
  ListSnapshots,
  "AWS.RedshiftServerless.ListSnapshots",
  () => Effect.Effect<
    (
      request?: serverless.ListSnapshotsRequest,
    ) => Effect.Effect<
      serverless.ListSnapshotsResponse,
      serverless.ListSnapshotsError
    >
  >
> {}
export const ListSnapshots = Binding.Service<ListSnapshots>(
  "AWS.RedshiftServerless.ListSnapshots",
);
