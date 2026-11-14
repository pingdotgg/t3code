import * as sfn from "@distilled.cloud/aws/sfn";
import * as Layer from "effect/Layer";
import { makeTaskCallbackHttpBinding } from "./BindingHttp.ts";
import { SendTaskFailure } from "./SendTaskFailure.ts";

export const SendTaskFailureHttp = Layer.effect(
  SendTaskFailure,
  makeTaskCallbackHttpBinding({
    tag: "AWS.StepFunctions.SendTaskFailure",
    operation: sfn.sendTaskFailure,
    actions: ["states:SendTaskFailure"],
  }),
);
