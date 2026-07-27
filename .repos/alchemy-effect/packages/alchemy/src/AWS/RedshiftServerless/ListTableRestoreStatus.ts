import type * as serverless from "@distilled.cloud/aws/redshift-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListTableRestoreStatus` operation (IAM actions
 * `redshift-serverless:ListTableRestoreStatus`).
 *
 * Lists table-restore requests, optionally filtered by namespace or
 * workgroup. Provide the implementation with
 * `Effect.provide(AWS.RedshiftServerless.ListTableRestoreStatusHttp)`.
 * @binding
 * @section Restoring Data
 * @example List Table Restores for a Namespace
 * ```typescript
 * // init — resolve the runtime client
 * const listTableRestoreStatus = yield* AWS.RedshiftServerless.ListTableRestoreStatus();
 *
 * const { tableRestoreStatuses } = yield* listTableRestoreStatus({ namespaceName });
 * ```
 */
export interface ListTableRestoreStatus extends Binding.Service<
  ListTableRestoreStatus,
  "AWS.RedshiftServerless.ListTableRestoreStatus",
  () => Effect.Effect<
    (
      request?: serverless.ListTableRestoreStatusRequest,
    ) => Effect.Effect<
      serverless.ListTableRestoreStatusResponse,
      serverless.ListTableRestoreStatusError
    >
  >
> {}
export const ListTableRestoreStatus = Binding.Service<ListTableRestoreStatus>(
  "AWS.RedshiftServerless.ListTableRestoreStatus",
);
