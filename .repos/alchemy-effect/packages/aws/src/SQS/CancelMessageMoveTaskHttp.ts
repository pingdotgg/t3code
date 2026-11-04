import * as sqs from "@distilled.cloud/aws/sqs";
import * as Layer from "effect/Layer";
import { makeQueueGrantHttpBinding } from "./BindingHttp.ts";
import { CancelMessageMoveTask } from "./CancelMessageMoveTask.ts";

export const CancelMessageMoveTaskHttp = Layer.effect(
  CancelMessageMoveTask,
  // The request identifies the task by `TaskHandle` only; the bound queue
  // exists purely to scope the IAM grant to the redrive source.
  makeQueueGrantHttpBinding({
    tag: "AWS.SQS.CancelMessageMoveTask",
    operation: sqs.cancelMessageMoveTask,
    actions: ["sqs:CancelMessageMoveTask"],
  }),
);
