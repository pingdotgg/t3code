import type * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Fleet } from "./Fleet.ts";

/**
 * `DisassociateVehicleFleet` request with `fleetId` injected from the bound
 * fleet.
 */
export interface DisassociateVehicleFleetRequest extends Omit<
  iotfleetwise.DisassociateVehicleFleetRequest,
  "fleetId"
> {}

/**
 * Runtime binding for the `DisassociateVehicleFleet` operation (IAM action
 * `iotfleetwise:DisassociateVehicleFleet`), scoped to one {@link Fleet}.
 *
 * Removes a vehicle from the bound fleet at runtime. Provide the
 * implementation with
 * `Effect.provide(AWS.IoTFleetWise.DisassociateVehicleFleetHttp)`.
 *
 * @binding
 * @section Fleet Membership
 * @example Remove a Vehicle from the Fleet
 * ```typescript
 * const disassociateVehicleFleet =
 *   yield* IoTFleetWise.DisassociateVehicleFleet(fleet);
 *
 * yield* disassociateVehicleFleet({ vehicleName: "vin-1HGBH41JXMN109186" });
 * ```
 */
export interface DisassociateVehicleFleet extends Binding.Service<
  DisassociateVehicleFleet,
  "AWS.IoTFleetWise.DisassociateVehicleFleet",
  (
    fleet: Fleet,
  ) => Effect.Effect<
    (
      request: DisassociateVehicleFleetRequest,
    ) => Effect.Effect<
      iotfleetwise.DisassociateVehicleFleetResponse,
      iotfleetwise.DisassociateVehicleFleetError
    >
  >
> {}
export const DisassociateVehicleFleet =
  Binding.Service<DisassociateVehicleFleet>(
    "AWS.IoTFleetWise.DisassociateVehicleFleet",
  );
