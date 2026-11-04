import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";
import { GetEvidenceFoldersByAssessment } from "./GetEvidenceFoldersByAssessment.ts";

export const GetEvidenceFoldersByAssessmentHttp = Layer.effect(
  GetEvidenceFoldersByAssessment,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.GetEvidenceFoldersByAssessment",
    operation: auditmanager.getEvidenceFoldersByAssessment,
    actions: ["auditmanager:GetEvidenceFoldersByAssessment"],
  }),
);
