import type * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListVehicles` operation (IAM action
 * `iotfleetwise:ListVehicles`), account-level.
 *
 * Lists the vehicles in the account, optionally filtered by model
 * manifest or attribute values. Provide the implementation with
 * `Effect.provide(AWS.IoTFleetWise.ListVehiclesHttp)`.
 *
 * @binding
 * @section Provisioning Vehicles
 * @example List Vehicles by Attribute
 * ```typescript
 * const listVehicles = yield* IoTFleetWise.ListVehicles();
 *
 * const { vehicleSummaries } = yield* listVehicles({
 *   attributeNames: ["Vehicle.Color"],
 *   attributeValues: ["red"],
 * });
 * ```
 */
export interface ListVehicles extends Binding.Service<
  ListVehicles,
  "AWS.IoTFleetWise.ListVehicles",
  () => Effect.Effect<
    (
      request?: iotfleetwise.ListVehiclesRequest,
    ) => Effect.Effect<
      iotfleetwise.ListVehiclesResponse,
      iotfleetwise.ListVehiclesError
    >
  >
> {}
export const ListVehicles = Binding.Service<ListVehicles>(
  "AWS.IoTFleetWise.ListVehicles",
);
