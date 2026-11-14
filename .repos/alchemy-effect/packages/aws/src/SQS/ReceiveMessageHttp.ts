import * as sqs from "@distilled.cloud/aws/sqs";
import * as Layer from "effect/Layer";
import { makeQueueUrlHttpBinding } from "./BindingHttp.ts";
import { ReceiveMessage } from "./ReceiveMessage.ts";

export const ReceiveMessageHttp = Layer.effect(
  ReceiveMessage,
  makeQueueUrlHttpBinding({
    tag: "AWS.SQS.ReceiveMessage",
    operation: sqs.receiveMessage,
    actions: ["sqs:ReceiveMessage"],
  }),
);
