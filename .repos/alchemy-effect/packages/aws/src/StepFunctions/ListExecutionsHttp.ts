import * as sfn from "@distilled.cloud/aws/sfn";
import * as Layer from "effect/Layer";
import { makeStateMachineArnHttpBinding } from "./BindingHttp.ts";
import { ListExecutions } from "./ListExecutions.ts";

export const ListExecutionsHttp = Layer.effect(
  ListExecutions,
  makeStateMachineArnHttpBinding({
    tag: "AWS.StepFunctions.ListExecutions",
    operation: sfn.listExecutions,
    actions: ["states:ListExecutions"],
  }),
);
