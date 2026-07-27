import * as sfn from "@distilled.cloud/aws/sfn";
import * as Layer from "effect/Layer";
import { makeExecutionScopedHttpBinding } from "./BindingHttp.ts";
import { GetExecutionHistory } from "./GetExecutionHistory.ts";

export const GetExecutionHistoryHttp = Layer.effect(
  GetExecutionHistory,
  makeExecutionScopedHttpBinding({
    tag: "AWS.StepFunctions.GetExecutionHistory",
    operation: sfn.getExecutionHistory,
    actions: ["states:GetExecutionHistory"],
  }),
);
