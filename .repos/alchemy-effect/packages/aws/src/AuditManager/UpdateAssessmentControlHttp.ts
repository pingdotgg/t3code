import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAssessmentScopedHttpBinding } from "./BindingHttp.ts";
import { UpdateAssessmentControl } from "./UpdateAssessmentControl.ts";

export const UpdateAssessmentControlHttp = Layer.effect(
  UpdateAssessmentControl,
  makeAssessmentScopedHttpBinding({
    tag: "AWS.AuditManager.UpdateAssessmentControl",
    operation: auditmanager.updateAssessmentControl,
    actions: ["auditmanager:UpdateAssessmentControl"],
  }),
);
