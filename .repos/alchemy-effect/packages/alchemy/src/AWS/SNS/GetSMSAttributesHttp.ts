import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";
import { GetSMSAttributes } from "./GetSMSAttributes.ts";

export const GetSMSAttributesHttp = Layer.effect(
  GetSMSAttributes,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.GetSMSAttributes",
    operation: sns.getSMSAttributes,
    // SNS SMS preferences are backed by AWS End User Messaging — the read
    // fans out to `sms-voice:DescribeSpendLimits` (probe-verified).
    actions: ["sns:GetSMSAttributes", "sms-voice:DescribeSpendLimits"],
  }),
);
