import * as im from "@distilled.cloud/aws/internetmonitor";
import * as Layer from "effect/Layer";
import { makeInternetMonitorMonitorHttpBinding } from "./BindingHttp.ts";
import { StartQuery } from "./StartQuery.ts";

export const StartQueryHttp = Layer.effect(
  StartQuery,
  makeInternetMonitorMonitorHttpBinding({
    tag: "AWS.InternetMonitor.StartQuery",
    operation: im.startQuery,
    actions: ["internetmonitor:StartQuery"],
  }),
);
