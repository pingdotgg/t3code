import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import * as Layer from "effect/Layer";
import { AssociateVehicleFleet } from "./AssociateVehicleFleet.ts";
import { makeFleetWiseResourceHttpBinding } from "./BindingHttp.ts";
import type { Fleet } from "./Fleet.ts";

export const AssociateVehicleFleetHttp = Layer.effect(
  AssociateVehicleFleet,
  makeFleetWiseResourceHttpBinding({
    tag: "AWS.IoTFleetWise.AssociateVehicleFleet",
    operation: iotfleetwise.associateVehicleFleet,
    actions: ["iotfleetwise:AssociateVehicleFleet"],
    requestKey: "fleetId",
    identifier: (fleet: Fleet) => fleet.fleetId,
    // The action authorizes on both the fleet and the vehicle; the vehicle
    // is a runtime argument, so its grant is the account-wide pattern.
    resources: (fleet: Fleet) => [
      fleet.fleetArn,
      "arn:aws:iotfleetwise:*:*:vehicle/*",
    ],
  }),
);
