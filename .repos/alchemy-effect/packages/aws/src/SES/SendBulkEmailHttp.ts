import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Layer from "effect/Layer";
import { makeSendScopedHttpBinding } from "./BindingHttp.ts";
import { SendBulkEmail } from "./SendBulkEmail.ts";

export const SendBulkEmailHttp = Layer.effect(
  SendBulkEmail,
  makeSendScopedHttpBinding({
    tag: "AWS.SES.SendBulkEmail",
    operation: sesv2.sendBulkEmail,
    actions: [
      "ses:SendEmail",
      "ses:SendBulkEmail",
      "ses:SendTemplatedEmail",
      "ses:SendBulkTemplatedEmail",
    ],
  }),
);
