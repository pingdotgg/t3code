import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";
import { GetEvidenceFoldersByAssessmentControl } from "./GetEvidenceFoldersByAssessmentControl.ts";

export const GetEvidenceFoldersByAssessmentControlHttp = Layer.effect(
  GetEvidenceFoldersByAssessmentControl,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.GetEvidenceFoldersByAssessmentControl",
    operation: auditmanager.getEvidenceFoldersByAssessmentControl,
    actions: ["auditmanager:GetEvidenceFoldersByAssessmentControl"],
  }),
);
