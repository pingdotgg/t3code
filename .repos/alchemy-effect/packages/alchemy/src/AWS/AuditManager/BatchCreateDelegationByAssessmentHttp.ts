import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";
import { BatchCreateDelegationByAssessment } from "./BatchCreateDelegationByAssessment.ts";

export const BatchCreateDelegationByAssessmentHttp = Layer.effect(
  BatchCreateDelegationByAssessment,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.BatchCreateDelegationByAssessment",
    operation: auditmanager.batchCreateDelegationByAssessment,
    actions: ["auditmanager:BatchCreateDelegationByAssessment"],
  }),
);
