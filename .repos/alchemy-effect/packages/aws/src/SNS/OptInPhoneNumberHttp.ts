import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";
import { OptInPhoneNumber } from "./OptInPhoneNumber.ts";

export const OptInPhoneNumberHttp = Layer.effect(
  OptInPhoneNumber,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.OptInPhoneNumber",
    operation: sns.optInPhoneNumber,
    // Opting a number back in deletes it from the End User Messaging
    // opted-out list (probe-verified).
    actions: ["sns:OptInPhoneNumber", "sms-voice:DeleteOptedOutNumber"],
  }),
);
