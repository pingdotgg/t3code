import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsTopicHttpBinding } from "./BindingHttp.ts";
import { PublishBatch } from "./PublishBatch.ts";

export const PublishBatchHttp = Layer.effect(
  PublishBatch,
  makeSnsTopicHttpBinding({
    tag: "AWS.SNS.PublishBatch",
    operation: sns.publishBatch,
    actions: ["sns:Publish"],
    key: "TopicArn",
  }),
);
