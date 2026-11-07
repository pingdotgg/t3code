import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsSubscriptionHttpBinding } from "./BindingHttp.ts";
import { GetSubscriptionAttributes } from "./GetSubscriptionAttributes.ts";

export const GetSubscriptionAttributesHttp = Layer.effect(
  GetSubscriptionAttributes,
  makeSnsSubscriptionHttpBinding({
    tag: "AWS.SNS.GetSubscriptionAttributes",
    operation: sns.getSubscriptionAttributes,
    actions: ["sns:GetSubscriptionAttributes"],
    key: "SubscriptionArn",
  }),
);
