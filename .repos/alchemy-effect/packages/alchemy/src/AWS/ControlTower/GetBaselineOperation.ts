import type * as controltower from "@distilled.cloud/aws/controltower";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `controltower:GetBaselineOperation`.
 *
 * An account-level operation that reads the status of an asynchronous
 * baseline operation (`ENABLE_BASELINE`, `DISABLE_BASELINE`,
 * `UPDATE_ENABLED_BASELINE`, `RESET_ENABLED_BASELINE`). Pair it with
 * {@link ResetEnabledBaseline} to poll a drift-remediation run to
 * completion. Provide the implementation with
 * `Effect.provide(AWS.ControlTower.GetBaselineOperationHttp)`.
 * @binding
 * @section Polling Asynchronous Operations
 * @example Poll a Baseline Operation
 * ```typescript
 * // init — account-level binding takes no resource
 * const getBaselineOperation = yield* AWS.ControlTower.GetBaselineOperation();
 *
 * // runtime
 * const { baselineOperation } = yield* getBaselineOperation({
 *   operationIdentifier,
 * });
 * console.log(baselineOperation.status);
 * ```
 */
export interface GetBaselineOperation extends Binding.Service<
  GetBaselineOperation,
  "AWS.ControlTower.GetBaselineOperation",
  () => Effect.Effect<
    (
      request: controltower.GetBaselineOperationInput,
    ) => Effect.Effect<
      controltower.GetBaselineOperationOutput,
      controltower.GetBaselineOperationError
    >
  >
> {}

export const GetBaselineOperation = Binding.Service<GetBaselineOperation>(
  "AWS.ControlTower.GetBaselineOperation",
);
