import * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import * as Layer from "effect/Layer";
import { makeSmsVoicePhoneNumberHttpBinding } from "./BindingHttp.ts";
import { PutKeyword } from "./PutKeyword.ts";

export const PutKeywordHttp = Layer.effect(
  PutKeyword,
  makeSmsVoicePhoneNumberHttpBinding({
    tag: "AWS.PinpointSMSVoiceV2.PutKeyword",
    operation: smsvoice.putKeyword,
    actions: ["sms-voice:PutKeyword"],
  }),
);
