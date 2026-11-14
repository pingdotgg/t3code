import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Layer from "effect/Layer";
import { makeLogGroupHttpBinding } from "./BindingHttp.ts";
import { FilterLogEvents } from "./FilterLogEvents.ts";

export const FilterLogEventsHttp = Layer.effect(
  FilterLogEvents,
  makeLogGroupHttpBinding({
    tag: "AWS.Logs.FilterLogEvents",
    operation: Logs.filterLogEvents,
    actions: ["logs:FilterLogEvents"],
  }),
);
