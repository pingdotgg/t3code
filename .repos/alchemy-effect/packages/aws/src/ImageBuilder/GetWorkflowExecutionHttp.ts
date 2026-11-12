import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Layer from "effect/Layer";
import { makeImageBuilderAccountHttpBinding } from "./BindingHttp.ts";
import { GetWorkflowExecution } from "./GetWorkflowExecution.ts";

export const GetWorkflowExecutionHttp = Layer.effect(
  GetWorkflowExecution,
  makeImageBuilderAccountHttpBinding({
    tag: "AWS.ImageBuilder.GetWorkflowExecution",
    operation: imagebuilder.getWorkflowExecution,
    actions: ["imagebuilder:GetWorkflowExecution"],
  }),
);
