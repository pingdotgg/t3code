import * as im from "@distilled.cloud/aws/internetmonitor";
import * as Layer from "effect/Layer";
import { makeInternetMonitorAccountHttpBinding } from "./BindingHttp.ts";
import { GetInternetEvent } from "./GetInternetEvent.ts";

export const GetInternetEventHttp = Layer.effect(
  GetInternetEvent,
  makeInternetMonitorAccountHttpBinding({
    tag: "AWS.InternetMonitor.GetInternetEvent",
    operation: im.getInternetEvent,
    actions: ["internetmonitor:GetInternetEvent"],
  }),
);
