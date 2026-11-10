import * as sqs from "@distilled.cloud/aws/sqs";
import * as Layer from "effect/Layer";
import { makeQueueArnHttpBinding } from "./BindingHttp.ts";
import { ListMessageMoveTasks } from "./ListMessageMoveTasks.ts";

export const ListMessageMoveTasksHttp = Layer.effect(
  ListMessageMoveTasks,
  makeQueueArnHttpBinding({
    tag: "AWS.SQS.ListMessageMoveTasks",
    operation: sqs.listMessageMoveTasks,
    actions: ["sqs:ListMessageMoveTasks"],
  }),
);
