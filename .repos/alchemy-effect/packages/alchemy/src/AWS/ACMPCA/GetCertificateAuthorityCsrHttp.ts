import * as acmpca from "@distilled.cloud/aws/acm-pca";
import * as Layer from "effect/Layer";
import { makeACMPCAHttpBinding } from "./BindingHttp.ts";
import { GetCertificateAuthorityCsr } from "./GetCertificateAuthorityCsr.ts";

export const GetCertificateAuthorityCsrHttp = Layer.effect(
  GetCertificateAuthorityCsr,
  makeACMPCAHttpBinding({
    action: "GetCertificateAuthorityCsr",
    operation: acmpca.getCertificateAuthorityCsr,
  }),
);
