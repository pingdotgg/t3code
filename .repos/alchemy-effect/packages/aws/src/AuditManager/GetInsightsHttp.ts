import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAuditManagerAccountHttpBinding } from "./BindingHttp.ts";
import { GetInsights } from "./GetInsights.ts";

export const GetInsightsHttp = Layer.effect(
  GetInsights,
  makeAuditManagerAccountHttpBinding({
    tag: "AWS.AuditManager.GetInsights",
    operation: auditmanager.getInsights,
    actions: ["auditmanager:GetInsights"],
  }),
);
