import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Layer from "effect/Layer";
import { makeSendScopedHttpBinding } from "./BindingHttp.ts";
import { SendEmail } from "./SendEmail.ts";

export const SendEmailHttp = Layer.effect(
  SendEmail,
  makeSendScopedHttpBinding({
    tag: "AWS.SES.SendEmail",
    operation: sesv2.sendEmail,
    actions: [
      "ses:SendEmail",
      "ses:SendRawEmail",
      "ses:SendTemplatedEmail",
      "ses:SendBulkTemplatedEmail",
    ],
  }),
);
