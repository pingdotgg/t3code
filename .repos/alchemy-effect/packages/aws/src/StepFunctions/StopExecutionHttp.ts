import * as sfn from "@distilled.cloud/aws/sfn";
import * as Layer from "effect/Layer";
import { makeExecutionScopedHttpBinding } from "./BindingHttp.ts";
import { StopExecution } from "./StopExecution.ts";

export const StopExecutionHttp = Layer.effect(
  StopExecution,
  makeExecutionScopedHttpBinding({
    tag: "AWS.StepFunctions.StopExecution",
    operation: sfn.stopExecution,
    actions: ["states:StopExecution"],
  }),
);
