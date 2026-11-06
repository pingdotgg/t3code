import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";
import { SetSMSAttributes } from "./SetSMSAttributes.ts";

export const SetSMSAttributesHttp = Layer.effect(
  SetSMSAttributes,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.SetSMSAttributes",
    operation: sns.setSMSAttributes,
    // Spend-limit updates fan out to AWS End User Messaging.
    actions: [
      "sns:SetSMSAttributes",
      "sms-voice:DescribeSpendLimits",
      "sms-voice:SetTextMessageSpendLimitOverride",
    ],
  }),
);
