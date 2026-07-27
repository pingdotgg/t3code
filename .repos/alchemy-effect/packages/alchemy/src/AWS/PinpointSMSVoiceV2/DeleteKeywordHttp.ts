import * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import * as Layer from "effect/Layer";
import { makeSmsVoicePhoneNumberHttpBinding } from "./BindingHttp.ts";
import { DeleteKeyword } from "./DeleteKeyword.ts";

export const DeleteKeywordHttp = Layer.effect(
  DeleteKeyword,
  makeSmsVoicePhoneNumberHttpBinding({
    tag: "AWS.PinpointSMSVoiceV2.DeleteKeyword",
    operation: smsvoice.deleteKeyword,
    actions: ["sms-voice:DeleteKeyword"],
  }),
);
