import type * as serverless from "@distilled.cloud/aws/redshift-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetRecoveryPoint` operation (IAM actions
 * `redshift-serverless:GetRecoveryPoint`).
 *
 * Reads one automatic recovery point by id. Provide the implementation with
 * `Effect.provide(AWS.RedshiftServerless.GetRecoveryPointHttp)`.
 * @binding
 * @section Working with Recovery Points
 * @example Inspect a Recovery Point
 * ```typescript
 * // init — resolve the runtime client
 * const getRecoveryPoint = yield* AWS.RedshiftServerless.GetRecoveryPoint();
 *
 * const { recoveryPoint } = yield* getRecoveryPoint({ recoveryPointId });
 * ```
 */
export interface GetRecoveryPoint extends Binding.Service<
  GetRecoveryPoint,
  "AWS.RedshiftServerless.GetRecoveryPoint",
  () => Effect.Effect<
    (
      request: serverless.GetRecoveryPointRequest,
    ) => Effect.Effect<
      serverless.GetRecoveryPointResponse,
      serverless.GetRecoveryPointError
    >
  >
> {}
export const GetRecoveryPoint = Binding.Service<GetRecoveryPoint>(
  "AWS.RedshiftServerless.GetRecoveryPoint",
);
