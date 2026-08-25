import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsTopicHttpBinding } from "./BindingHttp.ts";
import { GetTopicAttributes } from "./GetTopicAttributes.ts";

export const GetTopicAttributesHttp = Layer.effect(
  GetTopicAttributes,
  makeSnsTopicHttpBinding({
    tag: "AWS.SNS.GetTopicAttributes",
    operation: sns.getTopicAttributes,
    actions: ["sns:GetTopicAttributes"],
    key: "TopicArn",
  }),
);
