import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";
import { ListSMSSandboxPhoneNumbers } from "./ListSMSSandboxPhoneNumbers.ts";

export const ListSMSSandboxPhoneNumbersHttp = Layer.effect(
  ListSMSSandboxPhoneNumbers,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.ListSMSSandboxPhoneNumbers",
    operation: sns.listSMSSandboxPhoneNumbers,
    actions: [
      "sns:ListSMSSandboxPhoneNumbers",
      "sms-voice:DescribeVerifiedDestinationNumbers",
    ],
  }),
);
