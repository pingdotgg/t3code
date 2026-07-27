import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationTrackerHttpBinding } from "./BindingHttp.ts";
import { BatchUpdateDevicePosition } from "./BatchUpdateDevicePosition.ts";

export const BatchUpdateDevicePositionHttp = Layer.effect(
  BatchUpdateDevicePosition,
  makeLocationTrackerHttpBinding({
    tag: "AWS.Location.BatchUpdateDevicePosition",
    operation: location.batchUpdateDevicePosition,
    actions: ["geo:BatchUpdateDevicePosition"],
  }),
);
