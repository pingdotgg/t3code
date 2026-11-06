import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { BatchUpdateDevicePosition } from "./BatchUpdateDevicePosition.ts";
import { makeLocationTrackerHttpBinding } from "./BindingHttp.ts";

export const BatchUpdateDevicePositionHttp = Layer.effect(
  BatchUpdateDevicePosition,
  makeLocationTrackerHttpBinding({
    tag: "AWS.Location.BatchUpdateDevicePosition",
    operation: location.batchUpdateDevicePosition,
    actions: ["geo:BatchUpdateDevicePosition"],
  }),
);
