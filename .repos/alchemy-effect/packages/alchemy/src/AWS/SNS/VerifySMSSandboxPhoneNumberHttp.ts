import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";
import { VerifySMSSandboxPhoneNumber } from "./VerifySMSSandboxPhoneNumber.ts";

export const VerifySMSSandboxPhoneNumberHttp = Layer.effect(
  VerifySMSSandboxPhoneNumber,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.VerifySMSSandboxPhoneNumber",
    operation: sns.verifySMSSandboxPhoneNumber,
    actions: [
      "sns:VerifySMSSandboxPhoneNumber",
      "sms-voice:VerifyDestinationNumber",
    ],
  }),
);
