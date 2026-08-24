import * as acmpca from "@distilled.cloud/aws/acm-pca";
import * as Layer from "effect/Layer";
import { makeACMPCAHttpBinding } from "./BindingHttp.ts";
import { IssueCertificate } from "./IssueCertificate.ts";

export const IssueCertificateHttp = Layer.effect(
  IssueCertificate,
  makeACMPCAHttpBinding({
    action: "IssueCertificate",
    operation: acmpca.issueCertificate,
  }),
);
