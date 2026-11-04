import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";
import { CreateSMSSandboxPhoneNumber } from "./CreateSMSSandboxPhoneNumber.ts";

export const CreateSMSSandboxPhoneNumberHttp = Layer.effect(
  CreateSMSSandboxPhoneNumber,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.CreateSMSSandboxPhoneNumber",
    operation: sns.createSMSSandboxPhoneNumber,
    // Registering a sandbox number creates a verified destination number
    // and sends the OTP text via End User Messaging (probe-verified).
    actions: [
      "sns:CreateSMSSandboxPhoneNumber",
      "sms-voice:CreateVerifiedDestinationNumber",
      "sms-voice:SendDestinationNumberVerificationCode",
      "sms-voice:SendTextMessage",
    ],
  }),
);
