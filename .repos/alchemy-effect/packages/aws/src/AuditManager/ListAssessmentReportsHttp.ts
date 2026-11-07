import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAuditManagerAccountHttpBinding } from "./BindingHttp.ts";
import { ListAssessmentReports } from "./ListAssessmentReports.ts";

export const ListAssessmentReportsHttp = Layer.effect(
  ListAssessmentReports,
  makeAuditManagerAccountHttpBinding({
    tag: "AWS.AuditManager.ListAssessmentReports",
    operation: auditmanager.listAssessmentReports,
    actions: ["auditmanager:ListAssessmentReports"],
  }),
);
