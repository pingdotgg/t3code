import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationTrackerHttpBinding } from "./BindingHttp.ts";
import { GetDevicePosition } from "./GetDevicePosition.ts";

export const GetDevicePositionHttp = Layer.effect(
  GetDevicePosition,
  makeLocationTrackerHttpBinding({
    tag: "AWS.Location.GetDevicePosition",
    operation: location.getDevicePosition,
    actions: ["geo:GetDevicePosition"],
  }),
);
