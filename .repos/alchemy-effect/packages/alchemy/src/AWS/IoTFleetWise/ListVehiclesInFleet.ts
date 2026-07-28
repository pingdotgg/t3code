import type * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Fleet } from "./Fleet.ts";

/**
 * `ListVehiclesInFleet` request with `fleetId` injected from the bound
 * fleet.
 */
export interface ListVehiclesInFleetRequest extends Omit<
  iotfleetwise.ListVehiclesInFleetRequest,
  "fleetId"
> {}

/**
 * Runtime binding for the `ListVehiclesInFleet` operation (IAM action
 * `iotfleetwise:ListVehiclesInFleet`), scoped to one {@link Fleet}.
 *
 * Lists the names of the vehicles associated with the bound fleet. Provide
 * the implementation with
 * `Effect.provide(AWS.IoTFleetWise.ListVehiclesInFleetHttp)`.
 *
 * @binding
 * @section Fleet Membership
 * @example List the Vehicles in a Fleet
 * ```typescript
 * const listVehiclesInFleet = yield* IoTFleetWise.ListVehiclesInFleet(fleet);
 *
 * const { vehicles } = yield* listVehiclesInFleet();
 * ```
 */
export interface ListVehiclesInFleet extends Binding.Service<
  ListVehiclesInFleet,
  "AWS.IoTFleetWise.ListVehiclesInFleet",
  (
    fleet: Fleet,
  ) => Effect.Effect<
    (
      request?: ListVehiclesInFleetRequest,
    ) => Effect.Effect<
      iotfleetwise.ListVehiclesInFleetResponse,
      iotfleetwise.ListVehiclesInFleetError
    >
  >
> {}
export const ListVehiclesInFleet = Binding.Service<ListVehiclesInFleet>(
  "AWS.IoTFleetWise.ListVehiclesInFleet",
);
