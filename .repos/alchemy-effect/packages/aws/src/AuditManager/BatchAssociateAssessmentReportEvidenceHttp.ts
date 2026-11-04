import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { BatchAssociateAssessmentReportEvidence } from "./BatchAssociateAssessmentReportEvidence.ts";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";

export const BatchAssociateAssessmentReportEvidenceHttp = Layer.effect(
  BatchAssociateAssessmentReportEvidence,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.BatchAssociateAssessmentReportEvidence",
    operation: auditmanager.batchAssociateAssessmentReportEvidence,
    actions: ["auditmanager:BatchAssociateAssessmentReportEvidence"],
  }),
);
