import * as acmpca from "@distilled.cloud/aws/acm-pca";
import * as Layer from "effect/Layer";
import { makeACMPCAHttpBinding } from "./BindingHttp.ts";
import { CreateCertificateAuthorityAuditReport } from "./CreateCertificateAuthorityAuditReport.ts";

export const CreateCertificateAuthorityAuditReportHttp = Layer.effect(
  CreateCertificateAuthorityAuditReport,
  makeACMPCAHttpBinding({
    action: "CreateCertificateAuthorityAuditReport",
    operation: acmpca.createCertificateAuthorityAuditReport,
  }),
);
