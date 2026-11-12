import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import * as Layer from "effect/Layer";
import { BatchCreateVehicle } from "./BatchCreateVehicle.ts";
import { makeFleetWiseAccountHttpBinding } from "./BindingHttp.ts";

export const BatchCreateVehicleHttp = Layer.effect(
  BatchCreateVehicle,
  makeFleetWiseAccountHttpBinding({
    tag: "AWS.IoTFleetWise.BatchCreateVehicle",
    operation: iotfleetwise.batchCreateVehicle,
    // The vehicle ARNs only exist after the call; iot:CreateThing /
    // iot:DescribeThing are dependent actions when the association
    // behavior auto-creates the backing IoT thing.
    actions: [
      "iotfleetwise:BatchCreateVehicle",
      "iotfleetwise:CreateVehicle",
      "iot:CreateThing",
      "iot:DescribeThing",
    ],
  }),
);
