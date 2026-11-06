import * as transfer from "@distilled.cloud/aws/transfer";
import * as Layer from "effect/Layer";
import { makeTransferAccountHttpBinding } from "./BindingHttp.ts";
import { SendWorkflowStepState } from "./SendWorkflowStepState.ts";

export const SendWorkflowStepStateHttp = Layer.effect(
  SendWorkflowStepState,
  makeTransferAccountHttpBinding({
    tag: "AWS.Transfer.SendWorkflowStepState",
    operation: transfer.sendWorkflowStepState,
    actions: ["transfer:SendWorkflowStepState"],
  }),
);
