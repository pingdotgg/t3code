import * as acmpca from "@distilled.cloud/aws/acm-pca";
import * as Layer from "effect/Layer";
import { makeACMPCAHttpBinding } from "./BindingHttp.ts";
import { DescribeCertificateAuthorityAuditReport } from "./DescribeCertificateAuthorityAuditReport.ts";

export const DescribeCertificateAuthorityAuditReportHttp = Layer.effect(
  DescribeCertificateAuthorityAuditReport,
  makeACMPCAHttpBinding({
    action: "DescribeCertificateAuthorityAuditReport",
    operation: acmpca.describeCertificateAuthorityAuditReport,
  }),
);
