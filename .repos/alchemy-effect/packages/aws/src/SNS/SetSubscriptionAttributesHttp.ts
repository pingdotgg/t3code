import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsSubscriptionHttpBinding } from "./BindingHttp.ts";
import { SetSubscriptionAttributes } from "./SetSubscriptionAttributes.ts";

export const SetSubscriptionAttributesHttp = Layer.effect(
  SetSubscriptionAttributes,
  makeSnsSubscriptionHttpBinding({
    tag: "AWS.SNS.SetSubscriptionAttributes",
    operation: sns.setSubscriptionAttributes,
    actions: ["sns:SetSubscriptionAttributes"],
    key: "SubscriptionArn",
  }),
);
