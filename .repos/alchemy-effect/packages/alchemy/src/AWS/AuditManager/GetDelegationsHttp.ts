import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAuditManagerAccountHttpBinding } from "./BindingHttp.ts";
import { GetDelegations } from "./GetDelegations.ts";

export const GetDelegationsHttp = Layer.effect(
  GetDelegations,
  makeAuditManagerAccountHttpBinding({
    tag: "AWS.AuditManager.GetDelegations",
    operation: auditmanager.getDelegations,
    actions: ["auditmanager:GetDelegations"],
  }),
);
