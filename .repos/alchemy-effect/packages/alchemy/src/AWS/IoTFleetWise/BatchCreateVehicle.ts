import type * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `BatchCreateVehicle` operation (IAM action
 * `iotfleetwise:BatchCreateVehicle`), account-level.
 *
 * Creates up to 10 vehicles in one call — the data plane of vehicle
 * provisioning pipelines (each item names its model and decoder manifest).
 * Per-item failures are returned in the response `errors` list, not the
 * error channel. Provide the implementation with
 * `Effect.provide(AWS.IoTFleetWise.BatchCreateVehicleHttp)`.
 *
 * @binding
 * @section Provisioning Vehicles
 * @example Provision a Batch of Vehicles
 * ```typescript
 * const batchCreateVehicle = yield* IoTFleetWise.BatchCreateVehicle();
 *
 * const { vehicles, errors } = yield* batchCreateVehicle({
 *   vehicles: [
 *     {
 *       vehicleName: "vin-1HGBH41JXMN109186",
 *       modelManifestArn,
 *       decoderManifestArn,
 *     },
 *   ],
 * });
 * ```
 */
export interface BatchCreateVehicle extends Binding.Service<
  BatchCreateVehicle,
  "AWS.IoTFleetWise.BatchCreateVehicle",
  () => Effect.Effect<
    (
      request: iotfleetwise.BatchCreateVehicleRequest,
    ) => Effect.Effect<
      iotfleetwise.BatchCreateVehicleResponse,
      iotfleetwise.BatchCreateVehicleError
    >
  >
> {}
export const BatchCreateVehicle = Binding.Service<BatchCreateVehicle>(
  "AWS.IoTFleetWise.BatchCreateVehicle",
);
