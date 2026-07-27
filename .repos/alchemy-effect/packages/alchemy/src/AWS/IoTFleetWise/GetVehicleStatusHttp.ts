import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import * as Layer from "effect/Layer";
import { makeFleetWiseResourceHttpBinding } from "./BindingHttp.ts";
import { GetVehicleStatus } from "./GetVehicleStatus.ts";
import type { Vehicle } from "./Vehicle.ts";

export const GetVehicleStatusHttp = Layer.effect(
  GetVehicleStatus,
  makeFleetWiseResourceHttpBinding({
    tag: "AWS.IoTFleetWise.GetVehicleStatus",
    operation: iotfleetwise.getVehicleStatus,
    actions: ["iotfleetwise:GetVehicleStatus"],
    requestKey: "vehicleName",
    identifier: (vehicle: Vehicle) => vehicle.vehicleName,
    // GetVehicleStatus authorizes on both the vehicle and its associated
    // campaigns — the campaign ARNs are unknowable at deploy time.
    resources: (vehicle: Vehicle) => [
      vehicle.vehicleArn,
      "arn:aws:iotfleetwise:*:*:campaign/*",
    ],
  }),
);
