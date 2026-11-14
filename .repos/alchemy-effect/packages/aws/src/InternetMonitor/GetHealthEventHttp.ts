import * as im from "@distilled.cloud/aws/internetmonitor";
import * as Layer from "effect/Layer";
import { makeInternetMonitorMonitorHttpBinding } from "./BindingHttp.ts";
import { GetHealthEvent } from "./GetHealthEvent.ts";

export const GetHealthEventHttp = Layer.effect(
  GetHealthEvent,
  makeInternetMonitorMonitorHttpBinding({
    tag: "AWS.InternetMonitor.GetHealthEvent",
    operation: im.getHealthEvent,
    actions: ["internetmonitor:GetHealthEvent"],
  }),
);
