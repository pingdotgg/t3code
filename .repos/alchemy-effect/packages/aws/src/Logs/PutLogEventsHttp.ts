import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Layer from "effect/Layer";
import { makeLogGroupHttpBinding } from "./BindingHttp.ts";
import { PutLogEvents } from "./PutLogEvents.ts";

export const PutLogEventsHttp = Layer.effect(
  PutLogEvents,
  makeLogGroupHttpBinding({
    tag: "AWS.Logs.PutLogEvents",
    operation: Logs.putLogEvents,
    actions: ["logs:PutLogEvents"],
    // PutLogEvents authorizes against the log-stream resource
    // (`log-group:{name}:log-stream:{stream}`), covered by the `:*`
    // wildcard on the group ARN.
    iamResources: "streams",
  }),
);
