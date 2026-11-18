import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";
import { ListControlDomainInsightsByAssessment } from "./ListControlDomainInsightsByAssessment.ts";

export const ListControlDomainInsightsByAssessmentHttp = Layer.effect(
  ListControlDomainInsightsByAssessment,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.ListControlDomainInsightsByAssessment",
    operation: auditmanager.listControlDomainInsightsByAssessment,
    actions: ["auditmanager:ListControlDomainInsightsByAssessment"],
  }),
);
