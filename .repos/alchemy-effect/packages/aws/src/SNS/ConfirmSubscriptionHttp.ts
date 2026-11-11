import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsSubscriptionHttpBinding } from "./BindingHttp.ts";
import { ConfirmSubscription } from "./ConfirmSubscription.ts";

export const ConfirmSubscriptionHttp = Layer.effect(
  ConfirmSubscription,
  makeSnsSubscriptionHttpBinding({
    tag: "AWS.SNS.ConfirmSubscription",
    operation: sns.confirmSubscription,
    actions: ["sns:ConfirmSubscription"],
    key: "TopicArn",
  }),
);
