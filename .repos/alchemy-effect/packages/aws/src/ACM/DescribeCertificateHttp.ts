import * as acm from "@distilled.cloud/aws/acm";
import * as Layer from "effect/Layer";
import { makeAcmCertificateHttpBinding } from "./BindingHttp.ts";
import { DescribeCertificate } from "./DescribeCertificate.ts";

export const DescribeCertificateHttp = Layer.effect(
  DescribeCertificate,
  makeAcmCertificateHttpBinding({
    capability: "DescribeCertificate",
    iamActions: ["acm:DescribeCertificate"],
    operation: acm.describeCertificate,
  }),
);
