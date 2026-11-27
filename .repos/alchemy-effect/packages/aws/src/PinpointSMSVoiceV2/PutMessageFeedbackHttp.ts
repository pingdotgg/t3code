import * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import * as Layer from "effect/Layer";
import { makeSmsVoiceAccountHttpBinding } from "./BindingHttp.ts";
import { PutMessageFeedback } from "./PutMessageFeedback.ts";

export const PutMessageFeedbackHttp = Layer.effect(
  PutMessageFeedback,
  makeSmsVoiceAccountHttpBinding({
    tag: "AWS.PinpointSMSVoiceV2.PutMessageFeedback",
    operation: smsvoice.putMessageFeedback,
    actions: ["sms-voice:PutMessageFeedback"],
  }),
);
