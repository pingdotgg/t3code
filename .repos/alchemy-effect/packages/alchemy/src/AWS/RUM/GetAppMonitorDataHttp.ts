import * as rum from "@distilled.cloud/aws/rum";
import * as Layer from "effect/Layer";
import { makeRumAppMonitorHttpBinding } from "./BindingHttp.ts";
import { GetAppMonitorData } from "./GetAppMonitorData.ts";

export const GetAppMonitorDataHttp = Layer.effect(
  GetAppMonitorData,
  makeRumAppMonitorHttpBinding({
    tag: "AWS.RUM.GetAppMonitorData",
    operation: rum.getAppMonitorData,
    actions: ["rum:GetAppMonitorData"],
  }),
);
