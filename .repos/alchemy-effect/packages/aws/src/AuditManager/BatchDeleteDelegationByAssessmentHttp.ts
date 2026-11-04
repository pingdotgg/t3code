import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { BatchDeleteDelegationByAssessment } from "./BatchDeleteDelegationByAssessment.ts";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";

export const BatchDeleteDelegationByAssessmentHttp = Layer.effect(
  BatchDeleteDelegationByAssessment,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.BatchDeleteDelegationByAssessment",
    operation: auditmanager.batchDeleteDelegationByAssessment,
    actions: ["auditmanager:BatchDeleteDelegationByAssessment"],
  }),
);
