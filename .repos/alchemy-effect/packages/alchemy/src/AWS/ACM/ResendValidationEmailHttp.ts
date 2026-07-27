import * as acm from "@distilled.cloud/aws/acm";
import * as Layer from "effect/Layer";
import { makeAcmCertificateHttpBinding } from "./BindingHttp.ts";
import {
  ResendValidationEmail,
  type ResendValidationEmailRequest,
} from "./ResendValidationEmail.ts";

export const ResendValidationEmailHttp = Layer.effect(
  ResendValidationEmail,
  makeAcmCertificateHttpBinding({
    capability: "ResendValidationEmail",
    iamActions: ["acm:ResendValidationEmail"],
    operation: acm.resendValidationEmail,
  }),
);
