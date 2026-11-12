import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationTrackerHttpBinding } from "./BindingHttp.ts";
import { GetDevicePositionHistory } from "./GetDevicePositionHistory.ts";

export const GetDevicePositionHistoryHttp = Layer.effect(
  GetDevicePositionHistory,
  makeLocationTrackerHttpBinding({
    tag: "AWS.Location.GetDevicePositionHistory",
    operation: location.getDevicePositionHistory,
    actions: ["geo:GetDevicePositionHistory"],
  }),
);
