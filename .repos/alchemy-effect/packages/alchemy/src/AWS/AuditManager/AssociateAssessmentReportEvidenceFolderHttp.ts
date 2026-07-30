import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";
import { AssociateAssessmentReportEvidenceFolder } from "./AssociateAssessmentReportEvidenceFolder.ts";

export const AssociateAssessmentReportEvidenceFolderHttp = Layer.effect(
  AssociateAssessmentReportEvidenceFolder,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.AssociateAssessmentReportEvidenceFolder",
    operation: auditmanager.associateAssessmentReportEvidenceFolder,
    actions: ["auditmanager:AssociateAssessmentReportEvidenceFolder"],
  }),
);
