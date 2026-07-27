import type * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Vehicle } from "./Vehicle.ts";

/**
 * `ListFleetsForVehicle` request with `vehicleName` injected from the bound
 * vehicle.
 */
export interface ListFleetsForVehicleRequest extends Omit<
  iotfleetwise.ListFleetsForVehicleRequest,
  "vehicleName"
> {}

/**
 * Runtime binding for the `ListFleetsForVehicle` operation (IAM action
 * `iotfleetwise:ListFleetsForVehicle`), scoped to one {@link Vehicle}.
 *
 * Lists the IDs of the fleets the bound vehicle belongs to. Provide the
 * implementation with
 * `Effect.provide(AWS.IoTFleetWise.ListFleetsForVehicleHttp)`.
 *
 * @binding
 * @section Fleet Membership
 * @example List the Fleets a Vehicle Belongs To
 * ```typescript
 * const listFleetsForVehicle = yield* IoTFleetWise.ListFleetsForVehicle(vehicle);
 *
 * const { fleets } = yield* listFleetsForVehicle();
 * ```
 */
export interface ListFleetsForVehicle extends Binding.Service<
  ListFleetsForVehicle,
  "AWS.IoTFleetWise.ListFleetsForVehicle",
  (
    vehicle: Vehicle,
  ) => Effect.Effect<
    (
      request?: ListFleetsForVehicleRequest,
    ) => Effect.Effect<
      iotfleetwise.ListFleetsForVehicleResponse,
      iotfleetwise.ListFleetsForVehicleError
    >
  >
> {}
export const ListFleetsForVehicle = Binding.Service<ListFleetsForVehicle>(
  "AWS.IoTFleetWise.ListFleetsForVehicle",
);
