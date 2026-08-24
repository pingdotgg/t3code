import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";
import { UpdateAssessmentControlSetStatus } from "./UpdateAssessmentControlSetStatus.ts";

export const UpdateAssessmentControlSetStatusHttp = Layer.effect(
  UpdateAssessmentControlSetStatus,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.UpdateAssessmentControlSetStatus",
    operation: auditmanager.updateAssessmentControlSetStatus,
    actions: ["auditmanager:UpdateAssessmentControlSetStatus"],
  }),
);
