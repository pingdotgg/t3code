import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";
import { ListAssessmentControlInsightsByControlDomain } from "./ListAssessmentControlInsightsByControlDomain.ts";

export const ListAssessmentControlInsightsByControlDomainHttp = Layer.effect(
  ListAssessmentControlInsightsByControlDomain,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.ListAssessmentControlInsightsByControlDomain",
    operation: auditmanager.listAssessmentControlInsightsByControlDomain,
    actions: ["auditmanager:ListAssessmentControlInsightsByControlDomain"],
  }),
);
