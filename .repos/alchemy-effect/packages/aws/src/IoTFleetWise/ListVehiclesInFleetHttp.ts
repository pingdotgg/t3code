import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import * as Layer from "effect/Layer";
import { makeFleetWiseResourceHttpBinding } from "./BindingHttp.ts";
import type { Fleet } from "./Fleet.ts";
import { ListVehiclesInFleet } from "./ListVehiclesInFleet.ts";

export const ListVehiclesInFleetHttp = Layer.effect(
  ListVehiclesInFleet,
  makeFleetWiseResourceHttpBinding({
    tag: "AWS.IoTFleetWise.ListVehiclesInFleet",
    operation: iotfleetwise.listVehiclesInFleet,
    actions: ["iotfleetwise:ListVehiclesInFleet"],
    requestKey: "fleetId",
    identifier: (fleet: Fleet) => fleet.fleetId,
    resources: (fleet: Fleet) => [fleet.fleetArn],
  }),
);
