import * as acmpca from "@distilled.cloud/aws/acm-pca";
import * as Layer from "effect/Layer";
import { makeACMPCAHttpBinding } from "./BindingHttp.ts";
import { ImportCertificateAuthorityCertificate } from "./ImportCertificateAuthorityCertificate.ts";

export const ImportCertificateAuthorityCertificateHttp = Layer.effect(
  ImportCertificateAuthorityCertificate,
  makeACMPCAHttpBinding({
    action: "ImportCertificateAuthorityCertificate",
    operation: acmpca.importCertificateAuthorityCertificate,
  }),
);
