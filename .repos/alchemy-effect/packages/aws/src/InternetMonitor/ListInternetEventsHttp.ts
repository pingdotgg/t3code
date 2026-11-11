import * as im from "@distilled.cloud/aws/internetmonitor";
import * as Layer from "effect/Layer";
import { makeInternetMonitorAccountHttpBinding } from "./BindingHttp.ts";
import { ListInternetEvents } from "./ListInternetEvents.ts";

export const ListInternetEventsHttp = Layer.effect(
  ListInternetEvents,
  makeInternetMonitorAccountHttpBinding({
    tag: "AWS.InternetMonitor.ListInternetEvents",
    operation: im.listInternetEvents,
    actions: ["internetmonitor:ListInternetEvents"],
  }),
);
