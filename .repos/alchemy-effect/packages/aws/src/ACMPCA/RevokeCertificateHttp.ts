import * as acmpca from "@distilled.cloud/aws/acm-pca";
import * as Layer from "effect/Layer";
import { makeACMPCAHttpBinding } from "./BindingHttp.ts";
import { RevokeCertificate } from "./RevokeCertificate.ts";

export const RevokeCertificateHttp = Layer.effect(
  RevokeCertificate,
  makeACMPCAHttpBinding({
    action: "RevokeCertificate",
    operation: acmpca.revokeCertificate,
  }),
);
