import * as sfn from "@distilled.cloud/aws/sfn";
import * as Layer from "effect/Layer";
import { makeStateMachineArnHttpBinding } from "./BindingHttp.ts";
import { StartExecution } from "./StartExecution.ts";

export const StartExecutionHttp = Layer.effect(
  StartExecution,
  makeStateMachineArnHttpBinding({
    tag: "AWS.StepFunctions.StartExecution",
    operation: sfn.startExecution,
    actions: ["states:StartExecution"],
  }),
);
