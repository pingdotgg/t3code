import * as im from "@distilled.cloud/aws/internetmonitor";
import * as Layer from "effect/Layer";
import { makeInternetMonitorMonitorHttpBinding } from "./BindingHttp.ts";
import { StopQuery } from "./StopQuery.ts";

export const StopQueryHttp = Layer.effect(
  StopQuery,
  makeInternetMonitorMonitorHttpBinding({
    tag: "AWS.InternetMonitor.StopQuery",
    operation: im.stopQuery,
    actions: ["internetmonitor:StopQuery"],
  }),
);
