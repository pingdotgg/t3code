import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";
import { GetChangeLogs } from "./GetChangeLogs.ts";

export const GetChangeLogsHttp = Layer.effect(
  GetChangeLogs,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.GetChangeLogs",
    operation: auditmanager.getChangeLogs,
    actions: ["auditmanager:GetChangeLogs"],
  }),
);
