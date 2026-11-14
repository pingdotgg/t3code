import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";
import { CreateAssessmentReport } from "./CreateAssessmentReport.ts";

export const CreateAssessmentReportHttp = Layer.effect(
  CreateAssessmentReport,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.CreateAssessmentReport",
    operation: auditmanager.createAssessmentReport,
    actions: ["auditmanager:CreateAssessmentReport"],
  }),
);
