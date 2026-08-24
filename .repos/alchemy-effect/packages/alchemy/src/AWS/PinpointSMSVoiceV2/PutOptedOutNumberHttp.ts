import * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import * as Layer from "effect/Layer";
import { makeSmsVoiceOptOutListHttpBinding } from "./BindingHttp.ts";
import { PutOptedOutNumber } from "./PutOptedOutNumber.ts";

export const PutOptedOutNumberHttp = Layer.effect(
  PutOptedOutNumber,
  makeSmsVoiceOptOutListHttpBinding({
    tag: "AWS.PinpointSMSVoiceV2.PutOptedOutNumber",
    operation: smsvoice.putOptedOutNumber,
    actions: ["sms-voice:PutOptedOutNumber"],
  }),
);
