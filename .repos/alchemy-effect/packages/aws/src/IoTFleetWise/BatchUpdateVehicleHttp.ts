import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import * as Layer from "effect/Layer";
import { BatchUpdateVehicle } from "./BatchUpdateVehicle.ts";
import { makeFleetWiseAccountHttpBinding } from "./BindingHttp.ts";

export const BatchUpdateVehicleHttp = Layer.effect(
  BatchUpdateVehicle,
  makeFleetWiseAccountHttpBinding({
    tag: "AWS.IoTFleetWise.BatchUpdateVehicle",
    operation: iotfleetwise.batchUpdateVehicle,
    // The vehicle names are runtime arguments, so the grant is the
    // account-wide vehicle pattern.
    actions: ["iotfleetwise:BatchUpdateVehicle", "iotfleetwise:UpdateVehicle"],
    resources: ["arn:aws:iotfleetwise:*:*:vehicle/*"],
  }),
);
