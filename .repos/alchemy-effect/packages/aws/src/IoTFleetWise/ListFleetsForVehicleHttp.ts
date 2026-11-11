import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import * as Layer from "effect/Layer";
import { makeFleetWiseResourceHttpBinding } from "./BindingHttp.ts";
import { ListFleetsForVehicle } from "./ListFleetsForVehicle.ts";
import type { Vehicle } from "./Vehicle.ts";

export const ListFleetsForVehicleHttp = Layer.effect(
  ListFleetsForVehicle,
  makeFleetWiseResourceHttpBinding({
    tag: "AWS.IoTFleetWise.ListFleetsForVehicle",
    operation: iotfleetwise.listFleetsForVehicle,
    actions: ["iotfleetwise:ListFleetsForVehicle"],
    requestKey: "vehicleName",
    identifier: (vehicle: Vehicle) => vehicle.vehicleName,
    resources: (vehicle: Vehicle) => [vehicle.vehicleArn],
  }),
);
