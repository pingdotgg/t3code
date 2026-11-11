import * as acmpca from "@distilled.cloud/aws/acm-pca";
import * as Layer from "effect/Layer";
import { makeACMPCAHttpBinding } from "./BindingHttp.ts";
import { GetCertificateAuthorityCertificate } from "./GetCertificateAuthorityCertificate.ts";

export const GetCertificateAuthorityCertificateHttp = Layer.effect(
  GetCertificateAuthorityCertificate,
  makeACMPCAHttpBinding({
    action: "GetCertificateAuthorityCertificate",
    operation: acmpca.getCertificateAuthorityCertificate,
  }),
);
