import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { AssociateAssessmentReportEvidenceFolder } from "./AssociateAssessmentReportEvidenceFolder.ts";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";

export const AssociateAssessmentReportEvidenceFolderHttp = Layer.effect(
  AssociateAssessmentReportEvidenceFolder,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.AssociateAssessmentReportEvidenceFolder",
    operation: auditmanager.associateAssessmentReportEvidenceFolder,
    actions: ["auditmanager:AssociateAssessmentReportEvidenceFolder"],
  }),
);
