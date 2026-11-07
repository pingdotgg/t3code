import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAuditManagerAccountHttpBinding } from "./BindingHttp.ts";
import { ValidateAssessmentReportIntegrity } from "./ValidateAssessmentReportIntegrity.ts";

export const ValidateAssessmentReportIntegrityHttp = Layer.effect(
  ValidateAssessmentReportIntegrity,
  makeAuditManagerAccountHttpBinding({
    tag: "AWS.AuditManager.ValidateAssessmentReportIntegrity",
    operation: auditmanager.validateAssessmentReportIntegrity,
    actions: ["auditmanager:ValidateAssessmentReportIntegrity"],
  }),
);
