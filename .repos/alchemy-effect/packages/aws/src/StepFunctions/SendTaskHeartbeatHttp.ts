import * as sfn from "@distilled.cloud/aws/sfn";
import * as Layer from "effect/Layer";
import { makeTaskCallbackHttpBinding } from "./BindingHttp.ts";
import { SendTaskHeartbeat } from "./SendTaskHeartbeat.ts";

export const SendTaskHeartbeatHttp = Layer.effect(
  SendTaskHeartbeat,
  makeTaskCallbackHttpBinding({
    tag: "AWS.StepFunctions.SendTaskHeartbeat",
    operation: sfn.sendTaskHeartbeat,
    actions: ["states:SendTaskHeartbeat"],
  }),
);
