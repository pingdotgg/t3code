import * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Layer from "effect/Layer";
import { makeContactChannelHttpBinding } from "./BindingHttp.ts";
import { SendActivationCode } from "./SendActivationCode.ts";

export const SendActivationCodeHttp = Layer.effect(
  SendActivationCode,
  makeContactChannelHttpBinding({
    tag: "AWS.SSMContacts.SendActivationCode",
    operation: ssm.sendActivationCode,
    actions: ["ssm-contacts:SendActivationCode"],
  }),
);
