import type * as controltower from "@distilled.cloud/aws/controltower";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `controltower:GetLandingZoneOperation`.
 *
 * An account-level operation that reads the status of an asynchronous
 * landing zone operation (`CREATE`, `UPDATE`, `DELETE`, `RESET`). Pair it
 * with {@link ResetLandingZone} to poll a drift-remediation run to
 * completion. Provide the implementation with
 * `Effect.provide(AWS.ControlTower.GetLandingZoneOperationHttp)`.
 * @binding
 * @section Polling Asynchronous Operations
 * @example Poll a Landing Zone Operation
 * ```typescript
 * // init — account-level binding takes no resource
 * const getLandingZoneOperation =
 *   yield* AWS.ControlTower.GetLandingZoneOperation();
 *
 * // runtime
 * const { operationDetails } = yield* getLandingZoneOperation({
 *   operationIdentifier,
 * });
 * console.log(operationDetails.status);
 * ```
 */
export interface GetLandingZoneOperation extends Binding.Service<
  GetLandingZoneOperation,
  "AWS.ControlTower.GetLandingZoneOperation",
  () => Effect.Effect<
    (
      request: controltower.GetLandingZoneOperationInput,
    ) => Effect.Effect<
      controltower.GetLandingZoneOperationOutput,
      controltower.GetLandingZoneOperationError
    >
  >
> {}

export const GetLandingZoneOperation = Binding.Service<GetLandingZoneOperation>(
  "AWS.ControlTower.GetLandingZoneOperation",
);
