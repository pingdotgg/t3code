import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAuditManagerAccountHttpBinding } from "./BindingHttp.ts";
import { ListControlInsightsByControlDomain } from "./ListControlInsightsByControlDomain.ts";

export const ListControlInsightsByControlDomainHttp = Layer.effect(
  ListControlInsightsByControlDomain,
  makeAuditManagerAccountHttpBinding({
    tag: "AWS.AuditManager.ListControlInsightsByControlDomain",
    operation: auditmanager.listControlInsightsByControlDomain,
    actions: ["auditmanager:ListControlInsightsByControlDomain"],
  }),
);
