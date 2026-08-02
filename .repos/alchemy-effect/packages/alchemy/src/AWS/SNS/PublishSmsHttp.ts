import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";
import { PublishSms } from "./PublishSms.ts";

export const PublishSmsHttp = Layer.effect(
  PublishSms,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.PublishSms",
    operation: sns.publish,
    // Direct SMS delivery is backed by `sms-voice:SendTextMessage`
    // (probe-verified).
    actions: ["sns:Publish", "sms-voice:SendTextMessage"],
  }),
);
