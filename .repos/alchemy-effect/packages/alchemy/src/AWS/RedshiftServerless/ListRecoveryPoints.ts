import type * as serverless from "@distilled.cloud/aws/redshift-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListRecoveryPoints` operation (IAM actions
 * `redshift-serverless:ListRecoveryPoints`).
 *
 * Lists the automatic recovery points Redshift Serverless created in the
 * last 24 hours, optionally filtered by namespace — the discovery half of
 * point-in-time recovery tooling. Provide the implementation with
 * `Effect.provide(AWS.RedshiftServerless.ListRecoveryPointsHttp)`.
 * @binding
 * @section Working with Recovery Points
 * @example List Recovery Points for a Namespace
 * ```typescript
 * // init — resolve the runtime client
 * const listRecoveryPoints = yield* AWS.RedshiftServerless.ListRecoveryPoints();
 *
 * const { recoveryPoints } = yield* listRecoveryPoints({ namespaceName });
 * ```
 */
export interface ListRecoveryPoints extends Binding.Service<
  ListRecoveryPoints,
  "AWS.RedshiftServerless.ListRecoveryPoints",
  () => Effect.Effect<
    (
      request?: serverless.ListRecoveryPointsRequest,
    ) => Effect.Effect<
      serverless.ListRecoveryPointsResponse,
      serverless.ListRecoveryPointsError
    >
  >
> {}
export const ListRecoveryPoints = Binding.Service<ListRecoveryPoints>(
  "AWS.RedshiftServerless.ListRecoveryPoints",
);
