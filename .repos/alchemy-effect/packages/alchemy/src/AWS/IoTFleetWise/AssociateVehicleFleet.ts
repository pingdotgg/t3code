import type * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Fleet } from "./Fleet.ts";

/**
 * `AssociateVehicleFleet` request with `fleetId` injected from the bound
 * fleet.
 */
export interface AssociateVehicleFleetRequest extends Omit<
  iotfleetwise.AssociateVehicleFleetRequest,
  "fleetId"
> {}

/**
 * Runtime binding for the `AssociateVehicleFleet` operation (IAM action
 * `iotfleetwise:AssociateVehicleFleet`), scoped to one {@link Fleet}.
 *
 * Adds a vehicle to the bound fleet at runtime — e.g. a provisioning
 * Lambda enrolling freshly-registered vehicles. Provide the implementation
 * with `Effect.provide(AWS.IoTFleetWise.AssociateVehicleFleetHttp)`.
 *
 * @binding
 * @section Fleet Membership
 * @example Enroll a Vehicle into the Fleet
 * ```typescript
 * const associateVehicleFleet = yield* IoTFleetWise.AssociateVehicleFleet(fleet);
 *
 * yield* associateVehicleFleet({ vehicleName: "vin-1HGBH41JXMN109186" });
 * ```
 */
export interface AssociateVehicleFleet extends Binding.Service<
  AssociateVehicleFleet,
  "AWS.IoTFleetWise.AssociateVehicleFleet",
  (
    fleet: Fleet,
  ) => Effect.Effect<
    (
      request: AssociateVehicleFleetRequest,
    ) => Effect.Effect<
      iotfleetwise.AssociateVehicleFleetResponse,
      iotfleetwise.AssociateVehicleFleetError
    >
  >
> {}
export const AssociateVehicleFleet = Binding.Service<AssociateVehicleFleet>(
  "AWS.IoTFleetWise.AssociateVehicleFleet",
);
