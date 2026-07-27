import type * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Vehicle } from "./Vehicle.ts";

/**
 * `GetVehicleStatus` request with `vehicleName` injected from the bound
 * vehicle.
 */
export interface GetVehicleStatusRequest extends Omit<
  iotfleetwise.GetVehicleStatusRequest,
  "vehicleName"
> {}

/**
 * Runtime binding for the `GetVehicleStatus` operation (IAM action
 * `iotfleetwise:GetVehicleStatus`), scoped to one {@link Vehicle}.
 *
 * Reads the deployment status of the campaigns, decoder manifests, and
 * state templates associated with the bound vehicle. Provide the
 * implementation with
 * `Effect.provide(AWS.IoTFleetWise.GetVehicleStatusHttp)`.
 *
 * @binding
 * @section Vehicle Status
 * @example Check Campaign Deployment on a Vehicle
 * ```typescript
 * const getVehicleStatus = yield* IoTFleetWise.GetVehicleStatus(vehicle);
 *
 * const status = yield* getVehicleStatus();
 * for (const campaign of status.campaigns ?? []) {
 *   console.log(campaign.campaignName, campaign.status);
 * }
 * ```
 */
export interface GetVehicleStatus extends Binding.Service<
  GetVehicleStatus,
  "AWS.IoTFleetWise.GetVehicleStatus",
  (
    vehicle: Vehicle,
  ) => Effect.Effect<
    (
      request?: GetVehicleStatusRequest,
    ) => Effect.Effect<
      iotfleetwise.GetVehicleStatusResponse,
      iotfleetwise.GetVehicleStatusError
    >
  >
> {}
export const GetVehicleStatus = Binding.Service<GetVehicleStatus>(
  "AWS.IoTFleetWise.GetVehicleStatus",
);
