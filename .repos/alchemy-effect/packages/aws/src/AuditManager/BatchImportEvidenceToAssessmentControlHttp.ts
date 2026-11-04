import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { BatchImportEvidenceToAssessmentControl } from "./BatchImportEvidenceToAssessmentControl.ts";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";

export const BatchImportEvidenceToAssessmentControlHttp = Layer.effect(
  BatchImportEvidenceToAssessmentControl,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.BatchImportEvidenceToAssessmentControl",
    operation: auditmanager.batchImportEvidenceToAssessmentControl,
    actions: ["auditmanager:BatchImportEvidenceToAssessmentControl"],
  }),
);
