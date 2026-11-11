import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAuditManagerAccountHttpBinding } from "./BindingHttp.ts";
import { ListControlDomainInsights } from "./ListControlDomainInsights.ts";

export const ListControlDomainInsightsHttp = Layer.effect(
  ListControlDomainInsights,
  makeAuditManagerAccountHttpBinding({
    tag: "AWS.AuditManager.ListControlDomainInsights",
    operation: auditmanager.listControlDomainInsights,
    actions: ["auditmanager:ListControlDomainInsights"],
  }),
);
