import * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import * as Layer from "effect/Layer";
import { makeSmsVoicePhoneNumberHttpBinding } from "./BindingHttp.ts";
import { DescribeKeywords } from "./DescribeKeywords.ts";

export const DescribeKeywordsHttp = Layer.effect(
  DescribeKeywords,
  makeSmsVoicePhoneNumberHttpBinding({
    tag: "AWS.PinpointSMSVoiceV2.DescribeKeywords",
    operation: smsvoice.describeKeywords,
    actions: ["sms-voice:DescribeKeywords"],
  }),
);
