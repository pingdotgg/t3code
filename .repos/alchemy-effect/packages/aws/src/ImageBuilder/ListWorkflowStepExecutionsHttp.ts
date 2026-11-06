import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Layer from "effect/Layer";
import { makeImageBuilderAccountHttpBinding } from "./BindingHttp.ts";
import { ListWorkflowStepExecutions } from "./ListWorkflowStepExecutions.ts";

export const ListWorkflowStepExecutionsHttp = Layer.effect(
  ListWorkflowStepExecutions,
  makeImageBuilderAccountHttpBinding({
    tag: "AWS.ImageBuilder.ListWorkflowStepExecutions",
    operation: imagebuilder.listWorkflowStepExecutions,
    actions: ["imagebuilder:ListWorkflowStepExecutions"],
  }),
);
