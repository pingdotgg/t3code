import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";
import { GetEvidenceByEvidenceFolder } from "./GetEvidenceByEvidenceFolder.ts";

export const GetEvidenceByEvidenceFolderHttp = Layer.effect(
  GetEvidenceByEvidenceFolder,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.GetEvidenceByEvidenceFolder",
    operation: auditmanager.getEvidenceByEvidenceFolder,
    actions: ["auditmanager:GetEvidenceByEvidenceFolder"],
  }),
);
