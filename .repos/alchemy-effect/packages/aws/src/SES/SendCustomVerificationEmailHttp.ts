import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Layer from "effect/Layer";
import { makeVerificationScopedHttpBinding } from "./BindingHttp.ts";
import { SendCustomVerificationEmail } from "./SendCustomVerificationEmail.ts";

export const SendCustomVerificationEmailHttp = Layer.effect(
  SendCustomVerificationEmail,
  makeVerificationScopedHttpBinding({
    tag: "AWS.SES.SendCustomVerificationEmail",
    operation: sesv2.sendCustomVerificationEmail,
    actions: ["ses:SendCustomVerificationEmail"],
  }),
);
