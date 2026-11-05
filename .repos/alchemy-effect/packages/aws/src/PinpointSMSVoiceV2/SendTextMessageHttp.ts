import * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import * as Layer from "effect/Layer";
import { makeSmsVoicePhoneNumberHttpBinding } from "./BindingHttp.ts";
import { SendTextMessage } from "./SendTextMessage.ts";

export const SendTextMessageHttp = Layer.effect(
  SendTextMessage,
  makeSmsVoicePhoneNumberHttpBinding({
    tag: "AWS.PinpointSMSVoiceV2.SendTextMessage",
    operation: smsvoice.sendTextMessage,
    actions: ["sms-voice:SendTextMessage"],
  }),
);
