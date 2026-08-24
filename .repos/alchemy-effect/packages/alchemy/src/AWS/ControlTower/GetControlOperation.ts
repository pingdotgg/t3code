import type * as controltower from "@distilled.cloud/aws/controltower";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `controltower:GetControlOperation`.
 *
 * An account-level operation that reads the status of an asynchronous
 * control operation (`ENABLE_CONTROL`, `DISABLE_CONTROL`,
 * `UPDATE_ENABLED_CONTROL`, `RESET_ENABLED_CONTROL`). Pair it with
 * {@link ResetEnabledControl} to poll a drift-remediation run to
 * completion. Provide the implementation with
 * `Effect.provide(AWS.ControlTower.GetControlOperationHttp)`.
 * @binding
 * @section Polling Asynchronous Operations
 * @example Poll a Control Operation
 * ```typescript
 * // init — account-level binding takes no resource
 * const getControlOperation = yield* AWS.ControlTower.GetControlOperation();
 *
 * // runtime
 * const { controlOperation } = yield* getControlOperation({
 *   operationIdentifier,
 * });
 * console.log(controlOperation.status);
 * ```
 */
export interface GetControlOperation extends Binding.Service<
  GetControlOperation,
  "AWS.ControlTower.GetControlOperation",
  () => Effect.Effect<
    (
      request: controltower.GetControlOperationInput,
    ) => Effect.Effect<
      controltower.GetControlOperationOutput,
      controltower.GetControlOperationError
    >
  >
> {}

export const GetControlOperation = Binding.Service<GetControlOperation>(
  "AWS.ControlTower.GetControlOperation",
);
