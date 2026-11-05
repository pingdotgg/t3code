import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAuditManagerAccountHttpBinding } from "./BindingHttp.ts";
import { GetAccountStatus } from "./GetAccountStatus.ts";

export const GetAccountStatusHttp = Layer.effect(
  GetAccountStatus,
  makeAuditManagerAccountHttpBinding({
    tag: "AWS.AuditManager.GetAccountStatus",
    operation: auditmanager.getAccountStatus,
    actions: ["auditmanager:GetAccountStatus"],
  }),
);
