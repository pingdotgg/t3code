import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";
import { BatchDisassociateAssessmentReportEvidence } from "./BatchDisassociateAssessmentReportEvidence.ts";

export const BatchDisassociateAssessmentReportEvidenceHttp = Layer.effect(
  BatchDisassociateAssessmentReportEvidence,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.BatchDisassociateAssessmentReportEvidence",
    operation: auditmanager.batchDisassociateAssessmentReportEvidence,
    actions: ["auditmanager:BatchDisassociateAssessmentReportEvidence"],
  }),
);
