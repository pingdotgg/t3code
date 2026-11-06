import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsTopicHttpBinding } from "./BindingHttp.ts";
import { ListSubscriptionsByTopic } from "./ListSubscriptionsByTopic.ts";

export const ListSubscriptionsByTopicHttp = Layer.effect(
  ListSubscriptionsByTopic,
  makeSnsTopicHttpBinding({
    tag: "AWS.SNS.ListSubscriptionsByTopic",
    operation: sns.listSubscriptionsByTopic,
    actions: ["sns:ListSubscriptionsByTopic"],
    key: "TopicArn",
  }),
);
