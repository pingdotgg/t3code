import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";
import { GetEvidenceFolder } from "./GetEvidenceFolder.ts";

export const GetEvidenceFolderHttp = Layer.effect(
  GetEvidenceFolder,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.GetEvidenceFolder",
    operation: auditmanager.getEvidenceFolder,
    actions: ["auditmanager:GetEvidenceFolder"],
  }),
);
