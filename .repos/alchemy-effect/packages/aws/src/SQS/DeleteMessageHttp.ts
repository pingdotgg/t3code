import * as sqs from "@distilled.cloud/aws/sqs";
import * as Layer from "effect/Layer";
import { makeQueueUrlHttpBinding } from "./BindingHttp.ts";
import { DeleteMessage } from "./DeleteMessage.ts";

export const DeleteMessageHttp = Layer.effect(
  DeleteMessage,
  makeQueueUrlHttpBinding({
    tag: "AWS.SQS.DeleteMessage",
    operation: sqs.deleteMessage,
    actions: ["sqs:DeleteMessage"],
  }),
);
