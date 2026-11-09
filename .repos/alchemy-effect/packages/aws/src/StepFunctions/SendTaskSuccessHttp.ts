import * as sfn from "@distilled.cloud/aws/sfn";
import * as Layer from "effect/Layer";
import { makeTaskCallbackHttpBinding } from "./BindingHttp.ts";
import { SendTaskSuccess } from "./SendTaskSuccess.ts";

export const SendTaskSuccessHttp = Layer.effect(
  SendTaskSuccess,
  makeTaskCallbackHttpBinding({
    tag: "AWS.StepFunctions.SendTaskSuccess",
    operation: sfn.sendTaskSuccess,
    actions: ["states:SendTaskSuccess"],
  }),
);
