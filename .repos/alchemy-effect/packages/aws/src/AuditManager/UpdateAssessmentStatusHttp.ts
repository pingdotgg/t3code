import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";
import { UpdateAssessmentStatus } from "./UpdateAssessmentStatus.ts";

export const UpdateAssessmentStatusHttp = Layer.effect(
  UpdateAssessmentStatus,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.UpdateAssessmentStatus",
    operation: auditmanager.updateAssessmentStatus,
    actions: ["auditmanager:UpdateAssessmentStatus"],
  }),
);
