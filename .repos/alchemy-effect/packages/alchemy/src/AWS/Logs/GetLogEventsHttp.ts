import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Layer from "effect/Layer";
import { makeLogGroupHttpBinding } from "./BindingHttp.ts";
import { GetLogEvents } from "./GetLogEvents.ts";

export const GetLogEventsHttp = Layer.effect(
  GetLogEvents,
  makeLogGroupHttpBinding({
    tag: "AWS.Logs.GetLogEvents",
    operation: Logs.getLogEvents,
    actions: ["logs:GetLogEvents"],
  }),
);
