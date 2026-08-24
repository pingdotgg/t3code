import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteSMSSandboxPhoneNumber } from "./DeleteSMSSandboxPhoneNumber.ts";

export const DeleteSMSSandboxPhoneNumberHttp = Layer.effect(
  DeleteSMSSandboxPhoneNumber,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.DeleteSMSSandboxPhoneNumber",
    operation: sns.deleteSMSSandboxPhoneNumber,
    actions: [
      "sns:DeleteSMSSandboxPhoneNumber",
      "sms-voice:DeleteVerifiedDestinationNumber",
    ],
  }),
);
