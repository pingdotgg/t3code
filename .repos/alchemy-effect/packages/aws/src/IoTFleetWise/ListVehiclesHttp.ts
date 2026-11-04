import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import * as Layer from "effect/Layer";
import { makeFleetWiseAccountHttpBinding } from "./BindingHttp.ts";
import { ListVehicles } from "./ListVehicles.ts";

export const ListVehiclesHttp = Layer.effect(
  ListVehicles,
  makeFleetWiseAccountHttpBinding({
    tag: "AWS.IoTFleetWise.ListVehicles",
    operation: iotfleetwise.listVehicles,
    actions: ["iotfleetwise:ListVehicles"],
  }),
);
