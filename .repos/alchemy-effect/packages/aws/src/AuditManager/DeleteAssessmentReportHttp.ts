import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";
import { DeleteAssessmentReport } from "./DeleteAssessmentReport.ts";

export const DeleteAssessmentReportHttp = Layer.effect(
  DeleteAssessmentReport,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.DeleteAssessmentReport",
    operation: auditmanager.deleteAssessmentReport,
    actions: ["auditmanager:DeleteAssessmentReport"],
  }),
);
