import * as sqs from "@distilled.cloud/aws/sqs";
import * as Layer from "effect/Layer";
import { makeQueueUrlHttpBinding } from "./BindingHttp.ts";
import { ListDeadLetterSourceQueues } from "./ListDeadLetterSourceQueues.ts";

export const ListDeadLetterSourceQueuesHttp = Layer.effect(
  ListDeadLetterSourceQueues,
  makeQueueUrlHttpBinding({
    tag: "AWS.SQS.ListDeadLetterSourceQueues",
    operation: sqs.listDeadLetterSourceQueues,
    actions: ["sqs:ListDeadLetterSourceQueues"],
  }),
);
