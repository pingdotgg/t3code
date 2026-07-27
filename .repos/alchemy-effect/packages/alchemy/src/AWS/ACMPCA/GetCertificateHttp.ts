import * as acmpca from "@distilled.cloud/aws/acm-pca";
import * as Layer from "effect/Layer";
import { makeACMPCAHttpBinding } from "./BindingHttp.ts";
import { GetCertificate } from "./GetCertificate.ts";

export const GetCertificateHttp = Layer.effect(
  GetCertificate,
  makeACMPCAHttpBinding({
    action: "GetCertificate",
    operation: acmpca.getCertificate,
  }),
);
