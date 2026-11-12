import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Layer from "effect/Layer";
import { makeImageBuilderAccountHttpBinding } from "./BindingHttp.ts";
import { ListWaitingWorkflowSteps } from "./ListWaitingWorkflowSteps.ts";

export const ListWaitingWorkflowStepsHttp = Layer.effect(
  ListWaitingWorkflowSteps,
  makeImageBuilderAccountHttpBinding({
    tag: "AWS.ImageBuilder.ListWaitingWorkflowSteps",
    operation: imagebuilder.listWaitingWorkflowSteps,
    actions: ["imagebuilder:ListWaitingWorkflowSteps"],
  }),
);
