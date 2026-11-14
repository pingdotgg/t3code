import * as sqs from "@distilled.cloud/aws/sqs";
import * as Layer from "effect/Layer";
import { makeQueueUrlHttpBinding } from "./BindingHttp.ts";
import { DeleteMessageBatch } from "./DeleteMessageBatch.ts";

export const DeleteMessageBatchHttp = Layer.effect(
  DeleteMessageBatch,
  makeQueueUrlHttpBinding({
    tag: "AWS.SQS.DeleteMessageBatch",
    operation: sqs.deleteMessageBatch,
    // Batch entries are authorized by the singular action.
    actions: ["sqs:DeleteMessage"],
  }),
);
