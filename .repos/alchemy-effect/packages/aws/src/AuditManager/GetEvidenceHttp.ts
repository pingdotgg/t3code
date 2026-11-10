import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";
import { GetEvidence } from "./GetEvidence.ts";

export const GetEvidenceHttp = Layer.effect(
  GetEvidence,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.GetEvidence",
    operation: auditmanager.getEvidence,
    actions: ["auditmanager:GetEvidence"],
  }),
);
