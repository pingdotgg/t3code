import * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import * as Layer from "effect/Layer";
import { makeSmsVoicePhoneNumberHttpBinding } from "./BindingHttp.ts";
import { SendVoiceMessage } from "./SendVoiceMessage.ts";

export const SendVoiceMessageHttp = Layer.effect(
  SendVoiceMessage,
  makeSmsVoicePhoneNumberHttpBinding({
    tag: "AWS.PinpointSMSVoiceV2.SendVoiceMessage",
    operation: smsvoice.sendVoiceMessage,
    actions: ["sms-voice:SendVoiceMessage"],
  }),
);
