import * as im from "@distilled.cloud/aws/internetmonitor";
import * as Layer from "effect/Layer";
import { makeInternetMonitorMonitorHttpBinding } from "./BindingHttp.ts";
import { ListHealthEvents } from "./ListHealthEvents.ts";

export const ListHealthEventsHttp = Layer.effect(
  ListHealthEvents,
  makeInternetMonitorMonitorHttpBinding({
    tag: "AWS.InternetMonitor.ListHealthEvents",
    operation: im.listHealthEvents,
    actions: ["internetmonitor:ListHealthEvents"],
  }),
);
