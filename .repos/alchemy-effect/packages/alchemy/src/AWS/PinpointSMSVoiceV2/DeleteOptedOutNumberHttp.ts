import * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import * as Layer from "effect/Layer";
import { makeSmsVoiceOptOutListHttpBinding } from "./BindingHttp.ts";
import { DeleteOptedOutNumber } from "./DeleteOptedOutNumber.ts";

export const DeleteOptedOutNumberHttp = Layer.effect(
  DeleteOptedOutNumber,
  makeSmsVoiceOptOutListHttpBinding({
    tag: "AWS.PinpointSMSVoiceV2.DeleteOptedOutNumber",
    operation: smsvoice.deleteOptedOutNumber,
    actions: ["sms-voice:DeleteOptedOutNumber"],
  }),
);
