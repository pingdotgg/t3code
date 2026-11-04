import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationTrackerHttpBinding } from "./BindingHttp.ts";
import { ListDevicePositions } from "./ListDevicePositions.ts";

export const ListDevicePositionsHttp = Layer.effect(
  ListDevicePositions,
  makeLocationTrackerHttpBinding({
    tag: "AWS.Location.ListDevicePositions",
    operation: location.listDevicePositions,
    actions: ["geo:ListDevicePositions"],
  }),
);
