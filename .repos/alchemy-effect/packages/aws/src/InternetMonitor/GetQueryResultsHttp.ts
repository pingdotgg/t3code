import * as im from "@distilled.cloud/aws/internetmonitor";
import * as Layer from "effect/Layer";
import { makeInternetMonitorMonitorHttpBinding } from "./BindingHttp.ts";
import { GetQueryResults } from "./GetQueryResults.ts";

export const GetQueryResultsHttp = Layer.effect(
  GetQueryResults,
  makeInternetMonitorMonitorHttpBinding({
    tag: "AWS.InternetMonitor.GetQueryResults",
    operation: im.getQueryResults,
    actions: ["internetmonitor:GetQueryResults"],
  }),
);
