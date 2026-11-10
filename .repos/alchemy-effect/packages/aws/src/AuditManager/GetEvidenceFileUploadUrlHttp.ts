import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAuditManagerAccountHttpBinding } from "./BindingHttp.ts";
import { GetEvidenceFileUploadUrl } from "./GetEvidenceFileUploadUrl.ts";

export const GetEvidenceFileUploadUrlHttp = Layer.effect(
  GetEvidenceFileUploadUrl,
  makeAuditManagerAccountHttpBinding({
    tag: "AWS.AuditManager.GetEvidenceFileUploadUrl",
    operation: auditmanager.getEvidenceFileUploadUrl,
    actions: ["auditmanager:GetEvidenceFileUploadUrl"],
  }),
);
