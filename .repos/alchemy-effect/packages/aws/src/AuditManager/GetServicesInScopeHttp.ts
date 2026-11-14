import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAuditManagerAccountHttpBinding } from "./BindingHttp.ts";
import { GetServicesInScope } from "./GetServicesInScope.ts";

export const GetServicesInScopeHttp = Layer.effect(
  GetServicesInScope,
  makeAuditManagerAccountHttpBinding({
    tag: "AWS.AuditManager.GetServicesInScope",
    operation: auditmanager.getServicesInScope,
    actions: ["auditmanager:GetServicesInScope"],
  }),
);
