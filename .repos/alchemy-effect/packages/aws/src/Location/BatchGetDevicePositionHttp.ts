import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { BatchGetDevicePosition } from "./BatchGetDevicePosition.ts";
import { makeLocationTrackerHttpBinding } from "./BindingHttp.ts";

export const BatchGetDevicePositionHttp = Layer.effect(
  BatchGetDevicePosition,
  makeLocationTrackerHttpBinding({
    tag: "AWS.Location.BatchGetDevicePosition",
    operation: location.batchGetDevicePosition,
    actions: ["geo:BatchGetDevicePosition"],
  }),
);
