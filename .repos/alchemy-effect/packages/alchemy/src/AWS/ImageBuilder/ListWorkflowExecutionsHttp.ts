import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Layer from "effect/Layer";
import { makeImageBuilderAccountHttpBinding } from "./BindingHttp.ts";
import { ListWorkflowExecutions } from "./ListWorkflowExecutions.ts";

export const ListWorkflowExecutionsHttp = Layer.effect(
  ListWorkflowExecutions,
  makeImageBuilderAccountHttpBinding({
    tag: "AWS.ImageBuilder.ListWorkflowExecutions",
    operation: imagebuilder.listWorkflowExecutions,
    actions: ["imagebuilder:ListWorkflowExecutions"],
  }),
);
